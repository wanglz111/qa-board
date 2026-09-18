"""Let a test group be retired without being destroyed.

Revision ID: 0014_group_archive
Revises: 0013_screenshot_content_hash
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0014_group_archive"
down_revision: str | None = "0013_screenshot_content_hash"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A requirement that moves sends the cases back to the drawing board, and the
    # group that held the old layout has to leave the board — but it is also the
    # only local copy of the evidence it collected: screenshots, reports, and the
    # link to the table its records went into. A timestamp distinguishes "retired"
    # from "here", and NULL means it is still on the board. Nothing cascades and
    # nothing is deleted, so restoring is one update away.
    op.add_column(
        "groups",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("groups", "archived_at")
