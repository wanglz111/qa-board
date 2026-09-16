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
