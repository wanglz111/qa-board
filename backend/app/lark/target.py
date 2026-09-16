from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    describe_fields,
    missing_required_fields,
    schema_fingerprint,
)
from app.lark.link import LarkLinkError, parse_lark_link
from app.models import Group, LarkTarget, LarkTargetRevision


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


@dataclass(frozen=True)
class TargetDraft:
    execution_base_token: str
    execution_table_id: str
    execution_view_id: str | None
    bug_base_token: str
    bug_table_id: str

    @property
    def fingerprint(self) -> str:
        return "|".join(
            [
                self.execution_base_token,
                self.execution_table_id,
                self.bug_base_token,
                self.bug_table_id,
            ]
        )


def _table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id")) == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def resolve_link(client: LarkClient, url: str) -> dict[str, Any]:
    """Turn a pasted link into one base plus its selectable tables.

    Read-only: a wiki node lookup, the base metadata and the table/field
    listings are the only requests.
    """

    try:
        link = parse_lark_link(url)
    except LarkLinkError as error:
        raise LookupError(str(error)) from None

    base_token = link.source_id
    if link.kind == "wiki":
        try:
            node = client.wiki_node(link.source_id)
        except LarkError:
            raise PermissionError(
                "无法读取该 wiki 文档，请把 Lark 应用加为文档协作者后重试"
            ) from None
        if str(node.get("obj_type")) != "bitable":
            raise LookupError("该链接指向的不是多维表格")
        base_token = str(node.get("obj_token") or "")
        if not base_token:
            raise LookupError("该 wiki 文档没有关联多维表格")

    try:
        base = client.app_metadata(base_token)
        tables = client.list_tables(base_token)
    except LarkError as error:
        raise PermissionError(f"无法读取多维表格：{error}") from None

    selected = link.table_id if _table_name(tables, link.table_id or "") else None
    selected = selected or (str(tables[0].get("table_id")) if tables else None)
    fields = client.list_fields(base_token, selected) if selected else []

    return {
        "source_url": url,
        "host": link.host,
        "base_token": base_token,
        "base_name": str((base.get("app") or {}).get("name") or ""),
        "tables": [
            {
                "table_id": str(table.get("table_id")),
                "name": str(table.get("name") or ""),
            }
            for table in tables
        ],
        "selected": {
            "table_id": selected,
            "table_name": _table_name(tables, selected or ""),
            "view_id": link.view_id,
            "view_name": None,
        },
        "execution_fields": describe_fields(fields),
        "required_execution_fields": sorted(REQUIRED_RUN_FIELD_TYPES),
        "schema_errors": missing_required_fields(fields, REQUIRED_RUN_FIELD_TYPES),
        "read_errors": [],
    }


def read_draft_state(client: LarkClient, draft: TargetDraft) -> dict[str, Any]:
    """Read both tables' live names and fields; never returns credentials."""

    execution_base = client.app_metadata(draft.execution_base_token)
    bug_base = client.app_metadata(draft.bug_base_token)
    execution_tables = client.list_tables(draft.execution_base_token)
    bug_tables = client.list_tables(draft.bug_base_token)
    execution_fields = client.list_fields(
        draft.execution_base_token, draft.execution_table_id
    )
    bug_fields = client.list_fields(draft.bug_base_token, draft.bug_table_id)

    execution_table_name = _table_name(execution_tables, draft.execution_table_id)
    bug_table_name = _table_name(bug_tables, draft.bug_table_id)
    read_errors: list[str] = []
    if execution_table_name is None:
        read_errors.append(f"Lark 中找不到执行记录表 {draft.execution_table_id}")
    if bug_table_name is None:
        read_errors.append(f"Lark 中找不到缺陷表 {draft.bug_table_id}")

    schema_errors = missing_required_fields(execution_fields, REQUIRED_RUN_FIELD_TYPES)
    schema_errors += missing_required_fields(bug_fields, REQUIRED_BUG_FIELD_TYPES)
    return {
        "execution_base_name": str((execution_base.get("app") or {}).get("name") or ""),
        "execution_table_name": execution_table_name,
        "bug_base_name": str((bug_base.get("app") or {}).get("name") or ""),
        "bug_table_name": bug_table_name,
        "execution_fields": describe_fields(execution_fields),
        "bug_fields": describe_fields(bug_fields),
        "schema_errors": schema_errors,
        "read_errors": read_errors,
        "schema_fingerprint": (
            None
            if schema_errors
            else f"{schema_fingerprint(execution_fields)}||{schema_fingerprint(bug_fields)}"
        ),
    }


def target_diff(previous: LarkTarget | None, draft: TargetDraft) -> dict[str, Any]:
    """Which identity parts differ from the stored target."""

    next_identity = {
        "execution_base_token": draft.execution_base_token,
        "execution_table_id": draft.execution_table_id,
        "bug_base_token": draft.bug_base_token,
        "bug_table_id": draft.bug_table_id,
    }
    if previous is None:
        return {
            "changed": False,
            "changed_keys": [],
            "previous": None,
            "next": next_identity,
        }
    previous_identity = {key: getattr(previous, key) for key in next_identity}
    changed_keys = sorted(
        key for key, value in next_identity.items() if previous_identity[key] != value
    )
    return {
        "changed": bool(changed_keys),
        "changed_keys": changed_keys,
        "previous": previous_identity,
        "next": next_identity,
    }


class ResolveRequest(BaseModel):
    url: str


@router.post("/lark/resolve")
def resolve(
    payload: ResolveRequest,
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    try:
        return resolve_link(client, payload.url)
    except LookupError as error:
        raise HTTPException(status_code=422, detail=str(error)) from None
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from None


def target_for(
    db: Session, group_id: UUID, *, for_update: bool = False
) -> LarkTarget | None:
    """The group's stored target; ``for_update`` locks the row for a save."""

    query = select(LarkTarget).where(LarkTarget.group_id == group_id)
    return db.scalar(query.with_for_update() if for_update else query)


def _record_revision(db: Session, group_id: UUID, draft: TargetDraft) -> None:
    """Log a target the group has never used before; repeats are not new rows."""

    existing = db.scalar(
        select(LarkTargetRevision).where(
            LarkTargetRevision.group_id == group_id,
            LarkTargetRevision.target_fingerprint == draft.fingerprint,
        )
    )
    if existing is None:
        db.add(
            LarkTargetRevision(
                group_id=group_id,
                execution_base_token=draft.execution_base_token,
                execution_table_id=draft.execution_table_id,
                bug_base_token=draft.bug_base_token,
                bug_table_id=draft.bug_table_id,
                target_fingerprint=draft.fingerprint,
            )
        )


def serialize_target(target: LarkTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {
        "group_id": target.group_id,
        "source_url": target.source_url,
        "execution_base_token": target.execution_base_token,
        "execution_base_name": target.execution_base_name,
        "execution_table_id": target.execution_table_id,
        "execution_table_name": target.execution_table_name,
        "execution_view_id": target.execution_view_id,
        "execution_view_name": target.execution_view_name,
        "bug_base_token": target.bug_base_token,
        "bug_base_name": target.bug_base_name,
        "bug_table_id": target.bug_table_id,
        "bug_table_name": target.bug_table_name,
        "schema_fingerprint": target.schema_fingerprint,
        "target_fingerprint": target.target_fingerprint,
        "selected_at": target.selected_at,
        "confirmed_at": target.confirmed_at,
        "confirmed": target.confirmed_at is not None,
    }


class TargetRequest(BaseModel):
    source_url: str = ""
    execution_base_token: str
    execution_table_id: str
    execution_view_id: str | None = None
    bug_base_token: str
    bug_table_id: str
    # The client sends the fingerprint it saw, so a concurrent tab that already
    # moved the group is rejected instead of silently overwriting it.
    expected_previous_fingerprint: str | None = None
    acknowledge_change: bool = False


def _draft_from(payload: TargetRequest) -> TargetDraft:
    return TargetDraft(
        execution_base_token=payload.execution_base_token,
        execution_table_id=payload.execution_table_id,
        execution_view_id=payload.execution_view_id,
        bug_base_token=payload.bug_base_token,
        bug_table_id=payload.bug_table_id,
    )


def _require_group(db: Session, group_id: UUID) -> None:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")


@router.get("/groups/{group_id}/lark/target")
def read_target(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    target = target_for(db, group_id)
    if target is None:
        return {"target": None, "live": None, "read_errors": []}
    draft = TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )
    try:
        live = read_draft_state(client, draft)
    except LarkError as error:
        return {
            "target": serialize_target(target),
            "live": None,
            "read_errors": [str(error)],
        }
    return {
        "target": serialize_target(target),
        "live": live,
        "read_errors": live["read_errors"],
    }


@router.put("/groups/{group_id}/lark/target")
def save_target(
    group_id: UUID,
    payload: TargetRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    draft = _draft_from(payload)
    # The row is locked for this whole transaction so two tabs cannot both pass
    # the acknowledgement check and race to overwrite each other.
    previous = target_for(db, group_id, for_update=True)
    diff = target_diff(previous, draft)
    if diff["changed"]:
        if not payload.acknowledge_change:
            raise HTTPException(
                status_code=409, detail={"reason": "target_changed", "diff": diff}
            )
        # A fingerprint the page did not read from the stored target is stale:
        # another tab moved this group after the page was loaded.
        if (
            payload.expected_previous_fingerprint is not None
            and payload.expected_previous_fingerprint != previous.target_fingerprint
        ):
            raise HTTPException(
                status_code=409, detail={"reason": "stale_page", "diff": diff}
            )

    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    if state["read_errors"]:
        raise HTTPException(status_code=409, detail="；".join(state["read_errors"]))

    confirmation_cleared = bool(previous and diff["changed"] and previous.confirmed_at)
    target = previous or LarkTarget(group_id=group_id)
    target.source_url = payload.source_url
    target.execution_base_token = draft.execution_base_token
    target.execution_base_name = state["execution_base_name"]
    target.execution_table_id = draft.execution_table_id
    target.execution_table_name = state["execution_table_name"] or ""
    target.execution_view_id = draft.execution_view_id
    target.bug_base_token = draft.bug_base_token
    target.bug_base_name = state["bug_base_name"]
    target.bug_table_id = draft.bug_table_id
    target.bug_table_name = state["bug_table_name"] or ""
    target.schema_fingerprint = state["schema_fingerprint"]
    target.target_fingerprint = draft.fingerprint
    target.selected_at = datetime.now(timezone.utc)
    if diff["changed"]:
        # A changed destination can never inherit the previous write approval.
        target.confirmed_at = None
    db.add(target)
    _record_revision(db, group_id, draft)
    db.commit()
    db.refresh(target)
    return {
        "target": serialize_target(target),
        "live": state,
        "diff": diff,
        "confirmation_cleared": confirmation_cleared,
    }


class ConfirmTargetRequest(BaseModel):
    allow_writes: bool = False
    target_fingerprint: str


@router.post("/groups/{group_id}/lark/target/confirm")
def confirm_target(
    group_id: UUID,
    payload: ConfirmTargetRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    _require_group(db, group_id)
    if not payload.allow_writes:
        raise HTTPException(status_code=409, detail="需勾选允许向该表新增本组记录")
    target = target_for(db, group_id)
    if target is None:
        raise HTTPException(status_code=409, detail="尚未选择该组的 Lark 表")
    if target.target_fingerprint != payload.target_fingerprint:
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再确认")
    draft = TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )
    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    if state["read_errors"] or state["schema_errors"]:
        raise HTTPException(
            status_code=409,
            detail="；".join(state["read_errors"] + state["schema_errors"]),
        )
    target.schema_fingerprint = state["schema_fingerprint"]
    target.confirmed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(target)
    return serialize_target(target)
