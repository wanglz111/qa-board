# TestDeck Lark Read-Back And Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Run tests and commit after every task; never point a test at a real Lark tenant. This plan needs `2026-09-16-04-lark-connection.md` to be complete first.

**Goal:** Read a group's Lark table back (live, or from stored snapshots), show a per-record diff against the local database, and let the administrator resolve each difference by hand with multi-select.

**Architecture:** A pure `reconcile_rows` function joins local attempts and remote records on the attempt label and classifies every row as `same`, `local_only`, `remote_only`, `conflict` or `unmatched`. The API exposes one read endpoint with a `source=live|stored` switch and one apply endpoint that receives an explicit list of decisions. **Adopting a remote record never edits an `Attempt`**: it appends a new committed attempt carrying `source='reconcile'`, exactly like the retest flow appends a new label. The diff therefore only ever compares `source='execution'` attempts, an adopted record cannot re-enter the diff, and a table-sourced attempt is never queued back to Lark. Every decision is recorded in `reconcile_marks` so a resolved row stops reappearing.

**Tech Stack:** FastAPI, httpx, SQLAlchemy/PostgreSQL/Alembic, React + Vitest, Playwright.

---

## Why Adoption Appends

`Attempt` is an append-only audit trail (`Plan 02 Task 1`), and progress and reports are derived from it:

- `group_progress` derives each case's state from the highest `sequence`, so appending a new attempt changes the effective result without touching the original.
- `Screenshot` rows hang off `attempt_id`, so rewriting `result`/`console_text` would leave the old screenshots attached to a conclusion they do not evidence.
- `reports.py` reports `case_history[-1]`, so an appended attempt silently becomes the reported result unless its origin is recorded.

Hence: adoption appends, the original row and its evidence stay byte-identical, and `Attempt.source` records where the row came from.

## File Ownership

- `backend/app/lark/reconcile.py`: the diff engine, the read endpoint and the apply endpoint.
- `backend/app/execution.py`: extracts `allocate_attempt` so both the retest flow and adoption use one label rule.
- `backend/app/lark/outbox.py`, `backend/app/reports.py`, `backend/app/models.py`: provenance and the exclusion of table-sourced attempts from outbound sync.
- `backend/alembic/versions/0010_reconcile_marks.py`: the decision log and `attempts.source`.
- `backend/tests/test_lark_reconcile.py`, `backend/tests/test_reports.py`: classification, append-only adoption, provenance and idempotency.
- `frontend/src/views/Reconcile.tsx`, `frontend/src/components/History.tsx`, `frontend/src/api.ts`, `frontend/src/App.tsx`: the reconciliation view and the provenance badge.

### Task 1: Classify The Differences

**Files:** Create `backend/app/lark/reconcile.py`, `backend/tests/test_lark_reconcile.py`.

- [ ] **Step 1: Write the failing classification test**

```python
from app.lark.reconcile import reconcile_rows


def _local(label: str, result: str, console: str | None = None) -> dict:
    return {
        "label": label,
        "result": result,
        "console_text": console,
        "attempt_id": f"a-{label}",
    }


def _remote(text: str, result: str, console: str | None = None) -> dict:
    return {
        "record_id": f"r-{text}",
        "fields": {"用例": text, "结果": result, "控制台": console},
    }


def test_classifies_every_row():
    rows = reconcile_rows(
        local=[_local("B-001", "通过"), _local("B-002", "不通过"), _local("B-004", "通过")],
        remote=[_remote("B-001 管理员登录", "通过"), _remote("B-003 钱包绑定", "不通过")],
        known_codes={"B-001", "B-002", "B-003", "B-004"},
    )
    by_key = {row["key"]: row for row in rows}
    assert by_key["B-001"]["status"] == "same"
    assert by_key["B-002"]["status"] == "local_only"
    assert by_key["B-003"]["status"] == "remote_only"
    assert by_key["B-004"]["status"] == "local_only"


def test_conflict_names_the_differing_parts():
    rows = reconcile_rows(
        local=[_local("B-001", "通过", "ok")],
        remote=[_remote("B-001 管理员登录", "不通过", "boom")],
        known_codes={"B-001"},
    )
    assert rows[0]["status"] == "conflict"
    assert rows[0]["differing"] == ["console_text", "result"]
    assert rows[0]["local"]["result"] == "通过"
    assert rows[0]["remote"]["result"] == "不通过"


def test_a_remote_record_for_an_unknown_case_is_unmatched():
    rows = reconcile_rows(
        local=[], remote=[_remote("B-999 不存在的用例", "通过")], known_codes={"B-001"}
    )
    assert rows[0]["status"] == "unmatched"
    assert rows[0]["case_code"] == "B-999"


def test_retest_labels_match_exactly():
    rows = reconcile_rows(
        local=[_local("B-001-R0918-01", "通过")],
        remote=[_remote("B-001-R0918-01 管理员登录", "通过")],
        known_codes={"B-001"},
    )
    assert [row["key"] for row in rows] == ["B-001-R0918-01"]
    assert rows[0]["status"] == "same"


def test_an_empty_remote_result_is_a_conflict_not_a_failure():
    rows = reconcile_rows(
        local=[], remote=[_remote("B-001 管理员登录", "")], known_codes={"B-001"}
    )
    assert rows[0]["remote"]["result"] == "未执行"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.lark.reconcile'`.

- [ ] **Step 3: Write the engine**

Create `backend/app/lark/reconcile.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/reconcile.py backend/tests/test_lark_reconcile.py
git commit -m "feat: classify local and Lark records into a reconciled diff"
```

### Task 2: Decision Log, Provenance And The Read Endpoint

**Files:** Modify `backend/app/lark/reconcile.py`, `backend/app/models.py`, `backend/app/main.py`; create `backend/alembic/versions/0010_reconcile_marks.py`; modify `backend/tests/test_lark_reconcile.py`.

- [ ] **Step 1: Write the failing read test**

```python
def test_live_read_compares_the_bound_table_with_the_local_database(
    lark_fake, authenticated_client, confirmed_group, failed_attempt
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}},
        {"record_id": "r2", "fields": {"用例": "B-009 只存在于表里", "结果": "不通过"}},
    ]
    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/reconcile?source=live"
    ).json()

    assert body["source"] == "live"
    assert body["source_table_name"] == "执行记录"
    by_key = {row["key"]: row for row in body["rows"]}
    assert by_key["B-001"]["status"] == "conflict"
    assert by_key["B-009"]["status"] == "unmatched"
    assert by_key["B-009"]["case_code"] == "B-009"
    assert body["counts"]["conflict"] == 1
    assert body["unresolved"] == 2


def test_stored_read_uses_persisted_snapshots(
    authenticated_client, confirmed_group, failed_attempt, history_ref
):
    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/reconcile?source=stored"
    ).json()
    assert body["source"] == "stored"
    assert body["rows"][0]["remote"]["record_id"] == "old1"


def test_reconcile_needs_a_selected_table(authenticated_client, imported_group):
    body = authenticated_client.get(
        f"/api/groups/{imported_group.id}/reconcile?source=live"
    ).json()
    assert body["read_errors"] == ["该组尚未选择 Lark 表"]
    assert body["rows"] == []


def test_the_diff_ignores_attempts_that_came_from_the_table(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    from app.execution import allocate_attempt

    case = failed_attempt.group_case
    adopted = allocate_attempt(db_session, case, label="B-001-R0918-01")
    adopted.state = "committed"
    adopted.result = "通过"
    adopted.source = "reconcile"
    db_session.commit()
    lark_fake.records = []

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/reconcile?source=live"
    ).json()
    # The adopted copy mirrors the table, so it must not become a "local" row
    # that then looks like it is missing from Lark.
    assert [row["key"] for row in body["rows"]] == ["B-001"]
    assert body["rows"][0]["status"] == "local_only"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py -q`
Expected: FAIL with 404 for `/api/groups/{id}/reconcile`.

- [ ] **Step 3: Add the storage and the read endpoint**

Add to `backend/app/models.py`:

```python
class ReconcileMark(Base):
    """One administrator decision about one record key, so it stops resurfacing."""

    __tablename__ = "reconcile_marks"
    __table_args__ = (
        UniqueConstraint("group_id", "record_key", name="uq_reconcile_key"),
        CheckConstraint(
            "decision IN ('use_remote', 'use_local')", name="ck_reconcile_decision"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    record_key: Mapped[str] = mapped_column(String, nullable=False)
    decision: Mapped[str] = mapped_column(String, nullable=False)
    remote_record_id: Mapped[str | None] = mapped_column(String)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

Add the provenance column to `Attempt` and extend its constraints:

```python
        CheckConstraint(
            "source IN ('execution', 'reconcile')", name="ck_attempts_source"
        ),
```

```python
    source: Mapped[str] = mapped_column(
        String, nullable=False, server_default="execution", default="execution"
    )
```

Create `backend/alembic/versions/0010_reconcile_marks.py` with `revision = "0010_reconcile_marks"` and `down_revision = "0009_lark_targets"`. `upgrade()` creates `reconcile_marks`, then runs `op.add_column("attempts", sa.Column("source", sa.String(), nullable=False, server_default="execution"))` followed by

```python
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile')"
    )
```

`downgrade()` drops the constraint and the column, then the table. Use the column styles of `0008_sync_jobs.py`.

Append the read endpoint to `backend/app/lark/reconcile.py`:

```python
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.lark.client import LarkClient, LarkError, get_lark_client
from app.lark.target import target_for
from app.models import Attempt, Group, GroupCase, LarkHistoryRef, ReconcileMark


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


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
```

`source=stored` reads persisted snapshots only and must never be used as a write target. Register the router in `backend/app/main.py`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py tests/test_migrations.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/reconcile.py backend/app/models.py backend/app/main.py backend/alembic/versions/0010_reconcile_marks.py backend/tests/test_lark_reconcile.py
git commit -m "feat: record attempt provenance and read a group's table back"
```

### Task 3: Adoption Appends, Never Edits

**Files:** Modify `backend/app/execution.py`, `backend/app/lark/reconcile.py`, `backend/tests/test_lark_reconcile.py`.

- [ ] **Step 1: Write the failing apply test**

```python
def test_pulling_a_remote_only_record_creates_a_table_sourced_attempt(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    lark_fake.records = [
        {"record_id": "r9", "fields": {"用例": "B-001-R0918-01 管理员登录", "结果": "通过"}}
    ]
    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001-R0918-01", "action": "use_remote"}]},
    ).json()
    assert body["pulled"] == 1

    attempt = db_session.scalar(select(Attempt).where(Attempt.label == "B-001-R0918-01"))
    assert attempt.result == "通过"
    assert attempt.state == "committed"
    assert attempt.source == "reconcile"
    assert attempt.idempotency_key == f"reconcile-{confirmed_group.id}-B-001-R0918-01"


def test_conflict_adoption_appends_and_leaves_the_original_untouched(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    original_result = failed_attempt.result
    original_console = failed_attempt.console_text
    original_sequence = failed_attempt.sequence
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    ).json()
    assert body["pulled"] == 1

    db_session.refresh(failed_attempt)
    assert failed_attempt.result == original_result
    assert failed_attempt.console_text == original_console
    assert failed_attempt.source == "execution"

    appended = db_session.scalar(select(Attempt).where(Attempt.source == "reconcile"))
    assert appended.result == "通过"
    assert appended.console_text is None
    assert appended.sequence > original_sequence
    # The table's label is already held by the original attempt, so the group's
    # own retest rule allocates the next one.
    assert appended.label.startswith("B-001-R0918-")
    assert appended.idempotency_key == f"reconcile-{confirmed_group.id}-{appended.label}"


def test_adoption_moves_progress_and_the_report_without_editing_history(
    lark_fake, authenticated_client, confirmed_group, failed_attempt
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    )
    progress = authenticated_client.get(f"/api/groups/{confirmed_group.id}/progress").json()
    assert progress["passed"] == 1
    assert progress["failed"] == 0

    report = authenticated_client.get(f"/api/groups/{confirmed_group.id}/reports.csv").text
    assert "reconcile" in report


def test_keeping_the_local_record_appends_nothing(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_local"}]},
    ).json()
    assert body["kept"] == 1
    assert failed_attempt.result == "不通过"
    assert db_session.scalars(select(Attempt).where(Attempt.source == "reconcile")).all() == []
    assert not any(
        request["method"] in ("PUT", "PATCH", "DELETE") for request in lark_fake.requests
    )


def test_a_decided_row_is_not_adopted_twice(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    payload = {"decisions": [{"key": "B-001", "action": "use_remote"}]}
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply", json=payload
    )
    second = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply", json=payload
    ).json()

    assert second["pulled"] == 0
    assert second["skipped"] == [{"key": "B-001", "reason": "这条已经核对过"}]
    assert len(db_session.scalars(select(Attempt).where(Attempt.source == "reconcile")).all()) == 1


def test_an_unknown_case_code_is_skipped_with_a_reason(
    lark_fake, authenticated_client, confirmed_group
):
    lark_fake.records = [
        {"record_id": "r7", "fields": {"用例": "B-777 不在本组", "结果": "通过"}}
    ]
    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-777", "action": "use_remote"}]},
    ).json()
    assert body["pulled"] == 0
    assert body["skipped"] == [{"key": "B-777", "reason": "本组没有这个用例编号"}]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py -q`
Expected: FAIL with 404 for `/api/groups/{id}/reconcile/apply`.

- [ ] **Step 3: Extract the shared allocator and implement the apply endpoint**

In `backend/app/execution.py`, extract the retest label rule so adoption uses the same one. Add `allocate_attempt` above `_reserve_attempt` and turn the existing helper into a delegating wrapper — the two call sites in `reserve_retest`/`submit_attempt` and the monkeypatch seam in `tests/test_retest.py:174` all keep working:

```python
def allocate_attempt(
    db: Session, group_case: GroupCase, *, label: str | None = None
) -> Attempt:
    """Reserve the next append-only slot for one case.

    ``sequence`` is always the highest for the case, so the newest committed row
    is the one progress and reports read. ``label`` may be supplied to name an
    adopted row after the record it mirrors, and falls back to the group's own
    retest rule when the name is already taken.
    """

    last_sequence = db.scalar(
        select(func.max(Attempt.sequence)).where(
            Attempt.group_case_id == group_case.id
        )
    )
    sequence = (last_sequence or 0) + 1
    resolved = label or (
        group_case.code
        if sequence == 1
        else f"{group_case.code}-R{group_case.group.short_code}-{sequence - 1:02}"
    )
    attempt = Attempt(
        group_case=group_case,
        label=resolved,
        sequence=sequence,
        state="started",
    )
    db.add(attempt)
    db.flush()
    return attempt


def _reserve_attempt(db: Session, group_case: GroupCase) -> Attempt:
    return allocate_attempt(db, group_case)
```

Both call sites already hold the `group_case` row lock (`_locked_case_or_404`), wrapped in `_with_conflict_retry`, so the existing concurrency behaviour is unchanged.

Append the apply endpoint to `backend/app/lark/reconcile.py`:

```python
from typing import Literal

from pydantic import BaseModel

from app.execution import allocate_attempt


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


@router.post("/groups/{group_id}/reconcile/apply")
def apply_reconcile(
    group_id: UUID,
    payload: ApplyRequest,
    db: Annotated[Session, Depends(get_db)],
    client: Annotated[LarkClient, Depends(get_lark_client)],
) -> dict[str, Any]:
    read = read_reconcile(group_id, db, client, source="live")
    if read["read_errors"]:
        raise HTTPException(status_code=409, detail="；".join(read["read_errors"]))
    rows = {row["key"]: row for row in read["rows"]}
    pulled = kept = 0
    skipped: list[dict[str, str]] = []
    for decision in payload.decisions:
        row = rows.get(decision.key)
        if row is None:
            skipped.append({"key": decision.key, "reason": "本次读取没有这条记录"})
            continue
        if row["status"] == "same":
            # Both sides already agree, so this key needs no decision.
            continue
        if row["decision"] is not None:
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py tests/test_execution.py tests/test_retest.py -q`
Expected: PASS. The retest suite proves the extracted allocator kept its old behaviour.

- [ ] **Step 5: Commit**

```bash
git add backend/app/lark/reconcile.py backend/app/execution.py backend/tests/test_lark_reconcile.py
git commit -m "feat: adopt Lark records by appending instead of rewriting attempts"
```

### Task 4: Keep Table-Sourced Attempts Out Of Lark And Say Where They Came From

**Files:** Modify `backend/app/lark/outbox.py`, `backend/app/execution.py`, `backend/app/reports.py`, `backend/tests/test_lark_reconcile.py`, `backend/tests/test_reports.py`, `frontend/src/api.ts`, `frontend/src/components/History.tsx`.

- [ ] **Step 1: Write the failing test**

```python
def test_a_table_sourced_attempt_is_never_queued_for_sync(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    from app.models import SyncJob

    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    )
    body = authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/enqueue").json()

    assert body["queued"] == 1
    labels = db_session.scalars(
        select(Attempt.label).join(SyncJob, SyncJob.attempt_id == Attempt.id)
    ).all()
    assert labels == ["B-001"]


def test_sync_status_does_not_count_table_sourced_attempts(
    lark_fake, authenticated_client, confirmed_group, failed_attempt
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    )
    assert authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()[
        "pending_attempts"
    ] == 1


def test_attempt_payload_and_report_expose_the_source(
    lark_fake, authenticated_client, confirmed_group, failed_attempt
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    )
    attempts = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts"
    ).json()
    assert [attempt["source"] for attempt in attempts] == ["execution", "reconcile"]

    report = authenticated_client.get(f"/api/groups/{confirmed_group.id}/reports.csv").text
    header, *lines = report.splitlines()
    assert header.split(",")[-1] == "source"
    assert lines[0].endswith("reconcile")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_lark_reconcile.py -q`
Expected: FAIL — `/sync/enqueue` queues both attempts, and neither the payload nor the report has a `source`.

- [ ] **Step 3: Filter the sync paths and surface the source**

In `backend/app/lark/outbox.py`, add `Attempt.source == "execution"` to both selections so an adopted row is never written back to Lark as a new record:

```python
    attempt_ids = db.scalars(
        select(Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(
            GroupCase.group_id == group_id,
            Attempt.state == "committed",
            Attempt.source == "execution",
        )
    ).all()
```

and in `read_sync`:

```python
    pending_attempts = db.scalar(
        select(func.count())
        .select_from(Attempt)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(
            GroupCase.group_id == group_id,
            Attempt.state == "committed",
            Attempt.source == "execution",
        )
    )
```

In `backend/app/execution.py`, add `"source": attempt.source` to `_attempt_payload`.

In `backend/app/reports.py`, append `"source"` to `HEADERS`, add `"source": latest.source if latest else None` to each row, and extend the XLSX writer's header/row lists to match (they are built from `HEADERS` and the row dict order, so keep both in the same order).

In `frontend/src/api.ts`, extend the `Attempt` type with `source: "execution" | "reconcile"`. In `frontend/src/components/History.tsx`, render a `<span className="attempt-source">来自表内对账</span>` badge when `attempt.source === "reconcile"`, styled in `frontend/src/styles.css` next to `.result-badge`. Update the `Attempt` fixtures in `frontend/src/views/Execution.test.tsx` and `frontend/src/components/History`'s tests to include `source: "execution"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest -q && cd ../frontend && npm test -- --run`
Expected: PASS on both suites.

- [ ] **Step 5: Commit**

```bash
git add backend/app backend/tests frontend/src
git commit -m "feat: mark table-sourced attempts and keep them out of Lark sync"
```

### Task 5: The Reconciliation View

**Files:** Create `frontend/src/views/Reconcile.tsx`, `frontend/src/views/Reconcile.test.tsx`; modify `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/styles.css`, `frontend/e2e/reconcile.spec.ts`.

- [ ] **Step 1: Write the failing view test**

```tsx
it("selects rows in bulk and applies the chosen side", async () => {
  const apply = vi.fn().mockResolvedValue({ pulled: 2, kept: 0, skipped: [] });
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={apply} />);

  await userEvent.click(await screen.findByLabelText("全选有差异的记录"));
  await userEvent.click(screen.getByRole("button", { name: "采用表内记录（2）" }));

  expect(apply).toHaveBeenCalledWith("g1", [
    { key: "B-001", action: "use_remote" },
    { key: "B-002", action: "use_remote" }
  ]);
});

it("says that adopting appends a new record instead of overwriting", async () => {
  render(<Reconcile groupId="g1" load={vi.fn().mockResolvedValue(DIFF)} apply={vi.fn()} />);
  await userEvent.click(await screen.findByLabelText("选择 B-001"));
  await userEvent.click(screen.getByRole("button", { name: "采用表内记录（1）" }));

  const dialog = await screen.findByRole("dialog");
  expect(dialog).toHaveTextContent("新增一条");
  expect(dialog).toHaveTextContent("本地原始记录和截图会原样保留");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run src/views/Reconcile.test.tsx`
Expected: FAIL — the `Reconcile` view does not exist.

- [ ] **Step 3: Build the view**

Add to `frontend/src/api.ts`:

```ts
export type ReconcileRow = {
  key: string;
  case_code: string;
  label: string;
  status: "same" | "local_only" | "remote_only" | "conflict" | "unmatched";
  differing: string[];
  local: { attempt_id: string; result: string | null; console_text: string | null } | null;
  remote: { record_id: string | null; result: string | null; console_text: string | null } | null;
  decision: "use_remote" | "use_local" | null;
};

export type ReconcileDiff = {
  source: "live" | "stored";
  source_table_name: string | null;
  read_errors: string[];
  rows: ReconcileRow[];
  counts: Record<ReconcileRow["status"], number>;
  unresolved: number;
};

export type ReconcileDecision = { key: string; action: "use_remote" | "use_local" };
```

and to the `api` object:

```ts
  reconcile: (groupId: string, source: "live" | "stored") =>
    request<ReconcileDiff>(`/api/groups/${groupId}/reconcile?source=${source}`),
  applyReconcile: (groupId: string, decisions: ReconcileDecision[]) =>
    mutation<{ pulled: number; kept: number; skipped: { key: string; reason: string }[] }>(
      `/api/groups/${groupId}/reconcile/apply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions })
      }
    ),
```

`Reconcile.tsx` takes `{ groupId, load, apply }` and renders:

- a group selector plus a 「当场读表 / 读本地快照」 switch that re-calls `load` with `live` or `stored`;
- the source table name and a counts line (`一致 N · 仅本地 N · 仅表里 N · 冲突 N`);
- a table with one checkbox per unresolved row, a 「全选有差异的记录」 checkbox in the header, and per row the case code, the local value, the remote value and the differing field names highlighted;
- 「采用表内记录」 and 「保留本地记录」 buttons acting on the ticked rows, disabled while nothing is ticked, showing the ticked count;
- a confirmation dialog before 「采用表内记录」 that states plainly: 这会在本组新增一条记录（`source=reconcile`），本地原始记录和截图会原样保留，这条新记录不会写回 Lark；and a hint that 「保留本地记录」 only records the decision, because the table never receives updates;
- a result line after applying (`已拉回 N 条 · 保留 N 条`) plus each skip reason, and a 「已核对」 marker on rows that carry a `decision`.

Add a 「对账」 entry to the navigation in `frontend/src/App.tsx`, wired to `api.reconcile`/`api.applyReconcile`, and style the view in `frontend/src/styles.css` using the existing `.workspace-section` and `.lark-panel` classes. Add `frontend/e2e/reconcile.spec.ts` with one desktop and one 360px scenario showing a conflict row, selecting it, confirming the append dialog and applying.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npm test -- --run && npm run build && npx playwright test`
Expected: PASS with a clean production build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src frontend/e2e
git commit -m "feat: reconcile a group's Lark table with its local records"
```

## Final Delivery Evidence

Run `cd backend && python -m pytest -q`, `cd frontend && npm test -- --run && npm run build`, `cd frontend && npx playwright test`, and `git diff --check`. Then verify all four append-only contracts explicitly:

1. After adopting a conflicting row, the original attempt's `result`, `console_text`, `sequence` and `Screenshot` rows are byte-identical (assert on the ORM object, not a re-read).
2. `POST /api/groups/{id}/sync/enqueue` queues exactly the execution-sourced attempts.
3. The share of code that issues record mutations is still empty: the fake Lark log contains no PUT, PATCH or DELETE, and reconciling there issues only GETs.
4. `source=stored` works with the Lark client unreachable.

Record each task's commit hash in `task_plan.md` before starting the next task.
