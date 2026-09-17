from __future__ import annotations

from typing import Any, Iterable


# The option vocabulary of the tables this deployment has verified in Lark. It
# is copied from the reference base the team already fills by hand, so a table
# this tool generates is indistinguishable from one a person built.
PASS_RESULT_OPTIONS = ("通过", "不通过", "阻塞", "未执行")
RUN_PRIORITY_OPTIONS = ("P0", "P1", "P2", "P3")
# The defect table has no P3: a P3 case is filed as P2, exactly like the
# hand-run table does.
BUG_PRIORITY_OPTIONS = ("P0", "P1", "P2")
BUG_STATUS_OPTIONS = (
    "待修复",
    "修复中",
    "待验收",
    "验收不通过",
    "验收通过，待上线",
    "已上线",
    "需求确认",
    "无效 bug",
    "暂不处理",
)
DATE_PROPERTY: dict[str, Any] = {"date_formatter": "yyyy/MM/dd", "auto_fill": False}
PERSON_PROPERTY: dict[str, Any] = {"multiple": True}

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
    # 跟进人 is the assignee column the hand-built defect table carries; the
    # writer leaves it empty, exactly like the reference rows do.
    "跟进人": (1, 11),
    "优先级": (1, 3),
    "反馈时间": (5, 1001, 1002),
    "备注": (1,),
    "反馈人": (1, 11),
    # The defect row carries the same evidence as the run row: a screenshot
    # column the writer cannot fill is a defect report nobody can act on.
    "截图": (17,),
}

DATE_FIELD_CANDIDATES = ("日期", "反馈时间", "执行时间", "修改时间")
DESCRIPTION_FIELDS = ("问题描述", "缺陷描述", "描述")
# The remark is where this tool now files the case a defect came from, so the
# read-back has to look there too — the description carries only the failure.
REMARK_FIELDS = ("备注",)
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


# ``LarkTarget.schema_fingerprint`` stores one role's ``schema_fingerprint``
# output beside the other's, joined by this separator.
ROLE_SEPARATOR = "||"
# Lark's person field type. A person column only accepts ``[{"id": <open_id>}]``,
# so the writer has to know which columns are one before it builds a value.
PERSON_TYPE = 11


def person_field_names(fingerprint: str | None, role: str) -> set[str]:
    """The columns a stored schema fingerprint says are person columns.

    The write path has no field listing of its own and must not buy one: the
    destination's types were read when the administrator confirmed the target
    and are already stored beside it. Only a well-formed fingerprint is trusted
    — a target saved before this column existed, or a row the tests fabricate,
    yields the empty set, which is the caller's signal to keep its legacy
    behaviour instead of guessing a type.
    """

    if not fingerprint or ROLE_SEPARATOR not in fingerprint:
        return set()
    execution, bug = fingerprint.split(ROLE_SEPARATOR, 1)
    part = execution if role == "execution" else bug
    names: set[str] = set()
    for entry in part.split("|"):
        # ``rsplit`` because a field name may legitimately contain a colon; the
        # type is always the last colon-separated token.
        name, separator, type_id = entry.rpartition(":")
        if separator and type_id.isdigit() and int(type_id) == PERSON_TYPE:
            names.add(name)
    return names
