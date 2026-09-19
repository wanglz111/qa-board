from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
from typing import Annotated, Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field, StringConstraints
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from app.auth import require_admin
from app.case_assets import link_payload, new_storage_key, reference_path
from app.db import get_db
from app.execution import allocate_attempt
from app.importers.casebook import (
    BundleFocus,
    CasebookDocument,
    MAX_BUNDLE_BYTES,
    parse_casebook,
)
from app.importers.schema import ImportErrorDetail, MAX_FILE_SIZE, ParsedCase, parse_file
from app.models import (
    Attempt,
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
    # Materialise the outcome columns as attempts. The flag exists so the same
    # file can still be imported as cases only, and so a file whose results are
    # wrong can be pulled in without hand-editing it.
    import_results: bool = True


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
            # 结果列不是普通留档列：这两条数字决定导入页要不要给出"一并写入执行
            # 结果"，以及有没有"只有过程、没有结论"的行会被静默留档。
            "result_count": sum(1 for case in text_cases if case.result),
            "evidence_only_count": sum(
                1 for case in text_cases if case.evidence and not case.result
            ),
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


# What the attempt layer accepts. 「阻塞」 is a legal option in the Lark table's
# select column but not a state this tool records, so it is refused loudly
# instead of being mapped onto something it is not.
IMPORT_RESULTS = ("通过", "不通过", "未执行")


def _materialize_attempts(
    db: Session, group_cases: list[GroupCase], parsed_cases: list[ParsedCase], group_id: UUID
) -> int:
    """Turn every row that carries a conclusion into a committed attempt.

    A row without one stays 未测: no attempt means no execution record, so the
    board shows it blank and Lark never sees it — that is the whole mechanism
    behind "失败用例留空，等我亲自校验".
    """

    created = 0
    for group_case, case in zip(group_cases, parsed_cases, strict=True):
        result = (case.result or "").strip()
        evidence = (case.evidence or "").strip() or None
        if not result:
            continue
        if result not in IMPORT_RESULTS:
            raise ImportErrorDetail(
                f"Case {case.code} has invalid result: {result}"
                "（只接受 通过/不通过/未执行）"
            )
        if result == "不通过" and not evidence:
            raise ImportErrorDetail(f"Case {case.code} is a failure without 实测过程")
        attempt = allocate_attempt(db, group_case)
        attempt.state = "committed"
        attempt.result = result
        attempt.note = evidence if result == "不通过" else None
        attempt.console_text = None
        attempt.evidence = evidence
        attempt.source = "import"
        # Scoped to the group, never to the file: a repeat import is only a
        # warning the operator may accept, and it makes a second group with its
        # own records. Keying on the file hash instead would make both groups
        # mint the same key, so the second confirm would die on the unique
        # constraint instead of creating the group that contract promises.
        attempt.idempotency_key = f"import:{group_id}:{case.code}"
        created += 1
    return created


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
        parsed_cases: list[ParsedCase] = []
        asset_count = len(document.assets)
        link_count = sum(len(case.references) for case in document.cases)
    else:
        parsed_cases = _parse_or_422(source_name, ticket.original_file, payload.mapping or None)
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
    attempt_count = 0
    # The group is in the session first, so the materialiser flushes a complete
    # aggregate even though it is the attempt that triggers the flush.
    db.add(group)
    if payload.import_results and parsed_cases:
        try:
            attempt_count = _materialize_attempts(
                db, group_cases, parsed_cases, group_id
            )
        except ImportErrorDetail as error:
            # Nothing is half-written: the ticket stays usable and the operator
            # fixes the file instead of hunting a group that imported by halves.
            db.rollback()
            raise HTTPException(status_code=422, detail=str(error)) from None

    ticket.consumed_at = now
    ticket.original_file = b""
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
        "attempt_count": attempt_count,
    }


def _group_payload(group: Group, count: int) -> dict[str, Any]:
    return {
        "id": group.id,
        "name": group.name,
        "source_name": group.source_name,
        "source_version": group.source_version,
        "count": count,
        "created_at": group.created_at,
        "archived_at": group.archived_at,
    }


@router.get("/groups")
def list_groups(
    db: Annotated[Session, Depends(get_db)],
    include_archived: Annotated[bool, Query()] = False,
) -> list[dict[str, Any]]:
    statement = (
        select(Group, func.count(GroupCase.id))
        .outerjoin(GroupCase)
        .group_by(Group.id)
        .order_by(Group.created_at.desc(), Group.id)
    )
    if not include_archived:
        # The board is what is being worked on. A retired group is one query
        # away, which is the whole difference from deleting it.
        statement = statement.where(Group.archived_at.is_(None))
    rows = db.execute(statement).all()
    return [_group_payload(group, count) for group, count in rows]


def _group_or_404(db: Session, group_id: UUID) -> Group:
    group = db.scalar(select(Group).where(Group.id == group_id).with_for_update())
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


@router.post("/groups/{group_id}/archive")
def archive_group(
    group_id: UUID, db: Annotated[Session, Depends(get_db)]
) -> dict[str, Any]:
    """Retire a group: off the board, read-only, and whole.

    Archiving is idempotent and keeps the first moment, so a second click (or a
    reloaded tab) cannot move the timestamp that says when it was retired.
    """

    group = _group_or_404(db, group_id)
    if group.archived_at is None:
        group.archived_at = datetime.now(timezone.utc)
    count = db.scalar(
        select(func.count(GroupCase.id)).where(GroupCase.group_id == group.id)
    )
    db.commit()
    db.refresh(group)
    return _group_payload(group, count or 0)


@router.post("/groups/{group_id}/restore")
def restore_group(
    group_id: UUID, db: Annotated[Session, Depends(get_db)]
) -> dict[str, Any]:
    group = _group_or_404(db, group_id)
    group.archived_at = None
    count = db.scalar(
        select(func.count(GroupCase.id)).where(GroupCase.group_id == group.id)
    )
    db.commit()
    db.refresh(group)
    return _group_payload(group, count or 0)


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
    # One row per case: its highest-sequence committed attempt. The same shape
    # group_progress counts, but kept per case so the page can open on the first
    # case nobody has run instead of always on the first row.
    #
    # ``started`` rows are deliberately excluded: a retest the operator reserved
    # but never submitted carries no result, so letting it win the max would
    # hide the verdict the case already reported.
    latest_sequences = (
        select(
            Attempt.group_case_id,
            func.max(Attempt.sequence).label("sequence"),
        )
        .where(Attempt.state == "committed")
        .group_by(Attempt.group_case_id)
        .subquery()
    )
    latest_result = {
        row[0]: row[1]
        for row in db.execute(
            select(Attempt.group_case_id, Attempt.result).join(
                latest_sequences,
                (Attempt.group_case_id == latest_sequences.c.group_case_id)
                & (Attempt.sequence == latest_sequences.c.sequence),
            )
        ).all()
    }
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
            "latest_result": latest_result.get(case.id),
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
    # The outcome columns belong to the attempt, not the case row: spreading
    # them here is a TypeError, and dropping 未测 rows later is the whole
    # point of keeping them apart.
    fields = asdict(case)
    fields.pop("result")
    fields.pop("evidence")
    return GroupCase(
        **fields,
        expect_absent=[],
        visual_check="text_and_visual",
    )


def _group_short_code(name: str, group_id: UUID) -> str:
    digits = "".join(character for character in name if character.isdigit())[:4]
    prefix = digits or "group"
    return f"{prefix}-{group_id.hex[:6]}"
