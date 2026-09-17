from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, Iterable
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark import cache as lark_cache
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    BUG_PRIORITY_OPTIONS,
    BUG_STATUS_OPTIONS,
    DATE_PROPERTY,
    PASS_RESULT_OPTIONS,
    PERSON_PROPERTY,
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    RUN_PRIORITY_OPTIONS,
    field_types,
    type_name,
)
from app.lark.link import SOURCE_ID
from app.lark.outbox import reset_jobs_for_rebuilt_table, running_job_count
from app.lark.target import (
    TargetDraft,
    record_target_revision,
    locked_target_for,
    read_draft_state,
    serialize_target,
    target_for,
)
from app.models import Group


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

PROVISION_VIEW_NAME = "TestDeck"
TABLE_NAME_LIMIT = 100
# What a rebuilt table is called beside the one it replaces. The old table is
# never deleted by this tool, so the two have to be told apart at a glance.
REBUILD_SUFFIX = "（表头修正）"
# A listing failure is the one an administrator can act on: it is a missing
# collaborator, not a bad link.
READ_FIELDS_FAILED = "读取数据表字段失败，请确认应用仍是协作者"


ROLE_REQUIRED = {
    "execution": REQUIRED_RUN_FIELD_TYPES,
    "bug": REQUIRED_BUG_FIELD_TYPES,
}


def _select(options: Iterable[str]) -> dict[str, Any]:
    # The option ids are Lark's to mint: the create-field body only names them.
    return {"options": [{"name": name} for name in options]}


@dataclass(frozen=True)
class FieldSpec:
    """How one header has to be created, and what "already correct" means."""

    type_id: int
    # Named ``properties`` (not ``property``): a dataclass field called
    # ``property`` would shadow the builtin inside this class body and break
    # the ``type_name`` accessor below.
    properties: dict[str, Any] | None = None

    @property
    def type_name(self) -> str:
        return type_name(self.type_id)

    def matches(self, existing: dict[str, Any]) -> bool:
        """Whether a live header already is this header.

        The type is the whole contract: Lark mints its own option ids and may
        carry extra keys, so comparing properties would report a false
        difference for a column that is already right.
        """

        return int(existing.get("type") or 0) == self.type_id


# A header's type per role. 结果/优先级/进展状态 are single-select with the same
# vocabulary a person picks from in Lark, 反馈人 is a person column, and 截图 is
# an attachment. Leaving them text is what made the generated tables unreadable
# next to the hand-built ones.
#
# The order is load-bearing: a new table is created from these headers in this
# order, and it is the column order of the reference table the team fills by
# hand (用例 first and primary, then the result, the priority, the owner, the
# screenshot, the console, the reporter, the date / 问题描述 first and primary,
# then the status, the assignee, the priority, the screenshot, the reporter,
# the reported time, the remark). Sorting these names instead is what made the
# generated headers come out 优先级/反馈人/反馈时间/… — nothing like the table
# beside them.
RUN_SCHEMA: dict[str, FieldSpec] = {
    "用例": FieldSpec(1),
    "结果": FieldSpec(3, _select(PASS_RESULT_OPTIONS)),
    "优先级": FieldSpec(3, _select(RUN_PRIORITY_OPTIONS)),
    "负责人": FieldSpec(1),
    "截图": FieldSpec(17),
    "控制台": FieldSpec(1),
    "报告人": FieldSpec(1),
    "日期": FieldSpec(5, DATE_PROPERTY),
}

BUG_SCHEMA: dict[str, FieldSpec] = {
    "问题描述": FieldSpec(1),
    "进展状态": FieldSpec(3, _select(BUG_STATUS_OPTIONS)),
    "跟进人": FieldSpec(11, PERSON_PROPERTY),
    "优先级": FieldSpec(3, _select(BUG_PRIORITY_OPTIONS)),
    "截图": FieldSpec(17),
    "反馈人": FieldSpec(11, PERSON_PROPERTY),
    "反馈时间": FieldSpec(5, DATE_PROPERTY),
    "备注": FieldSpec(1),
}

ROLE_SCHEMA: dict[str, dict[str, FieldSpec]] = {
    "execution": RUN_SCHEMA,
    "bug": BUG_SCHEMA,
}


def schema_order(role: str) -> list[str]:
    """The required headers of one role, in the reference table's column order."""

    required = ROLE_REQUIRED[role]
    schema = ROLE_SCHEMA[role]
    for name in sorted(required):
        if name not in schema:
            # A required header without a spec is a configuration bug: say so
            # here instead of quietly leaving the column out of the plan.
            raise RuntimeError(f"必填表头「{name}」没有配置字段类型")
    return [name for name in schema if name in required]

# The type each header is created with, flattened for the callers that only need
# the id: the field guide, the tests and the loud configuration check.
PROVISION_FIELD_TYPES: dict[str, int] = {
    name: spec.type_id
    for schema in ROLE_SCHEMA.values()
    for name, spec in schema.items()
}


def _required_spec(role: str, name: str) -> FieldSpec:
    """The spec a required header of this role has to be created from."""

    spec = ROLE_SCHEMA[role].get(name)
    if spec is None:
        # A required header without a spec is a configuration bug: say so here
        # instead of failing with a bare KeyError.
        raise RuntimeError(f"必填表头「{name}」没有配置字段类型")
    return spec


def _planned_field(role: str, name: str) -> dict[str, Any]:
    spec = _required_spec(role, name)
    return {
        "name": name,
        "type": spec.type_id,
        "type_name": spec.type_name,
        "properties": dict(spec.properties or {}),
    }


def _table_field(role: str, name: str) -> dict[str, Any]:
    spec = _required_spec(role, name)
    return {
        "field_name": name,
        "type": spec.type_id,
        # Text and attachment fields carry no extra property, and the field
        # guide writes those as null; an empty object is never sent in its place.
        "property": dict(spec.properties) if spec.properties else None,
    }


def field_id_of(fields: Iterable[dict[str, Any]], name: str) -> str | None:
    """The live field id of one header, so a repair can address it."""

    for field in fields:
        if str(field.get("field_name") or "") == name:
            field_id = field.get("field_id")
            return str(field_id) if field_id else None
    return None


def retype_plan(fields: Iterable[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """The existing headers of this role that carry the wrong type.

    A header this tool created as text before the schema was known is the case
    this exists for: the column is real and may already hold data, so it is only
    converted when an administrator asks for it.
    """

    rows = list(fields)
    existing = {str(field.get("field_name")): field for field in rows}
    repaired: list[dict[str, Any]] = []
    for name in schema_order(role):
        spec = ROLE_SCHEMA[role][name]
        field = existing.get(name)
        if field is None or spec.matches(field):
            continue
        current = int(field.get("type") or 0)
        repaired.append(
            {
                "name": name,
                "type": spec.type_id,
                "type_name": spec.type_name,
                "field_id": field_id_of(rows, name),
                "current_type": current,
                "current_type_name": type_name(current),
                "properties": dict(spec.properties or {}),
            }
        )
    return repaired


def provision_plan(fields: Iterable[dict[str, Any]], role: str) -> list[dict[str, Any]]:
    """The headers that would be added to one role's table, in schema order.

    A header that already exists with any type is left alone: this never
    rewrites a column the administrator already uses.
    """

    existing = field_types(fields)
    return [
        _planned_field(role, name)
        for name in schema_order(role)
        if name not in existing
    ]


def table_fields(role: str) -> list[dict[str, Any]]:
    """The full header set for a brand-new table of one role."""

    return [_table_field(role, name) for name in schema_order(role)]


def _role_table(target, role: str) -> tuple[str, str]:
    if role == "execution":
        return target.execution_base_token, target.execution_table_id
    return target.bug_base_token, target.bug_table_id


def _target_draft(target) -> TargetDraft:
    return TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )


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
    repairs: dict[str, Any] = {}
    views: dict[str, Any] = {}
    for role in ("execution", "bug"):
        base_token, table_id = _role_table(target, role)
        fields, listed_views = _read_table_listings(client, base_token, table_id)
        roles[role] = provision_plan(fields, role)
        repairs[role] = retype_plan(fields, role)
        views[role] = _view_state(listed_views)
    return {
        "roles": roles,
        # A header that already exists with the wrong type is reported here
        # instead of being invented or silently rewritten: it may already hold
        # data, so converting it stays the administrator's decision.
        "retype": repairs,
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
        # Created in schema order, so asking for several headers at once still
        # leaves the table reading like the reference one.
        requested = set(payload.field_names)
        for name in schema_order(payload.role):
            if name not in requested:
                continue
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
            # The header is really there even though this request refuses, so the
            # snapshot of this role's table goes with it. Two arguments rather
            # than invalidate_group: when another tab re-pointed the group
            # mid-request, _clear_invalidated_approval deliberately left the
            # stored row alone, and invalidate_group would resolve to that new
            # target's tables — none of which this request ever read.
            lark_cache.invalidate(base_token, table_id)
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
    # A header this request just added is part of what the snapshot describes,
    # and the live schema read above is newer than anything already cached.
    lark_cache.invalidate_group(db, group_id)
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


class RetypeFieldsRequest(BaseModel):
    role: str
    field_names: list[str]
    acknowledge: bool = False


@router.post("/groups/{group_id}/lark/provision/retype")
def retype_fields(
    group_id: UUID,
    payload: RetypeFieldsRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    """Convert the approved headers that exist with the wrong type.

    A column this tool created as plain text before the schema was known is the
    case this exists for. It is never rewritten on its own: the live type is
    re-read here, and only a header that really is wrong *and* was ticked is
    converted. A run that changed anything clears the group's write approval,
    exactly like creating a header does.
    """

    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会修正表头类型")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    target = _require_group_target(db, group_id)
    checked_fingerprint = target.target_fingerprint
    base_token, table_id = _role_table(target, payload.role)
    fields, _views = _read_table_listings(client, base_token, table_id)
    planned = {field["name"]: field for field in retype_plan(fields, payload.role)}

    retyped: list[str] = []
    failure: str | None = None
    try:
        requested = set(payload.field_names)
        for name in schema_order(payload.role):
            if name not in requested:
                continue
            field = planned.get(name)
            # A header that is already correct, or is not part of this role's
            # schema, is never touched: only the plan may be acted on.
            if field is None or not field.get("field_id"):
                continue
            client.update_field(
                base_token,
                table_id,
                str(field["field_id"]),
                name=name,
                type_id=int(field["type"]),
                properties=field.get("properties") or None,
            )
            retyped.append(name)
    except LarkError as error:
        failure = f"修正表头类型失败：{error}"

    if failure is not None:
        if retyped:
            # Half-applied: the table really did change, so the approval that
            # covered the older structure must not survive it.
            _clear_invalidated_approval(db, group_id, checked_fingerprint)
            # ...and neither may the snapshot of that table, for the same reason
            # the fields path above gives: a column really was converted before
            # this request refused, and the role's own key is what is now stale.
            lark_cache.invalidate(base_token, table_id)
        raise HTTPException(
            status_code=409,
            detail={
                "reason": "provision_failed",
                "message": failure,
                "created_fields": retyped,
            },
        )

    try:
        state = read_draft_state(client, _target_draft(target))
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None

    locked = locked_target_for(db, group_id)
    if locked is None or locked.target_fingerprint != checked_fingerprint:
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再修正表头")
    locked.schema_fingerprint = state["schema_fingerprint"]
    if retyped:
        locked.confirmed_at = None
    db.commit()
    # A retype changes a column's type, so every snapshot of this table is stale.
    lark_cache.invalidate_group(db, group_id)
    db.refresh(locked)
    return {
        "retyped_fields": retyped,
        "schema_errors": state["schema_errors"],
        "target": serialize_target(locked),
    }


class ProvisionTableRequest(BaseModel):
    role: str
    base_token: str
    table_name: str = Field(min_length=1, max_length=TABLE_NAME_LIMIT)
    acknowledge: bool = False


class RebuildTableRequest(BaseModel):
    role: str
    acknowledge: bool = False


def rebuilt_table_name(name: str) -> str:
    """What the replacement for a table called ``name`` is called."""

    return f"{name or '数据表'}{REBUILD_SUFFIX}"[:TABLE_NAME_LIMIT]


@router.post("/groups/{group_id}/lark/provision/rebuild")
def rebuild_table(
    group_id: UUID,
    payload: RebuildTableRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    """Rebuild one role's table in the reference layout and re-file its rows.

    A table this tool built before the schema was known cannot be brought in
    line in place. Lark mints a column where it lands and takes the primary
    column from whichever field was created first, and neither the order nor
    the primary can be edited through the API — so an alphabetically created
    table stays 「优先级 first, 用例 nowhere near it」 however many columns are
    converted afterwards. The only route back to the layout the team fills by
    hand is a new table:

    * it is created with the reference headers, in the reference order, so
      「用例」/「问题描述」 is the first and primary column;
    * the group is pointed at it, which drops the write approval — the
      administrator re-confirms the same way a re-pointed target always is;
      rebuilding both roles one after the other is an ordinary thing to do, so
      the second rebuild is allowed even though the first one already cleared
      that approval (nothing is written into an unapproved table anyway);
    * every local result of that role is re-queued, so its row is written
      again by the current writer: right types, the screenshot, and the
      marker-free wording.

    The replaced table is left exactly where it is. Deleting a table is not
    something this tool does, and the administrator can compare the two before
    removing the old one by hand.
    """

    if not payload.acknowledge:
        raise HTTPException(status_code=409, detail="需确认后才会重建数据表")
    if payload.role not in ROLE_REQUIRED:
        raise HTTPException(status_code=422, detail="未知的表角色")
    target = _require_group_target(db, group_id)
    if running_job_count(db, group_id) > 0:
        # A job in flight is writing into the table this call is about to
        # replace, and its create may land after the stored id was cleared.
        raise HTTPException(status_code=409, detail="有记录正在同步，请稍后再重建")

    checked_fingerprint = target.target_fingerprint
    base_token, table_id = _role_table(target, payload.role)
    try:
        tables = client.list_tables(base_token)
    except LarkError as error:
        raise HTTPException(
            status_code=409, detail=f"无法读取该多维表格，请确认应用仍是协作者：{error}"
        ) from None
    current_name = next(
        (
            str(table.get("name") or "")
            for table in tables
            if str(table.get("table_id") or "") == table_id
        ),
        "",
    )
    if not current_name:
        raise HTTPException(
            status_code=409,
            detail=f"Lark 中找不到 {table_id} 这张数据表，请重新读取目标表",
        )

    new_name = rebuilt_table_name(current_name)
    try:
        table = client.create_table(base_token, new_name, table_fields(payload.role))
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"重建数据表失败：{error}") from None
    new_table_id = str(table.get("table_id") or "")
    if not new_table_id:
        raise HTTPException(status_code=409, detail="重建数据表失败：Lark 没有返回数据表 id")
    new_table_name = str(table.get("name") or new_name)

    draft = TargetDraft(
        execution_base_token=(
            base_token if payload.role == "execution" else target.execution_base_token
        ),
        execution_table_id=(
            new_table_id if payload.role == "execution" else target.execution_table_id
        ),
        # The recorded view belongs to the table being replaced; the new table
        # offers its own, and keeping a stale id would filter by nothing.
        execution_view_id=(
            None if payload.role == "execution" else target.execution_view_id
        ),
        bug_base_token=(
            base_token if payload.role == "bug" else target.bug_base_token
        ),
        bug_table_id=new_table_id if payload.role == "bug" else target.bug_table_id,
    )
    # Read before the lock, exactly like the save path: up to six Lark requests
    # do not belong inside a transaction that holds a row lock.
    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None

    locked = locked_target_for(db, group_id)
    if locked is None or locked.target_fingerprint != checked_fingerprint:
        # Another tab re-pointed the group while the new table was being built.
        # Its table is not this request's, so this one changes nothing.
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再重建")
    if payload.role == "execution":
        locked.execution_base_token = base_token
        locked.execution_base_name = state["execution_base_name"]
        locked.execution_table_id = new_table_id
        locked.execution_table_name = state["execution_table_name"] or ""
        locked.execution_view_id = None
        locked.execution_view_name = None
    else:
        locked.bug_base_token = base_token
        locked.bug_base_name = state["bug_base_name"]
        locked.bug_table_id = new_table_id
        locked.bug_table_name = state["bug_table_name"] or ""
    locked.schema_fingerprint = state["schema_fingerprint"]
    locked.target_fingerprint = draft.fingerprint
    locked.selected_at = datetime.now(timezone.utc)
    # A rebuilt destination can never inherit the approval of the table it
    # replaces, and the rows about to move were written under that approval.
    locked.confirmed_at = None
    db.add(locked)
    record_target_revision(db, group_id, draft)
    requeued = reset_jobs_for_rebuilt_table(
        db, group_id, role=payload.role, fingerprint=draft.fingerprint
    )
    db.commit()
    # A rebuild replaces the table entirely: the old table's snapshot must not
    # answer a read of the new one.
    lark_cache.invalidate_group(db, group_id)
    db.refresh(locked)
    return {
        "role": payload.role,
        "table": {"table_id": new_table_id, "name": new_table_name},
        "replaced": {"table_id": table_id, "name": current_name},
        "requeued": requeued,
        "schema_errors": state["schema_errors"],
        "target": serialize_target(locked),
    }


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
    # The table did not reach this group's target yet. What it did change is its
    # base's listing, and a cached names payload for this group may describe that
    # base, so drop it rather than serve a listing the next read would outgrow.
    lark_cache.invalidate_group(db, group_id)
    return {
        "table": {
            "table_id": str(table.get("table_id") or ""),
            "name": str(table.get("name") or table_name),
        },
        "role": payload.role,
    }
