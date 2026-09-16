"""Enforce a single administrator account.

Revision ID: 0003_admin_singleton
Revises: 0002_admin_sessions
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0003_admin_singleton"
down_revision: str | None = "0002_admin_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    admin_count = connection.scalar(sa.text("SELECT count(*) FROM admins"))
    if admin_count > 1:
        raise RuntimeError(
            "Cannot apply 0003_admin_singleton: singleton migration requires <=1 admin"
        )

    op.add_column(
        "admins",
        sa.Column("singleton_key", sa.Integer(), server_default="1", nullable=False),
    )
    op.create_unique_constraint("uq_admins_singleton_key", "admins", ["singleton_key"])
    op.create_check_constraint(
        "ck_admins_singleton_key", "admins", sa.column("singleton_key") == 1
    )


def downgrade() -> None:
    op.drop_constraint("ck_admins_singleton_key", "admins", type_="check")
    op.drop_constraint("uq_admins_singleton_key", "admins", type_="unique")
    op.drop_column("admins", "singleton_key")
