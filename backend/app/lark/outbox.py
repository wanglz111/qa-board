from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.lark.client import LarkError, LarkTimeout
from app.lark.target import target_for
from app.lark.write import (
    LarkWriteGateway,
    bug_fields,
    execution_fields,
)
from app.models import (
    Attempt,
    Group,
    GroupCase,
    SyncJob,
)


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# A worker that dies mid-job releases its work when the lease expires, and a
# retriable failure backs off exponentially up to the retry ceiling.
LEASE_SECONDS = 120
MAX_RETRIES = 5
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 900
# A job whose group lost its approval, or whose stored target moved to another
# table, waits for the administrator instead of spending retries. A restored
# approval wakes it up on its own; a moved target waits for an explicit re-point.
STALE_CONFIRMATION_SECONDS = 60

ACTIVE_STATES = ("pending", "running")

# A row is not written the instant it is queued. The browser uploads the
# screenshots that belong to it right after the result is saved, and a row built
# before they land would carry no attachment — and a create is never repeated.
# So a queued row waits one settle window, and every screenshot that arrives
# pushes that window back: the write happens once the evidence stops coming.
EVIDENCE_SETTLE_SECONDS = 15

# The suffix each stored screenshot's mime maps to, so the file reaches Lark
# under a name a person can read in the attachment list.
SCREENSHOT_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
SNAPSHOT_LIMIT = 10


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _stored_screenshots(attempt: Attempt) -> list[tuple[str, bytes, str]]:
    """This attempt's screenshots, read back as (name, bytes, mime).

    A row whose file is gone is skipped rather than blocking the row forever:
    the missing file is a storage problem, and the result still belongs in Lark.
    """

    directory = Path(settings.upload_dir)
    stored: list[tuple[str, bytes, str]] = []
    shots = sorted(
        attempt.screenshots, key=lambda shot: (shot.created_at, shot.storage_key)
    )
    for index, shot in enumerate(shots[:SNAPSHOT_LIMIT], start=1):
        path = directory / shot.storage_key
        if not path.is_file():
            continue
        suffix = SCREENSHOT_SUFFIX.get(shot.mime, "")
        stored.append((f"{attempt.label}-{index}{suffix}", path.read_bytes(), shot.mime))
    return stored


def _upload_screenshots(
    gateway: LarkWriteGateway, attempt: Attempt, *, role: str
) -> list[str]:
    """Upload this attempt's screenshots to that role's base, returning tokens."""

    tokens: list[str] = []
    for name, content, mime in _stored_screenshots(attempt):
        tokens.append(gateway.upload_attachment(name, content, mime, role=role))
    return tokens


def group_is_confirmed(db: Session, group_id: UUID) -> bool:
    target = target_for(db, group_id)
    return target is not None and target.confirmed_at is not None


def enqueue_attempt_job(db: Session, attempt: Attempt) -> SyncJob | None:
    """Queue one new attempt, but only inside a confirmed group."""

    group_id = attempt.group_case.group_id
    target = target_for(db, group_id)
    # A row adopted from the table already exists there, so it is never queued.
    if (
        attempt.state != "committed"
        or attempt.source != "execution"
        or target is None
        or target.confirmed_at is None
    ):
        return None
    job = SyncJob(
        attempt_id=attempt.id,
        state="pending",
        # The first write waits for the evidence of this attempt: the browser
        # starts uploading the screenshots only after this row is saved, so a
        # write that ran any earlier could never carry them.
        next_retry_at=_now() + timedelta(seconds=EVIDENCE_SETTLE_SECONDS),
        # The job is pinned to the destination that was approved when it was
        # queued; anything else parks it until an administrator re-points it.
        target_fingerprint=target.target_fingerprint,
    )
    db.add(job)
    return job


def hold_job_for_evidence(
    db: Session, attempt: Attempt, *, now: datetime | None = None
) -> None:
    """Push a queued row's write back so evidence still arriving is included.

    Called when a screenshot lands. Only a row that has not been written yet is
    held: once the execution record exists the attachment can no longer be
    added to it, and a job an administrator has to look at (failed/uncertain) is
    never rescheduled from here.
    """

    moment = now or _now()
    job = db.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))
    if job is None or job.state not in ACTIVE_STATES:
        return
    if job.new_exec_record_id is not None:
        # The row is already in Lark; a later picture cannot join it.
        return
    due = moment + timedelta(seconds=EVIDENCE_SETTLE_SECONDS)
    if job.next_retry_at is None or job.next_retry_at < due:
        job.next_retry_at = due


def enqueue_group_attempts(db: Session, group_id: UUID) -> int:
    """Explicitly queue every previously saved local attempt of a group."""

    target = target_for(db, group_id)
    if target is None or target.confirmed_at is None:
        raise HTTPException(
            status_code=409, detail="Group Lark targets are not confirmed yet"
        )
    attempt_ids = db.scalars(
        select(Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(
            GroupCase.group_id == group_id,
            Attempt.state == "committed",
            Attempt.source == "execution",
        )
    ).all()
    if not attempt_ids:
        return 0
    statement = (
        insert(SyncJob)
        .values(
            [
                {
                    "attempt_id": attempt_id,
                    "state": "pending",
                    "next_retry_at": _now(),
                    "target_fingerprint": target.target_fingerprint,
                }
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


def park_job_for_target_change(
    db: Session, job: SyncJob, *, now: datetime | None = None
) -> None:
    """Hold a claimed job whose destination is not the approved one.

    The job stays pending with a visible ``target_changed`` error kind, but its
    lease is released so the worker does not re-claim it into another doomed
    attempt; only an administrator re-points it at a target.
    """

    moment = now or _now()
    job.state = "pending"
    job.error_kind = "target_changed"
    job.lease_until = None
    job.next_retry_at = moment + timedelta(seconds=STALE_CONFIRMATION_SECONDS)
    db.flush()


def run_job(
    db: Session,
    job: SyncJob,
    gateway: LarkWriteGateway,
    attempt: Attempt,
    *,
    reporter: str,
    owner: str | None = None,
    reporter_id: str | None = None,
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

    target = target_for(db, case.group_id)
    if (
        target is None
        or target.confirmed_at is None
        or job.target_fingerprint != target.target_fingerprint
    ):
        # Never post into a destination the administrator has not approved for
        # this group; a swapped table parks the job until a human re-points it.
        park_job_for_target_change(db, job, now=moment)
        db.commit()
        return job

    if job.new_exec_record_id is None:
        try:
            # The evidence travels with the row: a failure nobody can look at is
            # not a defect report. A file that cannot be uploaded keeps the job
            # queued instead of dropping the screenshot.
            attachments = _upload_screenshots(gateway, attempt, role="execution")
        except LarkError:
            _schedule_retry(db, job, "upload_screenshot_failed", now=moment)
            db.commit()
            return job
        fields = execution_fields(
            attempt, case, owner=owner or reporter, reporter=reporter, attachments=attachments
        )
        try:
            job.new_exec_record_id = gateway.create_execution(fields)
        except LarkTimeout:
            # The create may have landed; only a single provable match may be
            # adopted, otherwise a human has to look before anything retries.
            matches = gateway.find_execution_ids(fields)
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
            # A bug table may live in another base, where the execution record's
            # tokens are not valid; the bug row gets its own uploads.
            bug_attachments = _upload_screenshots(gateway, attempt, role="bug")
        except LarkError:
            # An upload is not a record write: nothing ambiguous happened, so a
            # bounded retry is safe and the screenshot is not dropped.
            _schedule_retry(db, job, "upload_screenshot_failed", now=moment)
            db.commit()
            return job
        try:
            job.new_bug_record_id = gateway.create_bug(
                bug_fields(
                    attempt,
                    case,
                    reporter=reporter,
                    attachments=bug_attachments,
                    reporter_id=reporter_id,
                )
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
    # A parked job stays pending, so without its own counter an operator only
    # sees queued work and never learns that it is waiting for a re-point.
    parked = db.scalar(
        select(func.count(SyncJob.id))
        .join(Attempt, SyncJob.attempt_id == Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(
            GroupCase.group_id == group_id,
            SyncJob.state == "pending",
            SyncJob.error_kind == "target_changed",
        )
    )
    return {
        "queued": counts.get("pending", 0) + counts.get("running", 0),
        "synced": counts.get("synced", 0),
        "failed": counts.get("failed", 0),
        "uncertain": counts.get("uncertain", 0),
        "parked": int(parked or 0),
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
        .where(
            GroupCase.group_id == group_id,
            Attempt.state == "committed",
            Attempt.source == "execution",
        )
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


def release_uncertain_jobs(db: Session, group_id: UUID) -> int:
    """Requeue jobs parked after an unprovable write.

    Only an administrator who has inspected the destination table may release
    them: when the original create did land, the released job appends a second
    record, so this stays an explicit choice instead of an automatic retry.
    """

    attempt_ids = (
        select(Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id)
    )
    statement = (
        update(SyncJob)
        .where(SyncJob.state == "uncertain", SyncJob.attempt_id.in_(attempt_ids))
        .values(state="pending", retry_count=0, next_retry_at=_now(), error_kind=None)
    )
    result = db.execute(statement)
    db.commit()
    return int(result.rowcount or 0)


def repoint_parked_jobs(db: Session, group_id: UUID) -> int:
    """Re-aim jobs parked by a table switch at the current target.

    Only an administrator who decided that this group's local results belong in
    the new table may run this; nothing re-points itself.
    """

    target = target_for(db, group_id)
    if target is None:
        return 0
    result = db.execute(
        update(SyncJob)
        .where(
            SyncJob.error_kind == "target_changed",
            SyncJob.attempt_id.in_(
                select(Attempt.id)
                .join(GroupCase, Attempt.group_case_id == GroupCase.id)
                .where(GroupCase.group_id == group_id)
            ),
        )
        .values(
            state="pending",
            error_kind=None,
            retry_count=0,
            lease_until=None,
            next_retry_at=_now(),
            target_fingerprint=target.target_fingerprint,
        )
    )
    db.commit()
    return int(result.rowcount or 0)


def running_job_count(db: Session, group_id: UUID) -> int:
    """Jobs a worker holds right now, for the callers that must not race one.

    A rebuild replaces the table a job is writing into, so it waits until no
    row is in flight rather than resetting a job whose create may land in the
    table being replaced.
    """

    return int(
        db.scalar(
            select(func.count(SyncJob.id))
            .join(Attempt, SyncJob.attempt_id == Attempt.id)
            .join(GroupCase, Attempt.group_case_id == GroupCase.id)
            .where(
                GroupCase.group_id == group_id,
                SyncJob.state == "running",
            )
        )
        or 0
    )


def reset_jobs_for_rebuilt_table(
    db: Session, group_id: UUID, *, role: str, fingerprint: str
) -> int:
    """Send one role's rows back through the writer, into a rebuilt table.

    A rebuilt table is empty, so every stored record id of that role points at
    a row in the table being replaced and the row has to be written again. The
    other role's id is left alone: its table did not move, and clearing it
    would append a second record there.

    The caller owns the transaction (the rebuild writes the target in the same
    one), so this deliberately does not commit.
    """

    values: dict[str, Any] = {
        "state": "pending",
        "lease_until": None,
        "retry_count": 0,
        "next_retry_at": _now(),
        "error_kind": None,
        "target_fingerprint": fingerprint,
    }
    values["new_exec_record_id" if role == "execution" else "new_bug_record_id"] = None
    result = db.execute(
        update(SyncJob)
        .where(
            SyncJob.attempt_id.in_(
                select(Attempt.id)
                .join(GroupCase, Attempt.group_case_id == GroupCase.id)
                .where(GroupCase.group_id == group_id)
            )
        )
        .values(**values)
    )
    return int(result.rowcount or 0)


class SyncRetryRequest(BaseModel):
    # Releasing an uncertain job can duplicate a remote record; the flag makes
    # the administrator state that they checked the table first.
    release_uncertain: bool = False


@router.post("/groups/{group_id}/sync/retry")
def retry_sync(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    payload: SyncRetryRequest | None = None,
) -> dict[str, int]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    requeued = retry_failed_jobs(db, group_id)
    repointed = repoint_parked_jobs(db, group_id)
    released = (
        release_uncertain_jobs(db, group_id)
        if payload is not None and payload.release_uncertain
        else 0
    )
    return {"requeued": requeued, "released": released, "repointed": repointed}
