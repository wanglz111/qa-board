from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.lark.client import LarkClient, get_lark_client
from app.lark.history import read_lark_state
from app.models import Attempt, Group, GroupCase, GroupLarkConfirmation


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


class ConfirmationRequest(BaseModel):
    base_token: str
    execution_table_id: str
    bug_table_id: str
    schema_fingerprint: str
    target_fingerprint: str
    allow_writes: bool = False


def _group_or_404(db: Session, group_id: UUID) -> Group:
    group = db.get(Group, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def _confirmation_or_none(db: Session, group_id: UUID) -> GroupLarkConfirmation | None:
    return db.scalar(
        select(GroupLarkConfirmation).where(GroupLarkConfirmation.group_id == group_id)
    )


def _current_targets(state: dict[str, Any]) -> dict[str, str | None]:
    return {
        "base_token": settings.lark_app_token or None,
        "execution_table_id": settings.lark_table_runs or None,
        "bug_table_id": settings.lark_table_defects or None,
        "schema_fingerprint": state.get("schema_fingerprint"),
        "target_fingerprint": state.get("target_fingerprint"),
        "base_name": state.get("base_name"),
        "execution_table_name": state.get("execution_table_name"),
        "bug_table_name": state.get("bug_table_name"),
    }


def _matches(confirmation: GroupLarkConfirmation, targets: dict[str, str | None]) -> bool:
    return (
        confirmation.base_token == targets["base_token"]
        and confirmation.execution_table_id == targets["execution_table_id"]
        and confirmation.bug_table_id == targets["bug_table_id"]
        and confirmation.schema_fingerprint == targets["schema_fingerprint"]
        and confirmation.target_fingerprint == targets["target_fingerprint"]
    )


def _serialize(
    confirmation: GroupLarkConfirmation | None, *, valid: bool
) -> dict[str, Any] | None:
    if confirmation is None:
        return None
    return {
        "group_id": confirmation.group_id,
        "base_token": confirmation.base_token,
        "execution_table_id": confirmation.execution_table_id,
        "bug_table_id": confirmation.bug_table_id,
        "base_name": confirmation.base_name,
        "execution_table_name": confirmation.execution_table_name,
        "bug_table_name": confirmation.bug_table_name,
        "schema_fingerprint": confirmation.schema_fingerprint,
        "target_fingerprint": confirmation.target_fingerprint,
        "confirmed_at": confirmation.confirmed_at,
        "valid": valid,
    }


@router.get("/groups/{group_id}/lark/confirmation")
def read_confirmation(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _group_or_404(db, group_id)
    state = read_lark_state(client)
    confirmation = _confirmation_or_none(db, group_id)
    valid = confirmation is not None and _matches(confirmation, _current_targets(state))
    return {
        "confirmed": valid,
        "confirmation": _serialize(confirmation, valid=valid),
        "current": {
            **_current_targets(state),
            "schema_errors": state["schema_errors"],
            "read_errors": state["read_errors"],
            "state": state,
        },
    }


@router.post("/groups/{group_id}/lark/confirm")
def confirm_group_target(
    group_id: UUID,
    payload: ConfirmationRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _group_or_404(db, group_id)
    if not payload.allow_writes:
        raise HTTPException(
            status_code=409, detail="需勾选允许向旧表新增本组记录"
        )

    state = read_lark_state(client)
    if state["read_errors"]:
        raise HTTPException(
            status_code=409, detail="；".join(state["read_errors"])
        )
    if state["schema_errors"]:
        raise HTTPException(status_code=409, detail="；".join(state["schema_errors"]))

    targets = _current_targets(state)
    expected = {
        "base_token": payload.base_token,
        "execution_table_id": payload.execution_table_id,
        "bug_table_id": payload.bug_table_id,
        "schema_fingerprint": payload.schema_fingerprint,
        "target_fingerprint": payload.target_fingerprint,
    }
    if any(targets.get(key) != value for key, value in expected.items()):
        raise HTTPException(
            status_code=409,
            detail="Lark 目标表或字段已变化，请重新读取后再确认",
        )

    confirmation = _confirmation_or_none(db, group_id)
    if confirmation is None:
        confirmation = GroupLarkConfirmation(group_id=group_id)
        db.add(confirmation)
    confirmation.base_token = targets["base_token"] or ""
    confirmation.execution_table_id = targets["execution_table_id"] or ""
    confirmation.bug_table_id = targets["bug_table_id"] or ""
    confirmation.base_name = str(state["base_name"] or "")
    confirmation.execution_table_name = str(state["execution_table_name"] or "")
    confirmation.bug_table_name = str(state["bug_table_name"] or "")
    confirmation.schema_fingerprint = str(targets["schema_fingerprint"] or "")
    confirmation.target_fingerprint = str(targets["target_fingerprint"] or "")
    confirmation.confirmed_at = datetime.now().astimezone()
    db.commit()
    db.refresh(confirmation)
    return _serialize(confirmation, valid=True) or {}
