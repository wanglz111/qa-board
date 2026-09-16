"""Create per-group Lark write confirmations.

Revision ID: 0007_group_confirmation
Revises: 0006_lark_history
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0007_group_confirmation"
down_revision: str | None = "0006_lark_history"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.drop_table("group_lark_confirmations")
