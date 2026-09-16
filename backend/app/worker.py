from __future__ import annotations

import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.config import settings
from app.db import engine
from app.lark.client import build_lark_client
from app.lark.outbox import claim_next_job, run_job
from app.lark.write import HttpLarkWriteGateway, LarkWriteGateway
from app.models import Attempt, SyncJob


POLL_INTERVAL_SECONDS = 5


def build_gateway() -> HttpLarkWriteGateway:
    client = build_lark_client()
    return HttpLarkWriteGateway(
        client,
        run_app_token=settings.lark_app_token,
        run_table_id=settings.lark_table_runs,
        bug_app_token=settings.lark_bug_app_token,
        bug_table_id=settings.lark_table_defects,
    )


def _job_for(db: Session, attempt: Attempt) -> SyncJob:
    job = db.scalar(
        select(SyncJob).where(SyncJob.attempt_id == attempt.id).with_for_update()
    )
    if job is None:
        job = SyncJob(attempt_id=attempt.id, state="pending")
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
        reporter=reporter or settings.admin_email,
        now=now,
    )
    return job.state


def run_once(
    db: Session,
    gateway: LarkWriteGateway | None = None,
    *,
    reporter: str | None = None,
) -> str | None:
    """Claim and run one due job; returns its final state or None when idle."""

    job = claim_next_job(db)
    if job is None:
        db.commit()
        return None
    attempt = db.get(Attempt, job.attempt_id)
    db.commit()
    if attempt is None:
        return None
    return process_one_job(
        gateway or build_gateway(), attempt, db=db, reporter=reporter
    )


def main() -> None:  # pragma: no cover - exercised through run_once in tests
    gateway = build_gateway()
    while True:
        with Session(engine) as session:
            state = run_once(session, gateway)
        if state is None:
            time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":  # pragma: no cover
    main()
