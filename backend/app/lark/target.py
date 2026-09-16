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
from app.config import settings
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    describe_fields,
    missing_required_fields,
    schema_fingerprint,
)
from app.lark.link import SOURCE_ID, TABLE_ID, VIEW_ID, LarkLinkError, parse_lark_link
from app.models import Group, LarkTarget, LarkTargetRevision


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


# The four parts of a target's identity, in the order they appear in the stored
# fingerprint. Both the fingerprint and the diff derive from this one tuple, so
# adding a fifth identity component cannot drift the two apart.
IDENTITY_KEYS: tuple[str, ...] = (
    "execution_base_token",
    "execution_table_id",
    "bug_base_token",
    "bug_table_id",
)


@dataclass(frozen=True)
class TargetDraft:
    execution_base_token: str
    execution_table_id: str
    execution_view_id: str | None
    bug_base_token: str
    bug_table_id: str

    @property
    def fingerprint(self) -> str:
        return "|".join(getattr(self, key) for key in IDENTITY_KEYS)


def _table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id")) == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def _missing_credential() -> str | None:
    """Name the first unset app credential, worded like the read-state pre-check.

    The client raises the same way whether the credentials are unset or the app
    is not a collaborator, so without this an administrator whose app is simply
    unconfigured is sent to change document permissions.
    """

    for name, value in (
        ("LARK_APP_ID", settings.lark_app_id),
        ("LARK_APP_SECRET", settings.lark_app_secret),
    ):
        if not value:
            return f"缺少配置 {name}"
    return None


def resolve_link(client: LarkClient, url: str) -> dict[str, Any]:
    """Turn a pasted link into one base plus its selectable tables.

    Read-only: a wiki node lookup, the base metadata and the table/field
    listings are the only requests.
    """

    missing = _missing_credential()
    if missing:
        raise PermissionError(missing)

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

    read_errors: list[str] = []
    if not tables:
        read_errors.append("该多维表格中没有数据表，请先在 Lark 中新建数据表")

    selected = link.table_id if _table_name(tables, link.table_id or "") else None
    selected = selected or (str(tables[0].get("table_id")) if tables else None)
    try:
        fields = client.list_fields(base_token, selected) if selected else []
    except LarkError as error:
        raise PermissionError(
            f"无法读取数据表字段，请确认应用仍是协作者：{error}"
        ) from None

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
        "read_errors": read_errors,
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

    next_identity = {key: getattr(draft, key) for key in IDENTITY_KEYS}
    if previous is None:
        return {
            "changed": False,
            "changed_keys": [],
            "previous": None,
            "next": next_identity,
        }
    previous_identity = {key: getattr(previous, key) for key in IDENTITY_KEYS}
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


def target_for(db: Session, group_id: UUID) -> LarkTarget | None:
    """The group's stored target, unlocked, for read-only callers."""

    return db.scalar(select(LarkTarget).where(LarkTarget.group_id == group_id))


def locked_target_for(db: Session, group_id: UUID) -> LarkTarget | None:
    """The group's target taken with ``SELECT … FOR UPDATE``, for write paths.

    The lock is what makes a check-then-write atomic: two administrators whose
    saves interleave cannot both pass the fingerprint check and then overwrite
    each other. It is a separate function rather than a flag on ``target_for`` so
    a write path cannot take the unlocked read by accident.

    ``populate_existing`` is part of the lock's meaning, not an optimisation: the
    caller has usually read this row already in the same session, and without it
    SQLAlchemy would hand back the attributes that earlier read cached instead of
    the row the database just returned, so the check under the lock would inspect
    stale values.

    Keep every use of this short. A statement waiting on this lock counts against
    the 3 s ``statement_timeout`` that ``app/db.py`` sets on every connection, so
    holding it across the Lark HTTP reads would turn a second administrator's
    click into a 500 instead of a clean 409.
    """

    return db.scalar(
        select(LarkTarget)
        .where(LarkTarget.group_id == group_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


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


def _validate_target_tokens(payload: TargetRequest) -> None:
    """Refuse ids that could rewrite the authenticated Lark request path.

    Every token ends up interpolated into a path that carries the bearer token,
    so a value like ``../../../../wiki/v2/spaces/get_node`` would otherwise pick
    the endpoint the request hits. The accepted characters are the ones a pasted
    link may already carry.
    """

    checks = [
        ("执行库 App Token", payload.execution_base_token, SOURCE_ID),
        ("执行记录表 id", payload.execution_table_id, TABLE_ID),
        ("缺陷库 App Token", payload.bug_base_token, SOURCE_ID),
        ("缺陷表 id", payload.bug_table_id, TABLE_ID),
    ]
    # No view is a normal choice; only a supplied id has to be a real one.
    if payload.execution_view_id:
        checks.append(("视图 id", payload.execution_view_id, VIEW_ID))
    for label, value, pattern in checks:
        if pattern.match(value) is None:
            raise HTTPException(
                status_code=422,
                detail=f"{label} 不是有效的多维表格标识，请重新读取并粘贴 Lark 链接",
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
    _validate_target_tokens(payload)
    # This read is deliberately unlocked: the checks below only need to know what
    # the administrator's page was looking at, and their answer must not depend on
    # a row lock held across the Lark requests that follow.
    previous = target_for(db, group_id)
    diff = target_diff(previous, draft)
    if diff["changed"]:
        if not payload.acknowledge_change:
            raise HTTPException(
                status_code=409, detail={"reason": "target_changed", "diff": diff}
            )
        # A fingerprint the page did not read from the stored target is stale:
        # another tab moved this group after the page was loaded. Only a
        # *supplied* mismatch is refused — the plan's literal condition
        # (expected_previous_fingerprint != previous.target_fingerprint) also
        # rejected a client that never held a fingerprint, which makes the
        # plan's own acknowledged-change tests unreachable. Do not "fix" this
        # back into requiring a fingerprint the page may legitimately not have.
        if (
            payload.expected_previous_fingerprint is not None
            and payload.expected_previous_fingerprint != previous.target_fingerprint
        ):
            raise HTTPException(
                status_code=409, detail={"reason": "stale_page", "diff": diff}
            )

    # Snapshot the fingerprint these checks were based on. The locked read below
    # refreshes that same instance in place, so it has to be read out first.
    checked_fingerprint = previous.target_fingerprint if previous is not None else None

    try:
        state = read_draft_state(client, draft)
    except LarkError as error:
        raise HTTPException(status_code=409, detail=f"读取目标表失败：{error}") from None
    if state["read_errors"]:
        raise HTTPException(status_code=409, detail="；".join(state["read_errors"]))

    # Only now take the row lock, for one short transaction. The read above is
    # unlocked, so the row may have moved while those Lark requests ran; re-check
    # it against what we based the checks on (and what we are about to save)
    # before any of the state we read lands on it.
    locked = locked_target_for(db, group_id)
    locked_fingerprint = locked.target_fingerprint if locked is not None else None
    if (
        locked_fingerprint != checked_fingerprint
        and locked_fingerprint != draft.fingerprint
    ):
        # The stored row is now neither what the page was shown nor what the page
        # asked for: another tab re-pointed it mid-request. A supplied fingerprint
        # that no longer matches means that page is stale; otherwise the diff is
        # reported so the administrator can acknowledge the table actually stored.
        raise HTTPException(
            status_code=409,
            detail={
                "reason": (
                    "stale_page"
                    if payload.expected_previous_fingerprint is not None
                    else "target_changed"
                ),
                "diff": target_diff(locked, draft),
            },
        )

    # Everything that is reported or cleared is decided against the row the lock
    # just returned, not against the pre-lock snapshot: a row that already equals
    # the submitted target is not a change, and an approval another tab took on
    # it while this request was reading is a consent for exactly this target, so
    # it must survive. A destination that really does differ still cannot inherit
    # an earlier approval.
    locked_diff = target_diff(locked, draft)
    confirmation_cleared = bool(
        locked is not None and locked_diff["changed"] and locked.confirmed_at
    )
    target = locked if locked is not None else LarkTarget(group_id=group_id)
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
    if locked_diff["changed"]:
        # A changed destination can never inherit the previous write approval.
        target.confirmed_at = None
    db.add(target)
    _record_revision(db, group_id, draft)
    db.commit()
    db.refresh(target)
    return {
        "target": serialize_target(target),
        "live": state,
        "diff": locked_diff,
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
    # The live read above takes several requests, so the row may have been
    # re-pointed since the fingerprint check. Repeat that check under the row lock
    # in the same short transaction as the write: an approval must never land on a
    # table nobody approved, with a schema fingerprint read from the old one.
    locked = locked_target_for(db, group_id)
    if locked is None or locked.target_fingerprint != payload.target_fingerprint:
        raise HTTPException(status_code=409, detail="目标表已变化，请重新读取后再确认")
    locked.schema_fingerprint = state["schema_fingerprint"]
    locked.confirmed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(locked)
    return serialize_target(locked)
