from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any, Mapping


MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_CASES = 5000


class ImportErrorDetail(ValueError):
    """A file import error suitable for showing in an import preview."""


@dataclass(frozen=True, slots=True)
class ParsedCase:
    code: str
    position: int
    title: str
    module: str | None
    layer: str | None
    priority: str | None
    preconditions: str | None
    test_data: str | None
    steps: str | None
    expected: str | None
    prototype_note: str | None
    raw: dict[str, Any]


FIELDS = (
    "code",
    "position",
    "title",
    "module",
    "layer",
    "priority",
    "preconditions",
    "test_data",
    "steps",
    "expected",
    "prototype_note",
)

ALIASES: dict[str, tuple[str, ...]] = {
    "code": ("code", "id", "用例编号", "编号"),
    "position": ("position", "order", "执行顺序", "顺序", "序号"),
    "title": ("title", "用例标题", "标题"),
    "module": ("module", "所属模块", "模块"),
    "layer": ("layer", "执行分层", "分层"),
    "priority": ("priority", "优先级"),
    "preconditions": ("preconditions", "precondition", "前置条件"),
    "test_data": ("test_data", "testData", "测试数据"),
    "steps": ("steps", "执行步骤", "步骤"),
    "expected": ("expected", "checkpoints", "预期结果", "预期"),
    "prototype_note": ("prototype_note", "protoNote", "原型备注", "核图提示"),
}


def parse_file(
    name: str, content: bytes, mapping: dict[str, str] | None = None
) -> list[ParsedCase]:
    if not content:
        raise ImportErrorDetail("The import file is empty")
    if len(content) > MAX_FILE_SIZE:
        raise ImportErrorDetail("The import file exceeds the 10 MB limit")

    suffix = Path(name).suffix.lower()
    if suffix == ".csv":
        from .csv_file import parse_csv

        records = parse_csv(content)
    elif suffix == ".json":
        from .json_file import parse_json

        records = parse_json(content)
    elif suffix in {".md", ".markdown"}:
        from .markdown_file import parse_markdown

        records = parse_markdown(content)
    else:
        raise ImportErrorDetail(f"unsupported import format: {suffix or '(none)'}")

    if not records:
        raise ImportErrorDetail("No test case boundaries were recognized in the file")
    if len(records) > MAX_CASES:
        raise ImportErrorDetail(f"The import contains more than {MAX_CASES} cases")

    cases = [normalize_record(record, index, mapping) for index, record in enumerate(records, 1)]
    _ensure_unique(cases)
    return cases


def decode_utf8(content: bytes, *, bom: bool = False) -> str:
    try:
        return content.decode("utf-8-sig" if bom else "utf-8")
    except UnicodeDecodeError as exc:
        raise ImportErrorDetail("The import file must contain valid UTF-8 text") from exc


def normalize_record(
    record: Mapping[str, Any], default_position: int, mapping: dict[str, str] | None
) -> ParsedCase:
    source = {str(key).strip(): value for key, value in record.items()}
    source_lookup = {key.casefold(): key for key in source}
    field_sources = _field_sources(source_lookup, mapping)

    values: dict[str, Any] = {}
    for field in FIELDS:
        source_key = field_sources.get(field)
        value = source.get(source_key) if source_key is not None else None
        values[field] = _clean(value)

    code = values["code"]
    title = values["title"]
    if not code:
        raise ImportErrorDetail(f"Case {default_position} is missing required code")
    if not title:
        raise ImportErrorDetail(f"Case {code} is missing required title")

    raw_position = values["position"]
    if raw_position is None:
        position = default_position
    else:
        try:
            if isinstance(raw_position, str):
                position_match = re.fullmatch(r"(?:第\s*)?(\d+)(?:\s*条)?", raw_position)
                if not position_match:
                    raise ValueError
                position = int(position_match.group(1))
            else:
                if isinstance(raw_position, bool) or not isinstance(raw_position, int):
                    raise ValueError
                position = raw_position
        except (TypeError, ValueError) as exc:
            raise ImportErrorDetail(f"Case {code} has invalid position: {raw_position}") from exc
        if position < 1:
            raise ImportErrorDetail(f"Case {code} has invalid position: {position}")

    return ParsedCase(
        code=str(code),
        position=position,
        title=str(title),
        module=values["module"],
        layer=values["layer"],
        priority=values["priority"],
        preconditions=values["preconditions"],
        test_data=values["test_data"],
        steps=values["steps"],
        expected=values["expected"],
        prototype_note=values["prototype_note"],
        raw=dict(record),
    )


def _field_sources(
    source_lookup: dict[str, str], mapping: dict[str, str] | None
) -> dict[str, str]:
    result: dict[str, str] = {}
    if mapping:
        for left, right in mapping.items():
            left_normalized = left.strip()
            right_normalized = right.strip()
            if right_normalized in FIELDS and left_normalized.casefold() in source_lookup:
                field, source_key = right_normalized, source_lookup[left_normalized.casefold()]
            elif left_normalized in FIELDS and right_normalized.casefold() in source_lookup:
                field, source_key = left_normalized, source_lookup[right_normalized.casefold()]
            else:
                raise ImportErrorDetail(
                    f"Mapping {left!r} -> {right!r} does not identify a source field and canonical field"
                )
            if field in result and result[field] != source_key:
                raise ImportErrorDetail(f"Ambiguous mapping for canonical field {field}")
            result[field] = source_key

    for field, aliases in ALIASES.items():
        if field in result:
            continue
        matches = {
            source_lookup[alias.casefold()]
            for alias in aliases
            if alias.casefold() in source_lookup
        }
        if len(matches) > 1:
            raise ImportErrorDetail(f"Ambiguous source fields for canonical field {field}")
        if matches:
            result[field] = matches.pop()
    return result


def _clean(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        return value or None
    if isinstance(value, list):
        items = [_clean(item) for item in value]
        return "\n".join(str(item) for item in items if item is not None) or None
    if isinstance(value, dict):
        raw = _clean(value.get("raw"))
        if raw:
            return raw
        text = _clean(value.get("text"))
        label = _clean(value.get("label"))
        if text:
            return f"{label}: {text}" if label else text
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return value


def _ensure_unique(cases: list[ParsedCase]) -> None:
    codes: set[str] = set()
    positions: set[int] = set()
    for case in cases:
        if case.code in codes:
            raise ImportErrorDetail(f"The import contains duplicate code: {case.code}")
        if case.position in positions:
            raise ImportErrorDetail(f"The import contains duplicate position: {case.position}")
        codes.add(case.code)
        positions.add(case.position)
