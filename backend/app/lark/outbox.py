from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkError, LarkTimeout
from app.lark.write import (
    LarkWriteGateway,
    bug_fields,
    execution_fields,
)
from app.models import (
    Attempt,
    Group,
    GroupCase,
    GroupLarkConfirmation,
    SyncJob,
)


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# A worker that dies mid-job releases its work when the lease expires, and a
# retriable failure backs off exponentially up to the retry ceiling.
LEASE_SECONDS = 120
MAX_RETRIES = 5
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 900

ACTIVE_STATES = ("pending", "running")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def group_is_confirmed(db: Session, group_id: UUID) -> bool:
    return (
        db.scalar(
            select(GroupLarkConfirmation.id).where(
                GroupLarkConfirmation.group_id == group_id
            )
        )
        is not None
    )


def enqueue_attempt_job(db: Session, attempt: Attempt) -> SyncJob | None:
    """Queue one new attempt, but only inside a confirmed group."""

    group_id = attempt.group_case.group_id
    if attempt.state != "committed" or not group_is_confirmed(db, group_id):
        return None
    job = SyncJob(attempt_id=attempt.id, state="pending", next_retry_at=_now())
    db.add(job)
    return job


def enqueue_group_attempts(db: Session, group_id: UUID) -> int:
    """Explicitly queue every previously saved local attempt of a group."""

    if not group_is_confirmed(db, group_id):
        raise HTTPException(
            status_code=409, detail="Group Lark targets are not confirmed yet"
        )
    attempt_ids = db.scalars(
        select(Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id, Attempt.state == "committed")
    ).all()
    if not attempt_ids:
        return 0
    statement = (
        insert(SyncJob)
        .values(
            [
                {"attempt_id": attempt_id, "state": "pending", "next_retry_at": _now()}
                for attempt_id in attempt_ids
            ]
        )
        .on_conflict_do_nothing(index_elements=["attempt_id"])
        .returning(SyncJob.id)
    )
    inserted = db.execute(statement).scalars().all()
    db.commit()
    return len(inserted)


def claim_next_job(db: Session, *, now: datetime | None = None) -> SyncJob | None:
    """Claim one due job; concurrent workers skip rows another worker holds."""

    moment = now or _now()
    job = db.scalar(
        select(SyncJob)
        .where(
            SyncJob.state.in_(ACTIVE_STATES),
            (SyncJob.next_retry_at.is_(None)) | (SyncJob.next_retry_at <= moment),
            (SyncJob.lease_until.is_(None)) | (SyncJob.lease_until <= moment),
        )
        .order_by(SyncJob.created_at)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if job is None:
        return None
    job.state = "running"
    job.lease_until = moment + timedelta(seconds=LEASE_SECONDS)
    db.flush()
    return job


def _schedule_retry(db: Session, job: SyncJob, error_kind: str, *, now: datetime) -> None:
    job.retry_count += 1
    job.error_kind = error_kind
    if job.retry_count > MAX_RETRIES:
        job.state = "failed"
        job.lease_until = None
        job.next_retry_at = None
    else:
        delay = min(BACKOFF_BASE_SECONDS * 2 ** (job.retry_count - 1), BACKOFF_CAP_SECONDS)
        job.state = "pending"
        job.lease_until = None
        job.next_retry_at = now + timedelta(seconds=delay)
    db.flush()


def _mark_uncertain(db: Session, job: SyncJob, error_kind: str) -> None:
    job.state = "uncertain"
    job.error_kind = error_kind
    job.lease_until = None
    job.next_retry_at = None
    db.flush()


def run_job(
    db: Session,
    job: SyncJob,
    gateway: LarkWriteGateway,
    attempt: Attempt,
    *,
    reporter: str,
    now: datetime | None = None,
) -> SyncJob:
    """Run one job. A remote create is never repeated once its id is stored."""

    moment = now or _now()
    # A synced job is done, and an uncertain job waits for an administrator
    # instead of silently posting a possible duplicate.
    if job.state in ("synced", "uncertain"):
        return job

    case = attempt.group_case
    job.state = "running"
    job.lease_until = moment + timedelta(seconds=LEASE_SECONDS)
    db.flush()

    if job.new_exec_record_id is None:
        try:
            job.new_exec_record_id = gateway.create_execution(
                execution_fields(attempt, case, reporter)
            )
        except LarkTimeout:
            # The create may have landed; only a single provable match may be
            # adopted, otherwise a human has to look before anything retries.
            matches = gateway.find_execution_ids(attempt.label)
            if len(matches) == 1:
                job.new_exec_record_id = matches[0]
            else:
                _mark_uncertain(db, job, "timeout_unreconciled")
                db.commit()
                return job
        except LarkError:
            _schedule_retry(db, job, "create_execution_failed", now=moment)
            db.commit()
            return job
        # Persist the new record id before touching the bug table so a crash
        # cannot create the execution record twice.
        db.commit()

    if attempt.result == "不通过" and job.new_bug_record_id is None:
        try:
            job.new_bug_record_id = gateway.create_bug(
                bug_fields(attempt, case, reporter)
            )
        except LarkTimeout:
            _mark_uncertain(db, job, "timeout_after_exec_create")
            db.commit()
            return job
        except LarkError:
            # The execution record stays; an administrator retries just the bug.
            job.state = "failed"
            job.error_kind = "create_bug_failed"
            job.lease_until = None
            db.commit()
            return job

    job.state = "synced"
    job.error_kind = None
    job.lease_until = None
    job.next_retry_at = None
    db.commit()
    return job


def sync_counts(db: Session, group_id: UUID) -> dict[str, Any]:
    rows = db.execute(
        select(SyncJob.state, func.count(SyncJob.id))
        .join(Attempt, SyncJob.attempt_id == Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id)
        .group_by(SyncJob.state)
    ).all()
    counts = {state: int(count) for state, count in rows}
    last_error = db.scalar(
        select(SyncJob.error_kind)
        .join(Attempt, SyncJob.attempt_id == Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(
            GroupCase.group_id == group_id,
            SyncJob.error_kind.is_not(None),
        )
        .order_by(SyncJob.created_at.desc())
        .limit(1)
    )
    return {
        "queued": counts.get("pending", 0) + counts.get("running", 0),
        "synced": counts.get("synced", 0),
        "failed": counts.get("failed", 0),
        "uncertain": counts.get("uncertain", 0),
        "last_error_kind": last_error,
    }


@router.get("/groups/{group_id}/sync")
def read_sync(group_id: UUID, db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    confirmed = group_is_confirmed(db, group_id)
    pending_attempts = db.scalar(
        select(func.count())
        .select_from(Attempt)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id, Attempt.state == "committed")
    )
    counts = sync_counts(db, group_id)
    return {
        "confirmed": confirmed,
        "pending_attempts": int(pending_attempts or 0),
        **counts,
        "detail": (
            "目标表已确认，可显式排入同步"
            if confirmed
            else "尚未确认目标表，本地结果不会写入 Lark"
        ),
    }


@router.post("/groups/{group_id}/sync/enqueue")
def enqueue_sync(
    group_id: UUID, db: Annotated[Session, Depends(get_db)]
) -> dict[str, int]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"queued": enqueue_group_attempts(db, group_id)}


def retry_failed_jobs(db: Session, group_id: UUID | None = None) -> int:
    """Administrator-triggered retry of failed jobs (never of uncertain ones)."""

    statement = (
        update(SyncJob)
        .where(SyncJob.state == "failed")
        .values(state="pending", retry_count=0, next_retry_at=_now(), error_kind=None)
    )
    if group_id is not None:
        statement = statement.where(
            SyncJob.attempt_id.in_(
                select(Attempt.id)
                .join(GroupCase, Attempt.group_case_id == GroupCase.id)
                .where(GroupCase.group_id == group_id)
            )
        )
    result = db.execute(statement)
    db.commit()
    return int(result.rowcount or 0)
