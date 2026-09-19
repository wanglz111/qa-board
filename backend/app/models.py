from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Admin(Base):
    __tablename__ = "admins"
    __table_args__ = (CheckConstraint("singleton_key = 1", name="ck_admins_singleton_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    singleton_key: Mapped[int] = mapped_column(Integer, nullable=False, server_default="1", default=1, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    sessions: Mapped[list[AdminSession]] = relationship(
        back_populates="admin", cascade="all, delete-orphan", passive_deletes=True
    )


class AdminSession(Base):
    __tablename__ = "admin_sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    admin_id: Mapped[UUID] = mapped_column(
        ForeignKey("admins.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    csrf_token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    admin: Mapped[Admin] = relationship(back_populates="sessions")


class Group(Base):
    __tablename__ = "groups"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    short_code: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    source_name: Mapped[str] = mapped_column(String, nullable=False)
    source_sha256: Mapped[str] = mapped_column(String, nullable=False)
    source_format: Mapped[str] = mapped_column(String, nullable=False)
    source_version: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    # When the group was retired, or NULL while it is still on the board. A
    # retired group is hidden and read-only — kept whole, because it holds the
    # only local copy of the evidence its cases collected.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    cases: Mapped[list[GroupCase]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )
    reference_assets: Mapped[list[CaseReferenceAsset]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )


class GroupCase(Base):
    __tablename__ = "group_cases"
    __table_args__ = (
        UniqueConstraint("group_id", "code", name="uq_group_case_code"),
        UniqueConstraint("group_id", "position", name="uq_group_case_position"),
        CheckConstraint(
            "visual_check IN ('text_and_visual', 'visual_only', 'not_verifiable')",
            name="ck_group_cases_visual_check",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    code: Mapped[str] = mapped_column(String, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    module: Mapped[str | None] = mapped_column(String)
    layer: Mapped[str | None] = mapped_column(String)
    priority: Mapped[str | None] = mapped_column(String)
    preconditions: Mapped[str | None] = mapped_column(Text)
    test_data: Mapped[str | None] = mapped_column(Text)
    steps: Mapped[str | None] = mapped_column(Text)
    expected: Mapped[str | None] = mapped_column(Text)
    expect_absent: Mapped[list[str]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    visual_check: Mapped[str] = mapped_column(
        String, nullable=False, default="text_and_visual", server_default="text_and_visual"
    )
    prototype_note: Mapped[str | None] = mapped_column(Text)
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    group: Mapped[Group] = relationship(back_populates="cases")
    reference_links: Mapped[list[CaseReferenceLink]] = relationship(
        back_populates="group_case",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="CaseReferenceLink.sort_order",
    )
    attempts: Mapped[list[Attempt]] = relationship(
        back_populates="group_case", cascade="all, delete-orphan", passive_deletes=True
    )


class Attempt(Base):
    __tablename__ = "attempts"
    __table_args__ = (
        UniqueConstraint("group_case_id", "sequence", name="uq_attempt_case_sequence"),
        UniqueConstraint("group_case_id", "label", name="uq_attempt_case_label"),
        CheckConstraint(
            "state IN ('started', 'committed')", name="ck_attempts_state"
        ),
        CheckConstraint(
            "(state = 'started' AND result IS NULL) OR "
            "(state = 'committed' AND result IN ('通过', '不通过', '未执行'))",
            name="ck_attempts_state_result",
        ),
        CheckConstraint(
            "source IN ('execution', 'reconcile', 'import')", name="ck_attempts_source"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_case_id: Mapped[UUID] = mapped_column(
        ForeignKey("group_cases.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String, nullable=False)
    sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    state: Mapped[str] = mapped_column(String, nullable=False)
    result: Mapped[str | None] = mapped_column(String)
    note: Mapped[str | None] = mapped_column(Text)
    console_text: Mapped[str | None] = mapped_column(Text)
    # 实测过程 as the operator wrote it: the row's evidence narrative, which the
    # writer puts into Lark's own 实测过程 column. 控制台 keeps the console dump.
    evidence: Mapped[str | None] = mapped_column(Text)
    idempotency_key: Mapped[str | None] = mapped_column(String, unique=True)
    source: Mapped[str] = mapped_column(
        String, nullable=False, server_default="execution", default="execution"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group_case: Mapped[GroupCase] = relationship(back_populates="attempts")
    screenshots: Mapped[list[Screenshot]] = relationship(
        back_populates="attempt", cascade="all, delete-orphan", passive_deletes=True
    )


# Every attempt this tool creates locally: one a person ran, one materialised
# from an imported result. Both are ours to queue and to diff against the
# table; 'reconcile' rows were adopted from the table and mirror it.
LOCAL_SOURCES: tuple[str, ...] = ("execution", "import")


class Screenshot(Base):
    __tablename__ = "screenshots"
    __table_args__ = (
        # One attempt holds a given picture once. The same bytes uploaded again —
        # the retry a partial failure invites — answer with the row that is
        # already there instead of filing the image twice in Lark and leaving a
        # second file behind. Rows written before the column existed keep a NULL
        # hash, and Postgres treats NULLs as distinct, so they are never
        # deduplicated against.
        UniqueConstraint(
            "attempt_id", "content_hash", name="uq_screenshot_attempt_hash"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    attempt_id: Mapped[UUID] = mapped_column(
        ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    # SHA-256 of the stored bytes: what makes uploading the same picture twice a
    # no-op rather than a duplicate.
    content_hash: Mapped[str | None] = mapped_column(String(64))
    mime: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    attempt: Mapped[Attempt] = relationship(back_populates="screenshots")


class CaseReferenceAsset(Base):
    """One prototype image inside one test group.

    The file is stored once per group and shared by every case that checks it,
    so re-exporting a design frame replaces a single file.
    """

    __tablename__ = "case_reference_assets"
    __table_args__ = (
        UniqueConstraint(
            "group_id", "asset_key", name="uq_case_reference_asset_key"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    asset_key: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    mime: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    asset_type: Mapped[str] = mapped_column(
        String, nullable=False, default="page", server_default="page"
    )
    screen: Mapped[str | None] = mapped_column(String)
    state: Mapped[str | None] = mapped_column(String)
    source_path: Mapped[str] = mapped_column(String, nullable=False)
    prototype_version: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group: Mapped[Group] = relationship(back_populates="reference_assets")
    links: Mapped[list[CaseReferenceLink]] = relationship(
        back_populates="asset", cascade="all, delete-orphan", passive_deletes=True
    )


class CaseReferenceLink(Base):
    """One case pointing at one asset, with the reason it is checked."""

    __tablename__ = "case_reference_links"
    __table_args__ = (
        UniqueConstraint("group_case_id", "asset_id", name="uq_case_reference_link"),
        CheckConstraint(
            "role IN ('expected', 'locator')", name="ck_case_reference_links_role"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_case_id: Mapped[UUID] = mapped_column(
        ForeignKey("group_cases.id", ondelete="CASCADE"), nullable=False
    )
    asset_id: Mapped[UUID] = mapped_column(
        ForeignKey("case_reference_assets.id", ondelete="CASCADE"), nullable=False
    )
    role: Mapped[str] = mapped_column(
        String, nullable=False, default="expected", server_default="expected"
    )
    caption: Mapped[str | None] = mapped_column(Text)
    focus: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb")
    )
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group_case: Mapped[GroupCase] = relationship(back_populates="reference_links")
    asset: Mapped[CaseReferenceAsset] = relationship(back_populates="links")


class ImportTicket(Base):
    """An uploaded bundle waiting to be imported: one use, 30 minutes.

    `original_file` is the whole upload — for a casebook, the zip with its
    pictures — so PostgreSQL keeps it in this table's TOAST relation. The import
    flow clears it the moment the ticket is consumed or expires (the row stays as
    a tombstone, so a stale page gets a clear answer), and that leaves dead TOAST
    rows behind. A table this small never trips the default autovacuum trigger, so
    it carries its own thresholds; see `0015_import_ticket_autovacuum`.
    """

    __tablename__ = "import_tickets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    file_sha256: Mapped[str] = mapped_column(String, nullable=False)
    original_file: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    parsed: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class LarkHistoryRef(Base):
    """A read-only pointer to one legacy Lark record for a group case.

    The snapshot is display-only: nothing here is ever used as a write target.
    """

    __tablename__ = "lark_history_refs"
    __table_args__ = (
        UniqueConstraint(
            "group_case_id", "table_id", "old_record_id", name="uq_lark_history_ref"
        ),
        CheckConstraint(
            "certainty IN ('verified', 'uncertain')", name="ck_lark_history_certainty"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_case_id: Mapped[UUID] = mapped_column(
        ForeignKey("group_cases.id", ondelete="CASCADE"), nullable=False
    )
    table_id: Mapped[str] = mapped_column(String, nullable=False)
    old_record_id: Mapped[str] = mapped_column(String, nullable=False)
    certainty: Mapped[str] = mapped_column(String, nullable=False, default="uncertain")
    observed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)


class LarkTarget(Base):
    """The real Lark destination of one test group, selected by an administrator.

    ``confirmed_at`` is the write approval; a changed ``target_fingerprint``
    clears it so a re-pointed group can never inherit earlier consent.
    """

    __tablename__ = "lark_targets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    source_url: Mapped[str] = mapped_column(String, nullable=False)
    execution_base_token: Mapped[str] = mapped_column(String, nullable=False)
    execution_base_name: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_id: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_name: Mapped[str] = mapped_column(String, nullable=False)
    execution_view_id: Mapped[str | None] = mapped_column(String)
    execution_view_name: Mapped[str | None] = mapped_column(String)
    bug_base_token: Mapped[str] = mapped_column(String, nullable=False)
    bug_base_name: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_id: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_name: Mapped[str] = mapped_column(String, nullable=False)
    schema_fingerprint: Mapped[str | None] = mapped_column(String)
    target_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    selected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LarkTargetRevision(Base):
    """Every distinct target a group has ever used, newest last.

    History and reconciliation read old tables through this log, so a table
    that was swapped away stays reachable instead of disappearing.
    """

    __tablename__ = "lark_target_revisions"
    __table_args__ = (
        UniqueConstraint("group_id", "target_fingerprint", name="uq_lark_revision"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    execution_base_token: Mapped[str] = mapped_column(String, nullable=False)
    execution_table_id: Mapped[str] = mapped_column(String, nullable=False)
    bug_base_token: Mapped[str] = mapped_column(String, nullable=False)
    bug_table_id: Mapped[str] = mapped_column(String, nullable=False)
    target_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class SyncJob(Base):
    """One outbound Lark create per local attempt, claimed under a lease."""

    __tablename__ = "sync_jobs"
    __table_args__ = (
        CheckConstraint(
            "state IN ('pending', 'running', 'synced', 'failed', 'uncertain')",
            name="ck_sync_jobs_state",
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    attempt_id: Mapped[UUID] = mapped_column(
        ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    state: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    new_exec_record_id: Mapped[str | None] = mapped_column(String)
    new_bug_record_id: Mapped[str | None] = mapped_column(String)
    target_fingerprint: Mapped[str | None] = mapped_column(String)
    error_kind: Mapped[str | None] = mapped_column(String)
    # The reason behind ``error_kind``: Lark's HTTP status, its own code and
    # message, and the remediation the client already words. Without it the
    # operator can only see an internal category such as
    # ``create_execution_failed`` and has no way to learn what Lark refused.
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class ReconcileMark(Base):
    """One administrator decision about one record key, so it stops resurfacing."""

    __tablename__ = "reconcile_marks"
    __table_args__ = (
        UniqueConstraint("group_id", "record_key", name="uq_reconcile_key"),
        CheckConstraint(
            "decision IN ('use_remote', 'use_local')", name="ck_reconcile_decision"
        ),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    group_id: Mapped[UUID] = mapped_column(
        ForeignKey("groups.id", ondelete="CASCADE"), nullable=False
    )
    record_key: Mapped[str] = mapped_column(String, nullable=False)
    decision: Mapped[str] = mapped_column(String, nullable=False)
    remote_record_id: Mapped[str | None] = mapped_column(String)
    decided_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class LarkPeople(Base):
    """The open ids this deployment writes into Lark person columns.

    One row, always. 报告人 and 反馈人 are the same person on both sides of a
    group's target and 负责人 is one placeholder the team fills in later, so
    there is nothing to key by — the CHECK constraint is what keeps "which row"
    from becoming a second decision. An unset id is NULL, never a name: a person
    column refuses anything that is not an open id, and the writer omits the
    column instead of failing the whole row.
    """

    __tablename__ = "lark_people"
    __table_args__ = (CheckConstraint("id = 1", name="ck_lark_people_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    reporter_open_id: Mapped[str | None] = mapped_column(String)
    owner_open_id: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )
