from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.models import CaseReferenceAsset, CaseReferenceLink


# Reference images keep their own subdirectory so the flat, name-checked
# screenshot directory stays untouched.
REFERENCE_DIRECTORY = "reference"

router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


def new_storage_key(suffix: str) -> str:
    return f"{uuid4().hex}{suffix}"


def reference_path(storage_key: str) -> Path:
    # Defend the stored key: a key with separators must never escape UPLOAD_DIR.
    if Path(storage_key).name != storage_key:
        raise HTTPException(status_code=404, detail="Reference image not found")
    return Path(settings.upload_dir) / REFERENCE_DIRECTORY / storage_key


def link_payload(link: CaseReferenceLink) -> dict[str, Any]:
    """One case's view of one asset; the bytes are fetched by asset id."""

    asset = link.asset
    return {
        "id": asset.id,
        "link_id": link.id,
        "asset_key": asset.asset_key,
        "name": asset.name,
        "mime": asset.mime,
        "width": asset.width,
        "height": asset.height,
        "asset_type": asset.asset_type,
        "screen": asset.screen,
        "state": asset.state,
        "prototype_version": asset.prototype_version,
        "role": link.role,
        "caption": link.caption,
        "focus": link.focus,
    }


@router.get("/case-reference-assets/{asset_id}")
def read_reference_asset(
    asset_id: UUID,
    db: Annotated[Session, Depends(get_db)],
) -> FileResponse:
    asset = db.get(CaseReferenceAsset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Reference image not found")
    path = reference_path(asset.storage_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Reference image not found")
    return FileResponse(
        path,
        media_type=asset.mime,
        headers={"Cache-Control": "private, no-store"},
    )
