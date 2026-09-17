"""Old-table pictures, kept on disk once they have been fetched.

The read-only panel shows the same handful of attachments every time a case is
opened. Lark mints one token per file and the bytes never change, so the second
look is served from disk.
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
    """Name an entry by hash: a token is opaque and may hold path separators."""

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
    # endpoint's allowlist turns anything unusable into an octet-stream.
    return content, mime if isinstance(mime, str) and mime else "application/octet-stream"


def _write_beside(directory: Path, final: Path, data: bytes) -> None:
    """Publish ``data`` at ``final``, through a temp name no writer shares."""

    temporary = directory / f"{final.name}.part-{uuid4().hex}"
    temporary.write_bytes(data)
    os.replace(temporary, final)


def _store(directory: Path, name: str, content: bytes, mime: str) -> None:
    # The sidecar goes first and states what it vouches for. A crash can then
    # only leave an entry the next read rejects, never fresh-looking bytes
    # answered with a type that makes the browser show a broken picture.
    _write_beside(
        directory,
        directory / f"{name}.json",
        json.dumps({"mime": mime, "length": len(content)}).encode("utf-8"),
    )
    _write_beside(directory, directory / name, content)


def _prune(directory: Path, ttl: float) -> None:
    """Retire entries past their TTL and temp files a crash left behind."""

    deadline = time.time() - ttl
    for path in list(directory.iterdir()):
        try:
            if ".part-" in path.name:
                stale = path.stat().st_mtime < deadline
            elif path.suffix == ".json":
                # A sidecar and its bytes are one entry: retire them together.
                stored = directory / path.stem
                stale = not stored.is_file() or stored.stat().st_mtime < deadline
            else:
                stale = path.stat().st_mtime < deadline
            if not stale:
                continue
            path.unlink()
            if path.suffix == ".json":
                (directory / path.stem).unlink(missing_ok=True)
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
        # The endpoint will refuse this one; storing it would only keep
        # answering 502 from the volume for the rest of the TTL.
        return content, mime

    try:
        directory.mkdir(parents=True, exist_ok=True)
        _prune(directory, ttl)
        _store(directory, name, content, mime)
    except OSError:
        # The cache is an optimisation: a volume that cannot take the write
        # must not fail a request that already holds the bytes.
        pass
    return content, mime
