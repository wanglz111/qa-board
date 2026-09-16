from uuid import uuid4

from sqlalchemy import select

from app.models import CaseReferenceAsset
from tests.casebook_fixture import casebook_zip


def import_casebook(client) -> tuple[str, list[dict]]:
    preview = client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", casebook_zip(), "application/zip")},
    )
    created = client.post(
        "/api/import/confirm",
        json={"ticket_id": preview.json()["ticket_id"], "name": "Odyssey v2.0"},
    )
    group_id = created.json()["id"]
    return group_id, client.get(f"/api/groups/{group_id}/cases").json()


def test_case_list_returns_role_caption_and_focus(authenticated_client):
    _, cases = import_casebook(authenticated_client)

    first = cases[0]
    assert [asset["asset_key"] for asset in first["reference_assets"]] == [
        "sale-stage-selling",
        "sale-confirm-modal",
    ]
    assert first["reference_assets"][0]["role"] == "expected"
    assert first["reference_assets"][0]["caption"] == "默认发售态"
    assert first["reference_assets"][0]["name"] == "节点发售 · 阶段1 发售中"
    assert first["reference_assets"][0]["prototype_version"] == "v2.0"
    assert first["reference_assets"][1]["focus"][0]["label"] == "确认按钮"
    assert first["expect_absent"] == ["已售罄"]
    assert first["visual_check"] == "text_and_visual"
    assert first["prototype_note"] is None
    assert cases[1]["visual_check"] == "not_verifiable"
    assert cases[1]["prototype_note"] == "红色倒计时原型默认不展示，需要演示开关触发"
    assert cases[1]["reference_assets"][0]["role"] == "locator"
    # Neither the filesystem path nor the binary ever reaches the client.
    assert "storage_key" not in str(cases)
    assert "source_path" not in str(cases)


def test_two_cases_share_one_asset_row(authenticated_client):
    _, cases = import_casebook(authenticated_client)

    first_id = cases[0]["reference_assets"][0]["id"]
    second_id = cases[1]["reference_assets"][0]["id"]

    assert first_id == second_id


def test_reference_image_is_served_privately(
    authenticated_client, anonymous_client, upload_dir
):
    _, cases = import_casebook(authenticated_client)
    asset_id = cases[0]["reference_assets"][0]["id"]

    assert (
        anonymous_client.get(f"/api/case-reference-assets/{asset_id}").status_code == 401
    )

    image = authenticated_client.get(f"/api/case-reference-assets/{asset_id}")
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "private, no-store"
    assert image.content.startswith(b"\x89PNG")


def test_unknown_reference_image_is_404(authenticated_client):
    assert (
        authenticated_client.get(f"/api/case-reference-assets/{uuid4()}").status_code
        == 404
    )


def test_missing_file_for_a_known_asset_is_404(
    authenticated_client, db_session, upload_dir
):
    _, cases = import_casebook(authenticated_client)
    asset_id = cases[0]["reference_assets"][0]["id"]
    storage_key = db_session.scalar(
        select(CaseReferenceAsset.storage_key).where(CaseReferenceAsset.id == asset_id)
    )
    (upload_dir / "reference" / storage_key).unlink()

    assert (
        authenticated_client.get(f"/api/case-reference-assets/{asset_id}").status_code
        == 404
    )


def test_a_group_without_reference_images_lists_empty_assets(
    authenticated_client, imported_group
):
    cases = authenticated_client.get(f"/api/groups/{imported_group.id}/cases").json()

    assert cases[0]["reference_assets"] == []
    assert cases[0]["expect_absent"] == []
    assert cases[0]["visual_check"] == "text_and_visual"
