from __future__ import annotations

import html
import re
from typing import Any

from .schema import ALIASES, ImportErrorDetail, decode_utf8


CASE_HEADING = re.compile(
    r"^####\s+(?P<code>[A-Za-z0-9]+-\d+(?:-[A-Za-z0-9]+)*)\s*(?:[·]\s*)?(?P<title>.*?)\s*$",
    re.MULTILINE,
)
BREAK = re.compile(r"<br\s*/?>", re.IGNORECASE)
BOLD_SECTION = re.compile(r"^\*\*(?P<name>[^*]+)\*\*\s*$", re.MULTILINE)


def parse_markdown(content: bytes) -> list[dict[str, Any]]:
    text = decode_utf8(content, bom=True)
    heading_records = _heading_cases(text)
    table_records = _explicit_case_tables(text)
    if heading_records and table_records:
        raise ImportErrorDetail("Markdown has ambiguous case boundaries (headings and case tables)")
    return heading_records or table_records


def _heading_cases(text: str) -> list[dict[str, Any]]:
    matches = list(CASE_HEADING.finditer(text))
    records: list[dict[str, Any]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        field_tables = [
            table
            for table in _tables(text[match.end() : end])
            if len(table[0]) == 2 and _markdown_value(table[0][0]) in {"字段", "项", "Field"}
        ]
        if not field_tables:
            raise ImportErrorDetail(
                f"Markdown case boundaries are incomplete: {match.group('code')} has no case field table"
            )
        fields: dict[str, Any] = {
            "用例编号": match.group("code"),
            "用例标题": _markdown_value(match.group("title")),
        }
        for table in field_tables:
            for row in table[1:]:
                if len(row) != 2:
                    raise ImportErrorDetail("Markdown case field table has an inconsistent column count")
                fields[_markdown_value(row[0])] = _markdown_value(row[1])
        section = text[match.end() : end]
        steps = _section_body(section, "执行步骤")
        if steps:
            fields["执行步骤"] = _steps_text(steps)
        expected = _section_body(section, "预期结果")
        if expected:
            fields["预期结果"] = _expected_text(expected)
        records.append(fields)
    return records


def _explicit_case_tables(text: str) -> list[dict[str, Any]]:
    tables = _tables(text)
    records: list[dict[str, Any]] = []
    code_aliases = set(ALIASES["code"])
    title_aliases = set(ALIASES["title"])
    step_aliases = set(ALIASES["steps"])
    expected_aliases = set(ALIASES["expected"])
    for rows in tables:
        if len(rows) < 2:
            continue
        headers = [_markdown_value(cell) for cell in rows[0]]
        header_set = set(headers)
        is_case_table = (
            bool(header_set & code_aliases)
            and bool(header_set & title_aliases)
            and bool(header_set & step_aliases)
            and bool(header_set & expected_aliases)
        )
        if not is_case_table:
            continue
        for row in rows[1:]:
            values = [_markdown_value(cell) for cell in row]
            if len(values) != len(headers):
                raise ImportErrorDetail("Markdown case table has an inconsistent column count")
            records.append(dict(zip(headers, values, strict=True)))
    return records


def _tables(text: str) -> list[list[list[str]]]:
    lines = text.splitlines()
    tables: list[list[list[str]]] = []
    index = 0
    while index < len(lines):
        if not _is_table_line(lines[index]):
            index += 1
            continue
        block: list[str] = []
        while index < len(lines) and _is_table_line(lines[index]):
            block.append(lines[index])
            index += 1
        rows = [_split_row(line) for line in block]
        if len(rows) >= 2 and _is_separator(rows[1]):
            tables.append([rows[0], *rows[2:]])
    return tables


def _is_table_line(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("|") and stripped.endswith("|")


def _split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_separator(row: list[str]) -> bool:
    return bool(row) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in row)


def _markdown_value(value: str) -> str:
    value = html.unescape(BREAK.sub("\n", value)).strip()
    if len(value) >= 4 and value.startswith("**") and value.endswith("**"):
        return value[2:-2].strip()
    return value


def _section_body(section: str, name: str) -> str | None:
    matches = list(BOLD_SECTION.finditer(section))
    for index, match in enumerate(matches):
        if match.group("name").strip() != name:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(section)
        return section[match.end() : end].strip()
    return None


def _steps_text(body: str) -> str:
    table_start = body.find("\n|")
    if table_start >= 0:
        body = body[:table_start]
    lines = []
    for line in body.splitlines():
        cleaned = re.sub(r"^\s*\d+[.)]\s*", "", line).strip()
        if cleaned:
            lines.append(_markdown_value(cleaned))
    return "\n".join(lines)


def _expected_text(body: str) -> str:
    tables = _tables(body)
    if tables:
        table = tables[0]
        headers = [_markdown_value(cell) for cell in table[0]]
        if "预期结果" in headers:
            expected_index = headers.index("预期结果")
            location_index = headers.index("断言位置") if "断言位置" in headers else None
            assertions = []
            for row in table[1:]:
                if expected_index >= len(row):
                    raise ImportErrorDetail("Markdown expected-results table is malformed")
                expected = _markdown_value(row[expected_index])
                location = (
                    _markdown_value(row[location_index])
                    if location_index is not None and location_index < len(row)
                    else ""
                )
                assertions.append(f"{location}: {expected}" if location else expected)
            return "\n".join(assertions)
    return _steps_text(body)
