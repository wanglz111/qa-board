from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.models import Group, ImportTicket

# The same verdict-to-tally mapping execution.group_progress uses, so a case's
# latest_result can be folded into the counts the page shows next to it.
RESULT_TALLY = {"通过": "passed", "不通过": "failed", "未执行": "skipped"}


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


def test_latest_committed_attempt_wins_over_an_earlier_one(
    authenticated_client, csv_book
):
    """A case run twice reports the newer result, not the first one."""

    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    earlier = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-002/attempts",
        json={"result": "未执行", "idempotency_key": "cursor-latest-1"},
    )
    assert earlier.status_code == 201, earlier.text
    latest = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-002/attempts",
        json={"result": "通过", "idempotency_key": "cursor-latest-2"},
    )
    assert latest.status_code == 201, latest.text

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    assert {case["code"]: case["latest_result"] for case in cases}["B-002"] == "通过"


def test_a_reserved_retest_does_not_hide_the_committed_result(
    authenticated_client, csv_book
):
    """A page reopened mid-retest must still show what the case last reported."""

    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    saved = authenticated_client.post(
        f"/api/groups/{group_id}/cases/B-002/attempts",
        json={"result": "通过", "idempotency_key": "reserved-prev"},
    )
    assert saved.status_code == 201, saved.text

    reserved = authenticated_client.post(f"/api/groups/{group_id}/cases/B-002/retest")
    assert reserved.status_code == 201, reserved.text
    assert reserved.json()["state"] == "started"

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    assert {case["code"]: case["latest_result"] for case in cases}["B-002"] == "通过"


def test_a_reservation_alone_does_not_look_like_a_result(
    authenticated_client, csv_book
):
    """An unsubmitted retest has no verdict, so the case must still read as unrun."""

    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    reserved = authenticated_client.post(f"/api/groups/{group_id}/cases/B-001/retest")
    assert reserved.status_code == 201, reserved.text

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    assert {case["code"]: case["latest_result"] for case in cases}["B-001"] is None


def test_cases_and_progress_tally_the_same_results(authenticated_client, csv_book):
    """Both numbers sit side by side in the UI, so they must never disagree."""

    preview = preview_csv(authenticated_client, csv_book).json()
    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview["ticket_id"], "name": "0918"},
    ).json()
    group_id = created["id"]

    for code, result, key in (
        ("B-001", "通过", "tally-1"),
        ("B-002", "未执行", "tally-2"),
        ("B-004", "通过", "tally-3"),
    ):
        saved = authenticated_client.post(
            f"/api/groups/{group_id}/cases/{code}/attempts",
            json={"result": result, "idempotency_key": key},
        )
        assert saved.status_code == 201, saved.text
    # B-003 is never run; B-004 is parked in a retest the operator may abandon.
    retest = authenticated_client.post(f"/api/groups/{group_id}/cases/B-004/retest")
    assert retest.status_code == 201, retest.text

    cases = authenticated_client.get(f"/api/groups/{group_id}/cases").json()
    progress = authenticated_client.get(f"/api/groups/{group_id}/progress").json()

    tallies = {"passed": 0, "failed": 0, "skipped": 0, "untested": 0}
    for case in cases:
        tallies[RESULT_TALLY.get(case["latest_result"], "untested")] += 1

    # group14.csv holds B-001..B-014, so the eleven other cases stay unrun.
    assert len(cases) == 14
    assert tallies == {"passed": 2, "failed": 0, "skipped": 1, "untested": 11}
    assert tallies == progress


RESULT_BOOK = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
    "B-002,2,密码错误登录,账户,P1,Smoke,,,"
    '"1. 输入错误密码","1. 提示: 密码错误",,留档：本轮未复验\n'
)


def test_confirm_still_builds_the_group_when_the_file_carries_results(
    authenticated_client, db_session
):
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("result.csv", RESULT_BOOK.encode("utf-8"), "text/csv")},
    )
    assert preview.status_code == 200
    assert preview.json()["count"] == 2

    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "结果列回归"},
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["count"] == 2
    # 预览把两列带给页面（Task 8 用它算摘要），值来自新字段而不是 raw。
    assert preview.json()["cases"][0]["result"] == "通过"
    assert preview.json()["cases"][0]["evidence"] == "1. 实测 1.2s"
    # 预览的两个数字决定页面要不要给"一并写入执行结果"：这里一条有结论、一条只有过程。
    assert preview.json()["result_count"] == 1
    assert preview.json()["evidence_only_count"] == 1
