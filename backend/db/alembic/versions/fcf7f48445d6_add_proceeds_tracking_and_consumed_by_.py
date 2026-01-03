"""add_proceeds_tracking_and_consumed_by_leg_id

Revision ID: fcf7f48445d6
Revises: 025_cleanup_realized_pnl_columns
Create Date: 2026-01-01 22:22:46.120496

Adds:
1. Proceeds tracking fields to realized_pnl table for FMV transparency
2. consumed_by_leg_id to consumed_lot_slices for better audit trail
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'fcf7f48445d6'
down_revision: Union[str, Sequence[str], None] = '025_cleanup_realized_pnl_columns'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema.
    
    Adds proceeds tracking to realized_pnl:
    - proceeds_source: How proceeds were determined (fmv_lookup, base_currency, transfer)
    - proceeds_price: The price used for FMV calculation
    - proceeds_price_source: Where the price came from (coingecko, manual, etc.)
    - proceeds_price_timestamp: When the price was fetched
    
    Adds consumed_by_leg_id to consumed_lot_slices:
    - Links to the specific leg (disposal) that consumed this slice
    """
    # Add proceeds tracking to realized_pnl
    op.add_column('realized_pnl', sa.Column('proceeds_source', sa.String(), nullable=True))
    op.add_column('realized_pnl', sa.Column('proceeds_price', sa.Numeric(precision=36, scale=18), nullable=True))
    op.add_column('realized_pnl', sa.Column('proceeds_price_source', sa.String(), nullable=True))
    op.add_column('realized_pnl', sa.Column('proceeds_price_timestamp', sa.DateTime(), nullable=True))
    
    # Set default value for existing records
    op.execute("UPDATE realized_pnl SET proceeds_source = 'fmv_lookup' WHERE proceeds_source IS NULL")
    
    # Add consumed_by_leg_id to consumed_lot_slices with foreign key
    op.add_column('consumed_lot_slices', sa.Column('consumed_by_leg_id', sa.Integer(), nullable=True))
    op.create_index(op.f('ix_consumed_lot_slices_consumed_by_leg_id'), 'consumed_lot_slices', ['consumed_by_leg_id'], unique=False)
    op.create_foreign_key(
        'consumed_lot_slices_consumed_by_leg_id_fkey',
        'consumed_lot_slices',
        'calculation_unit_legs',
        ['consumed_by_leg_id'],
        ['id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Remove consumed_by_leg_id from consumed_lot_slices
    op.drop_constraint('consumed_lot_slices_consumed_by_leg_id_fkey', 'consumed_lot_slices', type_='foreignkey')
    op.drop_index(op.f('ix_consumed_lot_slices_consumed_by_leg_id'), table_name='consumed_lot_slices')
    op.drop_column('consumed_lot_slices', 'consumed_by_leg_id')
    
    # Remove proceeds tracking from realized_pnl
    op.drop_column('realized_pnl', 'proceeds_price_timestamp')
    op.drop_column('realized_pnl', 'proceeds_price_source')
    op.drop_column('realized_pnl', 'proceeds_price')
    op.drop_column('realized_pnl', 'proceeds_source')

