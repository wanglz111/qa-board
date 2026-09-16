from dataclasses import replace
from uuid import UUID

import pytest

import app.lark.history as lark_history
from app.config import settings
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


def test_check_returns_real_names_and_missing_columns(lark_fake, authenticated_client):
    lark_fake.fields = [
        field for field in lark_fake.fields if field["field_name"] != "控制台"
    ]

    response = authenticated_client.get("/api/lark/check")

    assert response.status_code == 200
    body = response.json()
    assert body["base_name"] == "旧版测试管理"
    assert body["execution_table_name"] == "执行记录"
    assert body["bug_table_name"] == "缺陷记录"
    assert body["execution_fields"]["用例"] == "text"
    assert body["schema_fingerprint"] is None
    assert "控制台" in " ".join(body["schema_errors"])
    assert "test-app-secret" not in response.text
    assert "fake-token" not in response.text


def test_check_requires_real_table_configuration(lark_fake, authenticated_client, monkeypatch):
    unconfigured = replace(
        settings,
        lark_app_id="test-app-id",
        lark_app_secret="test-app-secret",
        lark_app_token="app-token",
        lark_table_runs="",
        lark_table_defects="",
    )
    monkeypatch.setattr(lark_history, "settings", unconfigured)

    body = authenticated_client.get("/api/lark/check").json()

    errors = " ".join(body["read_errors"])
    assert "LARK_TABLE_RUNS" in errors
    assert "LARK_TABLE_DEFECTS" in errors
    assert body["execution_table_name"] is None
    assert not [request for request in lark_fake.requests if "/records" in request["path"]]


def test_check_reports_a_table_id_that_the_base_does_not_list(
    lark_fake, authenticated_client, monkeypatch
):
    """A stale table id has to be visible instead of silently confirming a target."""

    # Base the stale config on the fixture's working config so only the table
    # id under test is wrong.
    stale = replace(lark_history.settings, lark_table_runs="tbl-missing")
    monkeypatch.setattr(lark_history, "settings", stale)

    body = authenticated_client.get("/api/lark/check").json()

    assert body["execution_table_name"] is None
    assert body["target_fingerprint"] is None
    assert "tbl-missing" in " ".join(body["read_errors"])
    assert not [request for request in lark_fake.requests if "/records" in request["path"]]


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
    authenticated_client, lark_fake, imported_group, db_session
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
        f"/api/groups/{imported_group.id}/cases/B-001/lark-history"
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


def test_case_history_endpoint_reports_unavailable_lark(
    authenticated_client, lark_fake, imported_group, monkeypatch
):
    from dataclasses import replace

    from app.config import settings

    monkeypatch.setattr(
        lark_history, "settings", replace(settings, lark_app_token="", lark_table_runs="")
    )

    body = authenticated_client.get(
        f"/api/groups/{imported_group.id}/cases/B-001/lark-history"
    ).json()

    assert body["available"] is False
    assert body["original"] == []
    assert any("LARK_APP_TOKEN" in item for item in body["read_errors"])
