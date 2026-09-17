from dataclasses import replace
from uuid import UUID

import pytest

from app.config import settings
from app.lark import history as lark_history_module
from app.lark.history import match_bugs, parse_case_reference


@pytest.fixture(autouse=True)
def isolated_attachment_cache(tmp_path, monkeypatch):
    """Give every test its own on-disk attachment cache.

    ``legacy_attachment`` caches each download beside ``settings.upload_dir``,
    which the suite leaves at its relative default. Shared, one test's cached
    picture would answer the next test's fetch — stale bytes (or a stale 200
    where a 502 is expected) for the very token the next test sets up.
    """

    patched = replace(settings, upload_dir=str(tmp_path / "uploads"))
    monkeypatch.setattr(lark_history_module, "settings", patched)


def test_old_b001_is_not_b001_retest_and_adapter_never_writes(lark_fake):
    lark_fake.records = [
        {
            "record_id": "old1",
            "fields": {"用例": "B-001 Login", "结果": "不通过", "日期": 1_700_000_000_000},
        },
        {
            "record_id": "new1",
            "fields": {"用例": "B-001-R0918-01 Login", "结果": "通过", "日期": 1_700_100_000_000},
        },
    ]

    history = lark_fake.history_for("B-001")

    assert history.original[0]["record_id"] == "old1"
    assert history.retests[0]["record_id"] == "new1"
    assert history.certainty == "verified"
    assert history.latest["record_id"] == "new1"
    assert not any(method in ("PUT", "PATCH", "DELETE") for method in lark_fake.record_methods)


def test_case_code_boundary_keeps_b0010_separate(lark_fake):
    lark_fake.records = [
        {"record_id": "ten", "fields": {"用例": "B-0010 Login", "结果": "通过"}},
        {"record_id": "one", "fields": {"用例": "B-001 Login", "结果": "不通过"}},
        {"record_id": "suffix", "fields": {"用例": "B-0019 x", "结果": "通过"}},
    ]

    history = lark_fake.history_for("B-001")

    assert [record["record_id"] for record in history.original] == ["one"]
    assert parse_case_reference("B-0010 Login").code == "B-0010"
    assert parse_case_reference("B-001-R0918-01 Login").retest_label == "-R0918-01"
    assert parse_case_reference("绑定钱包 B-001") is None


def test_multi_segment_codes_keep_their_full_code_and_underscores_stay_ambiguous():
    assert parse_case_reference("TC-001-02 登录").code == "TC-001-02"
    assert parse_case_reference("B-001_2 登录") is None
    assert parse_case_reference("B-001-R0918-01 登录").code == "B-001"
    # Case is normalised for matching, not invented into a new code.
    assert parse_case_reference("b-001 login").code == "b-001"


def test_unparsed_legacy_rows_stay_visible(lark_fake):
    lark_fake.records = [
        {"record_id": "u1", "fields": {"用例": "管理员登录流程", "结果": "不通过"}},
        {"record_id": "u2", "fields": {"用例": "B-001 Login", "结果": "通过"}},
    ]

    history = lark_fake.history_for("B-001")

    assert [record["record_id"] for record in history.original] == ["u2"]
    assert [record["record_id"] for record in history.unknown] == ["u1"]


def test_lowercase_legacy_code_still_matches(lark_fake):
    lark_fake.records = [
        {"record_id": "lower", "fields": {"用例": "b-001 login", "结果": "不通过"}}
    ]

    history = lark_fake.history_for("B-001")

    assert [record["record_id"] for record in history.original] == ["lower"]


def test_paginated_reads_collect_every_page(lark_fake):
    lark_fake.page_size = 500
    lark_fake.records = [
        {
            "record_id": f"record-{index}",
            "fields": {"用例": "B-001 Login", "日期": 1_600_000_000_000 + index * 1000},
        }
        for index in range(503)
    ]

    records = lark_fake.client.list_records("app-token", "tbl-runs")
    history = lark_fake.history_for("B-001")

    assert len(records) == 503
    assert history.original[0]["record_id"] == "record-0"
    assert history.latest["record_id"] == "record-502"
    assert [request["method"] for request in lark_fake.record_requests] == ["GET", "GET"]


def test_multiple_undated_originals_stay_ambiguous(lark_fake):
    lark_fake.records = [
        {"record_id": "a", "fields": {"用例": "B-001 Login", "结果": "不通过"}},
        {"record_id": "b", "fields": {"用例": "B-001 Login", "结果": "通过"}},
    ]

    history = lark_fake.history_for("B-001")

    assert history.certainty == "uncertain"
    assert history.latest is None
    assert len(history.ambiguous) == 2
    assert "日期" in history.uncertainty


def test_old_bug_is_matched_read_only(lark_fake):
    lark_fake.bug_records = [
        {
            "record_id": "bug1",
            "fields": {
                "问题描述": "B-001 绑定未触发",
                "进展状态": "待修复",
                "优先级": "P0",
                "反馈时间": 1_699_000_000_000,
            },
        },
        {
            "record_id": "bug2",
            "fields": {"问题描述": "B-0010 另一个问题", "进展状态": "待修复"},
        },
    ]

    matches = match_bugs(lark_fake.bug_records, "B-001")

    assert [match["record_id"] for match in matches] == ["bug1"]
    assert matches[0]["status"] == "待修复"
    assert matches[0]["description"] == "B-001 绑定未触发"
    assert lark_fake.bug_records[0]["fields"]["进展状态"] == "待修复"
    assert not any(
        method in ("PUT", "PATCH", "DELETE") for method in lark_fake.client.record_methods
    )


def test_bug_this_tool_created_is_matched_through_its_marker():
    """The outbox writes 【自动提】 rows, so the read must see through it."""

    records = [
        {
            "record_id": "auto1",
            "fields": {
                "问题描述": "【自动提】B-005 发售阶段期次表与名额公式\n旧表没有该用例的失败记录",
                "进展状态": "待修复",
            },
        },
        # The marker must not blur the case-code boundary.
        {
            "record_id": "other",
            "fields": {"问题描述": "【自动提】B-0050 另一个用例", "进展状态": "待修复"},
        },
        # An ordinary legacy row keeps matching exactly as before.
        {
            "record_id": "legacy",
            "fields": {"问题描述": "【已修复】B-005 旧缺陷", "进展状态": "已修复"},
        },
    ]

    matches = match_bugs(records, "B-005")

    assert [match["record_id"] for match in matches] == ["auto1", "legacy"]


def test_read_audit_is_get_only(lark_fake):
    lark_fake.records = [{"record_id": "old1", "fields": {"用例": "B-001"}}]
    lark_fake.media["secret-file-token"] = (b"png-bytes", "image/png")

    lark_fake.client.list_records("app-token", "tbl-runs")
    lark_fake.client.list_fields("app-token", "tbl-runs")
    lark_fake.client.download_media("secret-file-token")

    methods = [call.method for call in lark_fake.client.calls]
    assert methods == ["POST", "GET", "GET", "GET"]
    assert lark_fake.client.calls[0].path.endswith("tenant_access_token/internal")
    assert lark_fake.record_methods == ["GET"]


def test_legacy_attachment_proxy_is_private_and_hides_the_token(
    authenticated_client, anonymous_client, lark_fake, history_ref
):
    lark_fake.media["secret-file-token"] = (b"old-png-bytes", "image/png")
    url = f"/api/lark/history/{history_ref.id}/attachments/0"

    assert anonymous_client.get(url).status_code == 401

    response = authenticated_client.get(url)

    assert response.status_code == 200
    assert response.content == b"old-png-bytes"
    assert response.headers["cache-control"] == "private, max-age=86400"
    assert "secret-file-token" not in response.text
    assert "secret-file-token" not in str(response.headers)
    assert (
        'attachment; filename="..-..-old-shot.png"'
        == response.headers["content-disposition"]
    )

    missing = authenticated_client.get(f"/api/lark/history/{history_ref.id}/attachments/9")
    assert missing.status_code == 404


def test_legacy_attachment_reports_unavailable_lark_object(
    authenticated_client, lark_fake, history_ref
):
    response = authenticated_client.get(f"/api/lark/history/{history_ref.id}/attachments/0")

    assert response.status_code == 502
    assert "secret-file-token" not in response.text


def test_legacy_attachment_denied_by_lark_is_reported_without_leaks(
    authenticated_client, lark_fake, history_ref
):
    lark_fake.media_unauthorized = True

    response = authenticated_client.get(f"/api/lark/history/{history_ref.id}/attachments/0")

    assert response.status_code == 502
    assert "secret-file-token" not in response.text
    assert "secret-file-token" not in str(response.headers)


def test_attachment_proxy_sets_nosniff_and_a_safe_content_type(
    authenticated_client, lark_fake, history_ref
):
    lark_fake.media["secret-file-token"] = (b"<svg/>", "image/svg+xml")

    response = authenticated_client.get(f"/api/lark/history/{history_ref.id}/attachments/0")

    assert response.status_code == 200
    # An upstream type the allowlist does not know is never echoed back.
    assert response.headers["content-type"].startswith("application/octet-stream")
    assert response.headers["x-content-type-options"] == "nosniff"


def test_case_history_endpoint_lists_legacy_records_for_one_case(
    authenticated_client, lark_fake, confirmed_group, db_session
):
    from app.models import LarkHistoryRef

    lark_fake.records = [
        {
            "record_id": "old1",
            "fields": {
                "用例": "B-001 Login",
                "结果": "不通过",
                "备注": "绑定未触发",
                "日期": 1_700_000_000_000,
                "截图": [{"file_token": "attach-1", "name": "old shot.png", "type": "image/png"}],
            },
        },
        {
            "record_id": "new1",
            "fields": {
                "用例": "B-001-R0918-01 Login",
                "结果": "通过",
                "日期": 1_700_100_000_000,
            },
        },
        {"record_id": "other", "fields": {"用例": "C-777 其他", "结果": "通过"}},
    ]
    lark_fake.bug_records = [
        {
            "record_id": "bug1",
            "fields": {
                "问题描述": "B-001 绑定未触发",
                "进展状态": "待修复",
                "优先级": "P0",
            },
        }
    ]

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is True
    assert body["source_table_name"] == "执行记录"
    assert body["certainty"] == "verified"
    assert [item["record_id"] for item in body["original"]] == ["old1"]
    assert [item["record_id"] for item in body["retests"]] == ["new1"]
    assert body["bugs"][0]["status"] == "待修复"
    assert body["unknown_count"] == 0
    first = body["original"][0]
    assert first["note"] == "绑定未触发"
    assert first["attachments"] == [{"index": 0, "name": "old shot.png", "mime": "image/png"}]
    # The listed reference is what the private attachment proxy uses.
    assert db_session.get(LarkHistoryRef, UUID(first["ref_id"])) is not None
    assert lark_fake.client.record_methods == ["GET", "GET"]


def test_case_history_endpoint_reports_a_target_that_cannot_be_read(
    authenticated_client, lark_fake, confirmed_group
):
    """An unreadable stored target is reported instead of raising."""

    lark_fake.bases_error = True

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is False
    assert body["original"] == []
    assert body["read_errors"]
    assert not [request for request in lark_fake.requests if "/records" in request["path"]]


def test_case_history_reads_the_groups_own_stored_target(
    authenticated_client, lark_fake, confirmed_group
):
    """The audit of the read path: the stored bases, not a hardcoded one."""

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    lark_fake.bug_records = [
        {"record_id": "bug1", "fields": {"问题描述": "B-001 绑定未触发"}}
    ]

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is True
    assert [
        request["path"] for request in lark_fake.requests if "/records" in request["path"]
    ] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]
    assert [request["method"] for request in lark_fake.record_requests] == ["GET", "GET"]


def test_case_history_endpoint_says_when_no_target_is_chosen(
    authenticated_client, imported_group
):
    """Without a stored row there is no table to read, and no Lark call is made."""

    body = authenticated_client.get(
        f"/api/groups/{imported_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is False
    assert body["read_errors"] == ["该组尚未选择 Lark 表"]
    assert body["original"] == []


def test_opening_one_case_reads_each_table_once_and_no_fields(
    authenticated_client, lark_fake, confirmed_group
):
    """The read the page repeats most: two record reads and nothing else."""

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    lark_fake.requests.clear()

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )

    assert response.status_code == 200, response.text
    paths = [
        request["path"] for request in lark_fake.requests if request["method"] == "GET"
    ]
    assert paths == [
        "/open-apis/bitable/v1/apps/app-exec",
        "/open-apis/bitable/v1/apps/app-exec/tables",
        "/open-apis/bitable/v1/apps/app-bug",
        "/open-apis/bitable/v1/apps/app-bug/tables",
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]
    body = response.json()
    assert body["source_table_name"] == "执行记录"
    assert body["bug_table_name"] == "缺陷记录"


def test_case_history_reports_a_target_whose_records_cannot_be_read(
    authenticated_client, lark_fake, confirmed_group
):
    """A readable target whose rows are refused keeps the unreadable state."""

    lark_fake.records_error = True

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is False
    assert body["read_errors"]
    assert body["original"] == []


def test_case_history_reports_a_stored_table_missing_from_the_listing(
    authenticated_client, lark_fake, confirmed_group
):
    """A readable base whose listing no longer carries the stored table."""

    lark_fake.bases["app-exec"] = ("执行库", [("tbl-gone", "已删除的表")])

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is False
    assert body["read_errors"] == ["Lark 中找不到执行记录表 tbl-runs"]
    assert not lark_fake.record_requests


def test_two_cases_in_a_row_share_one_table_read(
    authenticated_client, lark_fake, confirmed_group, add_case
):
    """Working through a group re-reads the same table; the snapshot answers."""

    # The group needs a second case to work through; the fixture imports one.
    add_case(confirmed_group.id, code="B-002", title="绑定登录")
    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}},
        {"record_id": "old2", "fields": {"用例": "B-002 Login", "结果": "通过"}},
    ]
    lark_fake.requests.clear()

    for code in ("B-001", "B-002"):
        response = authenticated_client.get(
            f"/api/groups/{confirmed_group.id}/cases/{code}/lark-history"
        )
        assert response.status_code == 200, response.text

    record_reads = [
        request["path"]
        for request in lark_fake.requests
        if "/records" in request["path"]
    ]
    assert (
        record_reads.count("/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records")
        == 1
    )


def test_a_warm_snapshot_costs_no_lark_request_at_all(
    authenticated_client, lark_fake, confirmed_group, add_case
):
    """The second case in a sitting should not touch Lark for names or records."""

    add_case(confirmed_group.id, code="B-002", title="绑定登录")
    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.requests.clear()

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-002/lark-history"
    )

    assert response.status_code == 200, response.text
    assert lark_fake.requests == []


def test_creating_an_attempt_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """The row this operator just wrote has to be visible on the next read.

    This pins ``create_attempt``. The reserved-attempt submission is a separate
    write with its own invalidation, and a test of its own below.
    """

    lark_fake.records = []
    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.records = [
        {"record_id": "mine", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]

    submitted = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "console_text": "",
            "idempotency_key": "key-snapshot-1",
        },
    )
    assert submitted.status_code == 201, submitted.text

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["mine"]


def test_a_transient_name_read_failure_is_not_cached(
    authenticated_client, lark_fake, confirmed_group
):
    """A refused read must heal on the next request, not linger for the TTL."""

    lark_fake.bases_error = True
    unavailable = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert unavailable["available"] is False
    assert unavailable["read_errors"]

    lark_fake.bases_error = False
    healed = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert healed["available"] is True
    assert healed["source_table_name"] == "执行记录"


def test_an_idle_queue_lets_the_panel_see_the_row_the_worker_filed(
    authenticated_client, lark_fake, confirmed_group
):
    """The worker runs in another container, so it cannot drop this snapshot.

    The page polls the sync summary while it waits, and an empty queue is the
    moment this process knows that whatever it cached before the worker ran is
    out of date.
    """

    lark_fake.records = []
    empty = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert empty["original"] == []

    # What the worker in the other container just filed.
    lark_fake.records = [
        {"record_id": "filed", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    summary = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync")
    assert summary.status_code == 200, summary.text
    assert summary.json()["queued"] == 0

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["filed"]


def test_reserving_a_retest_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """A reservation is a write of this process's own, so the next read is live."""

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.requests.clear()

    reserved = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/retest"
    )
    assert reserved.status_code == 201, reserved.text

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    assert response.status_code == 200, response.text
    assert lark_fake.record_requests


def test_submitting_a_reserved_attempt_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """A submission is this process's own write, so the next read is live."""

    reserved = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/retest"
    )
    assert reserved.status_code == 201, reserved.text
    attempt_id = reserved.json()["id"]

    # Warmed *after* the reservation: the reservation drops the snapshot too, so
    # only a snapshot taken between it and the submit is the submit's to discard.
    lark_fake.records = []
    warmed = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert warmed["original"] == []

    # What the worker in the other container files once this row is queued.
    lark_fake.records = [
        {"record_id": "filed", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    submitted = authenticated_client.post(
        f"/api/attempts/{attempt_id}/submit",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "console_text": "",
            "idempotency_key": "key-submit-snapshot-1",
        },
    )
    assert submitted.status_code == 200, submitted.text

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["filed"]


def _save_target(
    client,
    group_id,
    *,
    execution_base_token: str,
    execution_table_id: str,
    bug_base_token: str,
    bug_table_id: str,
):
    """One acknowledged save, the way the connection page sends it."""

    response = client.put(
        f"/api/groups/{group_id}/lark/target",
        json={
            "source_url": "https://tenant.larksuite.com/wiki/node-1",
            "execution_base_token": execution_base_token,
            "execution_table_id": execution_table_id,
            "execution_view_id": None,
            "bug_base_token": bug_base_token,
            "bug_table_id": bug_table_id,
            "expected_previous_fingerprint": None,
            "acknowledge_change": True,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_saving_a_target_back_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """A save drops what this process cached for the row it just wrote.

    Only this shape discriminates. Saving *to* a destination can never serve it,
    because nothing read it yet; saving *back* to the one the panel warmed on is
    the read that would otherwise answer from the entry the warm read left.
    """

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    warmed = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in warmed["original"]] == ["old1"]

    _save_target(
        authenticated_client,
        confirmed_group.id,
        execution_base_token="app-token",
        execution_table_id="tbl-runs",
        bug_base_token="app-token",
        bug_table_id="tbl-defects",
    )
    lark_fake.records = [
        {"record_id": "new1", "fields": {"用例": "B-001 Login", "结果": "不通过"}}
    ]
    _save_target(
        authenticated_client,
        confirmed_group.id,
        execution_base_token="app-exec",
        execution_table_id="tbl-runs",
        bug_base_token="app-bug",
        bug_table_id="tbl-defects",
    )

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["new1"]


def test_retyping_a_header_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """A retype changes a column's type, so the panel's copy of the table is stale."""

    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.requests.clear()

    # 结果 is one of the two headers the standard fake carries as plain text.
    retyped = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/provision/retype",
        json={"role": "execution", "field_names": ["结果"], "acknowledge": True},
    )
    assert retyped.status_code == 200, retyped.text
    assert retyped.json()["retyped_fields"] == ["结果"]

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    assert response.status_code == 200, response.text
    assert lark_fake.record_requests


def test_a_half_applied_retype_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group, monkeypatch
):
    """The 409 left a real column change behind, so the old shape cannot stay.

    ``_clear_invalidated_approval`` commits before this request refuses, which
    makes a half-applied run the one failure that has already written.
    """

    from app.lark.client import LarkError

    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_fake.requests.clear()

    real_update = lark_fake.client.update_field
    updates = {"count": 0}

    def refuse_the_second_header(*args, **kwargs):
        updates["count"] += 1
        if updates["count"] > 1:
            raise LarkError("Lark 拒绝了这次修改")
        return real_update(*args, **kwargs)

    monkeypatch.setattr(lark_fake.client, "update_field", refuse_the_second_header)

    refused = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/provision/retype",
        json={
            "role": "execution",
            "field_names": ["结果", "优先级"],
            "acknowledge": True,
        },
    )
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["created_fields"] == ["结果"]

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    assert response.status_code == 200, response.text
    assert lark_fake.record_requests


def _repoint_the_stored_target(db_session, group_id) -> None:
    """Move the group to the fake's other base, the way a second tab does.

    Committed, not left open: this stands in for another tab's finished save,
    which is what makes the stored row name a destination this request never
    read by the time its failure path runs.
    """

    from app.lark.target import TargetDraft, target_for

    stored = target_for(db_session, group_id)
    stored.execution_base_token = "app-token"
    stored.execution_table_id = "tbl-runs"
    stored.bug_base_token = "app-token"
    stored.bug_table_id = "tbl-defects"
    stored.target_fingerprint = TargetDraft(
        "app-token", "tbl-runs", None, "app-token", "tbl-defects"
    ).fingerprint
    stored.confirmed_at = None
    db_session.commit()


def test_a_repointed_half_applied_retype_drops_the_table_it_touched(
    authenticated_client, lark_fake, confirmed_group, db_session, monkeypatch
):
    """The request converted a column of a table the group no longer names.

    Dropping the *group's* snapshots here would drop the destination the
    re-point just saved — a table this request never read — and leave the one
    that really changed answering from its pre-conversion copy for the TTL.
    """

    import app.lark.cache as lark_cache
    from app.lark.client import LarkError

    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    # The destination the re-point moves to, held by this process all along.
    lark_cache.read_records("app-token", "tbl-runs", lambda: [])
    lark_fake.requests.clear()

    real_update = lark_fake.client.update_field
    calls = {"count": 0}

    def repoint_then_refuse(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] > 1:
            raise LarkError("Lark 拒绝了这次修改")
        _repoint_the_stored_target(db_session, confirmed_group.id)
        return real_update(*args, **kwargs)

    monkeypatch.setattr(lark_fake.client, "update_field", repoint_then_refuse)

    refused = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/provision/retype",
        json={
            "role": "execution",
            "field_names": ["结果", "优先级"],
            "acknowledge": True,
        },
    )

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["created_fields"] == ["结果"]
    assert ("app-exec", "tbl-runs") not in lark_cache._entries
    assert ("app-token", "tbl-runs") in lark_cache._entries


def test_a_repointed_half_applied_provision_drops_the_table_it_touched(
    authenticated_client, lark_fake, confirmed_group, db_session, monkeypatch
):
    """The same race, on the sibling branch that creates headers."""

    import app.lark.cache as lark_cache
    from app.lark.client import LarkError

    # Only 用例 exists, so 结果 and 优先级 are both in the create-only plan.
    lark_fake.fields = [{"field_id": "fld-用例", "field_name": "用例", "type": 1}]
    authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    lark_cache.read_records("app-token", "tbl-runs", lambda: [])
    lark_fake.requests.clear()

    real_create = lark_fake.client.create_field
    calls = {"count": 0}

    def repoint_then_refuse(*args, **kwargs):
        calls["count"] += 1
        if calls["count"] > 1:
            raise LarkError("Lark 拒绝了这次修改")
        _repoint_the_stored_target(db_session, confirmed_group.id)
        return real_create(*args, **kwargs)

    monkeypatch.setattr(lark_fake.client, "create_field", repoint_then_refuse)

    refused = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "优先级"],
            "acknowledge": True,
        },
    )

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["created_fields"] == ["结果"]
    assert ("app-exec", "tbl-runs") not in lark_cache._entries
    assert ("app-token", "tbl-runs") in lark_cache._entries


def _queued_job(authenticated_client, group, db_session):
    """One case's attempt, committed and queued, with its sync job returned."""

    from sqlalchemy import select

    from app.models import SyncJob

    queued = authenticated_client.post(
        f"/api/groups/{group.id}/cases/B-001/attempts",
        json={
            "result": "通过",
            "note": None,
            "console_text": "",
            "idempotency_key": "key-queued-snapshot-1",
        },
    )
    assert queued.status_code == 201, queued.text
    job = db_session.scalar(
        select(SyncJob).where(SyncJob.attempt_id == UUID(queued.json()["id"]))
    )
    assert job is not None
    return job


def test_a_drain_with_a_parked_job_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group, db_session
):
    """A parked job never leaves the queue, so the queue can never look empty.

    The page stops polling on ``queued - parked``, and the rows that did drain
    are in the table by then; waiting for a queue that never empties would serve
    the pre-write snapshot until the TTL.
    """

    job = _queued_job(authenticated_client, confirmed_group, db_session)
    # The worker parked this one on a re-point; it stays pending for good.
    job.error_kind = "target_changed"
    db_session.commit()

    lark_fake.records = []
    warmed = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert warmed["original"] == []

    lark_fake.records = [
        {"record_id": "filed", "fields": {"用例": "B-001 Login", "结果": "通过"}}
    ]
    summary = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync")
    assert summary.status_code == 200, summary.text
    assert summary.json()["queued"] == 1
    assert summary.json()["parked"] == 1

    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in body["original"]] == ["filed"]


def test_a_poll_with_work_in_flight_keeps_the_snapshot(
    authenticated_client, lark_fake, confirmed_group, db_session
):
    """The page polls while the worker runs; each poll must not cost a read.

    The snapshot only goes at the end of the drain, so a poll from a page that
    is still waiting keeps answering from it instead of re-reading the table it
    just read.
    """

    _queued_job(authenticated_client, confirmed_group, db_session)

    lark_fake.records = [
        {"record_id": "old1", "fields": {"用例": "B-001 Login", "结果": "通过"}}
    ]
    warmed = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    assert [record["record_id"] for record in warmed["original"]] == ["old1"]
    lark_fake.requests.clear()

    summary = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync")
    assert summary.status_code == 200, summary.text
    assert summary.json()["queued"] == 1
    assert summary.json()["parked"] == 0

    response = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    )
    assert response.status_code == 200, response.text
    assert not lark_fake.record_requests
    assert [record["record_id"] for record in response.json()["original"]] == ["old1"]


def test_the_same_legacy_attachment_is_downloaded_once(
    authenticated_client, lark_fake, confirmed_group
):
    lark_fake.media["file-old"] = (b"\x89PNG\r\n\x1a\n", "image/png")
    lark_fake.records = [
        {
            "record_id": "old1",
            "fields": {
                "用例": "B-001 Login",
                "结果": "不通过",
                "截图": [
                    {"file_token": "file-old", "name": "shot.png", "type": "image/png"}
                ],
            },
        }
    ]
    body = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/cases/B-001/lark-history"
    ).json()
    ref_id = body["original"][0]["ref_id"]
    lark_fake.requests.clear()

    first = authenticated_client.get(f"/api/lark/history/{ref_id}/attachments/0")
    second = authenticated_client.get(f"/api/lark/history/{ref_id}/attachments/0")

    assert first.status_code == 200, first.text
    assert first.content == b"\x89PNG\r\n\x1a\n"
    assert second.content == first.content
    downloads = [
        request["path"]
        for request in lark_fake.requests
        if "/medias/" in request["path"] and request["path"].endswith("/download")
    ]
    assert downloads == ["/open-apis/drive/v1/medias/file-old/download"]
    assert first.headers["cache-control"] == "private, max-age=86400"


def test_a_lapsed_attachment_cache_entry_is_fetched_again(lark_fake, tmp_path):
    from app.lark.attachments import cached_download

    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"one", "image/png")
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"one",
        "image/png",
    )

    # A token's bytes never change, so inside the TTL the disk copy answers;
    # once the entry lapses the picture is re-downloaded rather than trusted
    # forever.
    lark_fake.media["file-old"] = (b"two", "image/png")
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"one",
        "image/png",
    )
    assert cached_download(lark_fake.client, "file-old", directory=directory, ttl=0) == (
        b"two",
        "image/png",
    )
