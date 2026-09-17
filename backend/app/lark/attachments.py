"""Old-table pictures, kept on disk once they have been fetched.

The read-only panel shows the same handful of attachments every time a case is
opened. Lark mints one token per file and the bytes never change, so the second
look is served from disk.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

from app.lark.client import LarkClient

DEFAULT_TTL_SECONDS = 86_400.0


def cache_directory(upload_dir: str) -> Path:
    """Beside the screenshots, not inside them: that directory is ours alone."""

    return Path(upload_dir).parent / "lark-attachments"


def cached_download(
    client: LarkClient,
    file_token: str,
    *,
    directory: Path,
    ttl: float = DEFAULT_TTL_SECONDS,
) -> tuple[bytes, str]:
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / file_token
    mime_file = directory / f"{file_token}.mime"
    if target.is_file() and time.time() - target.stat().st_mtime < ttl:
        mime = mime_file.read_text(encoding="utf-8") if mime_file.is_file() else ""
        return target.read_bytes(), mime or "application/octet-stream"

    content, mime = client.download_media(file_token)
    # Write beside the final name and rename: a crashed download must never
    # leave a half file that the next read would serve as the picture.
    temporary = directory / f"{file_token}.part-{os.getpid()}"
    temporary.write_bytes(content)
    os.replace(temporary, target)
    mime_file.write_text(mime, encoding="utf-8")
    return content, mime
