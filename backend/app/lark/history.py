from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.fields import (
    DATE_FIELD_CANDIDATES,
    DESCRIPTION_FIELDS,
    LINK_FIELDS,
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    describe_fields,
    missing_required_fields,
    schema_fingerprint,
)
from app.models import LarkHistoryRef


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# The case code must be the whole leading token: "B-0010" must never be read as
# "B-001", and only an explicit "-R..." suffix marks a retest record.
CASE_REFERENCE = re.compile(
    r"^\s*(?P<code>[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)"
    r"(?P<retest>-R[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)?"
    r"(?![A-Za-z0-9-])"
)

EXPLICIT_LINK_FIELDS = ("关联用例", "用例编号")
CASE_TEXT_FIELDS = ("用例", "用例编号", "用例标题", "标题")


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
    return CaseReference(code=match.group("code"), retest_label=match.group("retest"))


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
    for record in records:
        reference = parse_case_reference(record_case_text(record))
        if reference is None or reference.code != code:
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
                reference = parse_case_reference(str(fields.get(name) or ""))
                if reference is not None and reference.code == code:
                    matched_by = name
                    break
        if matched_by is None:
            continue
        matches.append(
            {
                "record_id": record.get("record_id"),
                "description": next(
                    (str(fields.get(name)) for name in DESCRIPTION_FIELDS if fields.get(name)),
                    "",
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


@router.get("/lark/check")
def lark_check(
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    read_errors: list[str] = []
    for name, value in (
        ("LARK_APP_ID", settings.lark_app_id),
        ("LARK_APP_SECRET", settings.lark_app_secret),
        ("LARK_APP_TOKEN", settings.lark_app_token),
        ("LARK_TABLE_RUNS", settings.lark_table_runs),
        ("LARK_TABLE_DEFECTS", settings.lark_table_defects),
    ):
        if not value:
            read_errors.append(f"缺少配置 {name}")

    payload: dict[str, Any] = {
        "base_name": None,
        "execution_table_name": None,
        "bug_table_name": None,
        "execution_fields": {},
        "bug_fields": {},
        "required_execution_fields": sorted(REQUIRED_RUN_FIELD_TYPES),
        "required_bug_fields": sorted(REQUIRED_BUG_FIELD_TYPES),
        "schema_errors": [],
        "schema_fingerprint": None,
        "read_errors": read_errors,
    }
    if read_errors:
        return payload

    try:
        base = client.app_metadata(settings.lark_app_token)
        run_table = client.table_metadata(settings.lark_app_token, settings.lark_table_runs)
        bug_table = client.table_metadata(
            settings.lark_bug_app_token, settings.lark_table_defects
        )
        run_fields = client.list_fields(settings.lark_app_token, settings.lark_table_runs)
        bug_fields = client.list_fields(
            settings.lark_bug_app_token, settings.lark_table_defects
        )
    except LarkError as error:
        payload["read_errors"].append(str(error))
        return payload

    schema_errors = missing_required_fields(run_fields, REQUIRED_RUN_FIELD_TYPES)
    schema_errors += missing_required_fields(bug_fields, REQUIRED_BUG_FIELD_TYPES)
    payload.update(
        {
            "base_name": (base.get("app") or {}).get("name"),
            "execution_table_name": (run_table.get("table") or {}).get("name"),
            "bug_table_name": (bug_table.get("table") or {}).get("name"),
            "execution_fields": describe_fields(run_fields),
            "bug_fields": describe_fields(bug_fields),
            "schema_errors": schema_errors,
            "schema_fingerprint": (
                None
                if schema_errors
                else f"{schema_fingerprint(run_fields)}||{schema_fingerprint(bug_fields)}"
            ),
        }
    )
    return payload


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

    filename = str(attachments[index].get("name") or "legacy-attachment")
    filename = re.sub(r'[^A-Za-z0-9._-]+', "-", filename) or "legacy-attachment"
    return Response(
        content=content,
        media_type=content_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )
