import os
import threading
import time

from app.lark import attachments
from app.lark.attachments import cached_download


def _media_downloads(lark_fake) -> list[str]:
    return [
        request["path"]
        for request in lark_fake.requests
        if "/medias/" in request["path"] and request["path"].endswith("/download")
    ]


def test_two_concurrent_cold_fetches_publish_one_intact_entry(lark_fake, tmp_path, monkeypatch):
    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"png-bytes", "image/png")

    real_replace = os.replace
    park = threading.Barrier(2)

    def parked_replace(source, target):
        # Hold both writers just before they publish: a temp name they share
        # would collide here on every run instead of only under load.
        park.wait(timeout=5)
        real_replace(source, target)

    monkeypatch.setattr(attachments.os, "replace", parked_replace)

    results: list[tuple[bytes, str]] = []

    def fetch() -> None:
        results.append(cached_download(lark_fake.client, "file-old", directory=directory))

    threads = [threading.Thread(target=fetch) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=10)

    assert results == [(b"png-bytes", "image/png")] * 2
    # One whole picture landed, and the next look is answered from disk.
    lark_fake.requests.clear()
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"png-bytes",
        "image/png",
    )
    assert _media_downloads(lark_fake) == []


def test_an_over_cap_download_is_not_persisted(lark_fake, tmp_path):
    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"x" * 64, "image/png")

    content, mime = cached_download(
        lark_fake.client, "file-old", directory=directory, max_bytes=8
    )

    assert (content, mime) == (b"x" * 64, "image/png")
    assert not directory.exists() or list(directory.iterdir()) == []


def test_a_failed_sidecar_publish_leaves_nothing_to_serve(lark_fake, tmp_path, monkeypatch):
    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"png-bytes", "image/png")

    real_replace = os.replace

    def refuse_sidecar(source, target):
        if str(target).endswith(".json"):
            raise OSError("the sidecar volume is full")
        real_replace(source, target)

    monkeypatch.setattr(attachments.os, "replace", refuse_sidecar)

    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"png-bytes",
        "image/png",
    )
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"png-bytes",
        "image/png",
    )

    # The sidecar is published first, so one that never lands leaves the bytes
    # unpublished too: there is no fresh entry for the next call to trust.
    assert [path for path in directory.iterdir() if ".part-" not in path.name] == []
    assert len(_media_downloads(lark_fake)) == 2


def test_an_entry_whose_length_does_not_match_is_refetched(lark_fake, tmp_path):
    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"png-bytes", "image/png")
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"png-bytes",
        "image/png",
    )

    # A sidecar that vouches for nine bytes is not a licence to trust a
    # three-byte file: the mismatch is a miss and the picture comes back whole.
    stored = next(
        path for path in directory.iterdir() if path.suffix != ".json" and ".part-" not in path.name
    )
    stored.write_bytes(b"png")
    lark_fake.requests.clear()
    lark_fake.media["file-old"] = (b"tampered", "image/png")

    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"tampered",
        "image/png",
    )
    assert len(_media_downloads(lark_fake)) == 1


def test_a_lapsed_attachment_cache_entry_is_fetched_again(lark_fake, tmp_path):
    directory = tmp_path / "lark-attachments"
    lark_fake.media["file-old"] = (b"one", "image/png")
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"one",
        "image/png",
    )

    # A token's bytes never change, so inside the TTL the disk copy answers;
    # once the entry lapses the picture is re-downloaded rather than trusted
    # forever.
    lark_fake.media["file-old"] = (b"two", "image/png")
    assert cached_download(lark_fake.client, "file-old", directory=directory) == (
        b"one",
        "image/png",
    )
    assert cached_download(lark_fake.client, "file-old", directory=directory, ttl=0) == (
        b"two",
        "image/png",
    )


def test_a_miss_retires_lapsed_entries_and_abandoned_temp_files(lark_fake, tmp_path):
    directory = tmp_path / "lark-attachments"
    directory.mkdir()
    stale = time.time() - 10
    lapsed = directory / "lapsed"
    sidecar = directory / "lapsed.json"
    abandoned = directory / "lapsed.part-cafe"
    lapsed.write_bytes(b"old")
    sidecar.write_text('{"mime": "image/png", "length": 3}', encoding="utf-8")
    abandoned.write_bytes(b"hal")
    for path in (lapsed, sidecar, abandoned):
        os.utime(path, (stale, stale))

    # Anything the fetch touches is a miss, which is where the housekeeping
    # runs; the fresh picture must survive it.
    lark_fake.media["file-old"] = (b"fresh", "image/png")
    cached_download(lark_fake.client, "file-old", directory=directory, ttl=1)

    assert not lapsed.exists()
    assert not sidecar.exists()
    assert not abandoned.exists()
    # The fresh picture outlived the housekeeping: the next look is a hit.
    lark_fake.requests.clear()
    assert cached_download(lark_fake.client, "file-old", directory=directory, ttl=1) == (
        b"fresh",
        "image/png",
    )
    assert _media_downloads(lark_fake) == []
