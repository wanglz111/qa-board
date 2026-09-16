"""Release contract: no code path may mutate a legacy Lark row."""

from app.worker import process_one_job


LEGACY_MUTATION_METHODS = ("PUT", "PATCH", "DELETE")


def test_lark_client_has_no_legacy_mutation_calls(lark_fake):
    lark_fake.records = [{"record_id": "old1", "fields": {"用例": "B-001 Login"}}]

    lark_fake.read_history("B-001")

    assert not any(
        request["method"] in LEGACY_MUTATION_METHODS for request in lark_fake.requests
    )
    assert lark_fake.record_methods == ["GET"]


def test_worker_adds_only_new_records_and_leaves_the_old_bug_alone(
    fake_lark, confirmed_group, failed_attempt
):
    fake_lark.bug_records = [
        {
            "record_id": "old-bug",
            "fields": {"问题描述": "B-001 旧缺陷", "进展状态": "待修复"},
        }
    ]

    state = process_one_job(fake_lark, failed_attempt)

    assert state == "synced"
    assert not any(request["method"] in LEGACY_MUTATION_METHODS for request in fake_lark.requests)
    assert not fake_lark.put_calls and not fake_lark.delete_calls
    assert fake_lark.old_bug_status == "待修复"
    assert fake_lark.bug_records[0]["fields"]["进展状态"] == "待修复"
    assert all(record["record_id"].startswith("new-") for record in fake_lark.created_records)


def test_passing_retest_never_closes_the_old_bug(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    from sqlalchemy import select

    from app.models import Attempt

    case = failed_attempt.group_case
    retest = Attempt(
        group_case=case,
        label="B-001-R0918-01",
        sequence=2,
        state="committed",
        result="通过",
        idempotency_key="passing-retest-1",
    )
    db_session.add(retest)
    db_session.commit()

    assert process_one_job(fake_lark, retest) == "synced"

    assert fake_lark.created_execution == 1
    assert fake_lark.created_bug == 0
    assert not any(request["method"] in LEGACY_MUTATION_METHODS for request in fake_lark.requests)
    assert db_session.scalar(select(Attempt).where(Attempt.id == failed_attempt.id)) is not None
    assert failed_attempt.result == "不通过"


def test_worker_writes_only_into_the_groups_stored_target(
    fake_lark, confirmed_group, failed_attempt, db_session
):
    """The audited write path is the group's own target, and it stays create-only."""

    from app.lark.target import target_for
    from app.worker import build_gateway

    target = target_for(db_session, confirmed_group.id)

    state = process_one_job(build_gateway(target, fake_lark.client), failed_attempt)

    assert state == "synced"
    assert not any(
        request["method"] in LEGACY_MUTATION_METHODS for request in fake_lark.requests
    )
    assert [
        request["path"] for request in fake_lark.requests if "/records" in request["path"]
    ] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/records",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/records",
    ]
    assert fake_lark.record_methods == ["POST", "POST"]
