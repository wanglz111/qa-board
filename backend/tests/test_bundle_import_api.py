import json
from io import BytesIO
from pathlib import Path
import zipfile

import pytest
from sqlalchemy import select

from app.models import CaseReferenceAsset, CaseReferenceLink
from tests.casebook_fixture import casebook, casebook_zip, png_bytes


def preview(client, payload: bytes):
    return client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", payload, "application/zip")},
    )


def test_preview_reports_cases_assets_links_and_version(authenticated_client):
    response = preview(authenticated_client, casebook_zip())

    assert response.status_code == 200
    body = response.json()
    assert body["detected_format"] == "zip"
    assert body["count"] == 2
    # Two unique images, three slots: C-05 uses two, C-11 reuses one as locator.
    assert body["reference_asset_count"] == 2
    assert body["reference_link_count"] == 3
    assert body["prototype_version"] == "v2.0"
    assert body["title"] == "Odyssey 节点发售回归"
    first = body["cases"][0]
    assert first["code"] == "C-05"
    assert first["reference_asset_count"] == 2
    assert first["expect_absent"] == ["已售罄"]
    assert first["visual_check"] == "text_and_visual"
    # Preview never leaks binaries, storage keys or filesystem paths.
    assert "storage_key" not in json.dumps(body)
    assert "source_path" not in json.dumps(body)
    assert "content" not in json.dumps(body)


def test_confirm_dedupes_assets_and_writes_one_file_each(
    authenticated_client, upload_dir, db_session
):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]

    created = authenticated_client.post(
        "/api/import/confirm",
        json={"ticket_id": ticket, "name": "Odyssey v2.0"},
    )

    assert created.status_code == 201
    body = created.json()
    assert body["count"] == 2
    assert body["reference_asset_count"] == 2
    assert body["reference_link_count"] == 3

    assets = db_session.scalars(
        select(CaseReferenceAsset).order_by(CaseReferenceAsset.asset_key)
    ).all()
    links = db_session.scalars(select(CaseReferenceLink)).all()
    assert [asset.asset_key for asset in assets] == [
        "sale-confirm-modal",
        "sale-stage-selling",
    ]
    assert len(links) == 3
    assert {link.role for link in links} == {"expected", "locator"}
    assert all("/" not in asset.storage_key for asset in assets)
    assert all(asset.prototype_version == "v2.0" for asset in assets)
    assert sum(len(link.focus) for link in links) == 1

    written = sorted((upload_dir / "reference").iterdir())
    assert len(written) == 2
    assert sum(path.stat().st_size for path in written) == 2 * len(png_bytes())


def test_confirm_keeps_role_caption_and_focus(authenticated_client, db_session):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]
    authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )

    captioned = db_session.scalars(
        select(CaseReferenceLink).where(CaseReferenceLink.caption.is_not(None))
    ).one()
    assert captioned.caption == "默认发售态"
    assert captioned.asset.asset_key == "sale-stage-selling"

    focused = next(
        link
        for link in db_session.scalars(select(CaseReferenceLink)).all()
        if link.focus
    )
    assert focused.focus[0]["label"] == "确认按钮"
    assert focused.focus[0]["box"] == [0.62, 0.78, 0.3, 0.08]


def test_casebook_import_rejects_invalid_input(authenticated_client, upload_dir):
    broken = preview(authenticated_client, b"not a zip")
    assert broken.status_code == 422
    assert "ZIP" in broken.json()["detail"]

    empty_zip = BytesIO()
    with zipfile.ZipFile(empty_zip, "w"):
        pass
    missing = preview(authenticated_client, empty_zip.getvalue())
    assert missing.status_code == 422
    assert "casebook.json" in missing.json()["detail"]
    assert not (upload_dir / "reference").exists()

    dangling = preview(
        authenticated_client,
        casebook_zip(
            book=casebook(
                cases=[
                    {
                        "code": "C-05",
                        "title": "认购",
                        "steps": ["点确认购买"],
                        "expected": ["按钮: 显示「确认购买」"],
                        "visual": {
                            "check": "visual_only",
                            "references": [
                                {"asset": "sale-confirm-modal", "role": "expected"}
                            ],
                        },
                    }
                ]
            ),
            images={"sale-stage-selling.png": png_bytes()},
        ),
    )
    assert dangling.status_code == 422
    assert "unknown asset 'sale-confirm-modal'" in dangling.json()["detail"]


def test_confirm_consumes_the_ticket_once(authenticated_client, upload_dir):
    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]
    first = authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )
    second = authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )

    assert first.status_code == 201
    assert second.status_code == 409


def test_text_import_path_is_unchanged(authenticated_client, csv_book):
    response = authenticated_client.post(
        "/api/import/preview",
        files={"file": ("0918.csv", csv_book, "text/csv")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["detected_format"] == "csv"
    assert "reference_asset_count" not in body
    assert "reference_assets" not in json.dumps(body)


def test_confirm_cleans_up_a_partially_written_image(
    authenticated_client, upload_dir, monkeypatch
):
    # A disk error midway through write_bytes() leaves a partial file behind.
    # That file was not in the cleanup list, so it survived the failed import.
    original = Path.write_bytes
    calls = {"count": 0}

    def flaky_write(self: Path, data: bytes) -> int:
        calls["count"] += 1
        if calls["count"] == 1:
            self.parent.mkdir(parents=True, exist_ok=True)
            with self.open("wb") as handle:
                handle.write(b"partial")
            raise OSError(28, "No space left on device")
        return original(self, data)

    monkeypatch.setattr(Path, "write_bytes", flaky_write)

    ticket = preview(authenticated_client, casebook_zip()).json()["ticket_id"]
    failed = authenticated_client.post(
        "/api/import/confirm", json={"ticket_id": ticket, "name": "Odyssey"}
    )
    assert failed.status_code == 500

    reference_dir = upload_dir / "reference"
    leftovers = list(reference_dir.iterdir()) if reference_dir.exists() else []
    assert leftovers == []
