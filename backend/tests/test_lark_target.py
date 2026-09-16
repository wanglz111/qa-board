from sqlalchemy import select

from app.models import LarkTargetRevision


def test_resolve_returns_base_tables_and_the_linked_table(
    lark_fake, authenticated_client
):
    lark_fake.wiki_nodes["node-1"] = {"obj_type": "bitable", "obj_token": "app-exec"}
    body = authenticated_client.post(
        "/api/lark/resolve", json={"url": lark_fake.wiki_url}
    ).json()
    assert body["base_token"] == "app-exec"
    assert body["base_name"] == "执行库"
    assert {table["table_id"] for table in body["tables"]} == {"tbl-runs", "tbl-bugs"}
    assert body["selected"]["table_id"] == "tbl-runs"
    assert body["selected"]["view_id"] == "vew-main"
    assert "用例" in body["execution_fields"]
    assert body["read_errors"] == []


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
    fingerprints = db_session.scalars(
        select(LarkTargetRevision.target_fingerprint).where(
            LarkTargetRevision.group_id == imported_group.id
        )
    ).all()
    assert len(fingerprints) == 2
