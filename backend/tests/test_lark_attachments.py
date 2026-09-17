"""The legacy-attachment disk cache: what it stores, and what it must never do.

Every test here asserts an observable outcome — the bytes the endpoint answers
with, what is left on disk, and how often Lark was asked for the file. The cache
is an optimisation, so the interesting cases are all about it *not* being able
to change the answer or break the request.

The entry is located by the bytes it holds rather than by a name the test
guesses: the name is one of the things under test.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path

import pytest

import app.lark.history as lark_history
from app.lark.attachments import cache_directory, cached_download

TOKEN = "secret-file-token"
PAYLOAD = b"old-png-bytes"


def _cache_dir(upload_dir: Path) -> Path:
    """The directory the endpoint itself resolves, derived the same way."""

    return cache_directory(str(upload_dir))


def _downloads(lark_fake) -> list[str]:
    """Every upstream attachment fetch, in order."""

    return [
        request["path"]
        for request in lark_fake.requests
        if "/medias/" in request["path"] and request["path"].endswith("/download")
    ]


def _files_holding(directory: Path, payload: bytes) -> list[Path]:
    """The stored copies of ``payload``, found without knowing the entry's name."""

    if not directory.is_dir():
        return []
    return [
        path
        for path in sorted(directory.iterdir())
        if path.is_file() and path.read_bytes() == payload
    ]


def _age(path: Path, seconds: float) -> None:
    stamp = time.time() - seconds
    os.utime(path, (stamp, stamp))


def test_a_second_fetch_is_served_from_disk_with_one_upstream_download(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """The whole point of the cache: the second look costs no Lark call."""

    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")
    url = f"/api/lark/history/{history_ref.id}/attachments/0"
    lark_fake.requests.clear()

    first = authenticated_client.get(url)
    second = authenticated_client.get(url)

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.content == PAYLOAD
    assert second.content == PAYLOAD
    assert _downloads(lark_fake) == [f"/open-apis/drive/v1/medias/{TOKEN}/download"]
    assert first.headers["cache-control"] == "private, max-age=86400"
    assert second.headers["x-content-type-options"] == "nosniff"
    # The bytes really are on disk, so the second answer came from there.
    assert len(_files_holding(_cache_dir(upload_dir), PAYLOAD)) == 1


def test_the_entry_is_named_by_the_token_hash_and_never_by_the_token(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """A token is opaque and may hold separators: it may never name a path."""

    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")

    response = authenticated_client.get(
        f"/api/lark/history/{history_ref.id}/attachments/0"
    )

    assert response.status_code == 200, response.text
    cache = _cache_dir(upload_dir)
    digest = hashlib.sha256(TOKEN.encode("utf-8")).hexdigest()
    assert digest in {path.name for path in cache.iterdir()}
    assert len(_files_holding(cache, PAYLOAD)) == 1
    # Nowhere under the cache directory does the raw token appear as a path.
    assert [str(path) for path in cache.rglob("*") if TOKEN in path.name] == []


def test_a_truncated_cached_file_is_not_served(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """A half-written entry must be re-fetched, not served as the picture."""

    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")
    url = f"/api/lark/history/{history_ref.id}/attachments/0"
    assert authenticated_client.get(url).content == PAYLOAD

    cache = _cache_dir(upload_dir)
    stored = _files_holding(cache, PAYLOAD)
    assert len(stored) == 1
    # Fresh mtime, wrong length: only the recorded length can catch this.
    stored[0].write_bytes(PAYLOAD[:4])

    response = authenticated_client.get(url)

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD
    assert len(_downloads(lark_fake)) == 2


def test_an_entry_without_its_recorded_length_is_not_served(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """Nothing vouches for the entry's length, so nothing vouches for it."""

    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")
    url = f"/api/lark/history/{history_ref.id}/attachments/0"
    assert authenticated_client.get(url).content == PAYLOAD

    cache = _cache_dir(upload_dir)
    stored = _files_holding(cache, PAYLOAD)
    assert len(stored) == 1
    for path in cache.iterdir():
        if path.name != stored[0].name:
            path.unlink()

    response = authenticated_client.get(url)

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD
    assert len(_downloads(lark_fake)) == 2


def test_content_over_max_bytes_is_returned_to_the_caller_but_not_stored(
    lark_fake, upload_dir
):
    """Too big for the panel is too big for the volume: hand it back unstored."""

    oversized = b"x" * 64
    lark_fake.media["big-token"] = (oversized, "image/png")
    cache = _cache_dir(upload_dir)

    content, mime = cached_download(
        lark_fake.client, "big-token", directory=cache, max_bytes=16
    )

    assert content == oversized
    assert mime == "image/png"
    assert _files_holding(cache, oversized) == []


def test_content_exactly_at_max_bytes_is_stored(lark_fake, upload_dir):
    """The refusal is strict on both sides, so the boundary itself is cacheable.

    An off-by-one here would either drop a cacheable picture or keep one the
    endpoint refuses for the rest of the TTL.
    """

    payload = b"y" * 32
    lark_fake.media["exact-token"] = (payload, "image/png")
    cache = _cache_dir(upload_dir)

    content, mime = cached_download(
        lark_fake.client, "exact-token", directory=cache, max_bytes=len(payload)
    )

    assert content == payload
    assert mime == "image/png"
    assert len(_files_holding(cache, payload)) == 1


def test_the_endpoint_passes_max_bytes_so_an_oversized_attachment_is_not_kept(
    authenticated_client, lark_fake, history_ref, upload_dir, monkeypatch
):
    """The refusal already exists; the cache must not outlive it."""

    oversized = b"x" * 64
    lark_fake.media[TOKEN] = (oversized, "image/png")
    monkeypatch.setattr(lark_history, "MAX_ATTACHMENT_BYTES", 16)

    response = authenticated_client.get(
        f"/api/lark/history/{history_ref.id}/attachments/0"
    )

    assert response.status_code == 502
    assert _files_holding(_cache_dir(upload_dir), oversized) == []


def test_a_real_20_mib_attachment_is_refused_and_leaves_nothing_on_disk(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """The shipped boundary itself, not the monkeypatched one: an oversized
    attachment must cost a 502 and no bytes on a volume that outlives deploys."""

    oversized = b"x" * (lark_history.MAX_ATTACHMENT_BYTES + 1)
    assert len(oversized) > 20 * 1024 * 1024
    lark_fake.media[TOKEN] = (oversized, "image/png")
    cache = _cache_dir(upload_dir)

    response = authenticated_client.get(
        f"/api/lark/history/{history_ref.id}/attachments/0"
    )

    assert response.status_code == 502
    remaining = sorted(path.name for path in cache.iterdir()) if cache.is_dir() else []
    assert remaining == []


def test_an_aged_entry_and_an_orphan_part_file_are_pruned(lark_fake, upload_dir):
    """The volume survives redeploys, so entries have to retire themselves."""

    cache = _cache_dir(upload_dir)
    ttl = 60.0
    lark_fake.media["old-token"] = (b"aged-bytes", "image/png")
    lark_fake.media["new-token"] = (b"fresh-bytes", "image/png")

    assert cached_download(lark_fake.client, "old-token", directory=cache, ttl=ttl) == (
        b"aged-bytes",
        "image/png",
    )
    orphan = cache / ("0" * 64 + ".part-deadbeef")
    orphan.write_bytes(b"half a picture the crash left")
    for path in cache.iterdir():
        _age(path, 10 * ttl)
    # A writer that is still running owns a *fresh* temp file: prune must leave
    # it alone, or it would delete the file out from under a live download.
    in_flight = cache / ("f" * 64 + ".part-inflight")
    in_flight.write_bytes(b"being written right now")

    assert cached_download(lark_fake.client, "new-token", directory=cache, ttl=ttl) == (
        b"fresh-bytes",
        "image/png",
    )

    assert _files_holding(cache, b"aged-bytes") == []
    assert not list(cache.glob("*.part-deadbeef"))
    assert in_flight.is_file()
    assert len(_files_holding(cache, b"fresh-bytes")) == 1
    # The aged entry left nothing behind, not even the file that recorded its
    # length: the new entry's two files and the live temp file are all that is.
    assert len(list(cache.iterdir())) == 3


def test_a_prune_leaves_a_store_that_is_still_publishing_alone(lark_fake, upload_dir):
    """A store publishes its sidecar first and its bytes second.

    Housekeeping runs on the next store and sees that half-published entry. If
    it retired either fresh half along with the expired one, the bytes would be
    left with nothing vouching for them: never served again, re-downloaded on
    every request until they aged out. Fresh work is not housekeeping's to take.
    """

    cache = _cache_dir(upload_dir)
    ttl = 60.0
    half_published = hashlib.sha256(b"half-published").hexdigest()
    stale_sidecar = hashlib.sha256(b"stale-sidecar").hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    # A store that has published its sidecar and not yet its bytes: the old
    # bytes beside it are the expired entry.
    (cache / half_published).write_bytes(b"the expired old picture")
    (cache / f"{half_published}.json").write_text(
        json.dumps({"mime": "image/png", "length": 24}), encoding="utf-8"
    )
    _age(cache / half_published, 10 * ttl)
    # And the mirror image: fresh bytes beside the sidecar they replaced.
    (cache / stale_sidecar).write_bytes(b"freshly written bytes")
    (cache / f"{stale_sidecar}.json").write_text(
        json.dumps({"mime": "image/png", "length": 20}), encoding="utf-8"
    )
    _age(cache / f"{stale_sidecar}.json", 10 * ttl)

    lark_fake.media["other-token"] = (b"other", "image/png")
    cached_download(lark_fake.client, "other-token", directory=cache, ttl=ttl)

    assert (cache / f"{half_published}.json").is_file(), "a fresh sidecar was pruned"
    assert (cache / stale_sidecar).is_file(), "fresh bytes were pruned"


def test_a_cache_that_cannot_be_created_still_serves_the_bytes(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """A cache store failure must never fail a request that holds the bytes."""

    cache = _cache_dir(upload_dir)
    # A file where the cache directory belongs: every read and every write under
    # it raises a real OSError (NotADirectoryError / FileExistsError), the same
    # way a volume the process cannot write does.
    cache.write_bytes(b"not a directory")
    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")

    response = authenticated_client.get(
        f"/api/lark/history/{history_ref.id}/attachments/0"
    )

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD


@pytest.mark.skipif(
    not hasattr(os, "geteuid") or os.geteuid() == 0,
    reason="root ignores the mode bits, and only POSIX has geteuid",
)
def test_a_read_only_cache_directory_still_serves_the_bytes(
    authenticated_client, lark_fake, history_ref, upload_dir
):
    """The read-only-volume case, with the filesystem refusing the write."""

    cache = _cache_dir(upload_dir)
    cache.mkdir(parents=True, exist_ok=True)
    lark_fake.media[TOKEN] = (PAYLOAD, "image/png")
    cache.chmod(0o500)
    try:
        response = authenticated_client.get(
            f"/api/lark/history/{history_ref.id}/attachments/0"
        )
    finally:
        cache.chmod(0o700)

    assert response.status_code == 200, response.text
    assert response.content == PAYLOAD


class _NeverLark:
    """A hit that still asks upstream is not a hit."""

    def download_media(self, file_token: str) -> tuple[bytes, str]:
        raise AssertionError(f"a complete entry must be served from disk, not {file_token!r}")


def test_two_concurrent_first_requests_never_publish_a_partial_entry(tmp_path):
    """The temp name belongs to one writer, not to the whole process.

    Two writers in one process share a pid. If they also shared a temp name, one
    could publish the file the other was still writing. The double hands each
    thread its own bytes so a published mixture is visible, and its barrier puts
    both threads inside the download at the same time.
    """

    cache = tmp_path / "cache"
    payloads = {"aa": b"a" * (2 * 1024 * 1024), "bb": b"b" * (2 * 1024 * 1024)}
    ready = threading.Barrier(2, timeout=10)

    class RacyLark:
        def download_media(self, file_token: str) -> tuple[bytes, str]:
            ready.wait()
            return payloads[threading.current_thread().name], "image/png"

    results: dict[str, tuple[bytes, str] | BaseException] = {}

    def fetch(name: str) -> None:
        try:
            results[name] = cached_download(RacyLark(), "one-token", directory=cache)
        except BaseException as error:  # noqa: BLE001 - what escapes is the finding
            results[name] = error

    threads = [
        threading.Thread(target=fetch, args=(name,), name=name) for name in payloads
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)

    assert not [result for result in results.values() if isinstance(result, BaseException)]
    assert {name: result[0] for name, result in results.items()} == payloads

    published = [
        path
        for path in cache.iterdir()
        if path.is_file() and ".part-" not in path.name and path.suffix != ".json"
    ]
    assert len(published) == 1
    stored = published[0].read_bytes()
    # Exactly one writer's bytes: not a mixture, not a truncation.
    assert stored in payloads.values()
    assert not list(cache.glob("*.part-*"))
    # And the entry that was published is one the read path trusts.
    assert cached_download(_NeverLark(), "one-token", directory=cache) == (
        stored,
        "image/png",
    )


def test_a_token_with_a_separator_is_stored_without_making_a_directory(
    lark_fake, upload_dir
):
    """A ``/`` in the token must not build a tree inside the cache."""

    cache = _cache_dir(upload_dir)
    lark_fake.media["a/b"] = (PAYLOAD, "image/png")

    content, mime = cached_download(lark_fake.client, "a/b", directory=cache)

    assert content == PAYLOAD
    assert mime == "image/png"
    assert len(_files_holding(cache, PAYLOAD)) == 1
    assert [path for path in cache.iterdir() if path.is_dir()] == []


class _StubLark:
    """Only the upstream bytes, without the HTTP layer in between.

    ``download_media`` builds a URL from the token, and httpx normalises a
    ``..`` segment away before any file is touched, so a real client cannot
    deliver these tokens at all. What is under test here is where the cache
    *writes*, which is the filesystem's business alone.
    """

    def __init__(self, content: bytes, mime: str = "image/png") -> None:
        self.content = content
        self.mime = mime

    def download_media(self, file_token: str) -> tuple[bytes, str]:
        return self.content, self.mime


@pytest.mark.parametrize(
    "token",
    [
        "../escaped-token",
        "../../escaped-token",
        # Three levels up leaves tmp_path entirely: a check that only walks
        # tmp_path would never see this file.
        "../../../escaped-token",
        "a/b",
        "..",
        "x" * 300,
    ],
)
def test_a_token_cannot_escape_the_cache_directory(tmp_path, token):
    """No token may write, read or crash outside the directory the cache owns."""

    cache = tmp_path / "cache" / "lark-attachments"
    owned = cache.resolve()
    # The whole tree the cache sits in, not just tmp_path: an escape that lands
    # beside tmp_path has to show up as a new path here.
    before = {path for path in tmp_path.parent.rglob("*")}

    content, mime = cached_download(_StubLark(PAYLOAD), token, directory=cache)

    assert content == PAYLOAD
    assert mime == "image/png"
    stray = [
        path
        for path in sorted({path for path in tmp_path.parent.rglob("*")} - before)
        if owned not in path.resolve().parents
        and path.resolve() != owned
        # ``mkdir(parents=True)`` legitimately creates the directories above it.
        and path.resolve() not in owned.parents
    ]
    assert stray == []
    assert cache.is_dir() and list(cache.iterdir()), "the entry must be stored"
    assert [str(path) for path in cache.rglob("*") if token in path.name] == []
