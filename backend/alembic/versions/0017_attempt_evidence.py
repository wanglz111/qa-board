"""Give an attempt its evidence column, and let an imported row say so.

Revision ID: 0017_attempt_evidence
Revises: 0016_lark_people
Create Date: 2026-09-19
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0017_attempt_evidence"
down_revision: str | None = "0016_lark_people"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("attempts", sa.Column("evidence", sa.Text(), nullable=True))
    # 导入的行必须能与"人跑出来的行"区分开，否则执行历史与导出报表里
    # 41 条转译结果看起来像手工逐条点的。
    op.drop_constraint("ck_attempts_source", "attempts", type_="check")
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile', 'import')"
    )


def downgrade() -> None:
    op.drop_constraint("ck_attempts_source", "attempts", type_="check")
    op.create_check_constraint(
        "ck_attempts_source", "attempts", "source IN ('execution', 'reconcile')"
    )
    op.drop_column("attempts", "evidence")
