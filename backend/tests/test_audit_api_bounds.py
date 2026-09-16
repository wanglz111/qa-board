"""End-to-end confirmation: the audited edge cases are 422, never 500."""
import json
import zipfile
from io import BytesIO

import pytest

from tests.casebook_fixture import casebook, casebook_zip, png_bytes, valid_case

ONLY_ASSET = {"sale-stage-selling": {"name": "节点发售", "type": "page"}}


def preview(client, payload: bytes):
    return client.post(
        "/api/import/preview",
        files={"file": ("casebook.zip", payload, "application/zip")},
    )


def visual_case(*, position=None, **focus_overrides):
    reference = {"asset": "sale-stage-selling", "role": "expected"}
    reference.update(focus_overrides)
    case = valid_case(visual={"check": "visual_only", "references": [reference]})
    if position is not None:
        case["position"] = position
    return case


def raw_zip(payload: str, image: bytes | None = None) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("casebook.json", payload)
        archive.writestr("assets/sale-stage-selling.png", image or png_bytes())
    return buffer.getvalue()


def with_box(box_json: str) -> bytes:
    book = casebook(
        cases=[visual_case(focus=[{"label": "按钮", "box": [0, 0, 1, 1]}])],
        assets=ONLY_ASSET,
    )
    return raw_zip(json.dumps(book, ensure_ascii=False).replace("[0, 0, 1, 1]", box_json))


@pytest.mark.parametrize(
    ("payload", "path"),
    [
        (lambda: casebook_zip(book=casebook(cases=[visual_case(position=0)], assets=ONLY_ASSET), images={"sale-stage-selling.png": png_bytes()}), r"cases\[0\]\.position"),
        (lambda: with_box("[NaN, 0, 1, 1]"), r"box\[0\]"),
        (lambda: with_box("[" + "9" * 400 + ", 0, 1, 1]"), r"box\[0\]"),
    ],
)
def test_bad_numbers_are_422_with_a_field_path(authenticated_client, upload_dir, payload, path):
    response = preview(authenticated_client, payload())
    assert response.status_code == 422, response.text
    assert path.replace("\\", "") in response.json()["detail"]
    assert not (upload_dir / "reference").exists()


def test_dot_zip_member_is_422_not_500(authenticated_client):
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("casebook.json", json.dumps(casebook(), ensure_ascii=False))
        archive.writestr("assets/sale-stage-selling.png", png_bytes())
        archive.writestr("assets/sale-confirm-modal.png", png_bytes())
        archive.writestr(".", b"x")

    response = preview(authenticated_client, buffer.getvalue())
    assert response.status_code == 422
    assert "not a safe path" in response.json()["detail"]


def test_corrupt_png_is_422_not_stored(authenticated_client, upload_dir):
    buffer = BytesIO()
    from PIL import Image

    Image.new("RGB", (8, 8)).save(buffer, format="PNG")
    data = buffer.getvalue()
    marker = data.index(b"IDAT")
    length = int.from_bytes(data[marker - 4 : marker], "big")
    import zlib

    payload = b"\x00\x00\x00\x00"
    crc = zlib.crc32(b"IDAT" + payload) & 0xFFFFFFFF
    broken = (
        data[: marker - 4]
        + len(payload).to_bytes(4, "big")
        + b"IDAT"
        + payload
        + crc.to_bytes(4, "big")
        + data[marker + 4 + length + 4 :]
    )

    book = casebook(cases=[visual_case()], assets=ONLY_ASSET)
    response = preview(
        authenticated_client,
        casebook_zip(book=book, images={"sale-stage-selling.png": broken}),
    )
    assert response.status_code == 422
    assert "not a readable image" in response.json()["detail"]
    assert not (upload_dir / "reference").exists()
