"""Add French tax models for crypto and securities tax tracking.

Revision ID: 1775066503
Revises: ea875aa4ecfb
Create Date: 2026-04-01 12:00:00

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = '1775066503'
down_revision = 'ea875aa4ecfb'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create french_crypto_tax_entries table
    op.create_table(
        'french_crypto_tax_entries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('calculation_version_id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('realized_pnl_id', sa.Integer(), nullable=True),
        sa.Column('fiscal_year', sa.Integer(), nullable=False),
        sa.Column('cession_date', sa.DateTime(), nullable=False),
        sa.Column('asset_symbol', sa.String(), nullable=False),
        sa.Column('proceeds', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('cost_basis', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('portfolio_value_at_cession', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('total_acquisition_cost', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('taxable_gain', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('tax_amount', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('note', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id'], ),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], ),
        sa.ForeignKeyConstraint(['realized_pnl_id'], ['realized_pnl.pnl_id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_french_crypto_tax_entries_calculation_version_id'), 'french_crypto_tax_entries', ['calculation_version_id'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_entries_account_id'), 'french_crypto_tax_entries', ['account_id'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_entries_realized_pnl_id'), 'french_crypto_tax_entries', ['realized_pnl_id'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_entries_fiscal_year'), 'french_crypto_tax_entries', ['fiscal_year'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_entries_cession_date'), 'french_crypto_tax_entries', ['cession_date'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_entries_asset_symbol'), 'french_crypto_tax_entries', ['asset_symbol'], unique=False)

    # Create french_crypto_tax_annual_summaries table
    op.create_table(
        'french_crypto_tax_annual_summaries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('calculation_version_id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('fiscal_year', sa.Integer(), nullable=False),
        sa.Column('total_gains', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('total_losses', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('net_taxable', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('tax_before_carryforward', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('loss_carryforward_used', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('loss_carried_forward', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('tax_total', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('transaction_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id'], ),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_french_crypto_tax_annual_summaries_calculation_version_id'), 'french_crypto_tax_annual_summaries', ['calculation_version_id'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_annual_summaries_account_id'), 'french_crypto_tax_annual_summaries', ['account_id'], unique=False)
    op.create_index(op.f('ix_french_crypto_tax_annual_summaries_fiscal_year'), 'french_crypto_tax_annual_summaries', ['fiscal_year'], unique=False)

    # Create tax_loss_carryforwards table
    op.create_table(
        'tax_loss_carryforwards',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('loss_fiscal_year', sa.Integer(), nullable=False),
        sa.Column('current_fiscal_year', sa.Integer(), nullable=False),
        sa.Column('loss_amount', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('used_amount', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('remaining_amount', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('carryforward_expires', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('is_expired', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_tax_loss_carryforwards_account_id'), 'tax_loss_carryforwards', ['account_id'], unique=False)
    op.create_index(op.f('ix_tax_loss_carryforwards_loss_fiscal_year'), 'tax_loss_carryforwards', ['loss_fiscal_year'], unique=False)
    op.create_index(op.f('ix_tax_loss_carryforwards_current_fiscal_year'), 'tax_loss_carryforwards', ['current_fiscal_year'], unique=False)
    op.create_index(op.f('ix_tax_loss_carryforwards_is_expired'), 'tax_loss_carryforwards', ['is_expired'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_tax_loss_carryforwards_is_expired'), table_name='tax_loss_carryforwards')
    op.drop_index(op.f('ix_tax_loss_carryforwards_current_fiscal_year'), table_name='tax_loss_carryforwards')
    op.drop_index(op.f('ix_tax_loss_carryforwards_loss_fiscal_year'), table_name='tax_loss_carryforwards')
    op.drop_index(op.f('ix_tax_loss_carryforwards_account_id'), table_name='tax_loss_carryforwards')
    op.drop_table('tax_loss_carryforwards')
    
    op.drop_index(op.f('ix_french_crypto_tax_annual_summaries_fiscal_year'), table_name='french_crypto_tax_annual_summaries')
    op.drop_index(op.f('ix_french_crypto_tax_annual_summaries_account_id'), table_name='french_crypto_tax_annual_summaries')
    op.drop_index(op.f('ix_french_crypto_tax_annual_summaries_calculation_version_id'), table_name='french_crypto_tax_annual_summaries')
    op.drop_table('french_crypto_tax_annual_summaries')
    
    op.drop_index(op.f('ix_french_crypto_tax_entries_asset_symbol'), table_name='french_crypto_tax_entries')
    op.drop_index(op.f('ix_french_crypto_tax_entries_cession_date'), table_name='french_crypto_tax_entries')
    op.drop_index(op.f('ix_french_crypto_tax_entries_fiscal_year'), table_name='french_crypto_tax_entries')
    op.drop_index(op.f('ix_french_crypto_tax_entries_realized_pnl_id'), table_name='french_crypto_tax_entries')
    op.drop_index(op.f('ix_french_crypto_tax_entries_account_id'), table_name='french_crypto_tax_entries')
    op.drop_index(op.f('ix_french_crypto_tax_entries_calculation_version_id'), table_name='french_crypto_tax_entries')
    op.drop_table('french_crypto_tax_entries')
