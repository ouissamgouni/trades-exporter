"""Add related_asset_symbol to realized_pnl for derivative grouping.

Stores the underlying asset symbol (e.g. "ETH") on derivative settlement
P&L entries so the UI can redirect them to the correct asset view.

Revision ID: 061_add_related_asset_symbol
Revises: 060_add_source_lot_id
Create Date: 2026-03-14
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "061_add_related_asset_symbol"
down_revision: Union[str, Sequence[str], None] = "060_add_source_lot_id"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add related_asset_symbol column + index to realized_pnl."""
    op.add_column("realized_pnl", sa.Column("related_asset_symbol", sa.String(), nullable=True))
    op.create_index("ix_realized_pnl_related_asset_symbol", "realized_pnl", ["related_asset_symbol"])


def downgrade() -> None:
    """Remove related_asset_symbol column + index from realized_pnl."""
    op.drop_index("ix_realized_pnl_related_asset_symbol", "realized_pnl")
    op.drop_column("realized_pnl", "related_asset_symbol")
