"""Add PnL default config to app_settings and trigger to calculation_versions

Revision ID: 053_add_pnl_defaults_and_trigger
Revises: 052_add_mock_mode_and_backfill
Create Date: 2025-07-25 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '053_add_pnl_defaults_and_trigger'
down_revision: Union[str, Sequence[str], None] = '052_add_mock_mode_and_backfill'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add PnL default configuration columns to app_settings and trigger column to calculation_versions."""
    # Add P&L default config columns to app_settings
    op.add_column('app_settings', sa.Column('pnl_lot_method', sa.String(), nullable=False, server_default='FIFO'))
    op.add_column('app_settings', sa.Column('pnl_lot_mode', sa.String(), nullable=False, server_default='LOT_TRAVEL'))
    op.add_column('app_settings', sa.Column('pnl_residual_tolerance_pct', sa.Numeric(precision=10, scale=4), nullable=False, server_default='0'))
    op.add_column('app_settings', sa.Column('pnl_allow_negative_balances', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('app_settings', sa.Column('pnl_crypto_swap_taxable', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('app_settings', sa.Column('pnl_fee_taxable', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('app_settings', sa.Column('pnl_use_price_fallback', sa.Boolean(), nullable=False, server_default='true'))
    op.add_column('app_settings', sa.Column('pnl_price_staleness_days', sa.Integer(), nullable=False, server_default='7'))

    # Add trigger column to calculation_versions
    op.add_column('calculation_versions', sa.Column('trigger', sa.String(), nullable=True, server_default='manual'))


def downgrade() -> None:
    """Remove PnL default config columns and trigger column."""
    op.drop_column('calculation_versions', 'trigger')
    op.drop_column('app_settings', 'pnl_price_staleness_days')
    op.drop_column('app_settings', 'pnl_use_price_fallback')
    op.drop_column('app_settings', 'pnl_fee_taxable')
    op.drop_column('app_settings', 'pnl_crypto_swap_taxable')
    op.drop_column('app_settings', 'pnl_allow_negative_balances')
    op.drop_column('app_settings', 'pnl_residual_tolerance_pct')
    op.drop_column('app_settings', 'pnl_lot_mode')
    op.drop_column('app_settings', 'pnl_lot_method')
