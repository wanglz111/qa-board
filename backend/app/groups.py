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
from sqlalchemy.orm import Session, selectinload

from app.auth import require_admin
from app.case_assets import link_payload, new_storage_key, reference_path
from app.db import get_db
from app.importers.casebook import (
    BundleFocus,
    CasebookDocument,
    MAX_BUNDLE_BYTES,
    parse_casebook,
)
from app.importers.schema import ImportErrorDetail, MAX_FILE_SIZE, ParsedCase, parse_file
from app.models import (
    CaseReferenceAsset,
    CaseReferenceLink,
    Group,
    GroupCase,
    ImportTicket,
)


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
    is_casebook = Path(filename).suffix.lower() == ".zip"
    limit = MAX_BUNDLE_BYTES if is_casebook else MAX_FILE_SIZE
    content = await file.read(limit + 1)
    if is_casebook:
        document = _parse_casebook_or_422(content)
        parsed = _casebook_ticket_payload(filename, document)
        preview = _casebook_preview_payload(document)
    else:
        text_cases = _parse_or_422(filename, content)
        parsed = {
            "source_name": filename,
            "cases": [asdict(case) for case in text_cases],
        }
        preview = {
            "count": len(text_cases),
            "cases": [_case_payload(case) for case in text_cases[:10]],
            "fields": sorted({str(key) for case in text_cases for key in case.raw}),
        }

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
        parsed=parsed,
        expires_at=now + TICKET_TTL,
    )
    db.add(ticket)
    db.commit()
    db.refresh(ticket)

    return {
        "ticket_id": ticket.id,
        "detected_format": Path(filename).suffix.lower().lstrip("."),
        "errors": [],
        "warnings": ["This file was imported before"] if duplicate else [],
        **preview,
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
    group_id = uuid4()
    written: list[Path] = []
    if ticket.parsed.get("casebook"):
        document = _parse_casebook_or_422(ticket.original_file)
        group_cases, written = _casebook_group_cases(document, group_id)
        asset_count = len(document.assets)
        link_count = sum(len(case.references) for case in document.cases)
    else:
        parsed_cases = _parse_or_422(
            source_name, ticket.original_file, payload.mapping or None
        )
        group_cases = [_group_case(case) for case in parsed_cases]
        asset_count = 0
        link_count = 0

    group = Group(
        id=group_id,
        short_code=_group_short_code(payload.name, group_id),
        name=payload.name,
        source_name=source_name,
        source_sha256=ticket.file_sha256,
        source_format=Path(source_name).suffix.lower().lstrip("."),
        source_version=ticket.file_sha256[:12],
        cases=group_cases,
    )
    ticket.consumed_at = now
    ticket.original_file = b""
    db.add(group)
    try:
        db.commit()
    except Exception:
        db.rollback()
        for path in written:
            path.unlink(missing_ok=True)
        raise
    db.refresh(group)
    return {
        "id": group.id,
        "count": len(group_cases),
        "reference_asset_count": asset_count,
        "reference_link_count": link_count,
    }


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
        .options(
            selectinload(GroupCase.reference_links).selectinload(
                CaseReferenceLink.asset
            )
        )
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
            "expect_absent": case.expect_absent,
            "visual_check": case.visual_check,
            "prototype_note": case.prototype_note,
            "reference_assets": [link_payload(link) for link in case.reference_links],
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


def _parse_casebook_or_422(content: bytes) -> CasebookDocument:
    try:
        return parse_casebook(content)
    except ImportErrorDetail as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _focus_payload(focus: BundleFocus) -> dict[str, Any]:
    return {
        "label": focus.label,
        "note": focus.note,
        "box": list(focus.box) if focus.box is not None else None,
    }


def _casebook_ticket_payload(
    filename: str, document: CasebookDocument
) -> dict[str, Any]:
    """Store metadata only; the image bytes stay inside original_file."""

    return {
        "source_name": filename,
        "casebook": True,
        "title": document.title,
        "prototype_version": document.prototype_version,
        "assets": [
            {
                "asset_key": asset.asset_key,
                "name": asset.name,
                "asset_type": asset.asset_type,
                "screen": asset.screen,
                "state": asset.state,
                "source_path": asset.source_path,
                "mime": asset.mime,
                "size_bytes": len(asset.content),
                "width": asset.width,
                "height": asset.height,
            }
            for asset in document.assets.values()
        ],
        "cases": [
            {
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
                "expect_absent": list(case.expect_absent),
                "visual_check": case.visual_check,
                "prototype_note": case.prototype_note,
                "raw": case.raw,
                "references": [
                    {
                        "asset_key": reference.asset_key,
                        "role": reference.role,
                        "caption": reference.caption,
                        "focus": [_focus_payload(item) for item in reference.focus],
                    }
                    for reference in case.references
                ],
            }
            for case in document.cases
        ],
    }


def _casebook_preview_payload(document: CasebookDocument) -> dict[str, Any]:
    return {
        "count": len(document.cases),
        "title": document.title,
        "prototype_version": document.prototype_version,
        "reference_asset_count": len(document.assets),
        "reference_link_count": sum(len(case.references) for case in document.cases),
        "fields": [
            "code",
            "title",
            "position",
            "module",
            "priority",
            "preconditions",
            "steps",
            "expected",
            "expect_absent",
            "visual_check",
        ],
        "cases": [
            {
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
                "expect_absent": list(case.expect_absent),
                "visual_check": case.visual_check,
                "reference_asset_count": len(case.references),
            }
            for case in document.cases[:10]
        ],
    }


def _casebook_group_cases(
    document: CasebookDocument, group_id: UUID
) -> tuple[list[GroupCase], list[Path]]:
    written: list[Path] = []
    assets: dict[str, CaseReferenceAsset] = {}
    try:
        for key, asset in document.assets.items():
            storage_key = new_storage_key(asset.suffix)
            target = reference_path(storage_key)
            target.parent.mkdir(parents=True, exist_ok=True)
            # Register before writing: a partial write (e.g. ENOSPC) leaves a
            # file on disk that must still be cleaned up by the except block.
            written.append(target)
            target.write_bytes(asset.content)
            assets[key] = CaseReferenceAsset(
                group_id=group_id,
                asset_key=key,
                name=asset.name,
                storage_key=storage_key,
                mime=asset.mime,
                size_bytes=len(asset.content),
                width=asset.width,
                height=asset.height,
                asset_type=asset.asset_type,
                screen=asset.screen,
                state=asset.state,
                source_path=asset.source_path,
                prototype_version=asset.prototype_version,
            )
        group_cases = [
            GroupCase(
                code=case.code,
                position=case.position,
                title=case.title,
                module=case.module,
                layer=case.layer,
                priority=case.priority,
                preconditions=case.preconditions,
                test_data=case.test_data,
                steps=case.steps,
                expected=case.expected,
                expect_absent=list(case.expect_absent),
                visual_check=case.visual_check,
                prototype_note=case.prototype_note,
                raw=case.raw,
                reference_links=[
                    CaseReferenceLink(
                        asset=assets[reference.asset_key],
                        role=reference.role,
                        caption=reference.caption,
                        focus=[_focus_payload(item) for item in reference.focus],
                        sort_order=index,
                    )
                    for index, reference in enumerate(case.references)
                ],
            )
            for case in document.cases
        ]
    except OSError as exc:
        for path in written:
            path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500, detail="Could not store the reference image"
        ) from exc
    return group_cases, written


def _case_payload(case: ParsedCase) -> dict[str, Any]:
    payload = asdict(case)
    payload.pop("raw")
    return payload


def _group_case(case: ParsedCase) -> GroupCase:
    return GroupCase(
        **asdict(case),
        expect_absent=[],
        visual_check="text_and_visual",
    )


def _group_short_code(name: str, group_id: UUID) -> str:
    digits = "".join(character for character in name if character.isdigit())[:4]
    prefix = digits or "group"
    return f"{prefix}-{group_id.hex[:6]}"
