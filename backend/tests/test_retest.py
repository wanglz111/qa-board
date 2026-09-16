import threading
from uuid import UUID, uuid4

import pytest
from psycopg.errors import UniqueViolation
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import execution
from app.execution import reserve_retest
from app.models import Group, GroupCase


def _real_group(migrated_database, *, name: str = "0918") -> tuple[UUID, str]:
    group_id = uuid4()
    short_code = f"{name}-{group_id.hex[:6]}"
    with Session(bind=migrated_database) as setup:
        group = Group(
            id=group_id,
            short_code=short_code,
            name=name,
            source_name=f"{name}.csv",
            source_sha256="0" * 64,
            source_format="csv",
            source_version="1",
        )
        setup.add(group)
        setup.flush()
        setup.add(
            GroupCase(
                group=group,
                code="B-001",
                position=1,
                title="B-001",
                raw={"code": "B-001"},
            )
        )
        setup.commit()
    return group_id, short_code


def test_same_request_reuses_attempt_but_retest_gets_new_label(
    authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    url = f"/api/groups/{group_case.group_id}/cases/B-001/attempts"
    payload = {
        "result": "不通过",
        "note": "login broken",
        "idempotency_key": "submit-1",
    }

    first = authenticated_client.post(url, json=payload)
    repeated = authenticated_client.post(url, json=payload)
    next_attempt = authenticated_client.post(
        url,
        json={"result": "通过", "idempotency_key": "submit-2"},
    )

    assert first.status_code == 201
    assert repeated.status_code == 201
    assert repeated.json()["id"] == first.json()["id"]
    assert next_attempt.status_code == 201
    assert next_attempt.json()["id"] != first.json()["id"]
    assert first.json()["label"] == "B-001"
    assert next_attempt.json()["label"] == (
        f"B-001-R0918-{group_case.group_id.hex[:6]}-01"
    )
    assert [item["result"] for item in authenticated_client.get(url).json()] == [
        "不通过",
        "通过",
    ]


def test_idempotency_key_conflicts_for_changed_payload_or_case(
    authenticated_client, db_session, make_group_case
):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    second = GroupCase(
        group=first.group,
        code="B-002",
        position=2,
        title="B-002",
        raw={"code": "B-002"},
    )
    db_session.add(second)
    db_session.commit()
    first_url = f"/api/groups/{first.group_id}/cases/B-001/attempts"
    second_url = f"/api/groups/{first.group_id}/cases/B-002/attempts"
    payload = {"result": "通过", "idempotency_key": "shared-key"}
    assert authenticated_client.post(first_url, json=payload).status_code == 201

    changed = authenticated_client.post(
        first_url,
        json={"result": "未执行", "idempotency_key": "shared-key"},
    )
    other_case = authenticated_client.post(second_url, json=payload)

    assert changed.status_code == 409
    assert other_case.status_code == 409


def test_failure_requires_a_non_blank_note(
    authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    url = f"/api/groups/{group_case.group_id}/cases/B-001/attempts"

    missing = authenticated_client.post(
        url,
        json={"result": "不通过", "idempotency_key": "missing-note"},
    )
    blank = authenticated_client.post(
        url,
        json={"result": "不通过", "note": "   ", "idempotency_key": "blank-note"},
    )

    assert missing.status_code == 422
    assert blank.status_code == 422


def test_started_retest_does_not_count_until_it_is_committed(
    authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    group_id = group_case.group_id
    history_url = f"/api/groups/{group_id}/cases/B-001/attempts"

    reserved = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-001/retest"
    )

    assert reserved.status_code == 201
    assert reserved.json()["state"] == "started"
    assert reserved.json()["label"] == "B-001"
    assert authenticated_client.get(history_url).json() == []
    assert authenticated_client.get(f"/api/groups/{group_id}/progress").json() == {
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "untested": 1,
    }

    submit_url = f"/api/attempts/{reserved.json()['id']}/submit"
    payload = {"result": "通过", "idempotency_key": "reserved-submit"}
    submitted = authenticated_client.post(submit_url, json=payload)
    repeated = authenticated_client.post(submit_url, json=payload)

    assert submitted.status_code == 200
    assert submitted.json()["state"] == "committed"
    assert repeated.status_code == 200
    assert repeated.json()["id"] == submitted.json()["id"]
    assert authenticated_client.post(
        submit_url,
        json={"result": "未执行", "idempotency_key": "reserved-submit"},
    ).status_code == 409
    assert authenticated_client.get(f"/api/groups/{group_id}/progress").json()[
        "passed"
    ] == 1


def test_label_conflict_is_retried_instead_of_failing(
    monkeypatch, authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    url = f"/api/groups/{group_case.group_id}/cases/B-001/attempts"

    allocate = execution._reserve_attempt
    calls: list[int] = []

    def conflicting_reserve(session, case):
        calls.append(1)
        if len(calls) == 1:
            raise IntegrityError(
                "insert",
                {},
                UniqueViolation("duplicate key value violates unique constraint"),
            )
        return allocate(session, case)

    monkeypatch.setattr(execution, "_reserve_attempt", conflicting_reserve)

    response = authenticated_client.post(
        url,
        json={"result": "通过", "idempotency_key": "conflict-retry"},
    )

    assert response.status_code == 201
    assert response.json()["label"] == "B-001"
    assert len(calls) == 2


def test_unrelated_integrity_errors_are_not_reported_as_label_conflicts(
    monkeypatch, authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    url = f"/api/groups/{group_case.group_id}/cases/B-001/attempts"

    def broken_reserve(session, case):
        raise IntegrityError("insert", {}, Exception("null value in column"))

    monkeypatch.setattr(execution, "_reserve_attempt", broken_reserve)

    with pytest.raises(IntegrityError):
        authenticated_client.post(
            url,
            json={"result": "通过", "idempotency_key": "broken-reserve"},
        )


def test_concurrent_retests_allocate_distinct_labels(migrated_database):
    group_id, short_code = _real_group(migrated_database)
    labels: list[str] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def reserve() -> None:
        try:
            with Session(bind=migrated_database) as session:
                barrier.wait(timeout=10)
                labels.append(reserve_retest(group_id, "B-001", session)["label"])
        except BaseException as error:  # surfaced through the assertion below
            errors.append(error)

    try:
        threads = [threading.Thread(target=reserve) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert errors == []
        assert sorted(labels) == ["B-001", f"B-001-R{short_code}-01"]
    finally:
        with Session(bind=migrated_database) as cleanup:
            cleanup.execute(delete(Group).where(Group.id == group_id))
            cleanup.commit()
