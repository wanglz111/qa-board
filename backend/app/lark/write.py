from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Protocol

from app.lark.client import LarkClient
from app.lark.fields import BUG_PRIORITY_OPTIONS, RUN_PRIORITY_OPTIONS
from app.models import Attempt, GroupCase


OPEN_BUG_STATUS = "待修复"
# Every case lands in a bucket: a case whose own priority is missing, or names
# something the table's option list does not carry, is filed as P2 — the same
# fallback the hand-run table uses. The defect table has no P3 at all, so a P3
# case is filed as P2 there.
DEFAULT_PRIORITY = "P2"


class LarkWriteGateway(Protocol):
    """The narrow write surface the worker may use: create-only."""

    def create_execution(self, fields: dict[str, Any]) -> str: ...

    def create_bug(self, fields: dict[str, Any]) -> str: ...

    def find_execution_ids(self, fields: dict[str, Any]) -> list[str]: ...

    def upload_attachment(
        self, file_name: str, content: bytes, mime: str, *, role: str
    ) -> str: ...


def _milliseconds(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp() * 1000)


def _priority(value: str | None, options: tuple[str, ...]) -> str:
    text = (value or "").strip()
    return text if text in options else DEFAULT_PRIORITY


def _attachment_value(file_tokens: list[str]) -> list[dict[str, str]]:
    """The shape a Lark attachment column holds: one token per file."""

    return [{"file_token": token} for token in file_tokens]


def execution_fields(
    attempt: Attempt,
    case: GroupCase,
    *,
    owner: str,
    reporter: str,
    attachments: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "用例": f"{case.code} {case.title}",
        "结果": attempt.result or "",
        "优先级": _priority(case.priority, RUN_PRIORITY_OPTIONS),
        # 负责人 and 报告人 are two separate plain-text columns: the hand-run
        # rows file the case under the deployment's owner (待指派) and name the
        # reporter, rather than repeating one address in both.
        "负责人": owner,
        "报告人": reporter,
        "日期": _milliseconds(attempt.created_at),
        # A run with no screenshot writes an empty attachment list: the column
        # is attachment-typed in every table this tool builds.
        "截图": _attachment_value(attachments or []),
        "控制台": attempt.console_text or "",
    }


def bug_fields(
    attempt: Attempt,
    case: GroupCase,
    *,
    reporter: str,
    attachments: list[str] | None = None,
    reporter_id: str | None = None,
) -> dict[str, Any]:
    note = (attempt.note or "").strip()
    description = f"{case.code} {case.title}"
    if note:
        description = f"{description}\n{note}"
    # 备注 carries what the description does not: which case raised the defect,
    # with what result, then the console tail. The internal 【自动提】 marker this
    # tool used to prepend is gone from it.
    remark = f"由用例 {case.code} 提交（结果：{attempt.result or ''}）"
    console = attempt.console_text or ""
    if console:
        remark = f"{remark}\n{console}"
    fields: dict[str, Any] = {
        "问题描述": description,
        "进展状态": OPEN_BUG_STATUS,
        "优先级": _priority(case.priority, BUG_PRIORITY_OPTIONS),
        "反馈时间": _milliseconds(attempt.created_at),
        "备注": remark,
        "截图": _attachment_value(attachments or []),
    }
    # 反馈人 is a person column in the verified schema, and a person column only
    # accepts an open_id. Without one configured the field stays out of the
    # request, so a text-typed legacy column keeps the reporter it always had.
    if reporter_id:
        fields["反馈人"] = [{"id": reporter_id}]
    else:
        fields["反馈人"] = reporter
    return fields


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

    def upload_attachment(
        self, file_name: str, content: bytes, mime: str, *, role: str
    ) -> str:
        """Upload one screenshot into the base the record will live in.

        A file token is only valid inside the base that minted it, so a defect
        row living in another base gets its own upload of the same picture.
        """

        base_token = self.run_app_token if role == "execution" else self.bug_app_token
        return self.client.upload_media(
            file_name=file_name,
            content=content,
            mime=mime,
            parent_node=base_token,
        )
