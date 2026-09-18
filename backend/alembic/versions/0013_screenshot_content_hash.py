"""Store the hash that makes one attempt's evidence idempotent.

Revision ID: 0013_screenshot_content_hash
Revises: 0012_sync_job_last_error
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0013_screenshot_content_hash"
down_revision: str | None = "0012_sync_job_last_error"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Every upload used to insert a row and write a file, so the retry that a
    # partial failure invites filed the same picture twice: two rows, two files,
    # and a Lark attachment list that showed it twice. The hash of the bytes is
    # what lets the route answer "this attempt already has that picture" instead.
    #
    # Rows written before the column keep a NULL hash, and Postgres treats NULLs
    # as distinct in a unique index, so nothing existing is deduplicated against
    # and no row has to be re-hashed from a file that may be long gone.
    op.add_column(
        "screenshots",
        sa.Column("content_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "uq_screenshot_attempt_hash",
        "screenshots",
        ["attempt_id", "content_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_screenshot_attempt_hash", table_name="screenshots")
    op.drop_column("screenshots", "content_hash")
