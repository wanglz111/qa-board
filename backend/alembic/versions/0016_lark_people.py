"""Store the open ids the writer puts into Lark person columns.

Revision ID: 0016_lark_people
Revises: 0015_import_ticket_autovacuum
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0016_lark_people"
down_revision: str | None = "0015_import_ticket_autovacuum"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 报告人/反馈人和负责人对每一个测试组都是同两个人，所以这张表只有一行。
    # 单行由 CHECK 钉死：读配置的地方就不需要再决定「读哪一行」。
    # 未配置是 NULL 而不是空串，写端据此把该列整个省略——人员列只吃 open id，
    # 塞一个显示名进去会让整行 create 失败。
    op.create_table(
        "lark_people",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("reporter_open_id", sa.String(), nullable=True),
        sa.Column("owner_open_id", sa.String(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_lark_people_singleton"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("lark_people")
