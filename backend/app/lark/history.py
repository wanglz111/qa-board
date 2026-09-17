from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    DATE_FIELD_CANDIDATES,
    DESCRIPTION_FIELDS,
    LINK_FIELDS,
)
from app.lark.names import read_target_names
from app.lark.target import TargetDraft, read_draft_state, target_for
from app.models import GroupCase, LarkHistoryRef, LarkTarget


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# The case code is the longest leading token, optionally followed by one
# "-R..." retest suffix: "B-0010" must never be read as "B-001", "B-001_2" is
# ambiguous and stays unmatched, and "TC-001-02" keeps its full code.
CASE_REFERENCE = re.compile(
    r"^\s*(?P<token>[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)(?![A-Za-z0-9_-])"
)

# A retest label is the group short code plus a sequence, e.g. -R0918-01.
RETEST_SUFFIX = re.compile(r"(?P<retest>-R[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)$")

EXPLICIT_LINK_FIELDS = ("关联用例", "用例编号")
CASE_TEXT_FIELDS = ("用例", "用例编号", "用例标题", "标题")

# A defect row may carry a leading label before its text, and the outbox's own
# 【自动提】 rows always do. The label is decoration: the case code starts right
# after it, so the reader strips it instead of reporting "未匹配到旧缺陷" for the
# very rows this tool created.
LEADING_MARKER = re.compile(r"^\s*(?:【[^】]*】\s*)*")


@dataclass(frozen=True)
class CaseReference:
    code: str
    retest_label: str | None

    @property
    def is_retest(self) -> bool:
        return self.retest_label is not None


@dataclass
class CaseHistory:
    code: str
    original: list[dict[str, Any]] = field(default_factory=list)
    retests: list[dict[str, Any]] = field(default_factory=list)
    ambiguous: list[dict[str, Any]] = field(default_factory=list)
    unknown: list[dict[str, Any]] = field(default_factory=list)
    certainty: str = "uncertain"
    uncertainty: str | None = None

    @property
    def latest(self) -> dict[str, Any] | None:
        """Only a verified ranking can name the newest record."""

        if self.certainty != "verified":
            return None
        candidates = self.original + self.retests
        return candidates[-1] if candidates else None


def parse_case_reference(text: str | None) -> CaseReference | None:
    if not text:
        return None
    match = CASE_REFERENCE.match(text)
    if match is None:
        return None
    token = match.group("token")
    retest = RETEST_SUFFIX.search(token)
    if retest is None:
        return CaseReference(code=token, retest_label=None)
    code = token[: retest.start()]
    if "-" not in code:
        return CaseReference(code=token, retest_label=None)
    return CaseReference(code=code, retest_label=retest.group("retest"))


def parse_labelled_case_reference(text: str | None) -> CaseReference | None:
    """The same parse, ignoring a leading 【…】 label such as 【自动提】."""

    if not text:
        return None
    return parse_case_reference(LEADING_MARKER.sub("", text))


def record_fields(record: dict[str, Any]) -> dict[str, Any]:
    fields = record.get("fields")
    return fields if isinstance(fields, dict) else {}


def record_case_text(record: dict[str, Any]) -> str:
    fields = record_fields(record)
    for name in CASE_TEXT_FIELDS:
        value = fields.get(name)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        # Lark date fields are epoch milliseconds.
        return float(value) / 1000 if value > 10_000_000_000 else float(value)
    if isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return None


def verified_timestamp(record: dict[str, Any]) -> float | None:
    fields = record_fields(record)
    for name in DATE_FIELD_CANDIDATES:
        if name in fields:
            stamp = _timestamp(fields[name])
            if stamp is not None:
                return stamp
    return None


def rank_records(
    records: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], str, str | None]:
    """Order records by a verified date, or admit that the order is unknown."""

    dated: list[tuple[float, dict[str, Any]]] = []
    for record in records:
        stamp = verified_timestamp(record)
        if stamp is None:
            return list(records), "uncertain", "缺少可验证的日期或修改时间"
        dated.append((stamp, record))
    dated.sort(key=lambda item: item[0])
    return [record for _, record in dated], "verified", None


def history_for(records: list[dict[str, Any]], code: str) -> CaseHistory:
    history = CaseHistory(code=code)
    wanted = code.casefold()
    for record in records:
        text = record_case_text(record)
        reference = parse_case_reference(text)
        if reference is None:
            # Unparsed legacy rows stay visible instead of silently vanishing.
            history.unknown.append(record)
            continue
        if reference.code.casefold() != wanted:
            continue
        if reference.is_retest:
            history.retests.append(record)
        else:
            history.original.append(record)

    ordered, certainty, reason = rank_records(history.original + history.retests)
    originals = [record for record in ordered if record in history.original]
    retests = [record for record in ordered if record in history.retests]
    history.original = originals
    history.retests = retests
    history.certainty = certainty
    history.uncertainty = reason
    if certainty != "verified" and len(originals) > 1:
        # Several original records and no verified date: the caller must ask a
        # human instead of trusting an invented "latest".
        history.ambiguous = list(originals)
    return history


def match_bugs(bug_records: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    for record in bug_records:
        fields = record_fields(record)
        matched_by: str | None = None
        for name in EXPLICIT_LINK_FIELDS:
            if str(fields.get(name, "")).strip() == code:
                matched_by = f"字段「{name}」"
                break
        if matched_by is None:
            for name in DESCRIPTION_FIELDS:
                reference = parse_labelled_case_reference(str(fields.get(name) or ""))
                if reference is not None and reference.code == code:
                    matched_by = name
                    break
        if matched_by is None:
            continue
        matches.append(
            {
                "record_id": record.get("record_id"),
                # The label is stripped for the reader: a row this tool wrote
                # before the marker was dropped still shows its case, not a
                # 【自动提】 badge nobody asked for.
                "description": LEADING_MARKER.sub(
                    "",
                    next(
                        (
                            str(fields.get(name))
                            for name in DESCRIPTION_FIELDS
                            if fields.get(name)
                        ),
                        "",
                    ),
                ),
                "status": fields.get("进展状态") or fields.get("状态"),
                "priority": fields.get("优先级"),
                "matched_by": matched_by,
                "observed_at": verified_timestamp(record),
            }
        )
    return matches


def _snapshot_attachments(snapshot: Any) -> list[dict[str, Any]]:
    if not isinstance(snapshot, dict):
        return []
    attachments = snapshot.get("attachments")
    if not isinstance(attachments, list):
        return []
    return [item for item in attachments if isinstance(item, dict)]


ALLOWED_ATTACHMENT_TYPES = (
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "application/pdf",
    "text/plain",
)
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


def record_attachments(record: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalise the legacy 截图 field into display-only attachment metadata."""

    value = record_fields(record).get("截图")
    if not isinstance(value, list):
        return []
    attachments: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        token = item.get("file_token")
        if not isinstance(token, str) or not token:
            continue
        attachments.append(
            {
                "file_token": token,
                "name": str(item.get("name") or "legacy-attachment"),
                "mime": str(item.get("type") or item.get("mime") or "application/octet-stream"),
            }
        )
    return attachments


def _legacy_result(record: dict[str, Any]) -> dict[str, Any]:
    fields = record_fields(record)
    return {
        "record_id": record.get("record_id"),
        "case_text": record_case_text(record),
        "result": fields.get("结果"),
        "note": fields.get("备注") or fields.get("说明") or fields.get("控制台"),
        "console_text": fields.get("控制台"),
        "observed_at": verified_timestamp(record),
    }


def _upsert_reference(
    db: Session,
    group_case: GroupCase,
    record: dict[str, Any],
    *,
    table_id: str,
    certainty: str,
) -> LarkHistoryRef:
    snapshot = {
        "用例": record_case_text(record),
        "结果": record_fields(record).get("结果"),
        "attachments": record_attachments(record),
    }
    reference = db.scalar(
        select(LarkHistoryRef).where(
            LarkHistoryRef.group_case_id == group_case.id,
            LarkHistoryRef.table_id == table_id,
            LarkHistoryRef.old_record_id == str(record.get("record_id")),
        )
    )
    if reference is None:
        reference = LarkHistoryRef(
            group_case_id=group_case.id,
            table_id=table_id,
            old_record_id=str(record.get("record_id")),
            certainty=certainty,
            snapshot=snapshot,
        )
        db.add(reference)
    else:
        reference.snapshot = snapshot
        reference.certainty = certainty
    db.flush()
    return reference


@router.get("/groups/{group_id}/cases/{code}/lark-history")
def case_lark_history(
    group_id: UUID,
    code: str,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    group_case = db.scalar(
        select(GroupCase).where(GroupCase.group_id == group_id, GroupCase.code == code)
    )
    if group_case is None:
        raise HTTPException(status_code=404, detail="Group case not found")

    # History comes from the group's own stored target: there is no
    # environment-configured table any more.
    target = target_for(db, group_id)
    if target is None:
        return _unavailable_history(code, ["该组尚未选择 Lark 表"], "该组尚未选择 Lark 表")

    state = read_target_names(client, target)
    if state["read_errors"]:
        return _unavailable_history(code, state["read_errors"], "Lark 目标表不可读")

    records = client.list_records(target.execution_base_token, target.execution_table_id)
    history = history_for(records, code)
    case_history = history.original + history.retests
    references = {
        str(record.get("record_id")): _upsert_reference(
            db,
            group_case,
            record,
            table_id=target.execution_table_id,
            certainty=history.certainty,
        )
        for record in case_history
    }
    bugs = match_bugs(
        client.list_records(target.bug_base_token, target.bug_table_id),
        code,
    )
    db.commit()

    def serialize(record: dict[str, Any]) -> dict[str, Any]:
        reference = references[str(record.get("record_id"))]
        attachments = _snapshot_attachments(reference.snapshot)
        return {
            **_legacy_result(record),
            "ref_id": str(reference.id),
            "attachments": [
                {"index": index, "name": item.get("name"), "mime": item.get("mime")}
                for index, item in enumerate(attachments)
            ],
        }

    return {
        "available": True,
        "code": code,
        "read_errors": [],
        "source_table_name": state["execution_table_name"],
        "base_name": state["execution_base_name"],
        "bug_table_name": state["bug_table_name"],
        "read_at": datetime.now(timezone.utc).isoformat(),
        "certainty": history.certainty,
        "uncertainty": history.uncertainty,
        "ambiguous": bool(history.ambiguous),
        "original": [serialize(record) for record in history.original],
        "retests": [serialize(record) for record in history.retests],
        "bugs": bugs,
        "unknown_count": len(history.unknown),
    }


def _unavailable_history(
    code: str, read_errors: list[str], uncertainty: str
) -> dict[str, Any]:
    """The shape the page renders when this group has nothing readable yet."""

    return {
        "available": False,
        "code": code,
        "read_errors": read_errors,
        "source_table_name": None,
        "read_at": datetime.now(timezone.utc).isoformat(),
        "certainty": "uncertain",
        "uncertainty": uncertainty,
        "original": [],
        "retests": [],
        "bugs": [],
        "unknown_count": 0,
        "ambiguous": False,
    }


def read_target_state(client: LarkClient, target: LarkTarget) -> dict[str, Any]:
    """Read the stored target's live names and field types, never secrets."""

    draft = TargetDraft(
        execution_base_token=target.execution_base_token,
        execution_table_id=target.execution_table_id,
        execution_view_id=target.execution_view_id,
        bug_base_token=target.bug_base_token,
        bug_table_id=target.bug_table_id,
    )
    try:
        return read_draft_state(client, draft)
    except LarkError as error:
        # A target the app can no longer read stays a read error on the page
        # instead of an exception the administrator cannot act on.
        return {
            "execution_base_name": None,
            "execution_table_name": None,
            "bug_base_name": None,
            "bug_table_name": None,
            "execution_fields": {},
            "bug_fields": {},
            "schema_errors": [],
            "schema_fingerprint": None,
            "read_errors": [str(error)],
        }


@router.get("/lark/history/{history_ref_id}/attachments/{index}")
def legacy_attachment(
    history_ref_id: UUID,
    index: int,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> Response:
    reference = db.get(LarkHistoryRef, history_ref_id)
    if reference is None:
        raise HTTPException(status_code=404, detail="Legacy record not found")
    attachments = _snapshot_attachments(reference.snapshot)
    if index < 0 or index >= len(attachments):
        raise HTTPException(status_code=404, detail="Attachment not found")
    file_token = attachments[index].get("file_token")
    if not isinstance(file_token, str) or not file_token:
        raise HTTPException(status_code=404, detail="Attachment not found")

    try:
        content, content_type = client.download_media(file_token)
    except LarkError as error:
        raise HTTPException(status_code=502, detail=str(error)) from None
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=502, detail="Legacy attachment is too large")

    filename = str(attachments[index].get("name") or "legacy-attachment")
    filename = re.sub(r'[^A-Za-z0-9._-]+', "-", filename) or "legacy-attachment"
    declared = content_type.split(";")[0].strip().lower()
    return Response(
        content=content,
        # Never echo an upstream content type straight into the browser.
        media_type=declared if declared in ALLOWED_ATTACHMENT_TYPES else "application/octet-stream",
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
