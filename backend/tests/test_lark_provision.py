from datetime import datetime, timezone
from typing import Any

import pytest
from sqlalchemy import select

from app.lark.client import RECORD_MUTATION_METHODS, LarkError
from app.lark.fields import BUG_PRIORITY_OPTIONS, PASS_RESULT_OPTIONS
from app.lark.provision import (
    PROVISION_FIELD_TYPES,
    ROLE_SCHEMA,
    RUN_SCHEMA,
    provision_plan,
    rebuilt_table_name,
    retype_plan,
    schema_order,
)
from app.models import Attempt, Group, GroupCase, LarkTarget, SyncJob


@pytest.fixture
def provision_group(lark_fake, db_session, imported_group, add_case) -> Group:
    """A group bound to the standard two-base target, poised for provisioning.

    ``imported_group`` deliberately has no stored ``LarkTarget`` (see
    ``test_lark_target.py::test_read_target_before_any_target_is_chosen``) and
    provisioning only ever happens inside a target the administrator chose. The
    execution table also starts with a single header, which is the situation the
    endpoint exists for. It is a plain fixture rather than an autouse one so the
    binding stays visible in every test that depends on it.

    A second case is added because the rebuild counts have to be able to differ
    between the roles: one pass and one fail makes the execution count 2 and the
    defect count 1.
    """

    lark_fake.fields = [{"field_name": "用例", "type": 1}]
    add_case(imported_group.id, code="B-002", title="登录失败提示")
    db_session.add(
        LarkTarget(
            group_id=imported_group.id,
            source_url="https://tenant.larksuite.com/wiki/node-1",
            execution_base_token="app-exec",
            execution_base_name="执行库",
            execution_table_id="tbl-runs",
            execution_table_name="执行记录",
            bug_base_token="app-bug",
            bug_base_name="缺陷库",
            bug_table_id="tbl-defects",
            bug_table_name="缺陷记录",
            schema_fingerprint=None,
            target_fingerprint="app-exec|tbl-runs|app-bug|tbl-defects",
            confirmed_at=datetime.now(timezone.utc),
        )
    )
    db_session.commit()
    return imported_group


@pytest.fixture(autouse=True)
def no_record_writes(request):
    """The record audit: no provisioning test may touch a ``/records`` path."""

    lark_fake = (
        request.getfixturevalue("lark_fake")
        if "lark_fake" in request.fixturenames
        else None
    )
    yield
    if lark_fake is None:
        return
    assert [
        request_seen
        for request_seen in lark_fake.requests
        if "/records" in request_seen["path"]
        and request_seen["method"] in RECORD_MUTATION_METHODS
    ] == []


@pytest.fixture(autouse=True)
def schema_order_restored():
    """Put the role schemas back exactly as they were, order included.

    One test deletes a header to prove the loud check fires. ``monkeypatch``
    puts the key back at the *end* of the dict, and that dict's order is
    load-bearing — it is the column order a created table is given — so a test
    that ran afterwards would silently assert against a table built in the
    wrong order. Restoring the whole mapping is what keeps the two honest.
    """

    before = {name: dict(schema) for name, schema in ROLE_SCHEMA.items()}
    yield
    for name, snapshot in before.items():
        schema = ROLE_SCHEMA[name]
        schema.clear()
        schema.update(snapshot)


def test_plan_lists_only_the_missing_required_fields():
    existing = [{"field_name": "用例", "type": 1}, {"field_name": "自定义列", "type": 1}]
    plan = provision_plan(existing, "execution")
    names = [field["name"] for field in plan]
    assert "用例" not in names
    assert "自定义列" not in names
    # The plan follows the reference table's column order, not the alphabet.
    assert names == [name for name in RUN_SCHEMA if name in set(names)]
    assert set(names) == {"结果", "优先级", "负责人", "报告人", "日期", "截图", "控制台"}


def test_plan_is_empty_when_every_header_exists():
    existing = [
        {"field_name": name, "type": PROVISION_FIELD_TYPES[name]}
        for name in PROVISION_FIELD_TYPES
    ]
    assert provision_plan(existing, "execution") == []
    assert provision_plan(existing, "bug") == []


def test_bug_plan_only_covers_the_defect_table():
    names = {field["name"] for field in provision_plan([], "bug")}
    assert names == {
        "问题描述",
        "进展状态",
        "跟进人",
        "优先级",
        "反馈时间",
        "备注",
        "反馈人",
        "截图",
    }


def test_plan_marks_date_and_attachment_types():
    plan = {field["name"]: field for field in provision_plan([], "execution")}
    assert plan["日期"]["type"] == 5
    assert plan["截图"]["type"] == 17
    # 结果 and 优先级 are the single-select columns a person picks from in the
    # reference table, so the new field carries the same option vocabulary.
    assert plan["结果"]["type"] == 3
    assert plan["结果"]["properties"] == {
        "options": [{"name": name} for name in PASS_RESULT_OPTIONS]
    }
    assert plan["优先级"]["type"] == 3
    assert plan["用例"]["type"] == 1


def test_plan_marks_the_bug_multi_select_options():
    plan = {field["name"]: field for field in provision_plan([], "bug")}
    # The defect table has no P3 at all: a P3 case is filed as P2 there.
    assert plan["优先级"]["properties"] == {
        "options": [{"name": name} for name in BUG_PRIORITY_OPTIONS]
    }
    assert plan["进展状态"]["type"] == 3
    assert plan["反馈人"]["type"] == 11
    assert plan["反馈人"]["properties"] == {"multiple": True}
    assert plan["反馈时间"]["properties"] == {
        "date_formatter": "yyyy/MM/dd",
        "auto_fill": False,
    }


def test_setting_headers_creates_only_the_approved_fields(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = [{"field_name": "用例", "type": 1}]
    preview = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()
    names = [field["name"] for field in preview["roles"]["execution"]]
    assert "用例" not in names

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "日期"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()
    # Created in the reference order, so 结果 lands left of 日期.
    assert body["created_fields"] == ["结果", "日期"]
    created = lark_fake.created_fields
    assert [field["field_name"] for field in created] == ["结果", "日期"]
    assert [(field["base_token"], field["table_id"]) for field in created] == [
        ("app-exec", "tbl-runs"),
        ("app-exec", "tbl-runs"),
    ]
    assert all(
        field["path"].endswith("/apps/app-exec/tables/tbl-runs/fields")
        for field in created
    )
    assert lark_fake.created_views == []
    assert not lark_fake.record_requests


def test_setting_headers_refuses_an_unapproved_request(
    lark_fake, authenticated_client, provision_group
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": False,
        },
    )
    assert response.status_code == 409
    assert not lark_fake.created_fields
    assert lark_fake.created_views == []


def test_setting_headers_is_idempotent(lark_fake, authenticated_client, provision_group):
    payload = {
        "role": "execution",
        "field_names": ["结果"],
        "create_view": False,
        "acknowledge": True,
    }
    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields", json=payload
    ).json()
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields", json=payload
    ).json()
    assert first["created_fields"] == ["结果"]
    assert second["created_fields"] == []
    assert len(lark_fake.created_fields) == 1
    assert lark_fake.created_fields[0]["base_token"] == "app-exec"
    assert lark_fake.created_fields[0]["table_id"] == "tbl-runs"
    assert lark_fake.created_views == []


def test_creating_a_table_returns_its_new_id(lark_fake, authenticated_client, provision_group):
    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    ).json()
    assert body["table"]["table_id"] == "tbl-new"
    assert body["table"]["name"] == "缺陷记录"
    created_table = lark_fake.created_tables[0]
    assert created_table["base_token"] == "app-bug"
    assert created_table["path"] == "/open-apis/bitable/v1/apps/app-bug/tables"
    assert len(created_table["fields"]) == 8
    fields = {field["field_name"]: field for field in created_table["fields"]}
    # The field guide gives text fields a null property; a select, person and
    # date field each keep their own, exactly like the hand-built table.
    assert fields["问题描述"]["property"] is None
    assert fields["优先级"]["property"] == {
        "options": [{"name": name} for name in BUG_PRIORITY_OPTIONS]
    }
    assert fields["反馈人"]["property"] == {"multiple": True}
    assert fields["跟进人"]["property"] == {"multiple": True}
    assert fields["截图"]["property"] is None
    assert fields["反馈时间"]["property"] == {
        "date_formatter": "yyyy/MM/dd",
        "auto_fill": False,
    }
    assert lark_fake.created_views == []


def test_a_created_table_keeps_the_reference_column_order(
    lark_fake, authenticated_client, provision_group
):
    """A generated table reads in the same order as the hand-built one.

    Read off the reference base on 2026/09/17: the execution table is 用例 结果
    优先级 负责人 截图 控制台 报告人 日期, and the defect table is 问题描述 进展状态
    跟进人 优先级 截图 反馈人 反馈时间 备注. Sorting the names instead is what put
    优先级/反馈人/… at the front and 问题描述 last.
    """

    expected = {
        "execution": ["用例", "结果", "优先级", "负责人", "截图", "控制台", "报告人", "日期"],
        "bug": ["问题描述", "进展状态", "跟进人", "优先级", "截图", "反馈人", "反馈时间", "备注"],
    }
    for role, names in expected.items():
        lark_fake.created_tables.clear()
        authenticated_client.post(
            f"/api/groups/{provision_group.id}/lark/provision/table",
            json={
                "role": role,
                "base_token": "app-exec" if role == "execution" else "app-bug",
                "table_name": "新表",
                "acknowledge": True,
            },
        )
        created = lark_fake.created_tables[0]
        assert [field["field_name"] for field in created["fields"]] == names


def test_creating_a_table_reports_a_lark_permission_refusal(
    lark_fake, authenticated_client, provision_group
):
    """A 403 must name the status, Lark's reason and the remedy it needs."""

    lark_fake.table_create_http_status = 403
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "新建数据表失败" in detail
    assert "HTTP 403" in detail
    assert "91403" in detail
    assert "Forbidden" in detail
    assert "可编辑协作者" in detail
    assert "test-app-secret" not in response.text
    assert not lark_fake.created_tables


def test_a_new_execution_table_gives_the_attachment_a_null_property(
    lark_fake, authenticated_client, provision_group
):
    """Lark refuses an attachment whose property is not null (800074088)."""

    authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "execution",
            "base_token": "app-exec",
            "table_name": "执行记录",
            "acknowledge": True,
        },
    )

    fields = {field["field_name"]: field for field in lark_fake.created_tables[0]["fields"]}
    assert fields["截图"]["type"] == 17
    assert fields["截图"]["property"] is None
    assert fields["用例"]["property"] is None
    assert fields["日期"]["property"] == {
        "date_formatter": "yyyy/MM/dd",
        "auto_fill": False,
    }


def test_a_created_header_always_carries_a_property(
    lark_fake, authenticated_client, provision_group
):
    """The create-field body matches the guide: null, never an empty object."""

    authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "日期"],
            "create_view": False,
            "acknowledge": True,
        },
    )

    created = {field["field_name"]: field for field in lark_fake.created_fields}
    assert created["结果"]["property"] == {
        "options": [{"name": name} for name in PASS_RESULT_OPTIONS]
    }
    assert created["日期"]["property"] == {
        "date_formatter": "yyyy/MM/dd",
        "auto_fill": False,
    }


def test_setting_headers_creates_the_view_when_asked_to(
    lark_fake, authenticated_client, provision_group
):
    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": True,
            "acknowledge": True,
        },
    ).json()

    assert body["created_fields"] == ["结果"]
    assert body["view"] == {
        "name": "TestDeck",
        "exists": True,
        "view_id": "vew-created-1",
        "created": True,
    }
    created_view = lark_fake.created_views[0]
    assert created_view["view_name"] == "TestDeck"
    assert created_view["view_type"] == "grid"
    assert (created_view["base_token"], created_view["table_id"]) == (
        "app-exec",
        "tbl-runs",
    )
    assert created_view["path"].endswith("/apps/app-exec/tables/tbl-runs/views")


def test_setting_headers_creates_the_view_only_once(
    lark_fake, authenticated_client, provision_group
):
    """The plan reports the view, so a repeat never duplicates it."""

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()
    assert plan["views"]["execution"] == {
        "name": "TestDeck",
        "exists": False,
        "view_id": None,
    }

    payload = {
        "role": "execution",
        "field_names": [],
        "create_view": True,
        "acknowledge": True,
    }
    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields", json=payload
    ).json()
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields", json=payload
    ).json()

    assert first["created_fields"] == []
    assert first["view"]["created"] is True
    assert first["view"]["view_id"]
    assert second["view"]["created"] is False
    assert second["view"]["view_id"] == first["view"]["view_id"]
    assert [view["view_name"] for view in lark_fake.created_views] == ["TestDeck"]

    after = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()
    assert after["views"]["execution"]["exists"] is True
    assert after["views"]["execution"]["view_id"] == first["view"]["view_id"]


def test_setting_headers_never_invents_a_field(
    lark_fake, authenticated_client, provision_group
):
    """Only a requested header of this role may be created, whatever is asked."""

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "问题描述", "自定义列"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()

    assert body["created_fields"] == ["结果"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["结果"]
    assert lark_fake.created_views == []


def test_setting_headers_clears_the_write_approval(
    lark_fake, authenticated_client, provision_group, db_session
):
    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()

    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert body["target"]["confirmed"] is False
    assert stored is not None and stored.confirmed_at is None
    assert lark_fake.created_views == []


def test_creating_a_table_requires_acknowledgement(
    lark_fake, authenticated_client, provision_group
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": False,
        },
    )

    assert response.status_code == 409
    assert not lark_fake.created_tables
    assert lark_fake.created_views == []


def test_setting_headers_reports_a_refused_create_as_a_conflict(
    lark_fake, authenticated_client, provision_group
):
    """A refused header must reach the administrator, not become a 500."""

    lark_fake.field_create_error = True
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["reason"] == "provision_failed"
    assert "创建表头失败" in detail["message"]
    assert "no permission to create fields" in detail["message"]
    assert "可编辑协作者" in detail["message"]
    assert detail["created_fields"] == []
    assert "test-app-secret" not in response.text
    assert not lark_fake.created_fields


def test_setting_headers_reports_a_refused_view_as_a_conflict(
    lark_fake, authenticated_client, provision_group, monkeypatch
):
    def refuse(*args: object, **kwargs: object) -> dict[str, object]:
        raise LarkError("Lark rejected the create (code 1254302): no permission to create views")

    monkeypatch.setattr(lark_fake.client, "create_view", refuse)
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": [],
            "create_view": True,
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert "创建视图失败" in detail["message"]
    assert detail["created_fields"] == []
    assert not lark_fake.created_views


@pytest.mark.parametrize(
    "base_token",
    [
        "../../../../wiki/v2/spaces/get_node",
        "app-exec/../../app-token",
        "app exec",
        "",
        "app-exec?x=1",
    ],
)
def test_creating_a_table_refuses_a_base_token_that_could_rewrite_the_path(
    lark_fake, authenticated_client, provision_group, base_token
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": base_token,
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    )

    assert response.status_code == 422, response.text
    # The refused token never reaches a URL, so not even the token exchange ran.
    assert lark_fake.requests == []
    assert not lark_fake.created_tables


@pytest.mark.parametrize("table_name", ["", "   ", "缺" * 101])
def test_creating_a_table_requires_a_sensible_name(
    lark_fake, authenticated_client, provision_group, table_name
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": table_name,
            "acknowledge": True,
        },
    )

    assert response.status_code == 422, response.text
    assert lark_fake.requests == []
    assert not lark_fake.created_tables


def test_creating_a_table_requires_a_base_the_app_can_read(
    lark_fake, authenticated_client, provision_group
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-nope",
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    assert "协作者" in response.json()["detail"]
    assert not lark_fake.created_tables
    assert not [
        request
        for request in lark_fake.requests
        if request["method"] == "POST" and request["path"].endswith("/tables")
    ]


def test_the_plan_reports_a_field_listing_the_app_cannot_read(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields_error = True

    response = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    )

    assert response.status_code == 409, response.text
    assert "读取数据表字段失败" in response.json()["detail"]
    assert "test-app-secret" not in response.text


def test_setting_headers_reports_a_field_listing_the_app_cannot_read(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields_error = True

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    assert "读取数据表字段失败" in response.json()["detail"]
    assert "test-app-secret" not in response.text
    assert not lark_fake.created_fields
    assert lark_fake.created_views == []


@pytest.mark.parametrize("field_names", [[], ["用例"]])
def test_setting_headers_with_nothing_to_create_keeps_the_write_approval(
    lark_fake, authenticated_client, provision_group, db_session, field_names
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": field_names,
            "create_view": False,
            "acknowledge": True,
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["created_fields"] == []
    assert response.json()["target"]["confirmed"] is True
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None and stored.confirmed_at is not None
    assert not lark_fake.created_fields
    assert lark_fake.created_views == []


def test_setting_headers_clears_the_approval_when_a_later_create_is_refused(
    lark_fake, authenticated_client, provision_group, db_session, monkeypatch
):
    """First header lands, second is refused: the approval is already void."""

    real_create = lark_fake.client.create_field

    def create_one_then_refuse(app_token, table_id, name, type_id, properties):
        if name != "结果":
            raise LarkError(
                "Lark rejected the create (code 1254302): no permission to create fields"
            )
        return real_create(app_token, table_id, name, type_id, properties)

    monkeypatch.setattr(lark_fake.client, "create_field", create_one_then_refuse)
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "优先级"],
            "create_view": False,
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["created_fields"] == ["结果"]
    assert "创建表头失败" in detail["message"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["结果"]
    assert lark_fake.created_fields[0]["base_token"] == "app-exec"
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None and stored.confirmed_at is None


def test_plan_fails_loudly_when_a_required_header_has_no_type(monkeypatch):
    # The role schema is what the plan reads; dropping the header from the
    # flattened guide alone would not reach it.
    monkeypatch.delitem(RUN_SCHEMA, "控制台")

    with pytest.raises(RuntimeError, match="控制台"):
        provision_plan([], "execution")


def _all_text_exec_headers():
    """The headers this tool created as plain text before the schema was known.

    This is the shape the live self-built tables have: 结果/优先级 exist, so the
    create-only plan leaves them alone, and only a deliberate repair can make
    them selectable.
    """

    return [
        {"field_id": "fld-用例", "field_name": "用例", "type": 1},
        {"field_id": "fld-结果", "field_name": "结果", "type": 1},
        {"field_id": "fld-优先级", "field_name": "优先级", "type": 1},
    ]


def test_the_retype_plan_lists_the_wrongly_typed_headers(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _all_text_exec_headers()

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    repairs = {row["name"]: row for row in plan["retype"]["execution"]}
    assert set(repairs) == {"结果", "优先级"}
    assert repairs["结果"]["type"] == 3
    assert repairs["结果"]["type_name"] == "single_select"
    assert repairs["结果"]["field_id"] == "fld-结果"
    assert repairs["结果"]["current_type"] == 1
    assert repairs["结果"]["current_type_name"] == "text"
    # A header that is already correct is never offered for a repair, and a
    # whole-table listing is not confused with a repair.
    assert "用例" not in repairs


def test_the_retype_plan_is_empty_for_the_reference_schema(lark_fake, authenticated_client, provision_group):
    lark_fake.fields = [
        {"field_id": f"fld-{index}", "field_name": name, "type": type_id}
        for index, (name, type_id) in enumerate(
            {
                "用例": 1,
                "结果": 3,
                "优先级": 3,
                "负责人": 1,
                "报告人": 1,
                "日期": 5,
                "截图": 17,
                "控制台": 1,
            }.items()
        )
    ]
    lark_fake.bug_fields = [
        {"field_id": f"fld-bug-{index}", "field_name": name, "type": type_id}
        for index, (name, type_id) in enumerate(
            {
                "问题描述": 1,
                "进展状态": 3,
                "优先级": 3,
                "反馈时间": 5,
                "备注": 1,
                "反馈人": 11,
                "跟进人": 11,
                "截图": 17,
            }.items()
        )
    ]

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    assert plan["retype"] == {"execution": [], "bug": []}
    assert plan["roles"] == {"execution": [], "bug": []}
    assert retype_plan(lark_fake.fields, "execution") == []


def test_retype_converts_only_the_approved_header(
    lark_fake, authenticated_client, provision_group, db_session
):
    lark_fake.fields = _all_text_exec_headers()

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/retype",
        json={"role": "execution", "field_names": ["结果"], "acknowledge": True},
    ).json()

    assert body["retyped_fields"] == ["结果"]
    assert [row["field_name"] for row in lark_fake.updated_fields] == ["结果"]
    updated = lark_fake.updated_fields[0]
    assert updated["type"] == 3
    assert updated["property"] == {
        "options": [{"name": name} for name in PASS_RESULT_OPTIONS]
    }
    assert updated["path"] == (
        "/open-apis/bitable/v1/apps/app-exec/tables/tbl-runs/fields/fld-结果"
    )
    assert (updated["base_token"], updated["table_id"]) == ("app-exec", "tbl-runs")
    # The column that was not ticked keeps its type, and no row was touched.
    live = {field["field_name"]: field["type"] for field in lark_fake.fields}
    assert live["结果"] == 3
    assert live["优先级"] == 1
    assert live["用例"] == 1
    assert not lark_fake.put_calls and not lark_fake.delete_calls
    # A real structure change invalidates the earlier write approval.
    assert body["target"]["confirmed"] is False
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None and stored.confirmed_at is None


def test_retype_refuses_without_acknowledgement(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _all_text_exec_headers()

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/retype",
        json={"role": "execution", "field_names": ["结果"], "acknowledge": False},
    )

    assert response.status_code == 409
    assert lark_fake.updated_fields == []
    assert lark_fake.requests == []


def test_retype_only_touches_a_header_of_the_named_role(
    lark_fake, authenticated_client, provision_group
):
    """A defect header may not be converted through the execution table."""

    lark_fake.fields = _all_text_exec_headers()

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/retype",
        json={
            "role": "execution",
            "field_names": ["问题描述", "进展状态", "用例"],
            "acknowledge": True,
        },
    ).json()

    assert body["retyped_fields"] == []
    assert lark_fake.updated_fields == []


def test_retype_is_a_no_op_and_keeps_the_approval_once_everything_is_right(
    lark_fake, authenticated_client, provision_group, db_session
):
    lark_fake.fields = [
        {"field_id": f"fld-{index}", "field_name": name, "type": type_id}
        for index, (name, type_id) in enumerate(
            {
                "用例": 1,
                "结果": 3,
                "优先级": 3,
                "负责人": 1,
                "报告人": 1,
                "日期": 5,
                "截图": 17,
                "控制台": 1,
            }.items()
        )
    ]
    lark_fake.bug_fields = [
        {"field_id": f"fld-bug-{index}", "field_name": name, "type": type_id}
        for index, (name, type_id) in enumerate(
            {
                "问题描述": 1,
                "进展状态": 3,
                "优先级": 3,
                "反馈时间": 5,
                "备注": 1,
                "反馈人": 11,
                "跟进人": 11,
                "截图": 17,
            }.items()
        )
    ]
    payload = {
        "role": "execution",
        "field_names": ["结果", "优先级"],
        "acknowledge": True,
    }

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/retype", json=payload
    ).json()

    assert body["retyped_fields"] == []
    assert lark_fake.updated_fields == []
    # Nothing changed, so the approval that already covered this structure has
    # to survive: a no-op must never force a re-confirmation.
    assert body["target"]["confirmed"] is True
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None and stored.confirmed_at is not None


def test_retype_reports_a_refused_conversion_as_a_conflict(
    lark_fake, authenticated_client, provision_group, monkeypatch
):
    lark_fake.fields = _all_text_exec_headers()

    def refuse(*args, **kwargs):
        raise LarkError("Lark rejected the field update (code 1254306): bad type")

    monkeypatch.setattr(lark_fake.client, "update_field", refuse)
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/retype",
        json={"role": "execution", "field_names": ["结果"], "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["reason"] == "provision_failed"
    assert "修正表头类型失败" in detail["message"]
    assert "test-app-secret" not in response.text


def _attempt_with_job(db_session, group, *, result: str = "不通过"):
    """One committed attempt of this group, already written to both tables."""

    group_case = db_session.scalar(
        select(GroupCase).where(GroupCase.group_id == group.id)
    )
    attempt = Attempt(
        group_case=group_case,
        label="B-001",
        sequence=1,
        state="committed",
        result=result,
        note="",
        console_text="",
        idempotency_key="fixture-rebuild-1",
    )
    db_session.add(attempt)
    db_session.flush()
    job = SyncJob(
        attempt_id=attempt.id,
        state="synced",
        new_exec_record_id="rec-exec-1",
        new_bug_record_id="rec-bug-1",
        target_fingerprint="app-exec|tbl-runs|app-bug|tbl-defects",
    )
    db_session.add(job)
    db_session.commit()
    return attempt, job


def test_rebuilding_a_table_replaces_it_in_the_reference_layout(
    lark_fake, authenticated_client, provision_group, db_session
):
    """A table built before the schema was known is rebuilt, not patched.

    Neither the column order nor the primary column can be edited through the
    API, so the only way back to the reference layout is a new table: it is
    created with the reference headers in the reference order and the group is
    pointed at it.
    """

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    ).json()

    created = lark_fake.created_tables[0]
    assert created["base_token"] == "app-exec"
    # 用例 first: the first header Lark is given is the primary column.
    assert [field["field_name"] for field in created["fields"]] == [
        "用例",
        "结果",
        "优先级",
        "负责人",
        "截图",
        "控制台",
        "报告人",
        "日期",
    ]
    assert body["table"] == {"table_id": "tbl-new", "name": rebuilt_table_name("执行记录")}
    assert body["replaced"] == {"table_id": "tbl-runs", "name": "执行记录"}
    assert body["role"] == "execution"

    db_session.expire_all()
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None
    assert stored.execution_table_id == "tbl-new"
    assert stored.execution_table_name == rebuilt_table_name("执行记录")
    # The defect table did not move, and neither did its base.
    assert stored.bug_base_token == "app-bug"
    assert stored.bug_table_id == "tbl-defects"
    # The recorded view belongs to the replaced table.
    assert stored.execution_view_id is None
    assert stored.target_fingerprint == "app-exec|tbl-new|app-bug|tbl-defects"
    # A rebuilt destination can never inherit the previous write approval.
    assert stored.confirmed_at is None
    assert body["target"]["confirmed"] is False


def test_rebuilding_one_role_requeues_only_that_roles_rows(
    lark_fake, authenticated_client, provision_group, db_session
):
    """The rebuilt table is empty, so its rows are written again.

    The other role's table did not move: clearing its record id would append a
    second row beside the one already there.
    """

    attempt, _job = _attempt_with_job(db_session, provision_group)

    body = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "bug", "acknowledge": True},
    ).json()

    assert body["requeued"] == 1
    db_session.expire_all()
    stored = db_session.scalar(select(SyncJob).where(SyncJob.attempt_id == attempt.id))
    assert stored is not None
    assert stored.new_bug_record_id is None
    assert stored.new_exec_record_id == "rec-exec-1"
    assert stored.state == "pending"
    assert stored.retry_count == 0
    assert stored.error_kind is None
    assert stored.target_fingerprint == "app-exec|tbl-runs|app-bug|tbl-new"


def test_rebuilding_a_table_needs_the_acknowledgement(
    lark_fake, authenticated_client, provision_group
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution"},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "需确认后才会重建数据表"
    assert lark_fake.created_tables == []


def test_rebuilding_one_role_leaves_the_other_role_rebuildable(
    lark_fake, authenticated_client, provision_group, db_session
):
    """A rebuild clears the write approval, and the next role still rebuilds.

    Rebuilding both tables of a group is an ordinary thing to do, so the second
    call may not be refused for the state the first one created: nothing is
    written into an unapproved table, and the group is confirmed again once,
    at the end, against both rebuilt tables.
    """

    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )
    assert first.status_code == 200, first.text
    assert first.json()["target"]["confirmed"] is False

    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "bug", "acknowledge": True},
    )

    assert second.status_code == 200, second.text
    assert second.json()["replaced"] == {"table_id": "tbl-defects", "name": "缺陷记录"}
    db_session.expire_all()
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None
    assert stored.execution_table_id == "tbl-new"
    assert stored.bug_table_id == "tbl-new"
    # Two tables exist now, and neither of them is approved by accident.
    assert stored.confirmed_at is None


def test_rebuilding_a_table_waits_for_a_running_job(
    lark_fake, authenticated_client, provision_group, db_session
):
    """A row in flight is writing into the table this would replace."""

    attempt, job = _attempt_with_job(db_session, provision_group)
    job.state = "running"
    db_session.commit()

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"] == "有记录正在同步，请稍后再重建"
    assert lark_fake.created_tables == []


def test_rebuilding_a_table_rejects_an_unknown_role(
    lark_fake, authenticated_client, provision_group
):
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "screenshots", "acknowledge": True},
    )

    assert response.status_code == 422
    assert lark_fake.created_tables == []


def test_rebuilding_a_table_reports_a_table_lark_cannot_read(
    lark_fake, authenticated_client, provision_group, db_session
):
    """A base the app can only read cannot be built in either."""

    target = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    target.execution_table_id = "tbl-gone"
    db_session.commit()

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert "tbl-gone" in response.json()["detail"]
    assert lark_fake.created_tables == []


def test_rebuilding_a_table_reports_a_refused_creation(
    lark_fake, authenticated_client, provision_group, db_session
):
    lark_fake.table_create_http_status = 403

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert "重建数据表失败" in response.json()["detail"]
    db_session.expire_all()
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    # Nothing was replaced, so the approved target is still the approved one.
    assert stored is not None and stored.execution_table_id == "tbl-runs"
    assert stored.confirmed_at is not None


def _reference_layout(role: str) -> list[dict[str, Any]]:
    """The headers a table this tool just built would answer with."""

    return [
        {
            "field_id": f"fld-{index}",
            "field_name": name,
            "type": ROLE_SCHEMA[role][name].type_id,
            # Lark reports which column is the primary one, and the order alone
            # cannot tell: 用例 first is exactly what makes the layout right.
            "is_primary": index == 0,
        }
        for index, name in enumerate(schema_order(role))
    ]


def test_rebuilding_a_table_already_in_the_reference_layout_is_refused(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _reference_layout("execution")

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert "已经是参考表头" in response.json()["detail"]
    # Nothing was created: a refusal must not leave a spare table behind.
    assert lark_fake.created_tables == []


def test_force_rebuilds_a_table_that_already_looks_right(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields = _reference_layout("execution")

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True, "force": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_a_table_whose_headers_are_in_the_wrong_order_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """The case the feature exists for: 优先级 first, everything else off."""

    rows = _reference_layout("execution")
    # The pre-fix tables were created alphabetically, and Lark takes the primary
    # column from whichever field was created first — so 优先级 leads *and* is
    # the primary one. Sorting the reference names reproduces that table.
    lark_fake.fields = [
        {**row, "is_primary": index == 0}
        for index, row in enumerate(sorted(rows, key=lambda row: row["field_name"]))
    ]

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text


def test_a_table_reordered_within_one_type_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """Isolate the ordered-name clause.

    The alphabetical table above is also caught by the type comparison: 用例's
    spec never pairs with 优先级's live type, so a loosened name check still
    rebuilds it by accident. Two columns that share a type, swapped, leave every
    pairwise type in place — only the name comparison can tell this table from
    the reference layout, so this is what pins that clause.
    """

    rows = _reference_layout("execution")
    rows[0], rows[3] = rows[3], rows[0]  # 用例 and 负责人 are both text columns.
    rows[0]["is_primary"] = True  # The swapped-in first column leads the table.
    rows[3]["is_primary"] = False
    lark_fake.fields = rows

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_a_reference_table_without_the_primary_marker_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """A match we cannot confirm must not be refused on a guess."""

    rows = _reference_layout("execution")
    rows[0]["is_primary"] = False
    lark_fake.fields = rows

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_a_reference_table_with_a_wrong_type_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """Right names, order and primary — but one column's type is off."""

    rows = _reference_layout("execution")
    rows[3]["type"] = 3  # 负责人 is a person column, not 单选.
    lark_fake.fields = rows

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_a_reference_table_with_a_stray_column_still_rebuilds(
    lark_fake, authenticated_client, provision_group
):
    """No delete-column API: a rebuild is the only way to drop an extra column."""

    lark_fake.fields = [
        *_reference_layout("execution"),
        {"field_id": "fld-extra", "field_name": "单选", "type": 3, "is_primary": False},
    ]

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 200, response.text
    assert lark_fake.created_tables


def test_rebuilding_a_table_reports_a_field_read_failure(
    lark_fake, authenticated_client, provision_group
):
    lark_fake.fields_error = True

    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/rebuild",
        json={"role": "execution", "acknowledge": True},
    )

    assert response.status_code == 409, response.text
    assert "读取数据表字段失败" in response.json()["detail"]
    # The hint is the actionable half: a field read fails because the app lost
    # its collaborator seat far more often than for any other reason.
    assert "协作者" in response.json()["detail"]
    assert lark_fake.created_tables == []


def test_the_plan_says_how_many_rows_a_rebuild_would_rewrite(
    lark_fake, authenticated_client, provision_group
):
    cases = authenticated_client.get(f"/api/groups/{provision_group.id}/cases").json()
    codes = [case["code"] for case in cases][:2]
    assert len(codes) == 2, "这个 fixture 需要至少两条用例"

    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/{codes[0]}/attempts",
        json={"result": "通过", "idempotency_key": "rebuild-count-1"},
    )
    assert first.status_code == 201, first.text
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/{codes[1]}/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "idempotency_key": "rebuild-count-2",
        },
    )
    assert second.status_code == 201, second.text

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    # 执行表重写每一条本地结果；缺陷表只重写「不通过」的那一条。
    assert plan["rebuild"] == {"execution": 2, "bug": 1}


def test_a_row_adopted_from_the_table_is_not_counted_as_a_rebuild_row(
    lark_fake, authenticated_client, provision_group
):
    """A reconcile-sourced row is never queued back, so it is not re-filed."""

    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "adopted-count-1"},
    )
    assert first.status_code == 201, first.text
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/B-002/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "idempotency_key": "adopted-count-2",
        },
    )
    assert second.status_code == 201, second.text

    # B-001 disagrees with the table, so a fresh read offers a conflict and
    # 「use_remote」 appends the table's 不通过 as a reconcile-sourced attempt.
    lark_fake.records = [
        {
            "record_id": "rec-adopted",
            "fields": {"用例": "B-001 管理员登录", "结果": "不通过"},
        }
    ]
    applied = authenticated_client.post(
        f"/api/groups/{provision_group.id}/reconcile/apply",
        json={"decisions": [{"key": "B-001", "action": "use_remote"}]},
    ).json()
    assert applied["pulled"] == 1, applied

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    # The adopted 不通过 is invisible to both counts: a rebuild will not queue
    # it back, so it must not appear in the cost the dialog shows.
    assert plan["rebuild"] == {"execution": 2, "bug": 1}


def test_a_reserved_retest_is_not_counted_as_a_rebuild_row(
    lark_fake, authenticated_client, provision_group
):
    """A reserved row carries no result, so a rebuild does not re-file it."""

    first = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/B-001/attempts",
        json={"result": "通过", "idempotency_key": "reserved-count-1"},
    )
    assert first.status_code == 201, first.text
    second = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/B-002/attempts",
        json={
            "result": "不通过",
            "note": "登录按钮没反应",
            "idempotency_key": "reserved-count-2",
        },
    )
    assert second.status_code == 201, second.text

    reserved = authenticated_client.post(
        f"/api/groups/{provision_group.id}/cases/B-001/retest"
    )
    assert reserved.status_code == 201, reserved.text
    assert reserved.json()["state"] == "started"

    plan = authenticated_client.get(
        f"/api/groups/{provision_group.id}/lark/provision"
    ).json()

    # The reservation has no result yet: it is not one of the rows a rebuild
    # writes again.
    assert plan["rebuild"] == {"execution": 2, "bug": 1}
