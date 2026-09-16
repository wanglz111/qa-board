"""Add stable short codes to group snapshots.

Revision ID: 0005_group_short_code
Revises: 0004_attempts
Create Date: 2026-09-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005_group_short_code"
down_revision: str | None = "0004_attempts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("groups", sa.Column("short_code", sa.String(), nullable=True))
    op.execute(
        """
        UPDATE groups
        SET short_code =
            COALESCE(
                NULLIF(left(regexp_replace(name, '\\D', '', 'g'), 4), ''),
                'group'
            )
            || '-' || left(replace(id::text, '-', ''), 6)
        """
    )
    op.alter_column("groups", "short_code", nullable=False)
    op.create_unique_constraint("uq_groups_short_code", "groups", ["short_code"])


def downgrade() -> None:
    op.drop_constraint("uq_groups_short_code", "groups", type_="unique")
    op.drop_column("groups", "short_code")
