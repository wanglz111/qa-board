"""Reclaim what a cleared import payload leaves in TOAST.

Revision ID: 0015_import_ticket_autovacuum
Revises: 0014_group_archive
Create Date: 2026-09-18
"""

from collections.abc import Sequence

from alembic import op


revision: str = "0015_import_ticket_autovacuum"
down_revision: str | None = "0014_group_archive"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # An uploaded bundle is one bytea, so PostgreSQL keeps it in the table's TOAST
    # relation. The import flow already clears it the moment the ticket is consumed
    # or expires — that part was never the problem — but clearing it leaves dead
    # TOAST rows, and this table only ever holds a handful of live rows: the
    # default trigger (50 dead rows plus 20% of live) is never reached, so nothing
    # ever reclaims them. Production sat at 92 MB for 15 live rows with a 16 kB
    # heap until it was vacuumed by hand.
    #
    # These thresholds make autovacuum pick this table up after a few imports
    # instead of never, and it takes the TOAST relation with it. PostgreSQL stores
    # table storage parameters outside the ORM, so the model carries a comment
    # pointing here rather than a duplicate of this statement.
    op.execute(
        "ALTER TABLE import_tickets SET ("
        "autovacuum_vacuum_threshold = 5, "
        "autovacuum_vacuum_scale_factor = 0)"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE import_tickets RESET ("
        "autovacuum_vacuum_threshold, autovacuum_vacuum_scale_factor)"
    )
