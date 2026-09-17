"""Table and base names without paying for the schema.

The execution page asks for the same group's table names on every case it
opens. Reading the fields to answer that is a round trip per table that nothing
on the page uses, so names are read on their own.
"""

from __future__ import annotations

from typing import Any

from app.lark.client import LarkClient, LarkError


def _table_name(tables: list[dict[str, Any]], table_id: str) -> str | None:
    for table in tables:
        if str(table.get("table_id") or "") == table_id:
            name = table.get("name")
            return str(name) if name else None
    return None


def read_target_names(client: LarkClient, target: Any) -> dict[str, Any]:
    """The live names of a target's two tables, never its schema."""

    base_reads: dict[str, tuple[str, list[dict[str, Any]]]] = {}

    def _base(token: str) -> tuple[str, list[dict[str, Any]]]:
        if token not in base_reads:
            metadata = client.app_metadata(token)
            base_reads[token] = (
                str((metadata.get("app") or {}).get("name") or ""),
                client.list_tables(token),
            )
        return base_reads[token]

    try:
        execution_base_name, execution_tables = _base(target.execution_base_token)
        bug_base_name, bug_tables = _base(target.bug_base_token)
    except LarkError as error:
        return {
            "execution_base_name": None,
            "execution_table_name": None,
            "bug_base_name": None,
            "bug_table_name": None,
            "read_errors": [str(error)],
        }

    execution_table_name = _table_name(execution_tables, target.execution_table_id)
    bug_table_name = _table_name(bug_tables, target.bug_table_id)
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
