from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.config import settings
from app.db import engine
from app.lark.client import LarkClient, build_lark_client
from app.lark.outbox import claim_next_job, park_job_for_target_change, run_job
from app.lark.people import resolved_owner_open_id, resolved_reporter_open_id
from app.lark.target import target_for
from app.lark.write import HttpLarkWriteGateway, LarkWriteGateway
from app.models import Attempt, LarkTarget, SyncJob


POLL_INTERVAL_SECONDS = 5


def build_gateway(target: LarkTarget, client: LarkClient) -> HttpLarkWriteGateway:
    """One write gateway for one job, aimed at that job's stored target."""

    return HttpLarkWriteGateway(
        client,
        run_app_token=target.execution_base_token,
        run_table_id=target.execution_table_id,
        bug_app_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )


def _job_for(db: Session, attempt: Attempt) -> SyncJob:
    job = db.scalar(
        select(SyncJob).where(SyncJob.attempt_id == attempt.id).with_for_update()
    )
    if job is None:
        target = target_for(db, attempt.group_case.group_id)
        job = SyncJob(
            attempt_id=attempt.id,
            state="pending",
            target_fingerprint=target.target_fingerprint if target else None,
        )
        db.add(job)
        db.flush()
    return job


def process_one_job(
    gateway: LarkWriteGateway,
    attempt: Attempt,
    *,
    db: Session | None = None,
    reporter: str | None = None,
    now: Any | None = None,
    force: bool = False,
) -> str:
    """Sync exactly one attempt and report the job's final state."""

    session = db or object_session(attempt)
    if session is None:
        raise RuntimeError("process_one_job needs a database session")
    job = _job_for(session, attempt)
    if force and job.state in ("uncertain", "failed"):
        # An administrator reviewed the remote state before this retry.
        job.state = "pending"
        job.retry_count = 0
    session.commit()
    run_job(
        session,
        job,
        gateway,
        attempt,
        # 负责人/报告人 are display names in the hand-run rows; the sign-in
        # address is only the fallback when no name is configured.
        reporter=reporter or settings.default_reporter or settings.admin_email,
        owner=settings.default_owner,
        # The open ids live in the settings row the page writes; the environment
        # value is only what a deployment that never opened that page still has.
        reporter_id=resolved_reporter_open_id(session),
        owner_id=resolved_owner_open_id(session),
        now=now,
    )
    return job.state


def run_once(
    db: Session,
    gateway_factory: Callable[[LarkTarget], LarkWriteGateway] | None = None,
    *,
    client: LarkClient | None = None,
    reporter: str | None = None,
) -> str | None:
    """Claim and run one due job; returns its final state or None when idle."""

    job = claim_next_job(db)
    if job is None:
        db.commit()
        return None
    attempt = db.get(Attempt, job.attempt_id)
    target = target_for(db, attempt.group_case.group_id) if attempt else None
    if attempt is None or target is None:
        # There is nothing to aim this write at. Park the claim the same way a
        # stale target does: a job left running would only come back when its
        # lease expires, with no error kind and nothing for the operator to see.
        park_job_for_target_change(db, job)
        db.commit()
        return job.state
    db.commit()
    if gateway_factory is None:
        shared_client = client or build_lark_client()
        build = lambda resolved: build_gateway(resolved, shared_client)
    else:
        build = gateway_factory
    return process_one_job(build(target), attempt, db=db, reporter=reporter)


def main() -> None:  # pragma: no cover - exercised through run_once in tests
    client = build_lark_client()
    while True:
        with Session(engine) as session:
            state = run_once(session, client=client)
        if state is None:
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":  # pragma: no cover
    main()
