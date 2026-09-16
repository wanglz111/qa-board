from sqlalchemy import select
from sqlalchemy.orm import Session

from app.lark.reconcile import reconcile_rows
from app.models import Attempt


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


def test_a_key_named_twice_in_one_payload_is_adopted_once(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={
            "decisions": [
                {"key": "B-001", "action": "use_remote"},
                {"key": "B-001", "action": "use_remote"},
            ]
        },
    ).json()

    assert body["pulled"] == 1
    assert body["skipped"] == [{"key": "B-001", "reason": "这条已经核对过"}]
    assert (
        len(db_session.scalars(select(Attempt).where(Attempt.source == "reconcile")).all())
        == 1
    )


def test_a_racing_apply_is_told_the_record_is_already_reconciled(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session, monkeypatch
):
    from app.lark import reconcile as reconcile_module

    lark_fake.records = [
        {"record_id": "r1", "fields": {"用例": "B-001 管理员登录", "结果": "通过"}}
    ]
    payload = {"decisions": [{"key": "B-001", "action": "use_remote"}]}
    authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply", json=payload
    )

    # A second request can run its read and its mark lookup before the first one
    # commits, so it sees neither the decision nor the mark and writes its own
    # copy, which then loses on uq_reconcile_key.
    real_read = reconcile_module.read_reconcile
    real_scalar = Session.scalar

    def stale_read(group_id, db, client, source="live"):
        body = real_read(group_id, db, client, source=source)
        body["rows"] = [{**row, "decision": None} for row in body["rows"]]
        return body

    def blind_scalar(self, statement, *args, **kwargs):
        if "reconcile_marks" in str(statement):
            return None
        return real_scalar(self, statement, *args, **kwargs)

    monkeypatch.setattr(reconcile_module, "read_reconcile", stale_read)
    monkeypatch.setattr(Session, "scalar", blind_scalar)
    second = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply", json=payload
    )

    assert second.status_code == 200
    assert second.json() == {
        "pulled": 0,
        "kept": 0,
        "skipped": [{"key": "B-001", "reason": "这条已经核对过"}],
    }
    assert (
        len(db_session.scalars(select(Attempt).where(Attempt.source == "reconcile")).all())
        == 1
    )


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
