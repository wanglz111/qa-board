from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

from app.lark.client import LarkClient
from app.models import Attempt, GroupCase


# New bugs carry this marker so nobody mistakes them for a legacy defect thread.
AUTO_BUG_MARKER = "【自动提】"
OPEN_BUG_STATUS = "待修复"


class LarkWriteGateway(Protocol):
    """The narrow write surface the worker may use: create-only."""

    def create_execution(self, fields: dict[str, Any]) -> str: ...

    def create_bug(self, fields: dict[str, Any]) -> str: ...

    def find_execution_ids(self, fields: dict[str, Any]) -> list[str]: ...


def _milliseconds(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def execution_fields(attempt: Attempt, case: GroupCase, reporter: str) -> dict[str, Any]:
    return {
        "用例": f"{case.code} {case.title}",
        "结果": attempt.result or "",
        "优先级": case.priority or "",
        "负责人": reporter,
        "报告人": reporter,
        "日期": _milliseconds(attempt.created_at),
        "截图": [],
        "控制台": attempt.console_text or "",
    }


def bug_fields(attempt: Attempt, case: GroupCase, reporter: str) -> dict[str, Any]:
    note = (attempt.note or "").strip()
    description = f"{AUTO_BUG_MARKER}{case.code} {case.title}"
    if note:
        description = f"{description}\n{note}"
    return {
        "问题描述": description,
        "进展状态": OPEN_BUG_STATUS,
        "优先级": case.priority or "",
        "反馈时间": _milliseconds(attempt.created_at),
        "备注": attempt.console_text or "",
        "反馈人": reporter,
    }


def record_matches_execution(record: dict[str, Any], expected: dict[str, Any]) -> bool:
    from app.lark.history import record_fields

    actual = record_fields(record)
    try:
        same_date = int(actual.get("日期")) == int(expected.get("日期"))
    except (TypeError, ValueError):
        same_date = False
    return (
        actual.get("用例") == expected.get("用例")
        and str(actual.get("结果") or "") == str(expected.get("结果") or "")
        and str(actual.get("控制台") or "") == str(expected.get("控制台") or "")
        and same_date
    )


class HttpLarkWriteGateway:
    """Creates new records in the confirmed tables; it never updates anything."""

    def __init__(
        self,
        client: LarkClient,
        *,
        run_app_token: str,
        run_table_id: str,
        bug_app_token: str,
        bug_table_id: str,
    ) -> None:
        self.client = client
        self.run_app_token = run_app_token
        self.run_table_id = run_table_id
        self.bug_app_token = bug_app_token
        self.bug_table_id = bug_table_id

    def create_execution(self, fields: dict[str, Any]) -> str:
        record = self.client.create_record(self.run_app_token, self.run_table_id, fields)
        return str(record["record_id"])

    def create_bug(self, fields: dict[str, Any]) -> str:
        record = self.client.create_record(self.bug_app_token, self.bug_table_id, fields)
        return str(record["record_id"])

    def find_execution_ids(self, fields: dict[str, Any]) -> list[str]:
        records = self.client.list_records(self.run_app_token, self.run_table_id)
        return [
            str(record.get("record_id"))
            for record in records
            if record.get("record_id") and record_matches_execution(record, fields)
        ]
