"""Add foreign key constraint on cost_lots.origin_pnl_id -> realized_pnl.pnl_id.

Links each CostLot to the RealizedPnl disposal entry that generated
its cost basis (when cost_source='proceeds').

Revision ID: 059_add_origin_pnl_fk_to_cost_lots
Revises: 058_add_cost_source_and_fmv_metadata
Create Date: 2026-03-12
"""

from typing import Sequence, Union

from alembic import op

revision: str = "059_add_origin_pnl_fk"
down_revision: Union[str, Sequence[str], None] = "058_add_cost_source_fmv_meta"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add FK constraint linking cost_lots.origin_pnl_id to realized_pnl.pnl_id."""
    op.create_foreign_key(
        "fk_cost_lots_origin_pnl_id",
        "cost_lots",
        "realized_pnl",
        ["origin_pnl_id"],
        ["pnl_id"],
    )


def downgrade() -> None:
    """Remove FK constraint from cost_lots.origin_pnl_id."""
    op.drop_constraint("fk_cost_lots_origin_pnl_id", "cost_lots", type_="foreignkey")
