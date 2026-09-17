"""Record why a sync job last failed, not just which category it was.

Revision ID: 0012_sync_job_last_error
Revises: 0011_case_reference_assets
Create Date: 2026-09-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0012_sync_job_last_error"
down_revision: str | None = "0011_case_reference_assets"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ``error_kind`` was the only thing a failure left behind, and it is an
    # internal category: the Lark status, code and message that say *why* were
    # composed in ``lark/client.py`` and then dropped with the exception. The
    # operator could see "create_execution_failed" and nothing else.
    op.add_column("sync_jobs", sa.Column("last_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sync_jobs", "last_error")
