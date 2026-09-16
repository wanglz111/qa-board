from __future__ import annotations

from typing import Annotated, Any, Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    field_types,
    type_name,
)
from app.lark.target import TargetDraft, read_draft_state, serialize_target, target_for
from app.models import Group


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


ROLE_REQUIRED = {
    "execution": REQUIRED_RUN_FIELD_TYPES,
    "bug": REQUIRED_BUG_FIELD_TYPES,
}

# Every created header is a plain type the writer can already fill. 结果/优先级
# stay text instead of single-select so no option vocabulary has to be guessed,
# and 日期/截图 must be their real types or the writer cannot fill them.
PROVISION_FIELD_TYPES: dict[str, int] = {
    "用例": 1,
    "结果": 1,
    "优先级": 1,
    "负责人": 1,
    "报告人": 1,
    "日期": 5,
    "截图": 17,
    "控制台": 1,
    "问题描述": 1,
    "进展状态": 1,
    "反馈时间": 5,
    "备注": 1,
    "反馈人": 1,
}


def _properties(type_id: int) -> dict[str, Any]:
    if type_id == 5:
        return {"date_formatter": "yyyy/MM/dd", "auto_fill": False}
    return {}


def provision_plan(fields: Iterable[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """The headers that would be added to one role's table, sorted by name.

    A header that already exists with any type is left alone: this never
    rewrites a column the administrator already uses.
    """

    existing = field_types(fields)
    required = ROLE_REQUIRED[role]
    return [
        {
            "name": name,
            "type": PROVISION_FIELD_TYPES[name],
            "type_name": type_name(PROVISION_FIELD_TYPES[name]),
            "properties": _properties(PROVISION_FIELD_TYPES[name]),
        }
        for name in sorted(required)
        if name not in existing
    ]


def table_fields(role: str) -> list[dict[str, Any]]:
    """The full header set for a brand-new table of one role."""

    return [
        {
            "field_name": name,
            "type": PROVISION_FIELD_TYPES[name],
            "property": _properties(PROVISION_FIELD_TYPES[name]),
        }
        for name in sorted(ROLE_REQUIRED[role])
    ]


def _role_table(target, role: str) -> tuple[str, str]:
    if role == "execution":
        return target.execution_base_token, target.execution_table_id
    return target.bug_base_token, target.bug_table_id


def _require_group_target(db: Session, group_id: UUID):
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    target = target_for(db, group_id)
    if target is None:
        raise HTTPException(status_code=409, detail="尚未选择该组的 Lark 表")
    return target


@router.get("/groups/{group_id}/lark/provision")
def read_provision_plan(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    target = _require_group_target(db, group_id)
    roles: dict[str, Any] = {}
    for role in ("execution", "bug"):
        base_token, table_id = _role_table(target, role)
        fields = client.list_fields(base_token, table_id)
        roles[role] = provision_plan(fields, role)
    return {
        "roles": roles,
        "target": serialize_target(target),
    }


class ProvisionFieldsRequest(BaseModel):
    role: str
    field_names: list[str]
    create_view: bool = False
    acknowledge: bool = False


@router.post("/groups/{group_id}/lark/provision/fields")
def provision_fields(
    group_id: UUID,
    payload: ProvisionFieldsRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会创建表头")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    target = _require_group_target(db, group_id)
    base_token, table_id = _role_table(target, payload.role)
    planned = {field["name"]: field for field in provision_plan(
        client.list_fields(base_token, table_id), payload.role
    )}
    created: list[str] = []
    for name in sorted(set(payload.field_names)):
        field = planned.get(name)
        if field is None:
            # Already present or not part of this role's schema: never invent one.
            continue
        client.create_field(base_token, table_id, name, field["type"], field["properties"])
        created.append(name)
    if payload.create_view:
        client.create_view(base_token, table_id, "TestDeck")
    try:
        state = read_draft_state(
            client,
            TargetDraft(
                execution_base_token=target.execution_base_token,
                execution_table_id=target.execution_table_id,
                execution_view_id=target.execution_view_id,
                bug_base_token=target.bug_base_token,
                bug_table_id=target.bug_table_id,
            ),
        )
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    target.schema_fingerprint = state["schema_fingerprint"]
    # A structure change invalidates the earlier write approval.
    target.confirmed_at = None
    db.commit()
    db.refresh(target)
    return {
        "created_fields": created,
        "schema_errors": state["schema_errors"],
        "target": serialize_target(target),
    }


class ProvisionTableRequest(BaseModel):
    role: str
    base_token: str
    table_name: str
    acknowledge: bool = False


@router.post("/groups/{group_id}/lark/provision/table")
def provision_table(
    group_id: UUID,
    payload: ProvisionTableRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会新建数据表")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    _require_group_target(db, group_id)
    try:
        table = client.create_table(
            payload.base_token, payload.table_name, table_fields(payload.role)
        )
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"新建数据表失败：{error}") from None
    return {
        "table": {
            "table_id": str(table.get("table_id") or ""),
            "name": str(table.get("name") or payload.table_name),
        },
        "role": payload.role,
    }
