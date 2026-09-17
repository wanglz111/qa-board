"""Old-table pictures, kept on disk once they have been fetched.

The read-only panel shows the same handful of attachments every time a case is
opened. Lark mints one token per file and the bytes never change, so the second
look is served from disk.

The cache is an optimisation and nothing more, which decides everything below:
nothing it does may change the answer or fail the request, and an entry it
cannot vouch for is a miss rather than something to serve. Entries are named by
the token's SHA-256 (a token is opaque and may hold ``/`` or ``..``), and each
one records the length it was stored with, so a truncated file is fetched again
instead of being shown as the picture.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from uuid import uuid4

from app.lark.client import LarkClient

DEFAULT_TTL_SECONDS = 86_400.0


def cache_directory(upload_dir: str) -> Path:
    """Beside the screenshots, not inside them: that directory is ours alone."""

    return Path(upload_dir).parent / "lark-attachments"


def _entry_name(file_token: str) -> str:
    """The on-disk name of one token's entry.

    A token is opaque: it may carry a separator, start with ``..`` or be longer
    than a filename allows, so it can never be a path component. Its hash can.
    """

    return hashlib.sha256(file_token.encode("utf-8")).hexdigest()


def _read_entry(directory: Path, name: str, ttl: float) -> tuple[bytes, str] | None:
    """The cached picture, or ``None`` when the entry cannot be trusted."""

    target = directory / name
    meta_file = directory / f"{name}.json"
    try:
        if not target.is_file() or not meta_file.is_file():
            return None
        if time.time() - target.stat().st_mtime >= ttl:
            return None
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        content = target.read_bytes()
    except (OSError, ValueError):
        # A cache the volume will not let us read is a miss, not a failure.
        return None
    if not isinstance(meta, dict) or meta.get("length") != len(content):
        # A sidecar whose length does not match the bytes beside it vouches for
        # nothing: re-download rather than serve a truncated picture.
        return None
    mime = meta.get("mime")
    # A missing type is not a reason to re-download: the bytes are fine and the
    # endpoint's allowlist already turns anything unusable into an octet-stream.
    return content, mime if isinstance(mime, str) and mime else "application/octet-stream"


def _write_beside(directory: Path, final: Path, data: bytes) -> None:
    """Publish ``data`` at ``final`` through a temp name no writer shares."""

    temporary = directory / f"{final.name}.part-{uuid4().hex}"
    temporary.write_bytes(data)
    os.replace(temporary, final)


def _store(directory: Path, name: str, content: bytes, mime: str) -> None:
    """Write one entry: ``<hash>`` for the bytes, ``<hash>.json`` beside it.

    The old ``.mime`` sidecar grows into that small metadata file rather than
    gaining a third name: the type and the length are facts about the same
    bytes, and one file is easier to keep in step than two.

    The sidecar is published first and states what it vouches for, so a crash
    between the two renames can only leave an entry the next read rejects —
    never bytes that look fresh and are answered with a type that is not theirs.
    """
    _write_beside(
        directory,
        directory / f"{name}.json",
        json.dumps({"mime": mime, "length": len(content)}).encode("utf-8"),
    )
    _write_beside(directory, directory / name, content)


def _prune(directory: Path, ttl: float) -> None:
    """Retire entries past their TTL and temp files a crash left behind.

    The upload volume is a named volume and outlives every deploy, so the only
    thing bounding this directory is this walk. Only things older than ``ttl``
    are collected, and a pair is only pulled apart when neither half is fresh:
    a ``.part-`` file may belong to a download running right now, and ``_store``
    publishes its sidecar before the bytes that sidecar vouches for, so a prune
    landing inside that window would leave bytes nothing would ever answer for.
    Each deletion is best effort — housekeeping is not allowed to turn into an
    error.
    """

    deadline = time.time() - ttl
    for path in list(directory.iterdir()):
        try:
            if path.stat().st_mtime >= deadline:
                continue
            if ".part-" in path.name:
                path.unlink()
                continue
            if path.suffix == ".json":
                # A sidecar and the bytes it describes are one entry, and the
                # pair is only retired once both halves have aged out.
                stored = directory / path.stem
                if stored.is_file() and stored.stat().st_mtime >= deadline:
                    continue
                path.unlink(missing_ok=True)
                stored.unlink(missing_ok=True)
                continue
            sidecar = directory / f"{path.name}.json"
            if sidecar.is_file() and sidecar.stat().st_mtime >= deadline:
                continue
            path.unlink()
            sidecar.unlink(missing_ok=True)
        except OSError:
            continue


def cached_download(
    client: LarkClient,
    file_token: str,
    *,
    directory: Path,
    ttl: float = DEFAULT_TTL_SECONDS,
    max_bytes: int | None = None,
) -> tuple[bytes, str]:
    name = _entry_name(file_token)
    cached = _read_entry(directory, name, ttl)
    if cached is not None:
        return cached

    content, mime = client.download_media(file_token)
    if max_bytes is not None and len(content) > max_bytes:
        # The caller refuses this one anyway; storing it would only keep
        # answering from the volume for the rest of the TTL.
        return content, mime

    try:
        directory.mkdir(parents=True, exist_ok=True)
        _prune(directory, ttl)
        _store(directory, name, content, mime)
    except OSError:
        # An optimisation that cannot be written down is not an error.
        pass
    return content, mime
