from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from app.config import settings


# Reference images keep their own subdirectory so the flat, name-checked
# screenshot directory stays untouched.
REFERENCE_DIRECTORY = "reference"


def new_storage_key(suffix: str) -> str:
    return f"{uuid4().hex}{suffix}"


def reference_path(storage_key: str) -> Path:
    # Defend the stored key: a key with separators must never escape UPLOAD_DIR.
    if Path(storage_key).name != storage_key:
        raise HTTPException(status_code=404, detail="Reference image not found")
    return Path(settings.upload_dir) / REFERENCE_DIRECTORY / storage_key
