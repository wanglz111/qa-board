from __future__ import annotations

from typing import Any, Iterable


# Lark Bitable field type ids that this deployment has actually verified.
FIELD_TYPE_NAMES: dict[int, str] = {
    1: "text",
    2: "number",
    3: "single_select",
    4: "multi_select",
    5: "date",
    7: "checkbox",
    11: "person",
    13: "phone",
    15: "url",
    17: "attachment",
    18: "relation",
    20: "formula",
    1001: "created_time",
    1002: "modified_time",
    1003: "created_user",
    1004: "modified_user",
}

# A group may only be confirmed when every mandatory field exists with a type
# the outbound writer can actually fill.
REQUIRED_RUN_FIELD_TYPES: dict[str, tuple[int, ...]] = {
    "用例": (1,),
    "结果": (1, 3),
    "优先级": (1, 3),
    "负责人": (1, 11),
    "报告人": (1, 11),
    "日期": (5, 1001, 1002),
    "截图": (17,),
    "控制台": (1,),
}

REQUIRED_BUG_FIELD_TYPES: dict[str, tuple[int, ...]] = {
    "问题描述": (1,),
    "进展状态": (1, 3),
    "优先级": (1, 3),
    "反馈时间": (5, 1001, 1002),
    "备注": (1,),
    "反馈人": (1, 11),
}

DATE_FIELD_CANDIDATES = ("日期", "反馈时间", "执行时间", "修改时间")
DESCRIPTION_FIELDS = ("问题描述", "缺陷描述", "描述")
LINK_FIELDS = ("关联用例", "用例编号", "用例")


def type_name(type_id: int | None) -> str:
    if type_id is None:
        return "unknown"
    return FIELD_TYPE_NAMES.get(type_id, f"type_{type_id}")


def field_types(fields: Iterable[dict[str, Any]]) -> dict[str, int]:
    types: dict[str, int] = {}
    for field in fields:
        name = field.get("field_name")
        if isinstance(name, str):
            types[name] = int(field.get("type") or 0)
    return types


def describe_fields(fields: Iterable[dict[str, Any]]) -> dict[str, str]:
    return {name: type_name(type_id) for name, type_id in field_types(fields).items()}


def missing_required_fields(
    fields: Iterable[dict[str, Any]], required: dict[str, tuple[int, ...]]
) -> list[str]:
    types = field_types(fields)
    problems: list[str] = []
    for name, allowed in required.items():
        if name not in types:
            problems.append(f"缺少必填字段「{name}」")
            continue
        if types[name] not in allowed:
            expected = "/".join(type_name(item) for item in allowed)
            problems.append(
                f"字段「{name}」类型为 {type_name(types[name])}，需要 {expected}"
            )
    return problems


def schema_fingerprint(fields: Iterable[dict[str, Any]]) -> str:
    types = field_types(fields)
    return "|".join(f"{name}:{types[name]}" for name in sorted(types))
