from dataclasses import replace
from datetime import datetime, timezone

import pytest
from sqlalchemy import event, select, text

import app.lark.target as lark_target
from app.config import settings
from app.lark.fields import (
    REQUIRED_BUG_FIELD_TYPES,
    REQUIRED_RUN_FIELD_TYPES,
    schema_fingerprint,
)
from app.models import LarkTarget, LarkTargetRevision


def test_resolve_returns_base_tables_and_the_linked_table(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-1"] = {"obj_type": "bitable", "obj_token": "app-exec"}
    response = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["base_token"] == "app-exec"
    assert body["base_name"] == "执行库"
    assert {table["table_id"] for table in body["tables"]} == {"tbl-runs", "tbl-bugs"}
    assert body["selected"]["table_id"] == "tbl-runs"
    assert body["selected"]["view_id"] == "vew-main"
    assert "用例" in body["execution_fields"]
    assert body["read_errors"] == []
    # Resolving is read-only: the token exchange is the only non-GET request and
    # no record path is touched at all.
    assert lark_fake.client.record_methods == []
    assert [
        request
        for request in lark_fake.requests
        if request["method"] != "GET"
        and not request["path"].endswith("/tenant_access_token/internal")
    ] == []


def test_resolve_rejects_a_wiki_node_that_is_not_a_bitable(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-doc"] = {"obj_type": "docx", "obj_token": "doxcn1"}
    response = authenticated_client.post(
        "/api/lark/resolve",
        json={"url": "https://tenant.larksuite.com/wiki/node-doc"},
    )
    assert response.status_code == 422
    assert "多维表格" in response.json()["detail"]


def test_resolve_reports_a_link_the_app_cannot_read(lark_fake, authenticated_client):
    lark_fake.wiki_error = True
    response = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 409
    assert "协作者" in response.json()["detail"]


def test_resolve_reports_a_field_listing_the_app_cannot_read(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-1"] = {"obj_type": "bitable", "obj_token": "app-exec"}
    lark_fake.fields_error = True
    response = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 409, response.text
    assert "字段" in response.json()["detail"]
    assert "协作者" in response.json()["detail"]


def test_resolve_names_the_missing_credential_instead_of_a_permission_fix(
    lark_fake, authenticated_client, monkeypatch
):
    monkeypatch.setattr(
        lark_target,
        "settings",
        replace(settings, lark_app_id="", lark_app_secret=""),
    )
    response = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 409, response.text
    assert "LARK_APP_ID" in response.json()["detail"]
    assert "协作者" not in response.json()["detail"]
    assert lark_fake.requests == []


def test_resolve_reports_a_base_that_has_no_tables(lark_fake, authenticated_client):
    lark_fake.bases["app-empty"] = ("空库", [])
    response = authenticated_client.post(
        "/api/lark/resolve",
        json={"url": "https://tenant.larksuite.com/base/app-empty"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["tables"] == []
    assert body["selected"]["table_id"] is None
    assert "数据表" in " ".join(body["read_errors"])


def test_resolve_requires_an_admin_session(lark_fake, anonymous_client):
    response = anonymous_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    )
    assert response.status_code == 401
    assert lark_fake.requests == []


def _table_schema(client, *, base_token: str, table_id: str, role: str):
    return client.post(
        "/api/lark/table-schema",
        json={"base_token": base_token, "table_id": table_id, "role": role},
    )


def test_table_schema_judges_one_table_by_the_role_that_asked(
    lark_fake, authenticated_client
):
    """One table, two roles: the required set and the verdict both follow role."""

    lark_fake.fields = [
        field for field in lark_fake.fields if field["field_name"] != "截图"
    ]

    execution = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )
    bug = _table_schema(
        authenticated_client, base_token="app-exec", table_id="tbl-runs", role="bug"
    )

    assert execution.status_code == 200, execution.text
    assert bug.status_code == 200, bug.text
    assert execution.json()["table_id"] == "tbl-runs"
    assert bug.json()["table_id"] == "tbl-runs"
    # Both roles read the same table, so they see the same header.
    assert execution.json()["fields"] == {
        "用例": "text",
        "结果": "text",
        "优先级": "text",
        "负责人": "text",
        "报告人": "text",
        "日期": "date",
        "控制台": "text",
        "实测过程": "text",
    }
    assert bug.json()["fields"] == execution.json()["fields"]
    assert execution.json()["required"] == sorted(REQUIRED_RUN_FIELD_TYPES)
    assert bug.json()["required"] == sorted(REQUIRED_BUG_FIELD_TYPES)
    assert execution.json()["required"] != bug.json()["required"]
    assert execution.json()["schema_errors"] == ["缺少必填字段「截图」"]
    # 截图 is in REQUIRED_BUG_FIELD_TYPES as well (app/lark/fields.py:73), so the
    # defect role reports the same missing column among its own: the list is
    # asserted verbatim rather than assumed to be the execution role's.
    assert bug.json()["schema_errors"] == [
        "缺少必填字段「问题描述」",
        "缺少必填字段「进展状态」",
        "缺少必填字段「跟进人」",
        "缺少必填字段「反馈时间」",
        "缺少必填字段「备注」",
        "缺少必填字段「反馈人」",
        "缺少必填字段「截图」",
    ]


def test_table_schema_reports_a_table_the_base_does_not_have(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-gone",
        role="execution",
    )

    assert response.status_code == 422, response.text
    assert "tbl-gone" in response.json()["detail"]
    # The field listing is the whole happy path; the table listing is bought only
    # because that read failed, and only to tell "gone" from "no permission".
    assert [
        request["path"]
        for request in lark_fake.requests
        if request["path"].endswith("/fields")
    ] == ["/open-apis/bitable/v1/apps/app-exec/tables/tbl-gone/fields"]
    assert [
        request["path"]
        for request in lark_fake.requests
        if request["path"].endswith("/tables")
    ] == ["/open-apis/bitable/v1/apps/app-exec/tables"]


@pytest.mark.parametrize(
    ("break_it", "expected"),
    [("fields", "协作者"), ("base", "多维表格")],
)
def test_table_schema_reports_a_read_the_app_is_not_allowed(
    lark_fake, authenticated_client, break_it, expected
):
    """A refused read is a permission problem, never a table that does not exist."""

    if break_it == "fields":
        # The header listing refuses while the base itself still reads.
        lark_fake.fields_error = True
    else:
        # The base is beyond the app's reach: the field read and the listing that
        # would have explained it both refuse.
        del lark_fake.bases["app-exec"]

    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 409, response.text
    assert expected in response.json()["detail"]


def test_table_schema_refuses_a_role_it_does_not_know(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="defect",
    )

    assert response.status_code == 422, response.text
    assert "execution" in response.json()["detail"]
    assert lark_fake.requests == []


@pytest.mark.parametrize(
    ("base_token", "table_id"),
    [
        ("../../../../wiki/v2/spaces/get_node", "tbl-runs"),
        ("app-exec/../app-bug", "tbl-runs"),
        ("app-exec", "tbl-runs/../../records"),
        ("app-exec", "tbl-runs/.."),
        ("app-exec", "../tbl-runs"),
    ],
)
def test_table_schema_refuses_ids_that_could_rewrite_the_request_path(
    lark_fake, authenticated_client, base_token, table_id
):
    response = _table_schema(
        authenticated_client,
        base_token=base_token,
        table_id=table_id,
        role="execution",
    )

    assert response.status_code == 422, response.text
    assert "多维表格标识" in response.json()["detail"]
    assert lark_fake.requests == []


def test_table_schema_writes_nothing_to_the_database(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    """The endpoint takes no session at all: the read is Lark-only."""

    stored_before = _fresh_target(db_session, confirmed_group.id)
    flushes: list[str] = []
    commits: list[str] = []

    def record_flush(*_args: object) -> None:
        flushes.append("flush")

    def record_commit(*_args: object) -> None:
        commits.append("commit")

    event.listen(db_session, "before_flush", record_flush)
    event.listen(db_session, "before_commit", record_commit)
    try:
        response = _table_schema(
            authenticated_client,
            base_token="app-exec",
            table_id="tbl-runs",
            role="execution",
        )
    finally:
        event.remove(db_session, "before_flush", record_flush)
        event.remove(db_session, "before_commit", record_commit)

    assert response.status_code == 200, response.text
    assert flushes == []
    assert commits == []
    assert list(db_session.new) == []
    stored_after = _fresh_target(db_session, confirmed_group.id)
    assert stored_after.target_fingerprint == stored_before.target_fingerprint
    assert stored_after.schema_fingerprint == stored_before.schema_fingerprint
    assert stored_after.confirmed_at == stored_before.confirmed_at
    assert (
        db_session.scalars(
            select(LarkTargetRevision).where(
                LarkTargetRevision.group_id == confirmed_group.id
            )
        ).all()
        == []
    )


def test_table_schema_asks_lark_once_on_the_happy_path(
    lark_fake, authenticated_client
):
    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 200, response.text
    assert [request["path"] for request in lark_fake.requests] == [
        "/open-apis/auth/v3/tenant_access_token/internal",
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/fields",
    ]
    # Read-only: no record path is touched at all.
    assert lark_fake.client.record_methods == []


def test_table_schema_names_the_missing_credential_instead_of_a_permission_fix(
    lark_fake, authenticated_client, monkeypatch
):
    monkeypatch.setattr(
        lark_target,
        "settings",
        replace(settings, lark_app_id="", lark_app_secret=""),
    )

    response = _table_schema(
        authenticated_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 409, response.text
    assert "LARK_APP_ID" in response.json()["detail"]
    assert "协作者" not in response.json()["detail"]
    assert lark_fake.requests == []


def test_table_schema_requires_an_admin_session(lark_fake, anonymous_client):
    # The route hangs off the same router as /lark/resolve, so it inherits both
    # router dependencies: the admin session here, and refuse_archived_group —
    # which is a no-op for this path because no group_id is named in it
    # (app/archive.py:53-63), there being nothing per-group to archive.
    response = _table_schema(
        anonymous_client,
        base_token="app-exec",
        table_id="tbl-runs",
        role="execution",
    )

    assert response.status_code == 401
    assert lark_fake.requests == []


def _payload(table_id: str, *, expected_previous_fingerprint=None, acknowledge=False):
    return {
        "source_url": "https://tenant.larksuite.com/wiki/node-1?table=tbl-runs",
        "execution_base_token": "app-exec",
        "execution_table_id": table_id,
        "execution_view_id": None,
        "bug_base_token": "app-bug",
        "bug_table_id": "tbl-defects",
        "expected_previous_fingerprint": expected_previous_fingerprint,
        "acknowledge_change": acknowledge,
    }


def _save(client, group_id, *, table_id: str, acknowledge: bool = False):
    response = client.put(
        f"/api/groups/{group_id}/lark/target",
        json=_payload(
            table_id, expected_previous_fingerprint=None, acknowledge=acknowledge
        ),
    )
    assert response.status_code == 200, response.text
    return response.json()


TARGET_PAYLOAD_KEYS = {
    "group_id",
    "source_url",
    "execution_base_token",
    "execution_base_name",
    "execution_table_id",
    "execution_table_name",
    "execution_view_id",
    "execution_view_name",
    "bug_base_token",
    "bug_base_name",
    "bug_table_id",
    "bug_table_name",
    "schema_fingerprint",
    "target_fingerprint",
    "selected_at",
    "confirmed_at",
    "confirmed",
}


def _fresh_target(db_session, group_id) -> LarkTarget | None:
    """The stored row as it is now, not as an earlier read cached it."""

    db_session.expire_all()
    return db_session.scalar(select(LarkTarget).where(LarkTarget.group_id == group_id))


def _move_stored_target(db_session, group_id, *, table_id: str) -> None:
    """Re-point the stored target behind an in-flight request's back.

    Raw SQL, deliberately left uncommitted: an ORM update would synchronise the
    loaded instance and a commit would expire it, either of which would hide the
    stale attributes this stands in for a second tab's committed write.
    """

    fingerprint = lark_target.TargetDraft(
        "app-exec", table_id, None, "app-bug", "tbl-defects"
    ).fingerprint
    db_session.execute(
        text(
            "UPDATE lark_targets SET execution_table_id = :table_id,"
            " target_fingerprint = :fingerprint, confirmed_at = NULL"
            " WHERE group_id = :group_id"
        ),
        {"table_id": table_id, "fingerprint": fingerprint, "group_id": group_id},
    )


def _move_target_during_the_live_read(monkeypatch, db_session, group_id, *, table_id):
    """Make the next live read finish only after the target has moved."""

    real_read = lark_target.read_draft_state

    def read_then_move(client, draft):
        state = real_read(client, draft)
        _move_stored_target(db_session, group_id, table_id=table_id)
        return state

    monkeypatch.setattr(lark_target, "read_draft_state", read_then_move)


def _move_and_approve_target_during_the_live_read(
    monkeypatch, db_session, group_id, *, table_id
):
    """Another tab saves *and confirms* the destination while we are reading."""

    real_read = lark_target.read_draft_state

    def read_then_approve(client, draft):
        state = real_read(client, draft)
        _move_stored_target(db_session, group_id, table_id=table_id)
        db_session.execute(
            text(
                "UPDATE lark_targets SET confirmed_at = :now"
                " WHERE group_id = :group_id"
            ),
            {"now": datetime.now(timezone.utc), "group_id": group_id},
        )
        return state

    monkeypatch.setattr(lark_target, "read_draft_state", read_then_approve)


def test_changing_a_table_needs_an_acknowledged_diff(
    lark_fake, authenticated_client, imported_group
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    previous = first["target"]["target_fingerprint"]
    assert first["target"]["execution_table_id"] == "tbl-runs"

    refused = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload("tbl-bugs", expected_previous_fingerprint=previous),
    )
    assert refused.status_code == 409
    assert refused.json()["detail"]["reason"] == "target_changed"
    assert refused.json()["detail"]["diff"]["changed_keys"] == ["execution_table_id"]
    assert refused.json()["detail"]["diff"]["previous"]["execution_table_id"] == "tbl-runs"

    accepted = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=previous,
            acknowledge=True,
        ),
    )
    assert accepted.status_code == 200
    assert accepted.json()["target"]["execution_table_id"] == "tbl-bugs"


def test_a_stale_page_cannot_switch_a_table_silently(
    lark_fake, authenticated_client, imported_group
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    _save(authenticated_client, imported_group.id, table_id="tbl-bugs", acknowledge=True)
    stale = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-runs",
            expected_previous_fingerprint=first["target"]["target_fingerprint"],
            acknowledge=True,
        ),
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["reason"] == "stale_page"


def test_changing_a_table_clears_the_write_approval(
    lark_fake, authenticated_client, imported_group, db_session
):
    first = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    assert first["confirmation_cleared"] is False
    switched = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=first["target"]["target_fingerprint"],
            acknowledge=True,
        ),
    ).json()
    assert switched["target"]["confirmed"] is False


def test_confirm_requires_a_clean_schema(
    lark_fake, authenticated_client, imported_group
):
    lark_fake.fields = lark_fake.fields[:1]
    saved = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    assert saved["target"]["schema_fingerprint"] is None
    blocked = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/target/confirm",
        json={
            "allow_writes": True,
            "target_fingerprint": saved["target"]["target_fingerprint"],
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]


def test_revisions_keep_the_previous_table_readable(
    lark_fake, authenticated_client, imported_group, db_session
):
    _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    _save(authenticated_client, imported_group.id, table_id="tbl-bugs", acknowledge=True)
    revisions = {
        revision.target_fingerprint: (
            revision.execution_base_token,
            revision.execution_table_id,
            revision.bug_base_token,
            revision.bug_table_id,
        )
        for revision in db_session.scalars(
            select(LarkTargetRevision).where(
                LarkTargetRevision.group_id == imported_group.id
            )
        )
    }
    assert revisions == {
        "app-exec|tbl-runs|app-bug|tbl-defects": (
            "app-exec",
            "tbl-runs",
            "app-bug",
            "tbl-defects",
        ),
        "app-exec|tbl-bugs|app-bug|tbl-defects": (
            "app-exec",
            "tbl-bugs",
            "app-bug",
            "tbl-defects",
        ),
    }


def test_saving_the_same_table_twice_keeps_one_revision(
    lark_fake, authenticated_client, imported_group, db_session
):
    _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    again = _save(authenticated_client, imported_group.id, table_id="tbl-runs")

    assert again["diff"]["changed"] is False
    assert again["confirmation_cleared"] is False
    assert again["target"]["target_fingerprint"] == (
        "app-exec|tbl-runs|app-bug|tbl-defects"
    )
    assert (
        db_session.scalars(
            select(LarkTargetRevision.target_fingerprint).where(
                LarkTargetRevision.group_id == imported_group.id
            )
        ).all()
        == ["app-exec|tbl-runs|app-bug|tbl-defects"]
    )


def test_changing_a_confirmed_table_clears_the_stored_approval(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    approved = _fresh_target(db_session, confirmed_group.id)
    assert approved.confirmed_at is not None

    response = authenticated_client.put(
        f"/api/groups/{confirmed_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=approved.target_fingerprint,
            acknowledge=True,
        ),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["confirmation_cleared"] is True
    assert body["target"]["confirmed"] is False
    stored = _fresh_target(db_session, confirmed_group.id)
    assert stored.execution_table_id == "tbl-bugs"
    assert stored.confirmed_at is None


def test_a_stale_save_does_not_drop_a_fresh_approval(
    lark_fake, authenticated_client, confirmed_group, db_session, monkeypatch
):
    """A row that already equals the draft is not a change, so it stays approved."""

    stale_page = _fresh_target(db_session, confirmed_group.id)
    _move_and_approve_target_during_the_live_read(
        monkeypatch, db_session, confirmed_group.id, table_id="tbl-bugs"
    )

    response = authenticated_client.put(
        f"/api/groups/{confirmed_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=stale_page.target_fingerprint,
            acknowledge=True,
        ),
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["diff"]["changed"] is False
    assert body["confirmation_cleared"] is False
    assert body["target"]["confirmed"] is True
    stored = _fresh_target(db_session, confirmed_group.id)
    assert stored.execution_table_id == "tbl-bugs"
    assert stored.confirmed_at is not None


def test_confirming_a_saved_target_marks_it_approved(
    lark_fake, authenticated_client, imported_group
):
    saved = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    fingerprint = saved["target"]["target_fingerprint"]
    # A header added after the save must show up in the approved schema.
    lark_fake.fields = [*lark_fake.fields, {"field_name": "自定义列", "type": 1}]

    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/target/confirm",
        json={"allow_writes": True, "target_fingerprint": fingerprint},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    # The frontend consumes the bare target, not a wrapper.
    assert set(body) == TARGET_PAYLOAD_KEYS
    assert body["confirmed"] is True
    assert body["confirmed_at"] is not None
    assert body["target_fingerprint"] == fingerprint
    assert body["schema_fingerprint"] == (
        f"{schema_fingerprint(lark_fake.fields)}"
        f"||{schema_fingerprint(lark_fake.bug_fields)}"
    )
    assert body["schema_fingerprint"] != saved["target"]["schema_fingerprint"]


def test_a_target_moved_during_the_live_read_cannot_be_approved(
    lark_fake, authenticated_client, confirmed_group, db_session, monkeypatch
):
    approved = _fresh_target(db_session, confirmed_group.id)
    _move_target_during_the_live_read(
        monkeypatch, db_session, confirmed_group.id, table_id="tbl-bugs"
    )

    response = authenticated_client.post(
        f"/api/groups/{confirmed_group.id}/lark/target/confirm",
        json={"allow_writes": True, "target_fingerprint": approved.target_fingerprint},
    )

    assert response.status_code == 409, response.text
    stored = _fresh_target(db_session, confirmed_group.id)
    assert stored.execution_table_id == "tbl-bugs"
    assert stored.confirmed_at is None


@pytest.mark.parametrize("send_fingerprint", [False, True])
def test_a_target_moved_during_the_live_read_is_refused(
    lark_fake,
    authenticated_client,
    confirmed_group,
    db_session,
    monkeypatch,
    send_fingerprint,
):
    approved = _fresh_target(db_session, confirmed_group.id)
    _move_target_during_the_live_read(
        monkeypatch, db_session, confirmed_group.id, table_id="tbl-cases"
    )

    response = authenticated_client.put(
        f"/api/groups/{confirmed_group.id}/lark/target",
        json=_payload(
            "tbl-bugs",
            expected_previous_fingerprint=(
                approved.target_fingerprint if send_fingerprint else None
            ),
            acknowledge=True,
        ),
    )

    assert response.status_code == 409, response.text
    diff = response.json()["detail"]
    assert diff["reason"] == ("stale_page" if send_fingerprint else "target_changed")
    assert diff["diff"]["previous"]["execution_table_id"] == "tbl-cases"
    assert diff["diff"]["next"]["execution_table_id"] == "tbl-bugs"
    # The other tab's row survives untouched, still without an approval.
    stored = _fresh_target(db_session, confirmed_group.id)
    assert stored.execution_table_id == "tbl-cases"
    assert stored.confirmed_at is None


@pytest.mark.parametrize(
    ("field", "value", "label"),
    [
        (
            "execution_base_token",
            "../../../../wiki/v2/spaces/get_node",
            "执行库 App Token",
        ),
        ("execution_table_id", "tbl-runs/../../records", "执行记录表 id"),
        ("bug_base_token", "app-bug/../app-exec", "缺陷库 App Token"),
        ("bug_table_id", "tbl-defects/../tbl-runs", "缺陷表 id"),
        ("execution_view_id", "vew-main/../../tables", "视图 id"),
    ],
)
def test_saving_refuses_ids_that_could_rewrite_the_request_path(
    lark_fake, authenticated_client, imported_group, db_session, field, value, label
):
    response = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json={**_payload("tbl-runs"), field: value},
    )

    assert response.status_code == 422, response.text
    assert label in response.json()["detail"]
    assert lark_fake.requests == []
    assert _fresh_target(db_session, imported_group.id) is None


def test_read_target_before_any_target_is_chosen(
    lark_fake, authenticated_client, imported_group
):
    response = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/target"
    )

    assert response.status_code == 200, response.text
    assert response.json() == {"target": None, "live": None, "read_errors": []}


def test_read_target_keeps_the_stored_row_when_the_live_read_fails(
    lark_fake, authenticated_client, imported_group
):
    _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    del lark_fake.bases["app-bug"]

    response = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/target"
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["target"]["execution_table_id"] == "tbl-runs"
    assert body["live"] is None
    assert body["read_errors"] and "Lark" in body["read_errors"][0]


def test_read_target_returns_the_stored_target_and_its_live_state(
    lark_fake, authenticated_client, imported_group
):
    saved = _save(authenticated_client, imported_group.id, table_id="tbl-runs")
    # Only the GET request's own reads are audited below.
    lark_fake.requests.clear()

    body = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/target"
    ).json()

    assert body["target"]["target_fingerprint"] == saved["target"]["target_fingerprint"]
    assert body["target"]["confirmed"] is False
    assert body["read_errors"] == []
    assert body["live"]["execution_table_name"] == "执行记录"
    assert body["live"]["bug_table_name"] == "缺陷记录"
    assert body["live"]["schema_fingerprint"] == saved["target"]["schema_fingerprint"]
    # The live read follows the stored target's own bases and tables.
    assert [
        request["path"]
        for request in lark_fake.requests
        if request["path"].endswith("/fields")
    ] == [
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/fields",
        "/open-apis/bitable/v1/apps/app-bug/tables/tbl-defects/fields",
    ]
    assert [request["path"] for request in lark_fake.requests if "/records" in request["path"]] == []


def test_a_table_must_exist_in_the_base_the_payload_names(
    lark_fake, authenticated_client, imported_group, db_session
):
    """A table id from another base would make the stored fingerprint a lie."""

    response = authenticated_client.put(
        f"/api/groups/{imported_group.id}/lark/target",
        json={
            **_payload("tbl-runs"),
            # The defect table lives in app-bug, not in the execution base.
            "bug_base_token": "app-exec",
            "bug_table_id": "tbl-defects",
        },
    )
    assert response.status_code == 409, response.text
    assert db_session.scalar(
        select(LarkTargetRevision).where(
            LarkTargetRevision.group_id == imported_group.id
        )
    ) is None


def test_reading_a_target_in_one_base_reads_that_base_once(
    lark_fake, authenticated_client, confirmed_group, db_session
):
    """Both roles in one base: the base metadata and its table list are read once."""

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == confirmed_group.id)
    )
    # ``confirmed_group`` deliberately puts the two roles in different bases
    # (app-exec / app-bug), and reading two different bases once each is already
    # what the code does. This case is the one worth pinning: one operator who
    # points both roles at the same base.
    target.bug_base_token = "app-exec"
    target.bug_base_name = "执行库"
    target.bug_table_id = "tbl-bugs"
    target.bug_table_name = "缺陷记录"
    # Keep the row in a shape the app itself could have written: the stored
    # fingerprint has to describe the same four parts as the columns.
    target.target_fingerprint = lark_target.TargetDraft(
        "app-exec", "tbl-runs", None, "app-exec", "tbl-bugs"
    ).fingerprint
    db_session.commit()
    lark_fake.requests.clear()

    response = authenticated_client.get(f"/api/groups/{confirmed_group.id}/lark/target")

    assert response.status_code == 200, response.text
    # A duplicate call avoided is not enough: the bug side has to name the table
    # the target points at, not the execution side's. This pins the table; a
    # role swapped at the *base* level can only be caught where the two roles
    # sit in different bases, which the fixture below in this file covers.
    live = response.json()["live"]
    assert live["bug_base_name"] == "执行库"
    assert live["bug_table_name"] == "缺陷记录"
    paths = [request["path"] for request in lark_fake.requests]
    assert paths.count("/open-apis/bitable/v1/apps/app-exec") == 1
    assert paths.count("/open-apis/bitable/v1/apps/app-exec/tables") == 1

    # The memo lasts one read only. A later read must fetch the base again, or a
    # rebuild would keep serving the table listing taken before it created the
    # new table.
    lark_fake.requests.clear()
    again = authenticated_client.get(f"/api/groups/{confirmed_group.id}/lark/target")

    assert again.status_code == 200, again.text
    again_paths = [request["path"] for request in lark_fake.requests]
    assert again_paths.count("/open-apis/bitable/v1/apps/app-exec") == 1
    assert again_paths.count("/open-apis/bitable/v1/apps/app-exec/tables") == 1
