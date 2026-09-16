def _groups_with_shared_case(db_session, make_group_case):
    first = make_group_case(db_session, group_name="0918", code="B-001")
    second = make_group_case(db_session, group_name="0922", code="B-001")
    db_session.commit()
    return first.group_id, second.group_id


CSV_HEADER = "用例编号,执行顺序,端,所属模块,用例标题,优先级,执行分层,前置条件,测试数据,执行步骤,预期结果\n"


def _import_group(client, name: str, rows: str) -> str:
    preview = client.post(
        "/api/import/preview",
        files={"file": (f"{name}.csv", (CSV_HEADER + rows).encode(), "text/csv")},
    )
    assert preview.status_code == 200, preview.text
    confirmed = client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": name, "mapping": {}},
    )
    assert confirmed.status_code == 201, confirmed.text
    return confirmed.json()["id"]


def test_reimporting_a_newer_group_leaves_earlier_progress_untouched(
    authenticated_client,
):
    older_id = _import_group(
        authenticated_client,
        "0918",
        "B-001,1,Web,Account,Login,P0,Smoke,Registered user,Valid credentials,Open login page,Dashboard visible\n",
    )
    saved = authenticated_client.post(
        f"/api/groups/{older_id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "checkpoint-1"},
    )
    assert saved.status_code == 201
    assert authenticated_client.get(f"/api/groups/{older_id}/progress").json() == {
        "passed": 1,
        "failed": 0,
        "skipped": 0,
        "untested": 0,
    }

    newer_id = _import_group(
        authenticated_client,
        "0922",
        "B-001,1,Web,Account,Login with recovery code,P0,Smoke,Registered user,New credentials,Open login page,Recovery prompt visible\n",
    )

    assert newer_id != older_id
    assert authenticated_client.get(f"/api/groups/{older_id}/progress").json() == {
        "passed": 1,
        "failed": 0,
        "skipped": 0,
        "untested": 0,
    }
    assert authenticated_client.get(f"/api/groups/{newer_id}/progress").json() == {
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "untested": 1,
    }
    assert authenticated_client.get(
        f"/api/groups/{newer_id}/cases/B-001/attempts"
    ).json() == []


def test_results_are_group_scoped_and_history_is_append_only(
    authenticated_client, db_session, make_group_case
):
    first_id, second_id = _groups_with_shared_case(db_session, make_group_case)
    first_url = f"/api/groups/{first_id}/cases/B-001/attempts"

    failed = authenticated_client.post(
        first_url,
        json={
            "result": "不通过",
            "note": "binding failed",
            "idempotency_key": "first-submit",
        },
    )

    assert failed.status_code == 201
    assert authenticated_client.get(f"/api/groups/{first_id}/progress").json() == {
        "passed": 0,
        "failed": 1,
        "skipped": 0,
        "untested": 0,
    }
    assert authenticated_client.get(f"/api/groups/{second_id}/progress").json() == {
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "untested": 1,
    }

    passed = authenticated_client.post(
        first_url,
        json={"result": "通过", "idempotency_key": "second-submit"},
    )

    assert passed.status_code == 201
    assert passed.json()["id"] != failed.json()["id"]
    history = authenticated_client.get(first_url)
    assert history.status_code == 200
    assert [attempt["result"] for attempt in history.json()] == ["不通过", "通过"]
    assert authenticated_client.get(f"/api/groups/{first_id}/progress").json() == {
        "passed": 1,
        "failed": 0,
        "skipped": 0,
        "untested": 0,
    }


def test_execution_routes_require_authentication_and_csrf(
    client, seeded_admin, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    attempts_url = f"/api/groups/{group_case.group_id}/cases/B-001/attempts"

    assert client.get(f"/api/groups/{group_case.group_id}/progress").status_code == 401
    assert client.get(attempts_url).status_code == 401
    assert client.post(
        attempts_url,
        json={"result": "通过", "idempotency_key": "anonymous"},
    ).status_code == 401

    assert client.post(
        "/api/auth/login",
        json={"email": seeded_admin.email, "password": "test-password"},
    ).status_code == 200
    assert client.post(
        attempts_url,
        json={"result": "通过", "idempotency_key": "missing-csrf"},
    ).status_code == 403


def test_progress_ignores_attempts_from_another_group(
    authenticated_client, db_session, make_group_case
):
    first_id, second_id = _groups_with_shared_case(db_session, make_group_case)

    created = authenticated_client.post(
        f"/api/groups/{second_id}/cases/B-001/attempts",
        json={"result": "未执行", "idempotency_key": "second-group-submit"},
    )

    assert created.status_code == 201
    assert authenticated_client.get(f"/api/groups/{first_id}/progress").json()[
        "untested"
    ] == 1
    assert authenticated_client.get(f"/api/groups/{second_id}/progress").json() == {
        "passed": 0,
        "failed": 0,
        "skipped": 1,
        "untested": 0,
    }


def test_committed_attempts_have_no_update_or_delete_route(
    authenticated_client, db_session, make_group_case
):
    group_case = make_group_case(db_session, group_name="0918", code="B-001")
    db_session.commit()
    created = authenticated_client.post(
        f"/api/groups/{group_case.group_id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "immutable-submit"},
    )
    assert created.status_code == 201

    attempt_url = f"/api/attempts/{created.json()['id']}"
    assert authenticated_client.patch(attempt_url, json={"result": "不通过"}).status_code == 404
    assert authenticated_client.delete(attempt_url).status_code == 404
