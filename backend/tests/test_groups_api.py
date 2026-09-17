from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.models import Group, ImportTicket


def preview_csv(client, csv_book, name="0918.csv"):
    return client.post(
        "/api/import/preview",
        files={"file": (name, csv_book, "text/csv")},
    )


def test_preview_does_not_insert_and_confirm_creates_a_new_group(
    authenticated_client, csv_book, db_session
):
    preview = preview_csv(authenticated_client, csv_book)

    assert preview.status_code == 200
    assert preview.json()["count"] == 14
    assert db_session.scalars(select(Group)).all() == []

    result = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "0918"},
    )

    assert result.status_code == 201
    assert result.json()["count"] == 14
    assert len(db_session.scalars(select(Group)).all()) == 1


def test_ticket_is_one_use_and_expired_ticket_is_rejected(
    authenticated_client, csv_book, db_session
):
    first = preview_csv(authenticated_client, csv_book).json()
    payload = {"ticket_id": first["ticket_id"], "name": "first"}
    assert authenticated_client.post("/api/import/confirm", json=payload).status_code == 201
    assert authenticated_client.post("/api/import/confirm", json=payload).status_code == 409

    second = preview_csv(authenticated_client, csv_book, "expired.csv").json()
    ticket = db_session.get(ImportTicket, second["ticket_id"])
    ticket.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    db_session.commit()

    expired = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": second["ticket_id"], "name": "expired"},
    )

    assert expired.status_code == 410
    db_session.refresh(ticket)
    assert ticket.original_file == b""


def test_duplicate_file_warns_but_creates_a_distinct_group(
    authenticated_client, csv_book
):
    first = preview_csv(authenticated_client, csv_book).json()
    first_group = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": first["ticket_id"], "name": "first"},
    ).json()

    second = preview_csv(authenticated_client, csv_book).json()
    assert second["warnings"]
    second_group = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": second["ticket_id"], "name": "second"},
    ).json()

    assert first_group["id"] != second_group["id"]


def test_invalid_mapping_rolls_back_and_leaves_ticket_usable(
    authenticated_client, csv_book, db_session
):
    preview = preview_csv(authenticated_client, csv_book).json()
    bad_confirm = authenticated_client.post(
        "/api/import/confirm",
        json={
            "ticket_id": preview["ticket_id"],
            "name": "bad mapping",
            "mapping": {"missing source": "code"},
        },
    )

    assert bad_confirm.status_code == 422
    assert db_session.scalars(select(Group)).all() == []
    ticket = db_session.get(ImportTicket, preview["ticket_id"])
    assert ticket.consumed_at is None
    assert ticket.original_file

    valid_confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "recovered"},
    )
    assert valid_confirm.status_code == 201


def test_import_requires_authentication_and_csrf(client, seeded_admin, csv_book):
    assert preview_csv(client, csv_book).status_code == 401

    assert client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "test-password"},
    ).status_code == 200
    assert preview_csv(client, csv_book).status_code == 403


def test_group_listing_and_cases_are_ordered(authenticated_client, csv_book):
    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()

    groups = authenticated_client.get("/api/groups")
    cases = authenticated_client.get(f"/api/groups/{created['id']}/cases")

    assert groups.status_code == 200
    assert groups.json()[0]["count"] == 14
    assert cases.status_code == 200
    assert [case["position"] for case in cases.json()] == list(range(1, 15))


def test_confirm_rejects_a_blank_group_name(authenticated_client, csv_book):
    preview = preview_csv(authenticated_client, csv_book).json()

    response = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "   "},
    )

    assert response.status_code == 422


def test_each_case_carries_its_own_latest_result(authenticated_client, csv_book):
    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    saved = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-002/attempts",
        json={"result": "通过", "idempotency_key": "cursor-1"},
    )
    assert saved.status_code == 201, saved.text

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    by_code = {case["code"]: case["latest_result"] for case in cases}

    assert by_code["B-002"] == "通过"
    assert by_code["B-001"] is None
    # A skipped case counts as done, or it would look untested forever.
    skipped = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-003/attempts",
        json={"result": "未执行", "idempotency_key": "cursor-2"},
    )
    assert skipped.status_code == 201, skipped.text
    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    assert {case["code"]: case["latest_result"] for case in cases}["B-003"] == "未执行"
