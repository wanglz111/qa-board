from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.models import Attempt, Group, GroupCase


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


class AttemptCreate(BaseModel):
    result: Literal["通过", "不通过", "未执行"]
    note: str | None = None
    console_text: str | None = None
    idempotency_key: str


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
    group_case = _case_or_404(db, group_id, code)
    last_sequence = db.scalar(
        select(func.max(Attempt.sequence)).where(
            Attempt.group_case_id == group_case.id
        )
    )
    sequence = (last_sequence or 0) + 1
    attempt = Attempt(
        group_case=group_case,
        label=code if sequence == 1 else f"{code}-{sequence}",
        sequence=sequence,
        state="committed",
        result=payload.result,
        note=payload.note,
        console_text=payload.console_text,
        idempotency_key=payload.idempotency_key,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    return _attempt_payload(attempt)


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
