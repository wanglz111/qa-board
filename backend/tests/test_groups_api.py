from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlalchemy import select

from app.models import Attempt, Group, GroupCase, ImportTicket

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


THREE_OUTCOMES = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
    "B-002,2,未绑定拦截,账户,P0,Smoke,,,"
    '"1. 直访业务页","1. 页面: 被拦截",,\n'
    'B-003,3,邀请码校验,账户,P1,Smoke,,,"1. 输入邀请码",'
    '"1. 页面: 回显推荐人",不通过,"1. 实测回显 8+8，设计稿 6+6"\n'
)


def import_with_results(client, name="结果导入"):
    preview = client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", THREE_OUTCOMES.encode("utf-8"), "text/csv")},
    )
    assert preview.status_code == 200
    return preview, client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": name},
    )


def test_confirm_materialises_only_the_rows_that_carry_a_result(
    authenticated_client, db_session
):
    preview, confirm = import_with_results(authenticated_client)

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 2  # B-002 留空 → 不建 attempt

    attempts = db_session.scalars(select(Attempt).order_by(Attempt.label)).all()
    assert [attempt.label for attempt in attempts] == ["B-001", "B-003"]
    assert [attempt.result for attempt in attempts] == ["通过", "不通过"]
    assert attempts[0].source == "import"
    assert attempts[0].evidence == "1. 实测 1.2s"
    assert attempts[0].console_text is None
    # 不通过必须带 note（execution.AttemptCreate 的既有规则），导入用实测过程兜。
    assert attempts[1].note == "1. 实测回显 8+8，设计稿 6+6"
    assert attempts[0].idempotency_key.startswith("import:")


def test_confirm_rejects_a_result_outside_the_enum(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(",不通过,", ",阻塞,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "非法结果"},
    )

    assert confirm.status_code == 422
    assert "B-003" in confirm.json()["detail"]
    assert "只接受" in confirm.json()["detail"]
    # 拒绝是整体回滚：组与 attempt 都不许留下。
    assert db_session.scalars(select(Group)).all() == []


def test_confirm_rejects_a_failure_without_evidence(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(',不通过,"1. 实测回显 8+8，设计稿 6+6"', ",不通过,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "缺过程"},
    )

    assert confirm.status_code == 422
    assert confirm.json()["detail"] == "Case B-003 is a failure without 实测过程"
    assert db_session.scalars(select(Group)).all() == []


def test_import_results_false_ignores_the_outcome_columns(authenticated_client, db_session):
    body = THREE_OUTCOMES.replace(",不通过,", ",阻塞,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={
            "ticket_id": preview.json()["ticket_id"],
            "name": "只要用例",
            "import_results": False,
        },
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 0
    assert db_session.scalars(select(Attempt)).all() == []


def test_a_skipped_row_still_becomes_an_attempt(authenticated_client, db_session):
    """「未执行」是结论，不是留白：进度必须记 skipped，而不是 untested。"""

    body = THREE_OUTCOMES.replace(",不通过,", ",未执行,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("skipped.csv", body.encode("utf-8"), "text/csv")},
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "含未执行"},
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 2
    attempts = db_session.scalars(select(Attempt).order_by(Attempt.label)).all()
    assert [attempt.result for attempt in attempts] == ["通过", "未执行"]

    progress = authenticated_client.get(
        f"/api/groups/{confirm.json()['id']}/progress"
    ).json()
    assert progress == {"passed": 1, "failed": 0, "skipped": 1, "untested": 1}


# 「只有过程、没有结论」是任务契约的另一半：这一行不建 attempt，那两列的原文
# 就只能靠 GroupCase.raw 活下来——物化时先 continue 再谈别的，正是为此。
EVIDENCE_ONLY_BOOK = (
    "用例编号,执行顺序,用例标题,所属模块,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果,执行结果,实测过程\n"
    'B-001,1,管理员登录,账户,P0,Smoke,,,"1. 打开登录页","1. 页面: 进入工作台",通过,"1. 实测 1.2s"\n'
    'B-002,2,未绑定拦截,账户,P0,Smoke,,,"1. 直访业务页","1. 页面: 被拦截",,留档：本轮未复验\n'
)


def test_a_row_left_blank_keeps_both_columns_in_raw(authenticated_client, db_session):
    preview = authenticated_client.post(
        "/api/import/preview",
        files={
            "file": ("evidence-only.csv", EVIDENCE_ONLY_BOOK.encode("utf-8"), "text/csv")
        },
    )
    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "留白留档"},
    )

    assert confirm.status_code == 201, confirm.text
    assert confirm.json()["attempt_count"] == 1
    assert [
        attempt.label
        for attempt in db_session.scalars(select(Attempt).order_by(Attempt.label)).all()
    ] == ["B-001"]

    blank = db_session.scalar(
        select(GroupCase).where(
            GroupCase.group_id == confirm.json()["id"], GroupCase.code == "B-002"
        )
    )
    # 留空的那行没有 attempt 可挂结果，原始两列必须原样留在 raw 里。
    assert blank.raw["执行结果"] == ""
    assert blank.raw["实测过程"] == "留档：本轮未复验"


def test_a_rejected_result_rolls_back_whole_and_leaves_the_ticket_usable(
    authenticated_client, db_session
):
    body = THREE_OUTCOMES.replace(",不通过,", ",阻塞,")
    preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", body.encode("utf-8"), "text/csv")},
    )
    ticket_id = preview.json()["ticket_id"]

    confirm = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": ticket_id, "name": "非法结果回滚"},
    )

    assert confirm.status_code == 422
    # 半个 group、半个 attempt 都不许留下，ticket 也不许被消费。
    assert db_session.scalars(select(Group)).all() == []
    assert db_session.scalars(select(Attempt)).all() == []
    ticket = db_session.get(ImportTicket, ticket_id)
    assert ticket.consumed_at is None
    assert ticket.original_file

    # 同一张 ticket 还能用：改掉结果值不必重新上传预览。
    retry = authenticated_client.post(
        "/api/import/confirm",
        json={
            "ticket_id": ticket_id,
            "name": "修好结果列",
            "import_results": False,
        },
    )
    assert retry.status_code == 201, retry.text
    assert retry.json()["count"] == 3


def test_the_same_file_with_results_can_be_imported_again(
    authenticated_client, db_session
):
    """同一份文件再导一次是既有契约：预览只警告，两个组各管自己的执行记录。

    执行记录的幂等键若只由文件哈希决定，两个组就会撞同一把键——第二次确认
    直接变成未捕获的唯一约束冲突，而不是这里断言的第二次 201。
    """

    _, first = import_with_results(authenticated_client, name="第一次")

    second_preview = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("outcomes.csv", THREE_OUTCOMES.encode("utf-8"), "text/csv")},
    )
    assert second_preview.json()["warnings"] == ["This file was imported before"]
    second = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": second_preview.json()["ticket_id"], "name": "第二次"},
    )

    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["id"] != second.json()["id"]
    assert first.json()["attempt_count"] == 2
    assert second.json()["attempt_count"] == 2

    per_group: dict[str, list[tuple[str, str]]] = {}
    for group in (first.json(), second.json()):
        rows = db_session.execute(
            select(Attempt.label, Attempt.idempotency_key)
            .join(GroupCase, Attempt.group_case_id == GroupCase.id)
            .where(GroupCase.group_id == UUID(group["id"]))
            .order_by(Attempt.label)
        ).all()
        assert [label for label, _ in rows] == ["B-001", "B-003"]
        per_group[group["id"]] = rows

    # 每组自己那份键，两个组之间一把都不共享。
    first_keys = {key for _, key in per_group[first.json()["id"]]}
    second_keys = {key for _, key in per_group[second.json()["id"]]}
    assert first_keys.isdisjoint(second_keys)
