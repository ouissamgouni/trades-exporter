"""Add source_lot_id self-referential FK to cost_lots for chain traversal.

Links each inherited/split CostLot back to the lot it was created from,
enabling recursive cost basis chain traversal.

Revision ID: 060_add_source_lot_id
Revises: 059_add_origin_pnl_fk
Create Date: 2026-03-13
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "060_add_source_lot_id"
down_revision: Union[str, Sequence[str], None] = "059_add_origin_pnl_fk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add source_lot_id column + FK + index to cost_lots."""
    op.add_column("cost_lots", sa.Column("source_lot_id", sa.Integer(), nullable=True))
    op.create_index("ix_cost_lots_source_lot_id", "cost_lots", ["source_lot_id"])
    op.create_foreign_key(
        "fk_cost_lots_source_lot_id",
        "cost_lots",
        "cost_lots",
        ["source_lot_id"],
        ["cost_lot_id"],
    )


def downgrade() -> None:
    """Remove source_lot_id column + FK + index from cost_lots."""
    op.drop_constraint("fk_cost_lots_source_lot_id", "cost_lots", type_="foreignkey")
    op.drop_index("ix_cost_lots_source_lot_id", "cost_lots")
    op.drop_column("cost_lots", "source_lot_id")
