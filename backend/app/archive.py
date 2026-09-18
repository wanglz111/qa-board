"""A retired group is read-only, wherever the write comes from.

Archiving hides a group from the board, and the page that would write to it is
not reachable any more — but hidden is a property of the page, not of the API. A
reloaded tab, a bookmark, or a queued request can still name the group, and a
retired group must not keep collecting results, decisions, or rows in Lark.

The check is one dependency the mutating routers declare, so a write route added
later is covered by being a write route. Reads stay allowed on purpose: keeping
the group inspectable is what makes archiving different from deleting.
"""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Attempt, Group, GroupCase


ARCHIVED_DETAIL = "该测试组已归档，请先恢复再操作"
READ_METHODS = ("GET", "HEAD", "OPTIONS")


def _as_uuid(value: object) -> UUID | None:
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _group_of(request: Request, db: Session) -> UUID | None:
    """The group this request writes to, named directly or through an attempt."""

    named = request.path_params.get("group_id")
    if named is not None:
        return _as_uuid(named)
    attempt = _as_uuid(request.path_params.get("attempt_id"))
    if attempt is None:
        return None
    return db.scalar(
        select(GroupCase.group_id)
        .join(Attempt, Attempt.group_case_id == GroupCase.id)
        .where(Attempt.id == attempt)
    )


def refuse_archived_group(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> None:
    if request.method in READ_METHODS:
        return
    group_id = _group_of(request, db)
    if group_id is None:
        # Nothing here names a group (or names one that does not exist): the
        # route answers its own 404/422 rather than a refusal about archiving.
        return
    archived_at = db.scalar(select(Group.archived_at).where(Group.id == group_id))
    if archived_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=ARCHIVED_DETAIL)
