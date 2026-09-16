from datetime import datetime, timedelta, timezone
from uuid import uuid4
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.lark.outbox import claim_next_job, retry_failed_jobs, run_job
from app.models import Attempt, GroupCase, LarkTarget, SyncJob
from app.worker import process_one_job


def _job(db_session, attempt) -> SyncJob:
    return db_session.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))


def test_old_records_and_bugs_are_never_updated(fake_lark, confirmed_group, failed_attempt):
    state = process_one_job(fake_lark, failed_attempt)

    assert state == "synced"
    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 1
    assert not fake_lark.put_calls and not fake_lark.delete_calls
    assert fake_lark.old_bug_status == "待修复"
    assert all(
        request["method"] in ("GET", "POST") for request in fake_lark.requests
    )
    created = fake_lark.created_records[-1]
    assert created["fields"]["进展状态"] == "待修复"
    assert created["fields"]["问题描述"].startswith("【自动提】B-001")
    assert "绑定未触发" in created["fields"]["问题描述"]


def test_passing_attempt_creates_only_an_execution_record(
    fake_lark, confirmed_group, db_session
):
    from app.models import GroupCase

    case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == confirmed_group.id)
    )
    attempt = Attempt(
        group_case=case,
        label="B-001-R0918-01",
        sequence=2,
        state="committed",
        result="通过",
        idempotency_key="passing-1",
    )
    db_session.add(attempt)
    db_session.commit()

    assert process_one_job(fake_lark, attempt) == "synced"

    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 0
    assert fake_lark.created_records[0]["fields"]["用例"].startswith("B-001-R0918-01")
    assert fake_lark.created_records[0]["fields"]["结果"] == "通过"


def test_timeout_after_remote_create_binds_the_single_match(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    fake_lark.timeout_after_create = True

    state = process_one_job(fake_lark, failed_attempt)

    assert state == "synced"
    assert fake_lark.created_execution == 1
    job = _job(db_session, failed_attempt)
    assert job.new_exec_record_id == "new-1"
    assert job.state == "synced"
    assert fake_lark.created_bug == 1


def test_timeout_without_a_provable_match_stops_until_reviewed(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    fake_lark.timeout_after_create = True
    fake_lark.hide_created_records = True

    state = process_one_job(fake_lark, failed_attempt)

    assert state == "uncertain"
    job = _job(db_session, failed_attempt)
    assert job.error_kind == "timeout_unreconciled"
    assert job.new_exec_record_id is None

    created_before = fake_lark.created_execution
    assert process_one_job(fake_lark, failed_attempt) == "uncertain"
    assert fake_lark.created_execution == created_before
    db_session.rollback()

    # Only an explicit administrator retry may post again.
    fake_lark.hide_created_records = True
    assert process_one_job(fake_lark, failed_attempt, force=True) in (
        "synced",
        "uncertain",
    )
    assert fake_lark.created_execution > created_before


def test_known_failure_before_create_backs_off(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    fake_lark.create_error = True
    now = datetime.now(timezone.utc)

    state = process_one_job(fake_lark, failed_attempt, now=now)

    assert state == "pending"
    assert fake_lark.created_execution == 0
    job = _job(db_session, failed_attempt)
    assert job.retry_count == 1
    assert job.error_kind == "create_execution_failed"
    assert job.next_retry_at is not None
    assert job.next_retry_at > now
    assert claim_next_job(db_session, now=now) is None

    # Once the backoff has elapsed the work is claimable again.
    later = job.next_retry_at + timedelta(seconds=1)
    assert claim_next_job(db_session, now=later) is not None
    db_session.rollback()


def test_partial_bug_failure_keeps_the_execution_record(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    fake_lark.fail_bug_create = True

    state = process_one_job(fake_lark, failed_attempt)

    assert state == "failed"
    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 0
    job = _job(db_session, failed_attempt)
    assert job.new_exec_record_id == "new-1"
    assert job.error_kind == "create_bug_failed"

    assert retry_failed_jobs(db_session) == 1
    assert process_one_job(fake_lark, failed_attempt) == "synced"
    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 1
    assert not fake_lark.put_calls and not fake_lark.delete_calls


def test_worker_restart_reclaims_an_expired_lease(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    job = SyncJob(
        attempt_id=failed_attempt.id,
        state="running",
        lease_until=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    db_session.add(job)
    db_session.commit()

    claimed = claim_next_job(db_session)

    assert claimed is not None
    assert claimed.id == job.id
    assert claimed.state == "running"
    assert claimed.lease_until > datetime.now(timezone.utc)


def test_two_concurrent_workers_do_not_claim_the_same_job(
    migrated_database,
):
    from app.models import Group, GroupCase

    # This test needs two real connections, so the work item is committed
    # outside the per-test savepoint that the other fixtures use.
    group_id = uuid4()
    with Session(bind=migrated_database) as setup:
        group = Group(
            id=group_id,
            short_code=f"0918-{group_id.hex[:6]}",
            name="Concurrency",
            source_name="concurrency.csv",
            source_sha256="3" * 64,
            source_format="csv",
            source_version="1",
        )
        case = GroupCase(group=group, code="B-001", position=1, title="并发用例", raw={})
        attempt = Attempt(
            group_case=case,
            label="B-001",
            sequence=1,
            state="committed",
            result="通过",
            idempotency_key="concurrent-1",
        )
        setup.add(attempt)
        setup.flush()
        setup.add(
            SyncJob(
                attempt_id=attempt.id,
                state="pending",
                next_retry_at=datetime.now(timezone.utc) - timedelta(seconds=1),
            )
        )
        setup.commit()
        attempt_id = attempt.id

    with Session(bind=migrated_database) as first, Session(bind=migrated_database) as second:
        claimed = claim_next_job(first)
        assert claimed is not None, "the first worker must claim the due job"
        assert claimed.attempt_id == attempt_id
        assert claim_next_job(second) is None
        first.rollback()
        second.rollback()

    # Committed setup rows survive the fixture's savepoint, so clean them up to
    # keep later tests in this shared schema independent.
    with Session(bind=migrated_database) as cleanup:
        cleanup.execute(delete(SyncJob).where(SyncJob.attempt_id == attempt_id))
        cleanup.execute(delete(Attempt).where(Attempt.id == attempt_id))
        cleanup.execute(delete(GroupCase).where(GroupCase.group_id == group_id))
        cleanup.execute(delete(Group).where(Group.id == group_id))
        cleanup.commit()


def test_enqueue_only_works_for_confirmed_groups(
    lark_fake, authenticated_client, unconfirmed_group, confirmed_group, failed_attempt
):
    assert (
        authenticated_client.post(
            f"/api/groups/{unconfirmed_group.id}/sync/enqueue"
        ).status_code
        == 409
    )

    first = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/enqueue"
    )
    assert first.status_code == 200
    assert first.json()["queued"] == 1

    # Already-queued attempts are not queued twice.
    assert authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/enqueue"
    ).json()["queued"] == 0


def test_new_attempt_queues_only_inside_a_confirmed_group(
    lark_fake, authenticated_client, unconfirmed_group, confirmed_group, db_session
):
    unconfirmed_id = unconfirmed_group.id
    confirmed_id = confirmed_group.id

    unconfirmed = authenticated_client.post(
        f"/api/groups/{unconfirmed_id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "unconfirmed-1"},
    )
    assert unconfirmed.status_code == 201
    confirmed = authenticated_client.post(
        f"/api/groups/{confirmed_id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "confirmed-1"},
    )
    assert confirmed.status_code == 201

    queued = db_session.scalars(
        select(SyncJob).where(SyncJob.attempt_id == UUID(confirmed.json()["id"]))
    ).all()
    assert len(queued) == 1
    unconfirmed_jobs = db_session.scalars(
        select(SyncJob)
        .join(Attempt, SyncJob.attempt_id == Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == unconfirmed_id)
    ).all()
    assert unconfirmed_jobs == []


def test_sync_summary_reports_failed_and_uncertain_without_payloads(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    fake_lark.fail_bug_create = True
    process_one_job(fake_lark, failed_attempt)

    body = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()

    assert body["confirmed"] is True
    assert body["failed"] == 1
    assert body["uncertain"] == 0
    assert body["queued"] == 0
    assert body["last_error_kind"] == "create_bug_failed"
    assert "new-1" not in str(body["last_error_kind"])


def test_repointed_target_stops_counting_as_confirmed(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """Approval covers the tables that were read; re-pointing retires it."""

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    target.confirmed_at = None
    db_session.commit()

    summary = authenticated_client.get(
        f"/api/groups/{confirmed_group.id}/sync"
    ).json()
    assert summary["confirmed"] is False
    assert summary["detail"] == "尚未确认目标表，本地结果不会写入 Lark"
    assert (
        authenticated_client.post(
            f"/api/groups/{confirmed_group.id}/sync/enqueue"
        ).status_code
        == 409
    )


def test_new_attempt_is_not_queued_once_the_target_moved(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    target.confirmed_at = None
    db_session.commit()

    created = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={"result": "不通过", "note": "绑定未触发", "idempotency_key": "moved-1"},
    )
    assert created.status_code == 201

    queued = db_session.scalars(
        select(SyncJob).where(SyncJob.attempt_id == UUID(created.json()["id"]))
    ).all()
    assert queued == []


def test_stale_confirmation_halts_outbound_writes(
    lark_fake, confirmed_group, failed_attempt, db_session
):
    """A held job must not post into a destination nobody approved."""

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    target.confirmed_at = None
    db_session.commit()

    state = process_one_job(lark_fake, failed_attempt)

    assert state == "pending"
    assert lark_fake.created_execution == 0
    assert lark_fake.created_bug == 0
    assert [request["method"] for request in lark_fake.requests] == []

    job = _job(db_session, failed_attempt)
    assert job.error_kind == "confirmation_stale"
    assert job.retry_count == 0
    assert job.next_retry_at is not None


def _state(db_session, attempt) -> str:
    db_session.expire_all()
    return _job(db_session, attempt).state


def test_failed_jobs_wait_for_an_operator_then_resume(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """A parked job must be recoverable, and only the missing half is resent."""

    fake_lark.fail_bug_create = True
    assert process_one_job(fake_lark, failed_attempt) == "failed"
    assert _state(db_session, failed_attempt) == "failed"

    retried = authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/retry")
    assert retried.status_code == 200
    assert retried.json() == {"requeued": 1, "released": 0}
    assert _state(db_session, failed_attempt) == "pending"

    fake_lark.fail_bug_create = False
    assert process_one_job(fake_lark, failed_attempt) == "synced"
    # The execution record already exists, so the retry must not duplicate it.
    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 1
    assert not fake_lark.put_calls and not fake_lark.delete_calls


def test_uncertain_jobs_leave_only_after_explicit_acknowledgement(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """A possible duplicate needs the administrator to say they looked."""

    fake_lark.timeout_after_create = True
    fake_lark.hide_created_records = True
    assert process_one_job(fake_lark, failed_attempt) == "uncertain"

    plain = authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/retry")
    assert plain.json() == {"requeued": 0, "released": 0}
    assert _state(db_session, failed_attempt) == "uncertain"

    acknowledged = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry",
        json={"release_uncertain": True},
    )
    assert acknowledged.json() == {"requeued": 0, "released": 1}
    assert _state(db_session, failed_attempt) == "pending"


def test_sync_retry_requires_a_session_and_a_known_group(
    anonymous_client, authenticated_client, confirmed_group
):
    assert (
        anonymous_client.post(
            f"/api/groups/{confirmed_group.id}/sync/retry"
        ).status_code
        == 401
    )
    assert (
        authenticated_client.post(f"/api/groups/{uuid4()}/sync/retry").status_code == 404
    )
