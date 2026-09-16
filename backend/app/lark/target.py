from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any
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
