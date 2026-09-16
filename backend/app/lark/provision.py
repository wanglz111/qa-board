from __future__ import annotations

from typing import Annotated, Any, Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
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
from app.lark.link import SOURCE_ID
from app.lark.target import (
    TargetDraft,
    locked_target_for,
    read_draft_state,
    serialize_target,
    target_for,
)
from app.models import Group


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

PROVISION_VIEW_NAME = "TestDeck"
TABLE_NAME_LIMIT = 100
# A listing failure is the one an administrator can act on: it is a missing
# collaborator, not a bad link.
READ_FIELDS_FAILED = "读取数据表字段失败，请确认应用仍是协作者"


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


def _required_type(name: str) -> int:
    """The type a required header has to be created with."""

    type_id = PROVISION_FIELD_TYPES.get(name)
    if type_id is None:
        # A required header without a type entry is a configuration bug: say so
        # here instead of failing with a bare KeyError.
        raise RuntimeError(f"必填表头「{name}」没有配置字段类型")
    return type_id


def _planned_field(name: str) -> dict[str, Any]:
    type_id = _required_type(name)
    return {
        "name": name,
        "type": type_id,
        "type_name": type_name(type_id),
        "properties": _properties(type_id),
    }


def _table_field(name: str) -> dict[str, Any]:
    type_id = _required_type(name)
    return {
        "field_name": name,
        "type": type_id,
        # Text and attachment fields carry no extra property, and the field
        # guide writes those as null; an empty object is never sent in its place.
        "property": _properties(type_id) or None,
    }


def provision_plan(fields: Iterable[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """The headers that would be added to one role's table, sorted by name.

    A header that already exists with any type is left alone: this never
    rewrites a column the administrator already uses.
    """

    existing = field_types(fields)
    required = ROLE_REQUIRED[role]
    return [
        _planned_field(name) for name in sorted(required) if name not in existing
    ]


def table_fields(role: str) -> list[dict[str, Any]]:
    """The full header set for a brand-new table of one role."""

    return [_table_field(name) for name in sorted(ROLE_REQUIRED[role])]


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


def _read_table_listings(
    client: LarkClient, base_token: str, table_id: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The field and view listings one role's decisions are based on."""

    try:
        return (
            client.list_fields(base_token, table_id),
            client.list_views(base_token, table_id),
        )
    except LarkError as error:
        raise HTTPException(
            status_code=409, detail=f"{READ_FIELDS_FAILED}：{error}"
        ) from None


def _view_state(
    views: Iterable[dict[str, Any]], created_view_id: str | None = None
) -> dict[str, Any]:
    """Whether one table already carries the provisioning view, and its id."""

    existing_id: str | None = None
    for view in views:
        if str(view.get("view_name") or "") == PROVISION_VIEW_NAME:
            existing_id = str(view.get("view_id") or "") or None
            break
    return {
        "name": PROVISION_VIEW_NAME,
        "exists": created_view_id is not None or existing_id is not None,
        "view_id": created_view_id or existing_id,
    }


def _clear_invalidated_approval(db: Session, group_id: UUID, fingerprint: str) -> None:
    """Drop the write approval a real structure change just invalidated.

    Only the row that still is the target this request worked on is cleared: if
    another tab re-pointed the group meanwhile, its approval belongs to the new
    table and has to survive. The lock is taken here alone, for one short
    transaction, exactly like the save and confirm paths do.
    """

    locked = locked_target_for(db, group_id)
    if locked is None or locked.target_fingerprint != fingerprint:
        return
    locked.confirmed_at = None
    db.commit()


@router.get("/groups/{group_id}/lark/provision")
def read_provision_plan(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    target = _require_group_target(db, group_id)
    roles: dict[str, Any] = {}
    views: dict[str, Any] = {}
    for role in ("execution", "bug"):
        base_token, table_id = _role_table(target, role)
        fields, listed_views = _read_table_listings(client, base_token, table_id)
        roles[role] = provision_plan(fields, role)
        views[role] = _view_state(listed_views)
    return {
        "roles": roles,
        # The plan says whether 「TestDeck」 already exists, so nobody is offered
        # a view that is already there.
        "views": views,
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
    """Create the approved missing headers, and 「TestDeck」 when it is absent.

    A repeat of the same request creates nothing: a header is only created when
    the live listing does not carry it, and the view only when the live view
    list does not have it. A run that really changed the table clears the
    group's write approval; a run that created nothing leaves it alone.
    """

    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会创建表头")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    target = _require_group_target(db, group_id)
    # Everything reported or cleared below is decided against this identity: the
    # locked read near the end refreshes the same instance in place, so the
    # fingerprint has to be read out before that happens.
    checked_fingerprint = target.target_fingerprint
    base_token, table_id = _role_table(target, payload.role)
    fields, listed_views = _read_table_listings(client, base_token, table_id)
    planned = {field["name"]: field for field in provision_plan(fields, payload.role)}
    view = _view_state(listed_views)

    created: list[str] = []
    created_view_id: str | None = None
    failure: str | None = None
    try:
        for name in sorted(set(payload.field_names)):
            field = planned.get(name)
            if field is None:
                # Already present or not part of this role's schema: never invent one.
                continue
            client.create_field(
                base_token, table_id, name, field["type"], field["properties"]
            )
            created.append(name)
    except LarkError as error:
        # Lark's own message is safe to show; the request body and the
        # credentials never reach it. Refuse like the table creation does
        # instead of letting the failure become a 500.
        failure = f"创建表头失败：{error}"
    if failure is None and payload.create_view and not view["exists"]:
        try:
            created_view = client.create_view(base_token, table_id, PROVISION_VIEW_NAME)
            created_view_id = str(created_view.get("view_id") or "") or None
        except LarkError as error:
            failure = f"创建视图失败：{error}"

    if failure is not None:
        if created:
            # Half-applied: the table really did change, so the approval that
            # covered the older structure must not survive it. The stored schema
            # fingerprint is left for the confirm path, which re-reads it under
            # its own lock anyway.
            _clear_invalidated_approval(db, group_id, checked_fingerprint)
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "provision_failed",
                "message": failure,
                "created_fields": created,
            },
        )

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

    # One short transaction: the row may have been re-pointed while the Lark
    # requests above ran, and a refreshed schema must never land on a table
    # nobody approved.
    locked = locked_target_for(db, group_id)
    if locked is None or locked.target_fingerprint != checked_fingerprint:
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再设置表头")
    locked.schema_fingerprint = state["schema_fingerprint"]
    if created or created_view_id is not None:
        # A structure change invalidates the earlier write approval.
        locked.confirmed_at = None
    db.commit()
    db.refresh(locked)
    return {
        "created_fields": created,
        "view": {
            **_view_state(listed_views, created_view_id),
            "created": created_view_id is not None,
        },
        "schema_errors": state["schema_errors"],
        "target": serialize_target(locked),
    }


class ProvisionTableRequest(BaseModel):
    role: str
    base_token: str
    table_name: str = Field(min_length=1, max_length=TABLE_NAME_LIMIT)
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
    if SOURCE_ID.match(payload.base_token) is None:
        # The token is interpolated into a bearer-authenticated URL, so a value
        # like ``../../../../wiki/v2/spaces/get_node`` would otherwise choose the
        # endpoint this request hits.
        raise HTTPException(
            status_code=422,
            detail="多维表格标识不是有效的 App Token，请重新读取并粘贴 Lark 链接",
        )
    table_name = payload.table_name.strip()
    if not table_name:
        raise HTTPException(status_code=422, detail="数据表名称不能为空")
    _require_group_target(db, group_id)
    try:
        # A base the app cannot read cannot be created in either; refusing here
        # keeps the failure readable instead of a refusal deep inside the write.
        client.app_metadata(payload.base_token)
    except LarkError as error:
        raise HTTPException(
            status_code=409,
            detail=f"无法读取该多维表格，请确认应用仍是协作者：{error}",
        ) from None
    try:
        table = client.create_table(
            payload.base_token, table_name, table_fields(payload.role)
        )
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"新建数据表失败：{error}") from None
    return {
        "table": {
            "table_id": str(table.get("table_id") or ""),
            "name": str(table.get("name") or table_name),
        },
        "role": payload.role,
    }
