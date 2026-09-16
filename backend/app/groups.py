from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.auth import require_admin
from app.db import get_db
from app.importers.schema import ImportErrorDetail, MAX_FILE_SIZE, ParsedCase, parse_file
from app.models import Group, GroupCase, ImportTicket


TICKET_TTL = timedelta(minutes=30)
router = APIRouter(prefix="/api", dependencies=[Depends(require_admin)])


class ConfirmImport(BaseModel):
    ticket_id: UUID
    name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    mapping: dict[str, str] = Field(default_factory=dict)


@router.post("/import/preview")
async def preview_import(
    file: Annotated[UploadFile, File()],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    filename = file.filename or "upload"
    content = await file.read(MAX_FILE_SIZE + 1)
    cases = _parse_or_422(filename, content)
    now = datetime.now(timezone.utc)
    file_sha256 = hashlib.sha256(content).hexdigest()
    duplicate = db.scalar(
        select(Group.id).where(Group.source_sha256 == file_sha256).limit(1)
    )

    db.execute(
        update(ImportTicket)
        .where(ImportTicket.expires_at <= now, ImportTicket.consumed_at.is_(None))
        .values(original_file=b"")
    )
    ticket = ImportTicket(
        file_sha256=file_sha256,
        original_file=content,
        parsed={
            "source_name": filename,
            "cases": [asdict(case) for case in cases],
        },
        expires_at=now + TICKET_TTL,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    fields = sorted({str(key) for case in cases for key in case.raw})
    return {
        "ticket_id": ticket.id,
        "detected_format": Path(filename).suffix.lower().lstrip("."),
        "count": len(cases),
        "cases": [_case_payload(case) for case in cases[:10]],
        "fields": fields,
        "errors": [],
        "warnings": ["This file was imported before"] if duplicate else [],
    }


@router.post("/import/confirm", status_code=status.HTTP_201_CREATED)
def confirm_import(
    payload: ConfirmImport,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, Any]:
    ticket = db.scalar(
        select(ImportTicket)
        .where(ImportTicket.id == payload.ticket_id)
        .with_for_update()
    )
    if ticket is None:
        raise HTTPException(status_code=404, detail="Import ticket not found")
    if ticket.consumed_at is not None:
        raise HTTPException(status_code=409, detail="Import ticket was already consumed")

    now = datetime.now(timezone.utc)
    if ticket.expires_at <= now:
        ticket.original_file = b""
        db.commit()
        raise HTTPException(status_code=410, detail="Import ticket expired")

    source_name = str(ticket.parsed["source_name"])
    cases = _parse_or_422(source_name, ticket.original_file, payload.mapping or None)
    group_id = uuid4()
    group = Group(
        id=group_id,
        short_code=_group_short_code(payload.name, group_id),
        name=payload.name,
        source_name=source_name,
        source_sha256=ticket.file_sha256,
        source_format=Path(source_name).suffix.lower().lstrip("."),
        source_version=ticket.file_sha256[:12],
        cases=[_group_case(case) for case in cases],
    )
    ticket.consumed_at = now
    ticket.original_file = b""
    db.add(group)
    db.commit()
    db.refresh(group)
    return {"id": group.id, "count": len(cases)}


@router.get("/groups")
def list_groups(db: Annotated[Session, Depends(get_db)]) -> list[dict[str, Any]]:
    rows = db.execute(
        select(Group, func.count(GroupCase.id))
        .outerjoin(GroupCase)
        .group_by(Group.id)
        .order_by(Group.created_at.desc(), Group.id)
    ).all()
    return [
        {
            "id": group.id,
            "name": group.name,
            "source_name": group.source_name,
            "source_version": group.source_version,
            "count": count,
            "created_at": group.created_at,
        }
        for group, count in rows
    ]


@router.get("/groups/{group_id}/cases")
def list_group_cases(
    group_id: UUID, db: Annotated[Session, Depends(get_db)]
) -> list[dict[str, Any]]:
    if db.get(Group, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    cases = db.scalars(
        select(GroupCase)
        .where(GroupCase.group_id == group_id)
        .order_by(GroupCase.position)
    ).all()
    return [
        {
            "id": case.id,
            "code": case.code,
            "position": case.position,
            "title": case.title,
            "module": case.module,
            "layer": case.layer,
            "priority": case.priority,
            "preconditions": case.preconditions,
            "test_data": case.test_data,
            "steps": case.steps,
            "expected": case.expected,
        }
        for case in cases
    ]


def _parse_or_422(
    filename: str, content: bytes, mapping: dict[str, str] | None = None
) -> list[ParsedCase]:
    try:
        return parse_file(filename, content, mapping)
    except ImportErrorDetail as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _case_payload(case: ParsedCase) -> dict[str, Any]:
    payload = asdict(case)
    payload.pop("raw")
    return payload


def _group_case(case: ParsedCase) -> GroupCase:
    return GroupCase(**asdict(case))


def _group_short_code(name: str, group_id: UUID) -> str:
    digits = "".join(character for character in name if character.isdigit())[:4]
    prefix = digits or "group"
    return f"{prefix}-{group_id.hex[:6]}"
