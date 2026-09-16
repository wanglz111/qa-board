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
    name: Mapped[str] = mapped_column(String, nullable=False)
    source_name: Mapped[str] = mapped_column(String, nullable=False)
    source_sha256: Mapped[str] = mapped_column(String, nullable=False)
    source_format: Mapped[str] = mapped_column(String, nullable=False)
    source_version: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    cases: Mapped[list[GroupCase]] = relationship(
        back_populates="group", cascade="all, delete-orphan", passive_deletes=True
    )


class GroupCase(Base):
    __tablename__ = "group_cases"
    __table_args__ = (
        UniqueConstraint("group_id", "code", name="uq_group_case_code"),
        UniqueConstraint("group_id", "position", name="uq_group_case_position"),
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
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)

    group: Mapped[Group] = relationship(back_populates="cases")
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
    idempotency_key: Mapped[str | None] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group_case: Mapped[GroupCase] = relationship(back_populates="attempts")
    screenshots: Mapped[list[Screenshot]] = relationship(
        back_populates="attempt", cascade="all, delete-orphan", passive_deletes=True
    )


class Screenshot(Base):
    __tablename__ = "screenshots"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    attempt_id: Mapped[UUID] = mapped_column(
        ForeignKey("attempts.id", ondelete="CASCADE"), nullable=False
    )
    storage_key: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    mime: Mapped[str] = mapped_column(String, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    attempt: Mapped[Attempt] = relationship(back_populates="screenshots")


class ImportTicket(Base):
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
