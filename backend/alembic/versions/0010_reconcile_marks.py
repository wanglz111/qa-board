"""Record administrator reconcile decisions and attempt provenance.

Revision ID: 0010_reconcile_marks
Revises: 0009_lark_targets
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0010_reconcile_marks"
down_revision: str | None = "0009_lark_targets"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "reconcile_marks",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("record_key", sa.String(), nullable=False),
        sa.Column("decision", sa.String(), nullable=False),
        sa.Column("remote_record_id", sa.String(), nullable=True),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "decision IN ('use_remote', 'use_local')", name="ck_reconcile_decision"
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("group_id", "record_key", name="uq_reconcile_key"),
    )
    op.add_column(
        "attempts",
        sa.Column("source", sa.String(), nullable=False, server_default="execution"),
    )
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_attempts_source", "attempts", type_="check")
    op.drop_column("attempts", "source")
    op.drop_table("reconcile_marks")
