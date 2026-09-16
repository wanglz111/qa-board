from __future__ import annotations

from typing import Any, Iterable

from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    field_types,
    type_name,
)


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
