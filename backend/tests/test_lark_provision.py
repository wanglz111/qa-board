from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.lark.client import RECORD_MUTATION_METHODS, LarkError
from app.lark.provision import PROVISION_FIELD_TYPES, provision_plan
from app.models import Group, LarkTarget


@pytest.fixture
def provision_group(lark_fake, db_session, imported_group) -> Group:
    """A group bound to the standard two-base target, poised for provisioning.

    ``imported_group`` deliberately has no stored ``LarkTarget`` (see
    ``test_lark_target.py::test_read_target_before_any_target_is_chosen``) and
    provisioning only ever happens inside a target the administrator chose. The
    execution table also starts with a single header, which is the situation the
    endpoint exists for. It is a plain fixture rather than an autouse one so the
    binding stays visible in every test that depends on it.
    """

    lark_fake.fields = [{"field_name": "用例", "type": 1}]
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


def test_plan_lists_only_the_missing_required_fields():
    existing = [{"field_name": "用例", "type": 1}, {"field_name": "自定义列", "type": 1}]
    plan = provision_plan(existing, "execution")
    names = [field["name"] for field in plan]
    assert "用例" not in names
    assert "自定义列" not in names
    assert names == sorted(set(names))
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
    assert names == {"问题描述", "进展状态", "优先级", "反馈时间", "备注", "反馈人"}


def test_plan_marks_date_and_attachment_types():
    plan = {field["name"]: field for field in provision_plan([], "execution")}
    assert plan["日期"]["type"] == 5
    assert plan["截图"]["type"] == 17
    assert plan["结果"]["type"] == 1


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
    assert body["created_fields"] == ["日期", "结果"]
    created = lark_fake.created_fields
    assert [field["field_name"] for field in created] == ["日期", "结果"]
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
    assert len(created_table["fields"]) == 6
    assert lark_fake.created_views == []


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
        if name != "优先级":
            raise LarkError(
                "Lark rejected the create (code 1254302): no permission to create fields"
            )
        return real_create(app_token, table_id, name, type_id, properties)

    monkeypatch.setattr(lark_fake.client, "create_field", create_one_then_refuse)
    response = authenticated_client.post(
        f"/api/groups/{provision_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["优先级", "结果"],
            "create_view": False,
            "acknowledge": True,
        },
    )

    assert response.status_code == 409, response.text
    detail = response.json()["detail"]
    assert detail["created_fields"] == ["优先级"]
    assert "创建表头失败" in detail["message"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["优先级"]
    assert lark_fake.created_fields[0]["base_token"] == "app-exec"
    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == provision_group.id)
    )
    assert stored is not None and stored.confirmed_at is None


def test_plan_fails_loudly_when_a_required_header_has_no_type(monkeypatch):
    monkeypatch.delitem(PROVISION_FIELD_TYPES, "控制台")

    with pytest.raises(RuntimeError, match="控制台"):
        provision_plan([], "execution")
