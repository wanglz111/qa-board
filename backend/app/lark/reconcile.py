from __future__ import annotations

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import screenshots
from app.archive import refuse_archived_group
from app.auth import require_admin
from app.db import get_db
from app.execution import allocate_attempt
from app.lark import cache as lark_cache
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.history import parse_case_reference, record_case_text, record_fields
from app.lark.target import LarkTarget, target_for
from app.models import (
    LOCAL_SOURCES,
    Attempt,
    Group,
    GroupCase,
    LarkHistoryRef,
    ReconcileMark,
    Screenshot,
    SyncJob,
)


router = APIRouter(
    prefix="/api",
    dependencies=[Depends(require_admin), Depends(refuse_archived_group)],
)


READABLE_RESULTS = ("通过", "不通过", "未执行")
# A concurrent apply can claim a row between this request's read and its write.
# The loser retries against a fresh read, where the raced key reads as decided
# and the rest of the payload is genuinely applied.
MAX_APPLY_ATTEMPTS = 5

# Why a local row cannot be deleted. Each refusal is a different situation, and
# the administrator has to be able to tell them apart: one means waiting and
# reading again, another means this row never was the table's to begin with.
DELETE_NEEDS_AN_UPLOAD = "这条记录没有上传到表里，删不掉"
DELETE_NEEDS_A_LOCAL_ROW = "这条差异没有本地记录，删不掉"
DELETE_NEEDS_THE_SAME_TABLE = "这条记录上传时的目标表与当前表不一致，删不掉"
DELETE_REFUSED_STILL_IN_TABLE = "这条记录在表里还在，不能删"
DELETE_REFUSED_NEW_LABEL = "表里已经有一条同名的记录，请重新读取后再核对"
DELETE_REFUSED_MISSING = "本地这条记录已经不在，请重新读取"


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


def local_row(attempt: Any, remote_record_id: str | None = None) -> dict[str, Any]:
    return {
        "attempt_id": str(attempt.id),
        "case_code": attempt.group_case.code,
        "label": attempt.label,
        "result": attempt.result,
        "console_text": attempt.console_text,
        "remote_record_id": remote_record_id,
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
    local_by_record_id = {
        row["remote_record_id"]: row
        for row in local
        if row.get("remote_record_id")
    }
    parsed_remote = [parsed for record in remote if (parsed := remote_row(record))]
    remote_by_label: dict[str, dict[str, Any]] = {}

    # Durable record IDs are stronger than labels from old rows. Reserve those
    # keys first so Lark's return order cannot pair an attempt with a legacy row.
    for parsed in parsed_remote:
        linked = local_by_record_id.get(parsed["record_id"])
        if linked is not None:
            remote_by_label[linked["label"]] = parsed
    for parsed in parsed_remote:
        if parsed["record_id"] in local_by_record_id:
            continue
        key = parsed["label"]
        if key in remote_by_label:
            key = f"{key}@{parsed['record_id'] or len(remote_by_label) + 1}"
        remote_by_label[key] = parsed

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
                # Filled in by the reader: a pure join cannot tell a record that
                # was deleted from one it simply never saw.
                "remote_deleted": False,
            }
        )
    return rows


def _uploads(
    db: Session, attempts: list[Attempt]
) -> dict[str, tuple[str | None, str | None]]:
    """Each attempt's upload: the record it created and the table it went to."""

    if not attempts:
        return {}
    return {
        str(attempt_id): (record_id, fingerprint)
        for attempt_id, record_id, fingerprint in db.execute(
            select(
                SyncJob.attempt_id,
                SyncJob.new_exec_record_id,
                SyncJob.target_fingerprint,
            ).where(
                SyncJob.attempt_id.in_([attempt.id for attempt in attempts]),
                SyncJob.new_exec_record_id.is_not(None),
            )
        ).all()
    }


def _mark_deleted_records(
    rows: list[dict[str, Any]],
    remote: list[dict[str, Any]],
    uploads: dict[str, tuple[str | None, str | None]],
    target: LarkTarget | None,
) -> None:
    """Flag the local rows whose uploaded record is no longer in the table.

    The flag decides whether the page offers to delete a local row, so it errs
    towards "no". Two readings of "absent" are deliberately rejected:

    * the IDs come from the raw read, not from the rows that parsed — a record
      whose ``用例`` field no longer parses is still in the table, and reading
      "I cannot make sense of it" as "it was deleted" would invite deleting the
      local copy of a record that is still there;
    * a group re-pointed at another table answers "no" for the same reason: its
      old records are missing from this read, they were not deleted.

    A snapshot read (``source="stored"``) passes no target and therefore flags
    nothing: only a read of the table itself can witness a deletion.
    """

    if target is None:
        return
    present = {record.get("record_id") for record in remote}
    for row in rows:
        local = row["local"]
        if local is None:
            continue
        record_id, fingerprint = uploads.get(local["attempt_id"], (None, None))
        row["remote_deleted"] = bool(
            record_id
            and record_id not in present
            and fingerprint is not None
            and fingerprint == target.target_fingerprint
        )


def reconcile_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        status: 0
        for status in ("same", "local_only", "remote_only", "conflict", "unmatched")
    }
    for row in rows:
        counts[row["status"]] += 1
    return counts


def _attempts(db: Session, group_id: UUID) -> list[Attempt]:
    """Only the rows this tool owns take part in the diff.

    That is exactly ``LOCAL_SOURCES`` — ``execution`` plus ``import``. A row
    whose source is ``reconcile`` was adopted from the table and mirrors it, so
    comparing it with the table would always agree and would drown out the real
    differences.
    """

    return list(
        db.scalars(
            select(Attempt)
            .join(GroupCase, Attempt.group_case_id == GroupCase.id)
            .where(GroupCase.group_id == group_id, Attempt.source.in_(LOCAL_SOURCES))
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
    """The group's rows next to the table's, or next to the stored snapshot.

    ``source="live"`` means "read from Lark" as opposed to the rows this tool
    recorded: the rows come from the table, and since the record snapshot landed
    they may be answered from a copy taken up to a minute ago.
    """

    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    target = target_for(db, group_id)
    attempts = _attempts(db, group_id)
    uploads = _uploads(db, attempts)
    local = [
        local_row(attempt, uploads.get(str(attempt.id), (None, None))[0])
        for attempt in attempts
    ]
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
            remote = lark_cache.read_records(
                target.execution_base_token,
                target.execution_table_id,
                lambda: client.list_records(
                    target.execution_base_token, target.execution_table_id
                ),
            )
            source_table_name = target.execution_table_name
        except LarkError as error:
            read_errors.append(str(error))

    rows = reconcile_rows(local=local, remote=remote, known_codes=known_codes)
    _mark_deleted_records(rows, remote, uploads, target if source == "live" else None)
    decided = {
        mark.record_key: mark.decision
        for mark in db.scalars(
            select(ReconcileMark).where(ReconcileMark.group_id == group_id)
        ).all()
    }
    for row in rows:
        decision = decided.get(row["key"])
        # A record that left the table is a situation the recorded decision was
        # never about. Keeping it would leave the row reading as already
        # reconciled and therefore unselectable, which is precisely the dead end
        # this flag exists to end.
        row["decision"] = None if row["remote_deleted"] else decision
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
    action: Literal["use_remote", "use_local", "delete_local"]


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


def _delete_local(
    db: Session,
    group_id: UUID,
    row: dict[str, Any],
    client: LarkClient,
    target: LarkTarget | None,
) -> tuple[str | None, list[str]]:
    """Delete the local attempt whose record the administrator removed in Lark.

    Returns the reason it was refused, or None and the stored evidence keys the
    caller removes once the transaction has committed.

    Every guard is re-checked here against a read that bypasses the minute-long
    snapshot the diff may have answered from. That snapshot is good enough to
    show an administrator a difference; it is not good enough to delete with.
    """

    local = row["local"]
    if local is None:
        # The page never offers this, but the API is total: a key that names a
        # row with no local side answers a refusal rather than an error.
        return DELETE_NEEDS_A_LOCAL_ROW, []
    attempt_id = UUID(local["attempt_id"])
    record_id = local["remote_record_id"]
    if not record_id:
        return DELETE_NEEDS_AN_UPLOAD, []
    if target is None:
        return DELETE_NEEDS_THE_SAME_TABLE, []
    fingerprint = db.scalar(
        select(SyncJob.target_fingerprint).where(SyncJob.attempt_id == attempt_id)
    )
    if fingerprint is None or fingerprint != target.target_fingerprint:
        return DELETE_NEEDS_THE_SAME_TABLE, []

    # Deliberately before the row lock below: a statement waiting on that lock
    # counts against the 3 s statement_timeout, so it must not be held across an
    # HTTP request.
    records = client.list_records(target.execution_base_token, target.execution_table_id)
    if record_id in {record.get("record_id") for record in records}:
        return DELETE_REFUSED_STILL_IN_TABLE, []
    if any(
        parsed is not None and parsed["label"] == row["label"]
        for parsed in (remote_row(record) for record in records)
    ):
        return DELETE_REFUSED_NEW_LABEL, []

    locked = db.scalar(
        select(Attempt.id)
        .where(Attempt.id == attempt_id, Attempt.source.in_(LOCAL_SOURCES))
        .with_for_update()
    )
    if locked is None:
        return DELETE_REFUSED_MISSING, []
    attempt = db.get(Attempt, attempt_id)
    if attempt is None:
        return DELETE_REFUSED_MISSING, []
    keys = list(
        db.scalars(
            select(Screenshot.storage_key).where(Screenshot.attempt_id == attempt_id)
        ).all()
    )
    # The decision recorded for this key answered a difference that no longer
    # exists, and the label the row held is about to become free again: leaving
    # the mark behind would decide the next row to wear that name before anyone
    # had looked at it.
    db.execute(
        delete(ReconcileMark).where(
            ReconcileMark.group_id == group_id,
            ReconcileMark.record_key == row["key"],
        )
    )
    # The screenshot rows and the upload go with it through their foreign keys.
    db.delete(attempt)
    db.flush()
    return None, keys


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
    target = target_for(db, group_id)
    rows = {row["key"]: row for row in read["rows"]}
    pulled = kept = removed = 0
    skipped: list[dict[str, str]] = []
    # Files are removed after the commit, so a refused or rolled back payload
    # never deletes the evidence of a row that is still there.
    taken_evidence: list[str] = []
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
        elif decision.action == "delete_local":
            reason, keys = _delete_local(db, group_id, row, client, target)
            if reason is not None:
                skipped.append({"key": decision.key, "reason": reason})
                continue
            removed += 1
            taken_evidence.extend(keys)
        else:
            # The remote table only ever receives new records, so keeping the
            # local version is recorded rather than written back.
            kept += 1
        decided_keys.add(decision.key)
        if decision.action == "delete_local":
            # A mark would outlive the row it decided and pre-decide the next
            # one: the removal above is this key's whole outcome.
            continue
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
    # The rows are gone and cannot come back, so the files they named are now
    # unreachable: removing them is housekeeping, and failing to remove one
    # leaves an orphan rather than a row anyone can still see.
    for storage_key in taken_evidence:
        screenshots.discard_stored(storage_key)
    # An adoption only changes the local DB, so this is harmless rather than
    # necessary: the remote table the snapshot was taken from is untouched.
    lark_cache.invalidate_group(db, group_id)
    return {"pulled": pulled, "kept": kept, "removed": removed, "skipped": skipped}


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
