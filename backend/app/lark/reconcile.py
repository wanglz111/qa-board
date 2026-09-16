from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.execution import allocate_attempt
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.history import parse_case_reference, record_case_text, record_fields
from app.lark.target import target_for
from app.models import Attempt, Group, GroupCase, LarkHistoryRef, ReconcileMark


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


READABLE_RESULTS = ("通过", "不通过", "未执行")
# A concurrent apply can claim a row between this request's read and its write.
# The loser retries against a fresh read, where the raced key reads as decided
# and the rest of the payload is genuinely applied.
MAX_APPLY_ATTEMPTS = 5


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


def _attempts(db: Session, group_id: UUID) -> list[Attempt]:
    """Only executed attempts take part in the diff.

    A row adopted from the table mirrors the table, so comparing it with the
    table would always agree and would drown out the real differences.
    """

    return list(
        db.scalars(
            select(Attempt)
            .join(GroupCase, Attempt.group_case_id == GroupCase.id)
            .where(GroupCase.group_id == group_id, Attempt.source == "execution")
            .order_by(Attempt.created_at, Attempt.sequence)
        ).all()
    )


def _stored_records(db: Session, group_id: UUID) -> list[dict[str, Any]]:
    rows = db.scalars(
        select(LarkHistoryRef)
        .join(GroupCase, LarkHistoryRef.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == group_id)
        .order_by(LarkHistoryRef.observed_at)
    ).all()
    return [{"record_id": row.old_record_id, "fields": row.snapshot} for row in rows]


@router.get("/groups/{group_id}/reconcile")
def read_reconcile(
    group_id: UUID,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
    source: Annotated[str, Query(pattern="^(live|stored)$")] = "live",
) -> dict[str, Any]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    target = target_for(db, group_id)
    local = [local_row(attempt) for attempt in _attempts(db, group_id)]
    known_codes = set(
        db.scalars(select(GroupCase.code).where(GroupCase.group_id == group_id)).all()
    )
    source_table_name: str | None = None
    read_errors: list[str] = []
    remote: list[dict[str, Any]] = []

    if source == "stored":
        remote = _stored_records(db, group_id)
        source_table_name = "本地快照"
    elif target is None:
        read_errors.append("该组尚未选择 Lark 表")
    else:
        try:
            remote = client.list_records(
                target.execution_base_token, target.execution_table_id
            )
            source_table_name = target.execution_table_name
        except LarkError as error:
            read_errors.append(str(error))

    rows = reconcile_rows(local=local, remote=remote, known_codes=known_codes)
    decided = {
        mark.record_key: mark.decision
        for mark in db.scalars(
            select(ReconcileMark).where(ReconcileMark.group_id == group_id)
        ).all()
    }
    for row in rows:
        row["decision"] = decided.get(row["key"])
    return {
        "source": source,
        "source_table_name": source_table_name,
        "read_errors": read_errors,
        "rows": rows,
        "counts": reconcile_counts(rows),
        "unresolved": sum(
            1 for row in rows if row["status"] != "same" and row["decision"] is None
        ),
    }


class Decision(BaseModel):
    key: str
    action: Literal["use_remote", "use_local"]


class ApplyRequest(BaseModel):
    decisions: list[Decision]


def _adopt(db: Session, group_id: UUID, row: dict[str, Any]) -> str | None:
    """Adopt one remote record by appending. Returns a skip reason, or None."""

    remote = row["remote"]
    if remote is None:
        return "表里没有这条记录"
    if row["status"] == "unmatched":
        return "本组没有这个用例编号"
    group_case = db.scalar(
        select(GroupCase)
        .where(GroupCase.group_id == group_id, GroupCase.code == remote["case_code"])
        .with_for_update()
    )
    if group_case is None:
        return "本组没有这个用例编号"

    # Reuse the table's label when it is free, so the next read pairs this row
    # with that record; a taken label means the group's own rule allocates one.
    taken = db.scalar(
        select(Attempt.id).where(
            Attempt.group_case_id == group_case.id, Attempt.label == remote["label"]
        )
    )
    adopted = allocate_attempt(db, group_case, label=None if taken else remote["label"])
    adopted.state = "committed"
    adopted.result = remote["result"]
    adopted.console_text = remote["console_text"]
    # Provenance: this row mirrors the table, it was not executed here, and it
    # must never be queued back to Lark as a new record.
    adopted.source = "reconcile"
    adopted.idempotency_key = f"reconcile-{group_id}-{adopted.label}"
    db.flush()
    return None


def _unique_violation(error: IntegrityError) -> str | None:
    """The constraint a Postgres unique violation named, when it named one."""

    return getattr(getattr(error.orig, "diag", None), "constraint_name", None)


def _apply_decisions(
    db: Session,
    group_id: UUID,
    client: LarkClient,
    payload: ApplyRequest,
) -> dict[str, Any]:
    """One attempt at applying a whole payload against a fresh read."""

    read = read_reconcile(group_id, db, client, source="live")
    if read["read_errors"]:
        raise HTTPException(status_code=409, detail="；".join(read["read_errors"]))
    rows = {row["key"]: row for row in read["rows"]}
    pulled = kept = 0
    skipped: list[dict[str, str]] = []
    # The mark is written inside this transaction, so a payload that names the
    # same key twice would otherwise adopt it twice before the read state moves.
    decided_keys: set[str] = set()
    for decision in payload.decisions:
        row = rows.get(decision.key)
        if row is None:
            skipped.append({"key": decision.key, "reason": "本次读取没有这条记录"})
            continue
        if row["status"] == "same":
            # Both sides already agree, so this key needs no decision.
            continue
        if row["decision"] is not None or decision.key in decided_keys:
            skipped.append({"key": decision.key, "reason": "这条已经核对过"})
            continue
        if decision.action == "use_remote":
            reason = _adopt(db, group_id, row)
            if reason is not None:
                skipped.append({"key": decision.key, "reason": reason})
                continue
            pulled += 1
        else:
            # The remote table only ever receives new records, so keeping the
            # local version is recorded rather than written back.
            kept += 1
        decided_keys.add(decision.key)
        mark = db.scalar(
            select(ReconcileMark).where(
                ReconcileMark.group_id == group_id,
                ReconcileMark.record_key == decision.key,
            )
        ) or ReconcileMark(group_id=group_id, record_key=decision.key)
        mark.decision = decision.action
        mark.remote_record_id = (row["remote"] or {}).get("record_id")
        db.add(mark)
    db.commit()
    return {"pulled": pulled, "kept": kept, "skipped": skipped}


@router.post("/groups/{group_id}/reconcile/apply")
def apply_reconcile(
    group_id: UUID,
    payload: ApplyRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    for remaining in range(MAX_APPLY_ATTEMPTS, 0, -1):
        try:
            return _apply_decisions(db, group_id, client, payload)
        except IntegrityError as error:
            db.rollback()
            # Only the decision log means "someone already reconciled this row".
            # Any other unique violation is a real error and must not be
            # reported as a recorded decision.
            if _unique_violation(error) != "uq_reconcile_key":
                raise
            if remaining == 1:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="这条记录刚被另一次核对写入，请重新读取后再核对",
                ) from None
    raise AssertionError("unreachable")
