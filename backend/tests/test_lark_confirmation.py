from uuid import uuid4


def _fingerprint(client) -> str:
    check = client.get("/api/lark/check").json()
    assert check["schema_fingerprint"], check["schema_errors"]
    return check["schema_fingerprint"]


def _target_fingerprint(client) -> str:
    check = client.get("/api/lark/check").json()
    assert check["target_fingerprint"], check["schema_errors"]
    return check["target_fingerprint"]


def _confirmation_payload(client, known_table_names, **overrides):
    payload = {
        "base_token": known_table_names["base_token"],
        "execution_table_id": known_table_names["execution_table_id"],
        "bug_table_id": known_table_names["bug_table_id"],
        "schema_fingerprint": _fingerprint(client),
        "target_fingerprint": _target_fingerprint(client),
        "allow_writes": True,
    }
    payload.update(overrides)
    return payload


def test_cannot_queue_external_write_before_confirm(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    submit = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "check-1"},
    )
    assert submit.status_code == 201

    sync = authenticated_client.get(f"/api/groups/{imported_group.id}/sync").json()

    assert sync["queued"] == 0
    assert sync["confirmed"] is False
    assert sync["pending_attempts"] == 1
    assert "尚未确认" in sync["detail"]

    check = authenticated_client.get("/api/lark/check").json()
    assert check["base_name"] == known_table_names["base_name"]
    assert check["execution_table_name"] == known_table_names["execution_table_name"]
    assert check["bug_table_name"] == known_table_names["bug_table_name"]


def test_confirmation_requires_explicit_write_consent(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    payload = _confirmation_payload(
        authenticated_client, known_table_names, allow_writes=False
    )

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm", json=payload
    )

    assert response.status_code == 409
    assert "允许" in response.json()["detail"]
    assert (
        authenticated_client.get(f"/api/groups/{imported_group.id}/sync").json()["confirmed"]
        is False
    )


def test_confirmation_pins_the_approved_targets(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    payload = _confirmation_payload(authenticated_client, known_table_names)

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm", json=payload
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["base_name"] == known_table_names["base_name"]
    assert body["execution_table_name"] == known_table_names["execution_table_name"]
    assert body["bug_table_name"] == known_table_names["bug_table_name"]
    assert body["schema_fingerprint"] == payload["schema_fingerprint"]
    assert body["valid"] is True

    current = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/confirmation"
    ).json()
    assert current["confirmed"] is True
    assert current["confirmation"]["valid"] is True
    assert current["current"]["base_name"] == known_table_names["base_name"]

    sync = authenticated_client.get(f"/api/groups/{imported_group.id}/sync").json()
    assert sync["confirmed"] is True


def test_stale_fingerprint_is_rejected(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    payload = _confirmation_payload(authenticated_client, known_table_names)
    assert (
        authenticated_client.post(
            f"/api/groups/{imported_group.id}/lark/confirm", json=payload
        ).status_code
        == 200
    )

    # A target change must not inherit the earlier approval.
    lark_fake.runs_table_name = "执行记录 v2"
    stale = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm", json=payload
    )

    assert stale.status_code == 409
    assert "变化" in stale.json()["detail"]
    current = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/confirmation"
    ).json()
    assert current["confirmed"] is False
    assert current["confirmation"]["valid"] is False
    assert current["current"]["state"]["execution_table_name"] == "执行记录 v2"

    # Re-confirming with the values just read succeeds.
    refreshed = _confirmation_payload(authenticated_client, known_table_names)
    assert refreshed["schema_fingerprint"] == payload["schema_fingerprint"]
    again = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm", json=refreshed
    )
    assert again.status_code == 200
    assert again.json()["execution_table_name"] == "执行记录 v2"


def test_changed_schema_field_type_requires_reconfirmation(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    payload = _confirmation_payload(authenticated_client, known_table_names)
    assert (
        authenticated_client.post(
            f"/api/groups/{imported_group.id}/lark/confirm", json=payload
        ).status_code
        == 200
    )

    lark_fake.fields = [
        {**field, "type": 11} if field["field_name"] == "负责人" else field
        for field in lark_fake.fields
    ]

    assert (
        authenticated_client.post(
            f"/api/groups/{imported_group.id}/lark/confirm", json=payload
        ).status_code
        == 409
    )
    invalidated = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/confirmation"
    ).json()
    assert invalidated["confirmed"] is False
    assert invalidated["confirmation"]["valid"] is False
    refreshed = _confirmation_payload(authenticated_client, known_table_names)
    assert refreshed["schema_fingerprint"] != payload["schema_fingerprint"]
    assert (
        authenticated_client.post(
            f"/api/groups/{imported_group.id}/lark/confirm", json=refreshed
        ).status_code
        == 200
    )


def test_missing_mandatory_field_types_block_confirmation(
    lark_fake, authenticated_client, imported_group, known_table_names
):
    lark_fake.fields = [
        field for field in lark_fake.fields if field["field_name"] != "截图"
    ]
    check = authenticated_client.get("/api/lark/check").json()
    assert check["schema_fingerprint"] is None

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm",
        json={
            "base_token": known_table_names["base_token"],
            "execution_table_id": known_table_names["execution_table_id"],
            "bug_table_id": known_table_names["bug_table_id"],
            "schema_fingerprint": "anything",
            "target_fingerprint": "anything",
            "allow_writes": True,
        },
    )

    assert response.status_code == 409
    assert "截图" in response.json()["detail"]


def test_confirmation_needs_readable_lark_targets(
    lark_fake, authenticated_client, imported_group, known_table_names, monkeypatch
):
    import app.lark.confirmation as confirmation_module
    import app.lark.history as lark_history
    from dataclasses import replace

    from app.config import settings

    unconfigured = replace(settings, lark_table_runs="", lark_table_defects="")
    monkeypatch.setattr(lark_history, "settings", unconfigured)
    monkeypatch.setattr(confirmation_module, "settings", unconfigured)

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/confirm",
        json={
            "base_token": known_table_names["base_token"],
            "execution_table_id": known_table_names["execution_table_id"],
            "bug_table_id": known_table_names["bug_table_id"],
            "schema_fingerprint": "anything",
            "target_fingerprint": "anything",
            "allow_writes": True,
        },
    )

    assert response.status_code == 409
    assert "LARK_TABLE_RUNS" in response.json()["detail"]


def test_confirmation_endpoints_require_a_session_and_known_group(
    lark_fake, authenticated_client, anonymous_client, known_table_names
):
    payload = _confirmation_payload(authenticated_client, known_table_names)
    assert anonymous_client.post("/api/groups/tmp/lark/confirm", json=payload).status_code in (401, 422)

    missing = uuid4()
    assert (
        authenticated_client.get(f"/api/groups/{missing}/lark/confirmation").status_code
        == 404
    )
    assert (
        authenticated_client.post(
            f"/api/groups/{missing}/lark/confirm", json=payload
        ).status_code
        == 404
    )
    assert authenticated_client.get(f"/api/groups/{missing}/sync").status_code == 404
