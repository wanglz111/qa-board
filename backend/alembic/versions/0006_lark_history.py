"""Create read-only legacy Lark history references.

Revision ID: 0006_lark_history
Revises: 0005_group_short_code
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0006_lark_history"
down_revision: str | None = "0005_group_short_code"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "lark_history_refs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_case_id", sa.Uuid(), nullable=False),
        sa.Column("table_id", sa.String(), nullable=False),
        sa.Column("old_record_id", sa.String(), nullable=False),
        sa.Column("certainty", sa.String(), nullable=False),
        sa.Column(
            "observed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "certainty IN ('verified', 'uncertain')",
            name="ck_lark_history_certainty",
        ),
        sa.ForeignKeyConstraint(
            ["group_case_id"], ["group_cases.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "group_case_id",
            "table_id",
            "old_record_id",
            name="uq_lark_history_ref",
        ),
    )


def downgrade() -> None:
    op.drop_table("lark_history_refs")
