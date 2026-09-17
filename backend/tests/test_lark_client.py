from dataclasses import replace

import app.lark.client as lark_client_module
from app.config import settings


def _configured():
    return replace(
        settings,
        lark_base_url="https://open.feishu.test",
        lark_app_id="test-app-id",
        lark_app_secret="test-app-secret",
    )


def test_get_lark_client_hands_out_one_client_for_the_process(monkeypatch):
    monkeypatch.setattr(lark_client_module, "global_settings", _configured())
    lark_client_module.reset_shared_client()
    try:
        assert lark_client_module.get_lark_client() is lark_client_module.get_lark_client()
    finally:
        lark_client_module.reset_shared_client()


def test_reset_shared_client_builds_a_new_one(monkeypatch):
    monkeypatch.setattr(lark_client_module, "global_settings", _configured())
    lark_client_module.reset_shared_client()
    try:
        first = lark_client_module.get_lark_client()
        lark_client_module.reset_shared_client()
        assert lark_client_module.get_lark_client() is not first
    finally:
        lark_client_module.reset_shared_client()


def test_the_token_is_exchanged_once_and_renewed_only_when_it_lapses(lark_fake):
    client = lark_fake.client
    token_path = "/open-apis/auth/v3/tenant_access_token/internal"
    lark_fake.requests.clear()

    client.list_tables("app-exec")
    client.list_fields("app-exec", "tbl-runs")

    assert [r for r in lark_fake.requests if r["path"] == token_path] == [
        {"method": "POST", "path": token_path}
    ]

    # The double never sends ``expire``, so the client falls back to the
    # documented two hours. Put the deadline in the past: the next calls renew
    # exactly once instead of once per request.
    client._token_expires_at = 0.0
    client.list_tables("app-exec")
    client.list_fields("app-exec", "tbl-runs")

    assert len([r for r in lark_fake.requests if r["path"] == token_path]) == 2
