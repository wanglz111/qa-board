"""Table and base names without paying for the schema.

The execution page asks for the same group's table names on every case it
opens. Reading the fields to answer that is a round trip per table that nothing
on the page uses, so names are read on their own.

The base memo lives here as well: ``read_draft_state`` needs exactly the same
two calls per base, and one copy beats two that can drift apart.
"""

from __future__ import annotations

from typing import Any

from app.lark.client import LarkClient, LarkError


def read_bases(
    client: LarkClient, tokens: list[str]
) -> dict[str, tuple[dict[str, Any], list[dict[str, Any]]]]:
    """Each distinct base's metadata and table listing, read once per call."""

    reads: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}
    for token in tokens:
        if token not in reads:
            reads[token] = (client.app_metadata(token), client.list_tables(token))
    return reads


def table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id") or "") == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def read_target_names(client: LarkClient, target: Any) -> dict[str, Any]:
    """The live names of a target's two tables, never its schema."""

    try:
        reads = read_bases(client, [target.execution_base_token, target.bug_base_token])
    except LarkError as error:
        return {
            "execution_base_name": None,
            "execution_table_name": None,
            "bug_base_name": None,
            "bug_table_name": None,
            "read_errors": [str(error)],
        }

    execution_base, execution_tables = reads[target.execution_base_token]
    bug_base, bug_tables = reads[target.bug_base_token]

    def _base_name(metadata: dict[str, Any]) -> str:
        return str((metadata.get("app") or {}).get("name") or "")

    execution_base_name = _base_name(execution_base)
    bug_base_name = _base_name(bug_base)
    execution_table_name = table_name(execution_tables, target.execution_table_id)
    bug_table_name = table_name(bug_tables, target.bug_table_id)
    read_errors: list[str] = []
    if execution_table_name is None:
        read_errors.append(f"Lark 中找不到执行记录表 {target.execution_table_id}")
    if bug_table_name is None:
        read_errors.append(f"Lark 中找不到缺陷表 {target.bug_table_id}")
    return {
        "execution_base_name": execution_base_name,
        "execution_table_name": execution_table_name,
        "bug_base_name": bug_base_name,
        "bug_table_name": bug_table_name,
        "read_errors": read_errors,
    }
