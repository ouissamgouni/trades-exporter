"""Add Option D CQRS-Lite schema enhancements.

This migration adds:
- asset_balances table for materialized balance aggregations
- origin_unit_id FK to cost_lots (for linking lots to their creating unit)
- origin_unit_id FK to realized_pnl (for linking P&L entries to their creating unit)

Revision ID: 018
Revises: 017
Create Date: 2025-01-07

"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '018'
down_revision = '017'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Create asset_balances table for materialized balance aggregations
    op.create_table(
        'asset_balances',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('version_id', sa.Integer(), nullable=False),
        sa.Column('asset_id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=True),
        sa.Column('qty', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('cost_basis_in_base', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('lot_count', sa.Integer(), nullable=False, server_default='0'),
        sa.PrimaryKeyConstraint('id'),
        sa.ForeignKeyConstraint(['version_id'], ['calculation_versions.version_id']),
        sa.ForeignKeyConstraint(['asset_id'], ['assets.asset_id']),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
    )
    
    # Create indexes for asset_balances
    op.create_index('ix_asset_balances_version_id', 'asset_balances', ['version_id'])
    op.create_index('ix_asset_balances_asset_id', 'asset_balances', ['asset_id'])
    op.create_index('ix_asset_balances_account_id', 'asset_balances', ['account_id'])
    op.create_index(
        'ix_asset_balances_version_asset', 
        'asset_balances', 
        ['version_id', 'asset_id'],
        unique=False
    )
    
    # 2. Add origin_unit_id FK to cost_lots
    op.add_column(
        'cost_lots',
        sa.Column('origin_unit_id', sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        'fk_cost_lots_origin_unit_id',
        'cost_lots',
        'processed_units',
        ['origin_unit_id'],
        ['id']
    )
    op.create_index('ix_cost_lots_origin_unit_id', 'cost_lots', ['origin_unit_id'])
    
    # 3. Add origin_unit_id FK to realized_pnl
    op.add_column(
        'realized_pnl',
        sa.Column('origin_unit_id', sa.Integer(), nullable=True)
    )
    op.create_foreign_key(
        'fk_realized_pnl_origin_unit_id',
        'realized_pnl',
        'processed_units',
        ['origin_unit_id'],
        ['id']
    )
    op.create_index('ix_realized_pnl_origin_unit_id', 'realized_pnl', ['origin_unit_id'])


def downgrade() -> None:
    # 3. Remove origin_unit_id from realized_pnl
    op.drop_index('ix_realized_pnl_origin_unit_id', 'realized_pnl')
    op.drop_constraint('fk_realized_pnl_origin_unit_id', 'realized_pnl', type_='foreignkey')
    op.drop_column('realized_pnl', 'origin_unit_id')
    
    # 2. Remove origin_unit_id from cost_lots
    op.drop_index('ix_cost_lots_origin_unit_id', 'cost_lots')
    op.drop_constraint('fk_cost_lots_origin_unit_id', 'cost_lots', type_='foreignkey')
    op.drop_column('cost_lots', 'origin_unit_id')
    
    # 1. Drop asset_balances table
    op.drop_index('ix_asset_balances_version_asset', 'asset_balances')
    op.drop_index('ix_asset_balances_account_id', 'asset_balances')
    op.drop_index('ix_asset_balances_asset_id', 'asset_balances')
    op.drop_index('ix_asset_balances_version_id', 'asset_balances')
    op.drop_table('asset_balances')
