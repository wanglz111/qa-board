from uuid import UUID

import pytest

from app.lark.history import match_bugs, parse_case_reference


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
    assert response.headers["cache-control"] == "private, no-store"
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


def test_submitting_a_result_drops_the_snapshot(
    authenticated_client, lark_fake, confirmed_group
):
    """The row this operator just wrote has to be visible on the next read."""

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
