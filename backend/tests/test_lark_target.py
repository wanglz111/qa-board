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
