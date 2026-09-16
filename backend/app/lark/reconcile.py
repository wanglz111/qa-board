from __future__ import annotations

from typing import Any

from app.lark.history import parse_case_reference, record_case_text, record_fields


READABLE_RESULTS = ("通过", "不通过", "未执行")


def normalize_result(value: Any) -> str:
    text = str(value or "").strip()
    return text if text in READABLE_RESULTS else "未执行"


def remote_row(record: dict[str, Any]) -> dict[str, Any] | None:
    """One execution record as a comparable row, or None when it is unreadable."""

    reference = parse_case_reference(record_case_text(record))
    if reference is None:
        return None
    fields = record_fields(record)
    return {
        "record_id": record.get("record_id"),
        "case_code": reference.code,
        "label": f"{reference.code}{reference.retest_label or ''}",
        "result": normalize_result(fields.get("结果")),
        "console_text": fields.get("控制台"),
    }


def local_row(attempt: Any) -> dict[str, Any]:
    return {
        "attempt_id": str(attempt.id),
        "case_code": attempt.group_case.code,
        "label": attempt.label,
        "result": attempt.result,
        "console_text": attempt.console_text,
    }


def _differing(local: dict[str, Any], remote: dict[str, Any]) -> list[str]:
    return sorted(
        field
        for field in ("result", "console_text")
        if (local.get(field) or "") != (remote.get(field) or "")
    )


def reconcile_rows(
    local: list[dict[str, Any]],
    remote: list[dict[str, Any]],
    known_codes: set[str],
) -> list[dict[str, Any]]:
    """Join executed local attempts and remote records on the attempt label.

    Ordering is stable so the page does not reshuffle between reads.
    """

    local_by_label = {row["label"]: row for row in local}
    remote_by_label: dict[str, dict[str, Any]] = {}
    for record in remote:
        parsed = remote_row(record)
        if parsed is not None:
            remote_by_label[parsed["label"]] = parsed

    rows: list[dict[str, Any]] = []
    for label in sorted(set(local_by_label) | set(remote_by_label)):
        local_match = local_by_label.get(label)
        remote_match = remote_by_label.get(label)
        case_code = (local_match or remote_match or {}).get("case_code", "")
        if case_code and case_code not in known_codes:
            status = "unmatched"
        elif local_match and remote_match:
            status = "conflict" if _differing(local_match, remote_match) else "same"
        elif local_match:
            status = "local_only"
        else:
            status = "remote_only"
        rows.append(
            {
                "key": label,
                "case_code": case_code,
                "label": label,
                "status": status,
                "differing": (
                    _differing(local_match, remote_match)
                    if local_match and remote_match
                    else []
                ),
                "local": local_match,
                "remote": remote_match,
            }
        )
    return rows


def reconcile_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        status: 0
        for status in ("same", "local_only", "remote_only", "conflict", "unmatched")
    }
    for row in rows:
        counts[row["status"]] += 1
    return counts
