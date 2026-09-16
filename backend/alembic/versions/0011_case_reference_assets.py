"""Attach prototype reference images and visual checks to group cases.

Revision ID: 0011_case_reference_assets
Revises: 0010_reconcile_marks
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "0011_case_reference_assets"
down_revision: str | None = "0010_reconcile_marks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "group_cases",
        sa.Column(
            "expect_absent",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "group_cases",
        sa.Column(
            "visual_check",
            sa.String(),
            server_default="text_and_visual",
            nullable=False,
        ),
    )
    op.add_column("group_cases", sa.Column("prototype_note", sa.Text(), nullable=True))
    op.create_check_constraint(
        "ck_group_cases_visual_check",
        "group_cases",
        "visual_check IN ('text_and_visual', 'visual_only', 'not_verifiable')",
    )
    op.create_table(
        "case_reference_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=False),
        sa.Column("asset_key", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("storage_key", sa.String(), nullable=False),
        sa.Column("mime", sa.String(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("asset_type", sa.String(), nullable=False, server_default="page"),
        sa.Column("screen", sa.String(), nullable=True),
        sa.Column("state", sa.String(), nullable=True),
        sa.Column("source_path", sa.String(), nullable=False),
        sa.Column("prototype_version", sa.String(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["group_id"], ["groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_key"),
        sa.UniqueConstraint("group_id", "asset_key", name="uq_case_reference_asset_key"),
    )
    op.create_table(
        "case_reference_links",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("group_case_id", sa.Uuid(), nullable=False),
        sa.Column("asset_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(), nullable=False, server_default="expected"),
        sa.Column("caption", sa.Text(), nullable=True),
        sa.Column(
            "focus",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "role IN ('expected', 'locator')", name="ck_case_reference_links_role"
        ),
        sa.ForeignKeyConstraint(
            ["group_case_id"], ["group_cases.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["asset_id"], ["case_reference_assets.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "group_case_id", "asset_id", name="uq_case_reference_link"
        ),
    )


def downgrade() -> None:
    op.drop_table("case_reference_links")
    op.drop_table("case_reference_assets")
    op.drop_constraint("ck_group_cases_visual_check", "group_cases")
    op.drop_column("group_cases", "prototype_note")
    op.drop_column("group_cases", "visual_check")
    op.drop_column("group_cases", "expect_absent")
