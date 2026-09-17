from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from PIL import Image, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.lark.outbox import hold_job_for_evidence
from app.models import Attempt, Screenshot


# Screenshots are private evidence for one attempt: the client filename is never
# trusted, and the stored key is a random name plus the format we detected.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
FORMAT_SUFFIX = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
PILLOW_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}

router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


def _write_file(storage_path: Path, content: bytes) -> None:
    storage_path.write_bytes(content)


def _detected_mime(content: bytes) -> str:
    if not content:
        raise HTTPException(status_code=400, detail="Empty screenshot")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Screenshot exceeds 20 MB",
        )
    try:
        with Image.open(BytesIO(content)) as image:
            image.verify()
            detected = image.format
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="Unsupported image") from None
    mime = PILLOW_MIME.get(detected or "")
    if mime is None:
        raise HTTPException(status_code=400, detail="Unsupported image format")
    return mime


def _storage_path(storage_key: str) -> Path:
    # Defend the stored key as well: a key with separators must never escape
    # UPLOAD_DIR even if a row was written by something other than this router.
    if Path(storage_key).name != storage_key:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    return Path(settings.upload_dir) / storage_key


def screenshot_payload(screenshot: Screenshot) -> dict[str, Any]:
    """One screenshot as the API shows it, reused by the attempt payload."""

    return {
        "id": screenshot.id,
        "attempt_id": screenshot.attempt_id,
        "storage_key": screenshot.storage_key,
        "mime": screenshot.mime,
        "size_bytes": screenshot.size_bytes,
        "created_at": screenshot.created_at,
    }


@router.post(
    "/attempts/{attempt_id}/screenshots",
    status_code=status.HTTP_201_CREATED,
)
async def upload_screenshot(
    attempt_id: UUID,
    image: Annotated[UploadFile, File()],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    attempt = db.get(Attempt, attempt_id)
    if attempt is None:
        raise HTTPException(status_code=404, detail="Attempt not found")

    content = await image.read(MAX_UPLOAD_BYTES + 1)
    mime = _detected_mime(content)
    storage_key = f"{uuid4().hex}{FORMAT_SUFFIX[mime]}"
    storage_path = _storage_path(storage_key)
    storage_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        _write_file(storage_path, content)
    except OSError:
        raise HTTPException(
            status_code=500, detail="Could not store the screenshot"
        ) from None

    screenshot = Screenshot(
        attempt_id=attempt.id,
        storage_key=storage_key,
        mime=mime,
        size_bytes=len(content),
    )
    db.add(screenshot)
    try:
        db.flush()
        # The queued write for this attempt waits for its evidence: a row built
        # before this upload landed could never carry the picture.
        hold_job_for_evidence(db, attempt)
        db.commit()
    except Exception:
        db.rollback()
        storage_path.unlink(missing_ok=True)
        raise
    db.refresh(screenshot)
    return screenshot_payload(screenshot)


@router.get("/screenshots/{screenshot_id}")
def read_screenshot(
    screenshot_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    screenshot = db.get(Screenshot, screenshot_id)
    if screenshot is None:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    storage_path = _storage_path(screenshot.storage_key)
    if not storage_path.is_file():
        raise HTTPException(status_code=404, detail="Screenshot not found")
    return FileResponse(
        storage_path,
        media_type=screenshot.mime,
        headers={"Cache-Control": "private, no-store"},
    )
