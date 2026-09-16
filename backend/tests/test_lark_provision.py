from datetime import datetime, timezone

import pytest
from sqlalchemy import select

from app.lark.provision import PROVISION_FIELD_TYPES, provision_plan
from app.models import LarkTarget


@pytest.fixture(autouse=True)
def provisionable_table(request):
    """Point the fixture group at the standard two-base target.

    ``imported_group`` deliberately has no stored ``LarkTarget`` (see
    ``test_lark_target.py::test_read_target_before_any_target_is_chosen``) and
    provisioning only ever happens inside a target the administrator chose. The
    execution table then starts with a single header, which is the situation the
    endpoint exists for. The plan builders above are pure functions, so only the
    tests that drive the endpoints through ``lark_fake`` get either change.
    """

    if "lark_fake" not in request.fixturenames:
        return
    lark_fake = request.getfixturevalue("lark_fake")
    db_session = request.getfixturevalue("db_session")
    group = request.getfixturevalue("imported_group")
    lark_fake.fields = [{"field_name": "用例", "type": 1}]
    db_session.add(
        LarkTarget(
            group_id=group.id,
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
        if "/records" in request_seen["path"] and request_seen["method"] != "GET"
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
    lark_fake, authenticated_client, imported_group
):
    lark_fake.fields = [{"field_name": "用例", "type": 1}]
    preview = authenticated_client.get(
        f"/api/groups/{imported_group.id}/lark/provision"
    ).json()
    names = [field["name"] for field in preview["roles"]["execution"]]
    assert "用例" not in names

    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "日期"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()
    assert body["created_fields"] == ["日期", "结果"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["日期", "结果"]
    assert not lark_fake.record_requests


def test_setting_headers_refuses_an_unapproved_request(
    lark_fake, authenticated_client, imported_group
):
    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": False,
        },
    )
    assert response.status_code == 409
    assert not lark_fake.created_fields


def test_setting_headers_is_idempotent(lark_fake, authenticated_client, imported_group):
    payload = {
        "role": "execution",
        "field_names": ["结果"],
        "create_view": False,
        "acknowledge": True,
    }
    first = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields", json=payload
    ).json()
    second = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields", json=payload
    ).json()
    assert first["created_fields"] == ["结果"]
    assert second["created_fields"] == []
    assert len(lark_fake.created_fields) == 1


def test_creating_a_table_returns_its_new_id(lark_fake, authenticated_client, imported_group):
    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": True,
        },
    ).json()
    assert body["table"]["table_id"] == "tbl-new"
    assert body["table"]["name"] == "缺陷记录"
    assert len(lark_fake.created_tables[0]["fields"]) == 6


def test_setting_headers_creates_the_view_when_asked_to(
    lark_fake, authenticated_client, imported_group
):
    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": True,
            "acknowledge": True,
        },
    ).json()

    assert body["created_fields"] == ["结果"]
    assert lark_fake.created_views == [{"view_name": "TestDeck", "view_type": "grid"}]


def test_setting_headers_never_invents_a_field(
    lark_fake, authenticated_client, imported_group
):
    """Only a requested header of this role may be created, whatever is asked."""

    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果", "问题描述", "自定义列"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()

    assert body["created_fields"] == ["结果"]
    assert [field["field_name"] for field in lark_fake.created_fields] == ["结果"]


def test_setting_headers_clears_the_write_approval(
    lark_fake, authenticated_client, imported_group, db_session
):
    body = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/fields",
        json={
            "role": "execution",
            "field_names": ["结果"],
            "create_view": False,
            "acknowledge": True,
        },
    ).json()

    stored = db_session.scalar(
        select(LarkTarget).where(LarkTarget.group_id == imported_group.id)
    )
    assert body["target"]["confirmed"] is False
    assert stored is not None and stored.confirmed_at is None


def test_creating_a_table_requires_acknowledgement(
    lark_fake, authenticated_client, imported_group
):
    response = authenticated_client.post(
        f"/api/groups/{imported_group.id}/lark/provision/table",
        json={
            "role": "bug",
            "base_token": "app-bug",
            "table_name": "缺陷记录",
            "acknowledge": False,
        },
    )

    assert response.status_code == 409
    assert not lark_fake.created_tables
