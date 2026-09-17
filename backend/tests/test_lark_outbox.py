from datetime import datetime, timedelta, timezone
from dataclasses import replace
from uuid import uuid4
from uuid import UUID

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

import app.lark.outbox as outbox_module
import app.worker as worker_module
from app.config import settings
from app.lark.fields import person_field_names
from app.lark.outbox import (
    EVIDENCE_SETTLE_SECONDS,
    claim_next_job,
    enqueue_attempt_job,
    hold_job_for_evidence,
    retry_failed_jobs,
    run_job,
)
from app.lark.target import target_for
from app.lark.write import (
    bug_fields,
    clip_steps,
    execution_fields,
    record_matches_execution,
)
from app.models import Attempt, GroupCase, LarkTarget, Screenshot, SyncJob
from app.worker import build_gateway, process_one_job, run_once


def _stored_target(db_session, group_id) -> LarkTarget:
    db_session.expire_all()
    return db_session.scalar(select(LarkTarget).where(LarkTarget.group_id == group_id))


def _second_group(db_session, make_group_case, *, suffix: str, table_id: str) -> Attempt:
    """Another group with its own confirmed target and a committed attempt."""

    group_case = make_group_case(db_session, group_name=suffix, code="B-001")
    db_session.flush()
    db_session.add(
        LarkTarget(
            group_id=group_case.group_id,
            source_url=f"https://tenant.larksuite.com/wiki/{suffix}",
            execution_base_token="app-exec",
            execution_base_name="执行库",
            execution_table_id=table_id,
            execution_table_name="执行记录",
            bug_base_token="app-bug",
            bug_base_name="缺陷库",
            bug_table_id="tbl-defects",
            bug_table_name="缺陷记录",
            target_fingerprint=f"app-exec|{table_id}|app-bug|tbl-defects",
            confirmed_at=datetime.now(timezone.utc),
        )
    )
    attempt = Attempt(
        group_case=group_case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        idempotency_key=f"{suffix}-attempt-1",
    )
    db_session.add(attempt)
    db_session.commit()
    return attempt


class _RecordingGateway:
    """The narrow write surface, so a run_once test needs no HTTP double."""

    def create_execution(self, fields) -> str:
        return "rec-1"

    def create_bug(self, fields) -> str:
        return "rec-bug-1"

    def find_execution_ids(self, fields) -> list[str]:
        return []


def _job(db_session, attempt) -> SyncJob:
    return db_session.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))


def _withdraw_approval(db_session, group) -> None:
    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == group.id)
    )
    target.confirmed_at = None
    db_session.commit()


def test_timeout_match_normalizes_lark_empty_text_and_date_encoding():
    expected = {
        "用例": "B-001 管理员登录",
        "结果": "通过",
        "日期": 1789603200000,
        "控制台": "",
    }
    record = {
        "record_id": "run-1",
        "fields": {
            "用例": "B-001 管理员登录",
            "结果": "通过",
            "日期": "1789603200000",
        },
    }

    assert record_matches_execution(record, expected)


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
    # The defect row carries the operator's own words and nothing else: the
    # case code moved into the remark, and the internal marker is gone for good.
    assert created["fields"]["问题描述"] == "绑定未触发"
    assert "B-001" not in created["fields"]["问题描述"]
    assert "【" not in created["fields"]["问题描述"]


def test_the_run_row_fills_owner_and_reporter_from_the_deployment(failed_attempt):
    """负责人 and 报告人 are the hand-run display names, not the sign-in address."""

    fields = execution_fields(
        failed_attempt,
        failed_attempt.group_case,
        owner="待指派",
        reporter="Max",
        attachments=[],
    )

    assert fields["负责人"] == "待指派"
    assert fields["报告人"] == "Max"
    assert fields["结果"] == "不通过"


def test_the_defect_remark_names_the_case_and_drops_the_marker(failed_attempt):
    """备注 names the case, labels the console, and keeps the result out of it."""

    fields = bug_fields(
        failed_attempt,
        failed_attempt.group_case,
        reporter="Max",
        attachments=[],
    )

    assert fields["备注"].splitlines()[0] == "用例：B-001 管理员登录"
    assert "wallet.bind timeout" in fields["备注"]
    assert "控制台：" in fields["备注"]
    # This case carries no steps, so the guard on the line is visible here.
    assert "步骤：" not in fields["备注"]
    # The defect table itself answers "with what result": every row in it is a
    # failure, so the result is a column, never a sentence.
    assert "结果：" not in fields["备注"]
    assert "不通过" not in fields["备注"]
    # Every other column the writer fills has its own home, so none of them may
    # reappear as prose in either text field.
    for column in ("优先级", "进展状态", "反馈时间", "反馈人", "截图"):
        assert column not in fields["问题描述"]
        assert column not in fields["备注"]
    assert "【自动提】" not in fields["备注"]
    assert "【" not in fields["问题描述"]


def test_the_defect_remark_carries_the_clipped_steps(failed_attempt):
    """The case's steps join the remark so a reader can reproduce the failure."""

    case = failed_attempt.group_case
    case.steps = "\n".join(f"{index:02d}-" + "x" * 7 for index in range(1, 13))

    fields = bug_fields(failed_attempt, case, reporter="Max", attachments=[])

    assert fields["备注"].splitlines()[1].startswith("步骤：01-")
    assert "…（完整步骤见用例 B-001）" in fields["备注"]


def test_clip_steps_leaves_a_short_value_alone():
    steps = "1. 打开登录页\n2. 点击登录"

    assert clip_steps(steps, "B-001") == steps
    assert "…（完整步骤见用例 B-001）" not in clip_steps(steps, "B-001")


def test_clip_steps_keeps_a_value_that_is_exactly_the_limit():
    steps = "步" * 100

    assert clip_steps(steps, "B-001") == steps


def test_clip_steps_cuts_on_a_line_boundary_and_points_at_the_case():
    steps = "\n".join(f"{index:02d}-" + "x" * 7 for index in range(1, 13))
    pointer = "…（完整步骤见用例 B-001）"

    clipped = clip_steps(steps, "B-001", limit=45)

    # Four whole ten-character lines fit in 45; a fifth would not, and half of
    # one is worse than none. Spelled out rather than re-sliced, so the expected
    # prefix does not come from the same primitive the implementation uses.
    prefix = "01-xxxxxxx\n02-xxxxxxx\n03-xxxxxxx\n04-xxxxxxx"
    assert clipped == prefix + pointer
    # The pointer tells the reader where the rest lives, so it is not itself
    # paid for out of the limit.
    assert len(prefix) <= 45 < len(clipped)


def test_clip_steps_hard_cuts_a_first_line_longer_than_the_limit():
    steps = "y" * 50 + "\nsecond line"

    clipped = clip_steps(steps, "B-001", limit=20)

    # One line longer than the limit has no boundary to cut on.
    assert clipped == "y" * 20 + "…（完整步骤见用例 B-001）"


def test_clip_steps_has_nothing_to_say_about_an_absent_value():
    assert clip_steps(None, "B-001") is None
    assert clip_steps("", "B-001") is None
    assert clip_steps("  \n ", "B-001") is None


def test_a_failure_without_a_note_still_ships_a_description(failed_attempt):
    """The API refuses a note-less failure; the row must still never be blank."""

    for note in (None, "", "   "):
        attempt = Attempt(
            group_case=failed_attempt.group_case,
            label="B-001",
            sequence=2,
            state="committed",
            result="不通过",
            note=note,
            # Never flushed, so the column default has not run yet.
            created_at=datetime.now(timezone.utc),
            idempotency_key=f"note-less-{note!r}",
        )

        fields = bug_fields(
            attempt, failed_attempt.group_case, reporter="Max", attachments=[]
        )

        assert fields["问题描述"] == "B-001 管理员登录"
        assert fields["备注"].startswith("用例：B-001 管理员登录")


def test_a_person_typed_run_column_is_filled_with_an_id_or_left_out(failed_attempt):
    """A person column refuses a display name, so it gets an id or nothing.

    负责人 is the deployment's 待指派 placeholder and nobody holds an open id for
    it, so a person-typed 负责人 is omitted instead of failing the whole create.
    """

    without_id = execution_fields(
        failed_attempt,
        failed_attempt.group_case,
        owner="待指派",
        reporter="Max",
        attachments=[],
        person_fields={"负责人", "报告人"},
    )

    assert "负责人" not in without_id
    assert "报告人" not in without_id
    # Only the columns the writer cannot fill are gone; the row is still a row.
    assert without_id["用例"] == "B-001 管理员登录"
    assert without_id["结果"] == "不通过"

    with_id = execution_fields(
        failed_attempt,
        failed_attempt.group_case,
        owner="待指派",
        reporter="Max",
        attachments=[],
        person_fields={"负责人", "报告人"},
        reporter_id="ou_reporter",
    )

    assert "负责人" not in with_id
    assert with_id["报告人"] == [{"id": "ou_reporter"}]


def test_a_person_typed_defect_column_is_never_sent_text(failed_attempt):
    """反馈人 is a person column in the verified schema; a name there is refused."""

    without_id = bug_fields(
        failed_attempt,
        failed_attempt.group_case,
        reporter="Max",
        attachments=[],
        person_fields={"反馈人"},
    )
    assert "反馈人" not in without_id

    with_id = bug_fields(
        failed_attempt,
        failed_attempt.group_case,
        reporter="Max",
        attachments=[],
        person_fields={"反馈人"},
        reporter_id="ou_reporter",
    )
    assert with_id["反馈人"] == [{"id": "ou_reporter"}]


def test_a_text_typed_defect_column_keeps_the_display_name(failed_attempt):
    """A legacy text column must not start receiving an id it cannot read."""

    fields = bug_fields(
        failed_attempt,
        failed_attempt.group_case,
        reporter="Max",
        attachments=[],
        person_fields=set(),
        reporter_id="ou_reporter",
    )

    assert fields["反馈人"] == "Max"


def test_the_stored_schema_tells_the_two_roles_apart():
    """Each role reads its own half of the fingerprint, and only person columns."""

    fingerprint = (
        "负责人:1|报告人:11|用例:1||反馈人:11|跟进人:11|备注:1|进展状态:3"
    )

    assert person_field_names(fingerprint, "execution") == {"报告人"}
    assert person_field_names(fingerprint, "bug") == {"反馈人", "跟进人"}
    # A field name may carry the separator character itself; only the last colon
    # belongs to the type.
    assert person_field_names("a:b:11||", "execution") == {"a:b"}


def test_an_unreadable_schema_fingerprint_yields_no_person_columns():
    """The writer keeps its text behaviour rather than guessing a type."""

    for value in (None, "", "schema-fixture", "用例:1|结果:3", "||"):
        assert person_field_names(value, "execution") == set()
        assert person_field_names(value, "bug") == set()


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
    assert fake_lark.created_records[0]["fields"]["用例"] == "B-001 管理员登录"
    assert fake_lark.created_records[0]["fields"]["结果"] == "通过"


def test_failed_retest_keeps_internal_label_out_of_both_lark_tables(
    fake_lark, confirmed_group, db_session
):
    case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == confirmed_group.id)
    )
    attempt = Attempt(
        group_case=case,
        label="B-001-Rgroup-4e98c0-01",
        sequence=2,
        state="committed",
        result="不通过",
        note="登录接口返回 500",
        idempotency_key="failed-retest-title",
    )
    db_session.add(attempt)
    db_session.commit()

    assert process_one_job(fake_lark, attempt) == "synced"

    execution, bug = fake_lark.created_records
    assert execution["fields"]["用例"] == "B-001 管理员登录"
    assert bug["fields"]["问题描述"] == "登录接口返回 500"
    assert bug["fields"]["备注"].startswith("用例：B-001 管理员登录")
    assert "Rgroup-4e98c0-01" not in str(fake_lark.created_records)


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


def test_repointing_never_touches_another_groups_parked_jobs(
    fake_lark,
    authenticated_client,
    confirmed_group,
    failed_attempt,
    db_session,
    make_group_case,
):
    """The operator re-points one group; other groups keep waiting."""

    db_session.add(
        SyncJob(
            attempt_id=failed_attempt.id,
            state="pending",
            next_retry_at=datetime.now(timezone.utc),
            target_fingerprint="stale",
        )
    )
    db_session.commit()
    assert process_one_job(fake_lark, failed_attempt) == "pending"

    other_attempt = _second_group(
        db_session, make_group_case, suffix="repoint-other", table_id="tbl-runs"
    )
    db_session.add(
        SyncJob(
            attempt_id=other_attempt.id,
            state="pending",
            error_kind="target_changed",
            next_retry_at=datetime.now(timezone.utc),
            target_fingerprint="stale-other",
        )
    )
    db_session.commit()

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry"
    ).json()

    assert body["repointed"] == 1
    db_session.expire_all()
    assert (
        _job(db_session, failed_attempt).target_fingerprint
        == _stored_target(db_session, confirmed_group.id).target_fingerprint
    )
    untouched = db_session.scalar(
        select(SyncJob).where(SyncJob.attempt_id == other_attempt.id)
    )
    assert untouched.state == "pending"
    assert untouched.error_kind == "target_changed"
    assert untouched.target_fingerprint == "stale-other"


def test_a_reconfirmed_table_still_parks_queued_jobs_until_repointed(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """Switch, re-confirm, park, re-point, then sync into the new table."""

    # A second run-schema table, so the administrator can really confirm a
    # switch away from tbl-runs.
    fake_lark.bases["app-exec"] = (
        "执行库",
        [("tbl-runs", "执行记录"), ("tbl-bugs", "缺陷记录"), ("tbl-new", "新执行记录")],
    )
    fake_lark.field_roles[("app-exec", "tbl-new")] = "run"

    assert (
        authenticated_client.post(
            f"/api/groups/{confirmed_group.id}/sync/enqueue"
        ).json()["queued"]
        == 1
    )
    old_fingerprint = _stored_target(db_session, confirmed_group.id).target_fingerprint
    assert _job(db_session, failed_attempt).target_fingerprint == old_fingerprint

    switched = authenticated_client.put(
        f"/api/groups/{confirmed_group.id}/lark/target",
        json={
            "source_url": "https://tenant.larksuite.com/wiki/node-1?table=tbl-new",
            "execution_base_token": "app-exec",
            "execution_table_id": "tbl-new",
            "execution_view_id": None,
            "bug_base_token": "app-bug",
            "bug_table_id": "tbl-defects",
            "expected_previous_fingerprint": old_fingerprint,
            "acknowledge_change": True,
        },
    )
    assert switched.status_code == 200, switched.text
    new_fingerprint = switched.json()["target"]["target_fingerprint"]
    assert switched.json()["target"]["confirmed"] is False

    confirmed = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/target/confirm",
        json={"allow_writes": True, "target_fingerprint": new_fingerprint},
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["confirmed"] is True

    # The new destination is approved, so the job is not parked for a lost
    # approval: its own pin names the table nobody approved for it any more.
    new_target = _stored_target(db_session, confirmed_group.id)
    assert new_target.execution_table_id == "tbl-new"
    gateway = build_gateway(new_target, fake_lark.client)
    assert process_one_job(gateway, failed_attempt) == "pending"
    parked = _job(db_session, failed_attempt)
    assert parked.error_kind == "target_changed"
    assert parked.target_fingerprint == old_fingerprint
    assert fake_lark.created_execution == 0

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry"
    ).json()
    assert body["repointed"] == 1
    db_session.expire_all()
    assert _job(db_session, failed_attempt).target_fingerprint == new_fingerprint

    assert process_one_job(
        build_gateway(_stored_target(db_session, confirmed_group.id), fake_lark.client),
        failed_attempt,
    ) == "synced"
    assert [
        request["path"] for request in fake_lark.requests if "/records" in request["path"]
    ] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-new/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]
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
    lark_fake,
    authenticated_client,
    unconfirmed_group,
    confirmed_group,
    failed_attempt,
    db_session,
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
    # A queued job carries the fingerprint of the target it was approved for;
    # without it the worker can never prove the destination is still the same.
    assert (
        _job(db_session, failed_attempt).target_fingerprint
        == _stored_target(db_session, confirmed_group.id).target_fingerprint
    )

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
    assert (
        queued[0].target_fingerprint
        == _stored_target(db_session, confirmed_id).target_fingerprint
    )
    unconfirmed_jobs = db_session.scalars(
        select(SyncJob)
        .join(Attempt, SyncJob.attempt_id == Attempt.id)
        .join(GroupCase, Attempt.group_case_id == GroupCase.id)
        .where(GroupCase.group_id == unconfirmed_id)
    ).all()
    assert unconfirmed_jobs == []


def test_a_queued_job_writes_only_into_the_target_it_was_pinned_to(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """enqueue → claim → run, with the destination asserted on the wire."""

    target = _stored_target(db_session, confirmed_group.id)

    queued = authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/enqueue")
    assert queued.status_code == 200
    assert queued.json()["queued"] == 1

    job = claim_next_job(db_session)
    assert job is not None
    assert job.attempt_id == failed_attempt.id
    assert job.target_fingerprint == target.target_fingerprint

    run_job(
        db_session,
        job,
        build_gateway(target, fake_lark.client),
        failed_attempt,
        reporter="qa@example.test",
    )

    assert job.state == "synced"
    assert [
        request["path"] for request in fake_lark.requests if "/records" in request["path"]
    ] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]


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


def test_the_failure_reason_survives_on_the_row_and_reaches_the_panel(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """``error_kind`` alone could not be acted on; the reason has to persist.

    The category is an internal word. What Lark actually refused — its HTTP
    status, its own code and message — is what an operator can fix, so it is
    stored on the job and published beside the kind.
    """

    fake_lark.create_error = True

    assert process_one_job(fake_lark, failed_attempt) == "pending"

    job = _job(db_session, failed_attempt)
    assert job.error_kind == "create_execution_failed"
    assert job.last_error is not None
    # Lark's own words, with the fake's code and message in them.
    assert "create failed" in job.last_error
    assert "create_execution_failed" != job.last_error

    body = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()

    assert body["last_error_kind"] == job.error_kind
    assert body["last_error"] == job.last_error
    # The reason never carries the record id or anything else from the payload.
    assert "new-" not in body["last_error"]
    assert "用例" not in body["last_error"]


def test_a_row_rearmed_for_a_retry_stops_reporting_its_old_reason(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """A requeued row must not keep answering with the reason it was stuck on."""

    fake_lark.create_error = True

    assert process_one_job(fake_lark, failed_attempt) == "pending"
    assert _job(db_session, failed_attempt).state == "pending"
    # The double arms one refusal per flag, so each round arms it again and the
    # row walks its backoff up to the ceiling.
    for _ in range(5):
        fake_lark.create_error = True
        process_one_job(fake_lark, failed_attempt)
    assert _job(db_session, failed_attempt).state == "failed"

    body = authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/enqueue").json()
    assert body["requeued"] == 1

    assert _job(db_session, failed_attempt).last_error is None
    summary = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()
    assert summary["last_error_kind"] is None
    assert summary["last_error"] is None


def test_enqueue_revives_the_rows_it_can_and_leaves_uncertain_alone(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """The button an operator presses first has to move the rows they see.

    A parked row and a failed row are both decisions this explicit action
    already implies; a row whose write may have landed is not, because posting
    it again can append a second remote record.
    """

    now = datetime.now(timezone.utc)
    db_session.add(
        SyncJob(
            attempt_id=failed_attempt.id,
            state="pending",
            error_kind="target_changed",
            last_error="stale pin",
            target_fingerprint=None,
            next_retry_at=now,
        )
    )
    db_session.commit()

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/enqueue"
    ).json()

    # Nothing new to insert: this row already had a job.
    assert body == {"queued": 0, "repointed": 1, "requeued": 0}
    job = _job(db_session, failed_attempt)
    assert job.error_kind is None
    assert job.last_error is None
    assert job.target_fingerprint == _stored_target(
        db_session, confirmed_group.id
    ).target_fingerprint
    assert job.next_retry_at is not None and job.next_retry_at <= datetime.now(
        timezone.utc
    )

    # A row parked after an unprovable write keeps waiting for its own button.
    job.state = "uncertain"
    job.error_kind = "timeout_unreconciled"
    db_session.commit()
    again = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/enqueue"
    ).json()
    assert again == {"queued": 0, "repointed": 0, "requeued": 0}
    assert _job(db_session, failed_attempt).state == "uncertain"


def test_enqueue_still_refuses_a_group_without_a_confirmed_target(
    authenticated_client, unconfirmed_group, db_session
):
    """Re-arming rows must never bypass the write approval."""

    response = authenticated_client.post(
        f"/api/groups/{unconfirmed_group.id}/sync/enqueue"
    )

    assert response.status_code == 409
    assert (
        db_session.scalars(
            select(SyncJob).join(
                Attempt, SyncJob.attempt_id == Attempt.id
            ).join(GroupCase, Attempt.group_case_id == GroupCase.id).where(
                GroupCase.group_id == unconfirmed_group.id
            )
        ).all()
        == []
    )


def test_sync_summary_surfaces_jobs_parked_for_a_repoint(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """An upgraded deployment shows parked jobs instead of a silent queue."""

    assert (
        authenticated_client.post(
            f"/api/groups/{confirmed_group.id}/sync/enqueue"
        ).json()["queued"]
        == 1
    )
    # A job queued before this upgrade carries no pin at all.
    job = _job(db_session, failed_attempt)
    job.target_fingerprint = None
    db_session.commit()
    assert process_one_job(fake_lark, failed_attempt) == "pending"

    body = authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()

    assert body["parked"] == 1
    assert body["queued"] == 1
    assert body["failed"] == 0
    assert body["uncertain"] == 0
    assert body["last_error_kind"] == "target_changed"
    assert body["confirmed"] is True

    # Releasing the parked job clears the counter again.
    assert (
        authenticated_client.post(f"/api/groups/{confirmed_group.id}/sync/retry").json()[
            "repointed"
        ]
        == 1
    )
    assert (
        authenticated_client.get(f"/api/groups/{confirmed_group.id}/sync").json()["parked"]
        == 0
    )


def test_repointing_clears_a_stale_lease_left_by_a_crashed_worker(
    authenticated_client, confirmed_group, failed_attempt, db_session
):
    """A re-pointed job must be claimable now, not after the old lease expires."""

    now = datetime.now(timezone.utc)
    db_session.add(
        SyncJob(
            attempt_id=failed_attempt.id,
            state="pending",
            error_kind="target_changed",
            target_fingerprint=None,
            next_retry_at=now,
            lease_until=now + timedelta(seconds=90),
        )
    )
    db_session.commit()

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry"
    ).json()

    assert body["repointed"] == 1
    db_session.expire_all()
    stored = _job(db_session, failed_attempt)
    assert stored.lease_until is None
    assert stored.state == "pending"
    assert claim_next_job(db_session) is not None


def test_withdrawn_approval_stops_counting_as_confirmed(
    lark_fake, authenticated_client, confirmed_group, failed_attempt, db_session
):
    """A withdrawn approval stops the group from counting as confirmed."""

    _withdraw_approval(db_session, confirmed_group)

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


def test_new_attempt_is_not_queued_once_the_approval_is_withdrawn(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    _withdraw_approval(db_session, confirmed_group)

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

    _withdraw_approval(db_session, confirmed_group)

    state = process_one_job(lark_fake, failed_attempt)

    assert state == "pending"
    assert lark_fake.created_execution == 0
    assert lark_fake.created_bug == 0
    assert [request["method"] for request in lark_fake.requests] == []

    job = _job(db_session, failed_attempt)
    assert job.error_kind == "target_changed"
    assert job.retry_count == 0
    assert job.next_retry_at is not None


def test_queued_jobs_stop_when_the_group_switches_tables(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    from app.lark.target import target_for

    # The job has to exist before the switch: this is the queued work the
    # administrator already accepted under the old target.
    db_session.add(SyncJob(attempt_id=failed_attempt.id, state="pending"))
    db_session.commit()

    target = target_for(db_session, confirmed_group.id)
    _job(db_session, failed_attempt).target_fingerprint = target.target_fingerprint
    db_session.commit()

    target.execution_table_id = "tbl-bugs"
    target.target_fingerprint = "app-exec|tbl-bugs|app-bug|tbl-defects"
    target.confirmed_at = None
    db_session.commit()

    assert process_one_job(fake_lark, failed_attempt) == "pending"
    assert _job(db_session, failed_attempt).error_kind == "target_changed"
    assert fake_lark.created_execution == 0


def test_repointing_parked_jobs_is_an_explicit_administrator_action(
    fake_lark, authenticated_client, confirmed_group, failed_attempt, db_session
):
    from app.lark.target import target_for

    db_session.add(SyncJob(attempt_id=failed_attempt.id, state="pending"))
    db_session.commit()

    _job(db_session, failed_attempt).target_fingerprint = "stale"
    db_session.commit()
    assert process_one_job(fake_lark, failed_attempt) == "pending"

    body = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry"
    ).json()
    assert body["repointed"] == 1
    assert (
        _job(db_session, failed_attempt).target_fingerprint
        == target_for(db_session, confirmed_group.id).target_fingerprint
    )
    assert process_one_job(fake_lark, failed_attempt) == "synced"


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
    assert retried.json() == {"requeued": 1, "released": 0, "repointed": 0}
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
    assert plain.json() == {"requeued": 0, "released": 0, "repointed": 0}
    assert _state(db_session, failed_attempt) == "uncertain"

    acknowledged = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/sync/retry",
        json={"release_uncertain": True},
    )
    assert acknowledged.json() == {"requeued": 0, "released": 1, "repointed": 0}
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


def test_run_once_gives_each_claimed_job_its_own_target(
    confirmed_group,
    failed_attempt,
    db_session,
    make_group_case,
    monkeypatch,
):
    """run_once is the production wiring: the gateway must follow the job."""

    import app.worker as worker_module

    other_attempt = _second_group(
        db_session, make_group_case, suffix="run-once-other", table_id="tbl-other"
    )
    enqueue_attempt_job(db_session, failed_attempt)
    enqueue_attempt_job(db_session, other_attempt)
    db_session.commit()
    first = _job(db_session, failed_attempt)
    second = _job(db_session, other_attempt)
    first.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    second.created_at = datetime(2026, 1, 2, tzinfo=timezone.utc)
    # A freshly queued job waits for the evidence of its attempt; this test is
    # about which target each claim uses, so both rows are long since due.
    first.next_retry_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    second.next_retry_at = datetime(2026, 1, 2, tzinfo=timezone.utc)
    db_session.commit()

    # Without an injected factory the worker would build a real Lark client;
    # that must not happen on the injected branch.
    monkeypatch.setattr(
        worker_module,
        "build_lark_client",
        lambda: pytest.fail("the injected factory must not build a client"),
    )
    targets: list[LarkTarget] = []

    def factory(target):
        targets.append(target)
        return _RecordingGateway()

    assert run_once(db_session, factory) == "synced"
    assert run_once(db_session, factory) == "synced"
    assert run_once(db_session, factory) is None

    assert [target.execution_table_id for target in targets] == [
        "tbl-runs",
        "tbl-other",
    ]
    assert {target.group_id for target in targets} == {
        confirmed_group.id,
        other_attempt.group_case.group_id,
    }


def test_run_once_parks_a_claimed_job_whose_target_cannot_be_resolved(
    unconfirmed_group, db_session
):
    """A job with no destination waits visibly instead of bleeding leases."""

    case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == unconfirmed_group.id)
    )
    attempt = Attempt(
        group_case=case,
        label="B-001",
        sequence=1,
        state="committed",
        result="通过",
        idempotency_key="no-target-1",
    )
    db_session.add(attempt)
    db_session.commit()
    db_session.add(
        SyncJob(
            attempt_id=attempt.id,
            state="pending",
            next_retry_at=datetime.now(timezone.utc) - timedelta(seconds=1),
        )
    )
    db_session.commit()

    def factory(target):
        pytest.fail("a group without a target has no gateway to build")

    assert run_once(db_session, factory) == "pending"

    db_session.expire_all()
    job = db_session.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))
    assert job.state == "pending"
    assert job.error_kind == "target_changed"
    assert job.lease_until is None
    assert job.retry_count == 0
    # Parked means parked: no claim, lease expiry, claim cycle.
    assert claim_next_job(db_session) is None


@pytest.fixture
def screenshot_store(upload_dir, monkeypatch):
    """Point the outbox's storage root at a temp dir and seed one picture."""

    patched = replace(settings, upload_dir=str(upload_dir))
    monkeypatch.setattr(outbox_module, "settings", patched)
    return upload_dir


def _attach_screenshot(db_session, attempt, store, content: bytes, *, mime="image/png"):
    storage_key = f"{uuid4().hex}.png"
    (store / storage_key).write_bytes(content)
    shot = Screenshot(
        attempt_id=attempt.id,
        storage_key=storage_key,
        mime=mime,
        size_bytes=len(content),
    )
    db_session.add(shot)
    db_session.commit()
    return shot


def _request_index(fake_lark, path: str) -> int:
    return next(
        index
        for index, request in enumerate(fake_lark.requests)
        if request["path"] == path
    )


def test_screenshots_reach_the_row_as_attachments(
    fake_lark, confirmed_group, failed_attempt, screenshot_store, db_session, valid_png
):
    _attach_screenshot(db_session, failed_attempt, screenshot_store, valid_png)

    assert process_one_job(fake_lark, failed_attempt) == "synced"

    # The picture is uploaded (once for each base the two rows live in) and the
    # file token, not the local name, is what the 截图 column holds.
    assert [item["parent_type"] for item in fake_lark.uploaded_media] == [
        "bitable_image",
        "bitable_image",
    ]
    tokens = [item["file_token"] for item in fake_lark.uploaded_media]
    execution, bug = fake_lark.created_records
    assert execution["fields"]["截图"] == [{"file_token": tokens[0]}]
    assert bug["fields"]["截图"] == [{"file_token": tokens[1]}]
    # A row is never created before its evidence is in place.
    upload_at = _request_index(fake_lark, "/open-apis/drive/v1/medias/upload_all")
    create_at = _request_index(
        fake_lark, "/open-apis/bitable/v1/apps/app-token/tables/tbl-runs/records"
    )
    assert upload_at < create_at


def test_a_defect_row_uploads_its_own_copy_into_the_bug_base(
    fake_lark, confirmed_group, failed_attempt, screenshot_store, db_session, valid_png
):
    _attach_screenshot(db_session, failed_attempt, screenshot_store, valid_png)
    gateway = build_gateway(
        _stored_target(db_session, confirmed_group.id), fake_lark.client
    )

    assert process_one_job(gateway, failed_attempt) == "synced"

    # A file token only exists inside the base that minted it, so the defect row
    # in 缺陷库 gets its own upload of the same picture.
    assert [item["parent_node"] for item in fake_lark.uploaded_media] == [
        "app-exec",
        "app-bug",
    ]
    tokens = [item["file_token"] for item in fake_lark.uploaded_media]
    execution, bug = fake_lark.created_records
    assert execution["fields"]["截图"] == [{"file_token": tokens[0]}]
    assert bug["fields"]["截图"] == [{"file_token": tokens[1]}]


def test_a_run_without_a_screenshot_writes_an_empty_attachment_cell(
    fake_lark, confirmed_group, failed_attempt, screenshot_store, db_session
):
    assert process_one_job(fake_lark, failed_attempt) == "synced"

    assert fake_lark.uploaded_media == []
    execution, bug = fake_lark.created_records
    assert execution["fields"]["截图"] == []
    assert bug["fields"]["截图"] == []


def test_an_upload_failure_keeps_the_job_queued_with_its_screenshot(
    fake_lark, confirmed_group, failed_attempt, screenshot_store, db_session, valid_png
):
    _attach_screenshot(db_session, failed_attempt, screenshot_store, valid_png)
    fake_lark.upload_error = True
    now = datetime.now(timezone.utc)

    state = process_one_job(fake_lark, failed_attempt, now=now)

    assert state == "pending"
    assert fake_lark.created_execution == 0 and fake_lark.created_bug == 0
    job = _job(db_session, failed_attempt)
    assert job.error_kind == "upload_screenshot_failed"
    assert job.retry_count == 1
    assert job.next_retry_at > now

    # The retry, once uploads work again, posts the evidence it kept.
    fake_lark.upload_error = False
    assert process_one_job(fake_lark, failed_attempt) == "synced"
    tokens = [item["file_token"] for item in fake_lark.uploaded_media]
    assert tokens
    assert fake_lark.created_records[0]["fields"]["截图"] == [{"file_token": tokens[0]}]


def test_a_configured_reporter_id_fills_the_person_column(
    fake_lark, confirmed_group, failed_attempt, screenshot_store, db_session, monkeypatch
):
    monkeypatch.setattr(
        worker_module,
        "settings",
        replace(settings, default_reporter_id="ou_61dabbc372d72932a4f6d8c7afb9de75"),
    )

    assert process_one_job(fake_lark, failed_attempt) == "synced"

    assert fake_lark.created_records[1]["fields"]["反馈人"] == [
        {"id": "ou_61dabbc372d72932a4f6d8c7afb9de75"}
    ]


def test_a_freshly_queued_row_waits_for_the_evidence_of_its_attempt(
    confirmed_group, failed_attempt, db_session
):
    """A row must not be written while its screenshots could still be uploading."""

    enqueue_attempt_job(db_session, failed_attempt)
    db_session.commit()

    job = _job(db_session, failed_attempt)
    now = datetime.now(timezone.utc)
    due = job.next_retry_at
    assert due is not None and due > now
    # The browser uploads the evidence right after the result is saved, so a
    # claim inside that window is held back rather than building a row without it.
    assert claim_next_job(db_session, now=now) is None
    assert claim_next_job(db_session, now=due + timedelta(seconds=1)) is not None


def test_a_screenshot_that_lands_pushes_the_queued_write_back(
    authenticated_client, confirmed_group, valid_png, upload_dir, db_session
):
    """Evidence that arrives late still belongs to the row being written."""

    created = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "evidence-settles-1"},
    )
    assert created.status_code == 201
    attempt_id = UUID(created.json()["id"])
    queued_due = db_session.scalar(
        select(SyncJob.next_retry_at).where(SyncJob.attempt_id == attempt_id)
    )
    assert queued_due is not None

    uploaded = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )

    assert uploaded.status_code == 201
    db_session.expire_all()
    pushed_due = db_session.scalar(
        select(SyncJob.next_retry_at).where(SyncJob.attempt_id == attempt_id)
    )
    assert pushed_due is not None and pushed_due > queued_due
    assert pushed_due >= datetime.now(timezone.utc) + timedelta(
        seconds=EVIDENCE_SETTLE_SECONDS - 1
    )


def test_a_screenshot_that_arrives_after_the_row_is_written_never_moves_it(
    fake_lark, authenticated_client, confirmed_group, valid_png, upload_dir, db_session
):
    """Once the record exists the picture can no longer join it, so nothing moves."""

    created = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "evidence-too-late-1"},
    )
    assert created.status_code == 201
    attempt = db_session.get(Attempt, UUID(created.json()["id"]))
    assert process_one_job(fake_lark, attempt) == "synced"

    uploaded = authenticated_client.post(
        f"/api/attempts/{attempt.id}/screenshots",
        files={"image": ("late.png", valid_png, "image/png")},
    )

    assert uploaded.status_code == 201
    db_session.expire_all()
    job = _job(db_session, attempt)
    assert job.state == "synced"
    assert job.next_retry_at is None
    assert fake_lark.created_execution == 1
def test_a_queued_row_waits_for_the_evidence_of_its_attempt(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    """A row is not written while its screenshots could still be uploading."""

    now = datetime.now(timezone.utc)
    enqueue_attempt_job(db_session, failed_attempt)
    db_session.commit()

    job = _job(db_session, failed_attempt)
    assert job.next_retry_at > now
    # The browser uploads the evidence only after the row is saved, so a claim
    # in that window would build the row without it.
    assert claim_next_job(db_session, now=now) is None

    # Once the settle window has passed the row is claimable as usual.
    due = job.next_retry_at + timedelta(seconds=1)
    assert claim_next_job(db_session, now=due) is not None
    db_session.rollback()


def test_a_screenshot_pushes_the_queued_write_of_its_row_back(
    authenticated_client, confirmed_group, db_session, valid_png, upload_dir
):
    """Evidence that lands after the enqueue still belongs to that row."""

    created = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "evidence-settles-1"},
    )
    assert created.status_code == 201
    attempt = db_session.get(Attempt, UUID(created.json()["id"]))
    queued_due = _job(db_session, attempt).next_retry_at
    assert queued_due is not None

    uploaded = authenticated_client.post(
        f"/api/attempts/{attempt.id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )
    assert uploaded.status_code == 201

    db_session.expire_all()
    assert _job(db_session, attempt).next_retry_at > queued_due


def test_a_screenshot_after_the_row_is_written_is_left_alone(
    fake_lark,
    authenticated_client,
    confirmed_group,
    failed_attempt,
    screenshot_store,
    db_session,
    valid_png,
    upload_dir,
):
    """A created row is never rescheduled by a picture that arrives too late."""

    assert process_one_job(fake_lark, failed_attempt) == "synced"
    job = _job(db_session, failed_attempt)
    synced_state, synced_due = job.state, job.next_retry_at

    uploaded = authenticated_client.post(
        f"/api/attempts/{failed_attempt.id}/screenshots",
        files={"image": ("late.png", valid_png, "image/png")},
    )
    assert uploaded.status_code == 201

    db_session.expire_all()
    job = _job(db_session, failed_attempt)
    assert (job.state, job.next_retry_at) == (synced_state, synced_due)
