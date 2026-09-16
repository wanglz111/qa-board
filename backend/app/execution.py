from __future__ import annotations

from typing import Annotated, Any, Callable, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.outbox import enqueue_attempt_job
from app.models import Attempt, Group, GroupCase


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# The group-case row lock serialises ordinary callers; the retry covers the
# residual race where two transactions still pick the same sequence or label,
# so a losing request retries instead of surfacing a 500.
MAX_ALLOCATION_ATTEMPTS = 5


class AttemptCreate(BaseModel):
    result: Literal["通过", "不通过", "未执行"]
    note: str | None = None
    console_text: str | None = None
    idempotency_key: str

    @model_validator(mode="after")
    def require_failure_note(self) -> AttemptCreate:
        if self.result == "不通过" and not (self.note and self.note.strip()):
            raise ValueError("note is required for a failed result")
        return self


def _case_or_404(db: Session, group_id: UUID, code: str) -> GroupCase:
    group_case = db.scalar(
        select(GroupCase).where(
            GroupCase.group_id == group_id,
            GroupCase.code == code,
        )
    )
    if group_case is None:
        raise HTTPException(status_code=404, detail="Group case not found")
    return group_case


def _attempt_payload(attempt: Attempt) -> dict[str, Any]:
    return {
        "id": attempt.id,
        "label": attempt.label,
        "sequence": attempt.sequence,
        "state": attempt.state,
        "result": attempt.result,
        "note": attempt.note,
        "console_text": attempt.console_text,
        "created_at": attempt.created_at,
    }


def _matching_attempt(
    db: Session,
    group_case: GroupCase,
    payload: AttemptCreate,
) -> Attempt | None:
    existing = db.scalar(
        select(Attempt).where(Attempt.idempotency_key == payload.idempotency_key)
    )
    if existing is None:
        return None
    if (
        existing.group_case_id != group_case.id
        or existing.state != "committed"
        or existing.result != payload.result
        or existing.note != payload.note
        or existing.console_text != payload.console_text
    ):
        raise HTTPException(status_code=409, detail="Idempotency key conflict")
    return existing


def _locked_case_or_404(db: Session, group_id: UUID, code: str) -> GroupCase:
    group_case = db.scalar(
        select(GroupCase)
        .where(GroupCase.group_id == group_id, GroupCase.code == code)
        .with_for_update()
    )
    if group_case is None:
        raise HTTPException(status_code=404, detail="Group case not found")
    return group_case


def allocate_attempt(
    db: Session, group_case: GroupCase, *, label: str | None = None
) -> Attempt:
    """Reserve the next append-only slot for one case.

    ``sequence`` is always the highest for the case, so the newest committed row
    is the one progress and reports read. ``label`` may be supplied to name an
    adopted row after the record it mirrors, and falls back to the group's own
    retest rule when the name is already taken.
    """

    last_sequence = db.scalar(
        select(func.max(Attempt.sequence)).where(
            Attempt.group_case_id == group_case.id
        )
    )
    sequence = (last_sequence or 0) + 1
    resolved = label or (
        group_case.code
        if sequence == 1
        else f"{group_case.code}-R{group_case.group.short_code}-{sequence - 1:02}"
    )
    attempt = Attempt(
        group_case=group_case,
        label=resolved,
        sequence=sequence,
        state="started",
    )
    db.add(attempt)
    db.flush()
    return attempt


def _reserve_attempt(db: Session, group_case: GroupCase) -> Attempt:
    return allocate_attempt(db, group_case)


def _commit_attempt(attempt: Attempt, payload: AttemptCreate) -> None:
    attempt.state = "committed"
    attempt.result = payload.result
    attempt.note = payload.note
    attempt.console_text = payload.console_text
    attempt.idempotency_key = payload.idempotency_key


def _with_conflict_retry(
    db: Session,
    operation: Callable[[], dict[str, Any]],
    *,
    detail: str = "Could not allocate a unique attempt label",
) -> dict[str, Any]:
    for remaining in range(MAX_ALLOCATION_ATTEMPTS, 0, -1):
        try:
            return operation()
        except IntegrityError as error:
            db.rollback()
            if getattr(error.orig, "sqlstate", None) != "23505":
                raise
            if remaining == 1:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=detail,
                ) from None
    raise AssertionError("unreachable")


@router.post(
    "/groups/{group_id}/cases/{code}/attempts",
    status_code=status.HTTP_201_CREATED,
)
def create_attempt(
    group_id: UUID,
    code: str,
    payload: AttemptCreate,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    def operation() -> dict[str, Any]:
        group_case = _locked_case_or_404(db, group_id, code)
        existing = _matching_attempt(db, group_case, payload)
        if existing is not None:
            return _attempt_payload(existing)
        attempt = _reserve_attempt(db, group_case)
        _commit_attempt(attempt, payload)
        # A confirmed group queues the outbound create in the same transaction
        # as the local attempt, so the two can never disagree.
        enqueue_attempt_job(db, attempt)
        db.commit()
        db.refresh(attempt)
        return _attempt_payload(attempt)

    return _with_conflict_retry(db, operation)


@router.post(
    "/groups/{group_id}/cases/{code}/retest",
    status_code=status.HTTP_201_CREATED,
)
def reserve_retest(
    group_id: UUID,
    code: str,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    def operation() -> dict[str, Any]:
        group_case = _locked_case_or_404(db, group_id, code)
        attempt = _reserve_attempt(db, group_case)
        db.commit()
        db.refresh(attempt)
        return _attempt_payload(attempt)

    return _with_conflict_retry(db, operation)


@router.post("/attempts/{attempt_id}/submit")
def submit_attempt(
    attempt_id: UUID,
    payload: AttemptCreate,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    def operation() -> dict[str, Any]:
        attempt = db.scalar(
            select(Attempt).where(Attempt.id == attempt_id).with_for_update()
        )
        if attempt is None:
            raise HTTPException(status_code=404, detail="Attempt not found")
        existing = _matching_attempt(db, attempt.group_case, payload)
        if existing is not None:
            if existing.id != attempt.id:
                raise HTTPException(
                    status_code=409, detail="Idempotency key conflict"
                )
            return _attempt_payload(existing)
        if attempt.state != "started":
            raise HTTPException(status_code=409, detail="Attempt is already committed")
        _commit_attempt(attempt, payload)
        enqueue_attempt_job(db, attempt)
        db.commit()
        db.refresh(attempt)
        return _attempt_payload(attempt)

    # Two different reserved attempts can be submitted at the same moment with
    # one idempotency key. The loser loses on the global unique constraint, so
    # it re-reads the winner and answers 409 instead of a server error.
    return _with_conflict_retry(db, operation, detail="Idempotency key conflict")


@router.get("/groups/{group_id}/cases/{code}/attempts")
def list_attempts(
    group_id: UUID,
    code: str,
    db: Annotated[Session, Depends(get_db)],
) -> list[dict[str, Any]]:
    group_case = _case_or_404(db, group_id, code)
    attempts = db.scalars(
        select(Attempt)
        .where(
            Attempt.group_case_id == group_case.id,
            Attempt.state == "committed",
        )
        .order_by(Attempt.created_at, Attempt.sequence)
    ).all()
    return [_attempt_payload(attempt) for attempt in attempts]


@router.get("/groups/{group_id}/progress")
def group_progress(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, int]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")

    latest_sequences = (
        select(
            Attempt.group_case_id,
            func.max(Attempt.sequence).label("sequence"),
        )
        .where(Attempt.state == "committed")
        .group_by(Attempt.group_case_id)
        .subquery()
    )
    rows = db.execute(
        select(Attempt.result, func.count(GroupCase.id))
        .select_from(GroupCase)
        .outerjoin(
            latest_sequences,
            latest_sequences.c.group_case_id == GroupCase.id,
        )
        .outerjoin(
            Attempt,
            (Attempt.group_case_id == latest_sequences.c.group_case_id)
            & (Attempt.sequence == latest_sequences.c.sequence),
        )
        .where(GroupCase.group_id == group_id)
        .group_by(Attempt.result)
    ).all()
    progress = {"passed": 0, "failed": 0, "skipped": 0, "untested": 0}
    result_keys = {"通过": "passed", "不通过": "failed", "未执行": "skipped"}
    for result, count in rows:
        progress[result_keys[result] if result is not None else "untested"] = count
    return progress
