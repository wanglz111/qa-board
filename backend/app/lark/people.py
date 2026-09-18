"""The Lark people this deployment writes into person columns.

A person column only accepts ``[{"id": "<open_id>"}]``, so the writer needs the
two open ids and nothing else. They live in one row of ``lark_people`` because
they are the same people for every test group; the environment variable
``DEFAULT_REPORTER_ID`` stays as the fallback for a deployment that has not
opened the settings page yet.

The HTTP surface lives here too: this module owns the row, so the endpoint that
edits it is the only other thing that has to know the shape.
"""

from __future__ import annotations

import re
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.config import settings
from app.db import get_db
from app.models import LarkPeople


router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])

# Every token is interpolated into a request the writer sends as-is, and Lark
# only ever mints open ids in this shape. Refusing anything else here is what
# keeps a display name ("Max") or a union id out of a column that reads neither.
OPEN_ID = re.compile(r"^ou_[A-Za-z0-9_-]{1,64}\Z")

SINGLETON_ID = 1


def _stored(db: Session) -> LarkPeople | None:
    return db.get(LarkPeople, SINGLETON_ID)


def read_people(db: Session) -> LarkPeople:
    """The single settings row, created empty on first read."""

    row = _stored(db)
    if row is None:
        row = LarkPeople(id=SINGLETON_ID)
        db.add(row)
        db.flush()
    return row


def resolved_reporter_open_id(db: Session) -> str | None:
    """The id 反馈人/报告人 receive: what the page saved, else the env fallback."""

    row = _stored(db)
    if row is not None and row.reporter_open_id:
        return row.reporter_open_id
    return settings.default_reporter_id or None


def resolved_owner_open_id(db: Session) -> str | None:
    """The id 负责人 receives.

    There is no environment fallback: no deployment ever configured one, and
    inventing an owner is worse than leaving the column empty — which is what
    the operator asked for until the case is handed to a lead.
    """

    row = _stored(db)
    return (row.owner_open_id if row is not None else None) or None


def save_people(
    db: Session, *, reporter_open_id: str | None, owner_open_id: str | None
) -> LarkPeople:
    """Normalize both ids and write them; "not configured" is NULL, never "".

    Format validation is not this function's job: the boundary is the HTTP
    layer's ``_checked``, which strips and refuses anything that is not an open
    id with a 422. This one trusts its caller but still normalizes, so a blank
    or whitespace-only value lands as NULL however it arrived.
    """

    row = read_people(db)
    row.reporter_open_id = (reporter_open_id or "").strip() or None
    row.owner_open_id = (owner_open_id or "").strip() or None
    db.commit()
    db.refresh(row)
    return row


class PeopleRequest(BaseModel):
    reporter_open_id: str = ""
    owner_open_id: str = ""


def _checked(label: str, value: str) -> str | None:
    text_value = value.strip()
    if text_value and OPEN_ID.match(text_value) is None:
        raise HTTPException(
            status_code=422,
            detail=f"{label} 要填本应用名下的 open_id（ou_ 开头），不能填姓名或邮箱",
        )
    return text_value or None


def _payload(db: Session, stored: LarkPeople) -> dict[str, Any]:
    """What the page shows: what it saved, and what will actually be written."""

    return {
        "reporter_open_id": stored.reporter_open_id or "",
        "owner_open_id": stored.owner_open_id or "",
        "env_reporter_open_id": settings.default_reporter_id or "",
        "effective_reporter_open_id": resolved_reporter_open_id(db) or "",
        "effective_owner_open_id": resolved_owner_open_id(db) or "",
    }


@router.get("/lark/people")
def read_people_settings(db: Annotated[Session, Depends(get_db)]) -> dict[str, Any]:
    stored = read_people(db)
    db.commit()
    return _payload(db, stored)


@router.put("/lark/people")
def save_people_settings(
    payload: PeopleRequest, db: Annotated[Session, Depends(get_db)]
) -> dict[str, Any]:
    stored = save_people(
        db,
        reporter_open_id=_checked("报告人", payload.reporter_open_id),
        owner_open_id=_checked("负责人", payload.owner_open_id),
    )
    return _payload(db, stored)
