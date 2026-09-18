"""Retiring a test group: off the board, still there.

A group is archived when the requirement it came from moved and its cases have
to be laid out again. The old group is evidence — screenshots, reports, the
records it already put in Lark — so archiving hides it and stops it writing
outward, and restoring it puts everything back.
"""

from datetime import datetime, timezone

from sqlalchemy import select

from app.models import Attempt, GroupCase, LarkTarget, SyncJob
from app.worker import process_one_job


def _archive(client, group_id):
    return client.post(f"/api/groups/{group_id}/archive")


def _restore(client, group_id):
    return client.post(f"/api/groups/{group_id}/restore")


def _board(client, *, include_archived: bool = False):
    suffix = "?include_archived=true" if include_archived else ""
    return {group["id"]: group for group in client.get(f"/api/groups{suffix}").json()}


def test_a_group_starts_on_the_board(authenticated_client, imported_group):
    board = _board(authenticated_client)

    assert set(board) == {str(imported_group.id)}
    assert board[str(imported_group.id)]["archived_at"] is None


def test_archiving_takes_the_group_off_the_board(
    authenticated_client, imported_group, unconfirmed_group
):
    archived = _archive(authenticated_client, imported_group.id)

    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None
    assert set(_board(authenticated_client)) == {str(unconfirmed_group.id)}
    # Kept, not gone: the archive is one query away.
    assert set(_board(authenticated_client, include_archived=True)) == {
        str(imported_group.id),
        str(unconfirmed_group.id),
    }


def test_archiving_twice_keeps_the_first_moment(
    authenticated_client, imported_group, db_session
):
    first = _archive(authenticated_client, imported_group.id)
    second = _archive(authenticated_client, imported_group.id)

    assert second.status_code == 200
    assert second.json()["archived_at"] == first.json()["archived_at"]


def test_restoring_puts_the_group_back(authenticated_client, imported_group):
    _archive(authenticated_client, imported_group.id)
    restored = _restore(authenticated_client, imported_group.id)

    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    assert set(_board(authenticated_client)) == {str(imported_group.id)}


def test_an_archived_group_still_answers_reads(
    authenticated_client, imported_group
):
    """Hidden from the board is not the same as deleted: its cases and its
    progress stay readable, which is the whole point of keeping it."""

    assert _archive(authenticated_client, imported_group.id).status_code == 200

    assert authenticated_client.get(
        f"/api/groups/{imported_group.id}/cases"
    ).status_code == 200
    assert authenticated_client.get(
        f"/api/groups/{imported_group.id}/progress"
    ).status_code == 200


def test_an_archived_group_refuses_a_new_execution(
    authenticated_client, imported_group, db_session
):
    _archive(authenticated_client, imported_group.id)

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "archive-refuses-execution"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "该测试组已归档，请先恢复再操作"
    assert db_session.scalars(select(Attempt)).all() == []


def test_an_archived_group_refuses_a_retest_reservation(
    authenticated_client, imported_group
):
    _archive(authenticated_client, imported_group.id)

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/retest"
    )

    assert response.status_code == 409


def test_an_archived_group_refuses_a_write_to_its_attempts(
    authenticated_client, imported_group, db_session
):
    """The attempt is still here, so the group has to be checked through it."""

    created = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "archive-attempt-to-submit"},
    ).json()
    _archive(authenticated_client, imported_group.id)

    submitted = authenticated_client.post(
        f"/api/attempts/{created['id']}/submit",
        json={
            "result": "不通过",
            "note": "归档后不该还能改",
            "idempotency_key": "archive-attempt-to-submit",
        },
    )
    assert submitted.status_code == 409
    assert submitted.json()["detail"] == "该测试组已归档，请先恢复再操作"


def test_an_archived_group_refuses_a_target_change(
    authenticated_client, imported_group, db_session
):
    _archive(authenticated_client, imported_group.id)

    response = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json={
            "source_url": "https://tenant.larksuite.com/wiki/node-1",
            "execution_base_token": "app-exec",
            "execution_table_id": "tbl-runs",
            "bug_base_token": "app-bug",
            "bug_table_id": "tbl-defects",
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "该测试组已归档，请先恢复再操作"


def test_an_archived_group_refuses_a_reconcile_write(
    lark_fake, authenticated_client, confirmed_group
):
    """Decisions delete local rows; a retired group is not the place for them."""

    _archive(authenticated_client, confirmed_group.id)
    lark_fake.records = []

    response = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "该测试组已归档，请先恢复再操作"


def test_restoring_makes_the_group_writable_again(
    authenticated_client, imported_group
):
    _archive(authenticated_client, imported_group.id)
    _restore(authenticated_client, imported_group.id)

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "restored-group-writes"},
    )

    assert response.status_code == 201


def test_the_worker_parks_a_queued_job_for_an_archived_group(
    fake_lark, authenticated_client, confirmed_group, db_session
):
    case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == confirmed_group.id)
    )
    attempt = Attempt(
        group_case=case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        idempotency_key="archive-parks-the-job",
    )
    db_session.add(attempt)
    db_session.commit()
    _archive(authenticated_client, confirmed_group.id)

    assert process_one_job(fake_lark, attempt, db=db_session) == "pending"

    # Nothing left the process: archiving pauses the queue instead of spending
    # retries on rows the administrator has retired.
    assert fake_lark.created_execution == 0
    job = db_session.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))
    assert job is not None
    assert (job.state, job.error_kind) == ("pending", "group_archived")


def test_restoring_lets_the_parked_job_go_out(
    fake_lark, authenticated_client, confirmed_group, db_session
):
    case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == confirmed_group.id)
    )
    attempt = Attempt(
        group_case=case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        idempotency_key="archive-then-restore",
    )
    db_session.add(attempt)
    db_session.commit()
    _archive(authenticated_client, confirmed_group.id)
    assert process_one_job(fake_lark, attempt, db=db_session) == "pending"

    _restore(authenticated_client, confirmed_group.id)

    assert process_one_job(fake_lark, attempt, db=db_session) == "synced"
    assert fake_lark.created_execution == 1


def test_archiving_does_not_touch_the_lark_target(
    authenticated_client, confirmed_group, db_session
):
    """The link to the table stays: restoring must not need a re-point, and the
    group's own identity in the table is what the records were filed under."""

    assert _archive(authenticated_client, confirmed_group.id).status_code == 200

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    assert target is not None
    assert target.confirmed_at is not None
    assert isinstance(target.confirmed_at, datetime)
    assert target.confirmed_at.tzinfo is not None
    assert target.confirmed_at < datetime.now(timezone.utc)
