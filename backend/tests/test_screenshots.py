from io import BytesIO
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app import screenshots
from app.main import app
from app.models import Screenshot


def test_uploaded_attachment_is_private_and_uses_uuid_storage(
    authenticated_client, attempt_id, valid_png, anonymous_client, upload_dir
):
    response = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("../../unsafe.png", valid_png, "image/png")},
    )

    assert response.status_code == 201
    body = response.json()
    shot_id = body["id"]
    assert body["storage_key"] != "../../unsafe.png"
    assert "/" not in body["storage_key"] and ".." not in body["storage_key"]
    assert body["mime"] == "image/png"
    assert body["size_bytes"] == len(valid_png)
    assert (upload_dir / body["storage_key"]).read_bytes() == valid_png

    assert anonymous_client.get(f"/api/screenshots/{shot_id}").status_code == 401
    private = authenticated_client.get(f"/api/screenshots/{shot_id}")
    assert private.status_code == 200
    assert private.content == valid_png
    assert private.headers["cache-control"] == "private, no-store"


def test_rejects_non_image_and_unsupported_format(
    authenticated_client, attempt_id, upload_dir
):
    not_an_image = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("notes.txt", b"just text", "text/plain")},
    )
    gif = _png_as(authenticated_client, attempt_id, format="GIF")

    assert not_an_image.status_code == 400
    assert gif.status_code == 400
    assert not list(upload_dir.iterdir())


def _png_as(client, attempt_id, *, format: str):
    buffer = BytesIO()
    Image.new("RGB", (2, 2), (0, 0, 255)).save(buffer, format=format)
    return client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": (f"shot.{format.lower()}", buffer.getvalue(), "image/gif")},
    )


def test_rejects_oversized_and_unknown_attempt(
    authenticated_client, attempt_id, valid_png, upload_dir
):
    oversized = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("big.png", valid_png + b"\0" * (20 * 1024 * 1024), "image/png")},
    )
    unknown = authenticated_client.post(
        f"/api/attempts/{uuid4()}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )

    assert oversized.status_code == 413
    assert unknown.status_code == 404
    assert not list(upload_dir.iterdir())


def test_failed_write_leaves_no_dangling_row(
    monkeypatch, authenticated_client, attempt_id, valid_png, upload_dir, db_session
):
    def broken_write(storage_path, content):
        raise OSError("disk full")

    monkeypatch.setattr(screenshots, "_write_file", broken_write)

    response = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )

    assert response.status_code == 500
    assert db_session.scalars(select(Screenshot)).all() == []


def test_upload_survives_a_new_application_session(
    authenticated_client, attempt_id, valid_png, upload_dir
):
    created = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )
    assert created.status_code == 201
    shot_id = created.json()["id"]
    cookie = authenticated_client.cookies["testdeck_session"]

    with TestClient(app) as restarted:
        restarted.cookies.set("testdeck_session", cookie)
        fetched = restarted.get(f"/api/screenshots/{shot_id}")

    assert fetched.status_code == 200
    assert fetched.content == valid_png


def test_missing_file_for_known_row_is_not_a_success(
    authenticated_client, attempt_id, valid_png, upload_dir
):
    created = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )
    shot_id = created.json()["id"]
    (upload_dir / created.json()["storage_key"]).unlink()

    assert authenticated_client.get(f"/api/screenshots/{shot_id}").status_code == 404


def test_empty_upload_is_rejected(authenticated_client, attempt_id, upload_dir):
    response = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", b"", "image/png")},
    )

    assert response.status_code == 400
    assert not list(upload_dir.iterdir())


def test_an_attempt_payload_lists_its_screenshots(
    authenticated_client, local_attempt, valid_png, upload_dir
):
    created = authenticated_client.post(
        f"/api/attempts/{local_attempt.id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )

    assert created.status_code == 201
    shot = created.json()
    case = local_attempt.group_case
    listing = authenticated_client.get(
        f"/api/groups/{case.group_id}/cases/{case.code}/attempts"
    )

    assert listing.status_code == 200
    attempts = listing.json()
    assert len(attempts) == 1
    # The row the executor submitted shows the evidence it was submitted with:
    # the page renders a thumbnail from each entry.
    assert attempts[0]["screenshots"] == [
        {
            "id": shot["id"],
            "attempt_id": str(local_attempt.id),
            "storage_key": shot["storage_key"],
            "mime": "image/png",
            "size_bytes": len(valid_png),
            "created_at": shot["created_at"],
        }
    ]


def test_the_same_picture_for_one_attempt_is_stored_once(
    authenticated_client, attempt_id, valid_png, upload_dir, db_session
):
    first = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("first.png", valid_png, "image/png")},
    )
    # The retry a partial upload invites: the same picture, another file name.
    second = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("second.png", valid_png, "image/png")},
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["storage_key"] == first.json()["storage_key"]
    rows = db_session.scalars(
        select(Screenshot).where(Screenshot.attempt_id == attempt_id)
    ).all()
    assert len(rows) == 1
    # One row means one file: the retry wrote nothing to clean up, and Lark's
    # attachment list carries the picture once.
    assert [path.name for path in upload_dir.iterdir()] == [first.json()["storage_key"]]


def test_two_different_pictures_for_one_attempt_are_both_kept(
    authenticated_client, attempt_id, valid_png, upload_dir, db_session
):
    other = BytesIO()
    Image.new("RGB", (3, 3), (9, 9, 9)).save(other, format="PNG")
    first = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("first.png", valid_png, "image/png")},
    )
    second = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("second.png", other.getvalue(), "image/png")},
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    rows = db_session.scalars(
        select(Screenshot).where(Screenshot.attempt_id == attempt_id)
    ).all()
    assert len(rows) == 2
    assert len(list(upload_dir.iterdir())) == 2


def test_the_database_refuses_a_second_row_for_the_same_bytes(
    authenticated_client, attempt_id, valid_png, upload_dir, db_session
):
    created = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("shot.png", valid_png, "image/png")},
    )
    row = db_session.scalar(
        select(Screenshot).where(Screenshot.id == created.json()["id"])
    )

    # The lookup in the route is the fast path; the unique index is the guarantee
    # behind it, so a writer that skips the lookup — or two uploads that race past
    # it — still cannot file the same bytes for one attempt twice.
    with pytest.raises(IntegrityError):
        with db_session.begin_nested():
            db_session.add(
                Screenshot(
                    attempt_id=attempt_id,
                    storage_key="a-second-file.png",
                    content_hash=row.content_hash,
                    mime="image/png",
                    size_bytes=row.size_bytes,
                )
            )
            db_session.flush()

    assert (
        len(
            db_session.scalars(
                select(Screenshot).where(Screenshot.attempt_id == attempt_id)
            ).all()
        )
        == 1
    )


def test_a_racing_duplicate_answers_with_the_row_that_won(
    monkeypatch, authenticated_client, attempt_id, valid_png, upload_dir, db_session
):
    first = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("first.png", valid_png, "image/png")},
    )

    # Blind the fast lookup on its first call so the route takes the insert path,
    # exactly as a second upload that raced past that lookup would. The insert
    # then loses on the unique index, and the route has to answer with the row
    # that won instead of a 500 — and clean up the file it had already written.
    real_lookup = screenshots._already_stored
    calls = {"n": 0}

    def blind_once(db, attempt_id, content_hash):
        calls["n"] += 1
        if calls["n"] == 1:
            return None
        return real_lookup(db, attempt_id, content_hash)

    monkeypatch.setattr(screenshots, "_already_stored", blind_once)

    second = authenticated_client.post(
        f"/api/attempts/{attempt_id}/screenshots",
        files={"image": ("second.png", valid_png, "image/png")},
    )

    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]
    assert calls["n"] == 2
    rows = db_session.scalars(
        select(Screenshot).where(Screenshot.attempt_id == attempt_id)
    ).all()
    assert len(rows) == 1
    # The loser's file is gone: the winner's is the only one left on disk.
    assert [path.name for path in upload_dir.iterdir()] == [first.json()["storage_key"]]
