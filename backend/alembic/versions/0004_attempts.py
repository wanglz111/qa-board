"""Create append-only execution attempts and screenshot metadata.

Revision ID: 0004_attempts
Revises: 0003_admin_singleton
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004_attempts"
down_revision: str | None = "0003_admin_singleton"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attempts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_case_id", sa.Uuid(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("result", sa.String(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("console_text", sa.Text(), nullable=True),
        sa.Column("idempotency_key", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "state IN ('started', 'committed')", name="ck_attempts_state"
        ),
        sa.CheckConstraint(
            "(state = 'started' AND result IS NULL) OR "
            "(state = 'committed' AND result IN ('通过', '不通过', '未执行'))",
            name="ck_attempts_state_result",
        ),
        sa.ForeignKeyConstraint(
            ["group_case_id"], ["group_cases.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_case_id", "label", name="uq_attempt_case_label"),
        sa.UniqueConstraint(
            "group_case_id", "sequence", name="uq_attempt_case_sequence"
        ),
        sa.UniqueConstraint("idempotency_key"),
    )
    op.create_table(
        "screenshots",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("attempt_id", sa.Uuid(), nullable=False),
        sa.Column("storage_key", sa.String(), nullable=False),
        sa.Column("mime", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["attempt_id"], ["attempts.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
    )


def downgrade() -> None:
    op.drop_table("screenshots")
    op.drop_table("attempts")
