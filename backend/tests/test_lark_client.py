import time
from dataclasses import replace

import pytest

import app.lark.client as lark_client_module
from app.config import settings
from app.lark.client import LarkError, TOKEN_PATH


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
        # The dropped client is closed too, so its sockets do not outlive it.
        assert first._client.is_closed
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


def test_a_refused_token_is_replaced_once_and_the_read_is_retried(lark_fake):
    client = lark_fake.client
    lark_fake.token_revoked_once = True
    lark_fake.requests.clear()

    tables = client.list_tables("app-exec")

    assert [table["table_id"] for table in tables] == ["tbl-runs", "tbl-bugs"]
    # One exchange before the refusal, one after the token was dropped.
    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 2


def test_a_real_authentication_failure_surfaces_instead_of_looping(lark_fake):
    client = lark_fake.client
    lark_fake.unauthorized = True
    lark_fake.requests.clear()

    with pytest.raises(LarkError):
        client.list_tables("app-exec")

    # The first refusal buys one fresh token; the second one is real.
    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 2


@pytest.mark.parametrize("expire", [600, "600"])
def test_the_expire_field_sets_the_deadline(lark_fake, expire):
    client = lark_fake.client
    lark_fake.token_expire = expire

    client.list_tables("app-exec")

    remaining = client._token_expires_at - time.monotonic()
    assert 0 < remaining <= 600 - lark_client_module.TOKEN_EXPIRY_MARGIN_SECONDS


def test_a_malformed_expire_falls_back_to_the_documented_two_hours(lark_fake):
    client = lark_fake.client
    lark_fake.token_expire = "soon"

    client.list_tables("app-exec")

    remaining = client._token_expires_at - time.monotonic()
    assert remaining > (
        lark_client_module.DEFAULT_TOKEN_TTL_SECONDS
        - lark_client_module.TOKEN_EXPIRY_MARGIN_SECONDS
        - 60
    )


def test_a_ttl_longer_than_the_documented_one_is_capped(lark_fake):
    client = lark_fake.client
    # Milliseconds, a unit Lark does not use, would otherwise pin the token for
    # the whole process lifetime.
    lark_fake.token_expire = 3_600_000

    client.list_tables("app-exec")

    remaining = client._token_expires_at - time.monotonic()
    # The token must be alive and clamped: a value that fell back to the
    # default would still be alive, so the upper bound alone would not prove
    # the huge value was really clamped rather than ignored.
    assert remaining > 6000
    assert remaining <= (
        lark_client_module.DEFAULT_TOKEN_TTL_SECONDS
        - lark_client_module.TOKEN_EXPIRY_MARGIN_SECONDS
    )


def test_a_refused_token_does_not_stop_a_write(lark_fake):
    client = lark_fake.client
    lark_fake.token_revoked_once = True
    lark_fake.requests.clear()

    record = client.create_record("app-exec", "tbl-runs", {"用例": "B-001"})

    assert record["record_id"] == "new-1"
    # One exchange before the refusal, one after the token was dropped.
    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 2


def test_a_real_authentication_failure_on_a_write_surfaces(lark_fake):
    client = lark_fake.client
    lark_fake.unauthorized = True
    lark_fake.requests.clear()

    with pytest.raises(LarkError):
        client.create_record("app-exec", "tbl-runs", {"用例": "B-001"})

    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 2


def test_a_refused_token_does_not_stop_an_attachment_download(lark_fake):
    client = lark_fake.client
    lark_fake.media["file-1"] = (b"shot", "image/png")
    lark_fake.token_revoked_once = True
    lark_fake.requests.clear()

    content, mime = client.download_media("file-1")

    assert (content, mime) == (b"shot", "image/png")
    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 2


def test_a_refused_token_exchange_surfaces_without_looping(lark_fake):
    client = lark_fake.client
    lark_fake.token_unauthorized = True
    lark_fake.requests.clear()

    with pytest.raises(LarkError):
        client.list_tables("app-exec")

    # There is no token to re-buy, so the exchange is attempted exactly once.
    assert len([r for r in lark_fake.requests if r["path"] == TOKEN_PATH]) == 1
