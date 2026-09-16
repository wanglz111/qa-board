"""Store one Lark target and revision log per test group.

Revision ID: 0009_lark_targets
Revises: 0008_sync_jobs
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0009_lark_targets"
down_revision: str | None = "0008_sync_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lark_targets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("source_url", sa.String(), nullable=False),
        sa.Column("execution_base_token", sa.String(), nullable=False),
        sa.Column("execution_base_name", sa.String(), nullable=False),
        sa.Column("execution_table_id", sa.String(), nullable=False),
        sa.Column("execution_table_name", sa.String(), nullable=False),
        sa.Column("execution_view_id", sa.String(), nullable=True),
        sa.Column("execution_view_name", sa.String(), nullable=True),
        sa.Column("bug_base_token", sa.String(), nullable=False),
        sa.Column("bug_base_name", sa.String(), nullable=False),
        sa.Column("bug_table_id", sa.String(), nullable=False),
        sa.Column("bug_table_name", sa.String(), nullable=False),
        sa.Column("schema_fingerprint", sa.String(), nullable=True),
        sa.Column("target_fingerprint", sa.String(), nullable=False),
        sa.Column(
            "selected_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id"),
    )
    op.create_table(
        "lark_target_revisions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("execution_base_token", sa.String(), nullable=False),
        sa.Column("execution_table_id", sa.String(), nullable=False),
        sa.Column("bug_base_token", sa.String(), nullable=False),
        sa.Column("bug_table_id", sa.String(), nullable=False),
        sa.Column("target_fingerprint", sa.String(), nullable=False),
        sa.Column(
            "recorded_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "group_id", "target_fingerprint", name="uq_lark_revision"
        ),
    )
    op.add_column(
        "sync_jobs", sa.Column("target_fingerprint", sa.String(), nullable=True)
    )
    op.drop_table("group_lark_confirmations")


def downgrade() -> None:
    op.create_table(
        "group_lark_confirmations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("base_token", sa.String(), nullable=False),
        sa.Column("execution_table_id", sa.String(), nullable=False),
        sa.Column("bug_table_id", sa.String(), nullable=False),
        sa.Column("base_name", sa.String(), nullable=False),
        sa.Column("execution_table_name", sa.String(), nullable=False),
        sa.Column("bug_table_name", sa.String(), nullable=False),
        sa.Column("schema_fingerprint", sa.String(), nullable=False),
        sa.Column("target_fingerprint", sa.String(), nullable=False),
        sa.Column(
            "confirmed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id"),
    )
    op.drop_column("sync_jobs", "target_fingerprint")
    op.drop_table("lark_target_revisions")
    op.drop_table("lark_targets")
