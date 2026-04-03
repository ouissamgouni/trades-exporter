"""Rename tax_regime to tax_jurisdiction and add French securities tax tables.

Revision ID: 1775066504
Revises: b48f4313bddc
Create Date: 2026-04-01

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '1775066504'
down_revision: Union[str, Sequence[str], None] = 'b48f4313bddc'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    existing_columns = {c['name'] for c in inspector.get_columns('calculation_versions')}
    existing_tables = set(inspector.get_table_names())
    app_settings_columns = {c['name'] for c in inspector.get_columns('app_settings')}

    # 1. Rename tax_regime → tax_jurisdiction on calculation_versions
    if 'tax_regime' in existing_columns and 'tax_jurisdiction' not in existing_columns:
        op.alter_column('calculation_versions', 'tax_regime', new_column_name='tax_jurisdiction')

    # 2. Migrate data values: "none" → "standard", "fr_crypto"/"fr_securities" → "fr"
    op.execute("UPDATE calculation_versions SET tax_jurisdiction = 'standard' WHERE tax_jurisdiction IN ('none', 'standard') OR tax_jurisdiction IS NULL")
    op.execute("UPDATE calculation_versions SET tax_jurisdiction = 'fr' WHERE tax_jurisdiction IN ('fr_crypto', 'fr_securities')")

    # 3. Update default
    op.alter_column('calculation_versions', 'tax_jurisdiction', server_default='standard')

    # 4. Add pnl_tax_jurisdiction to app_settings
    if 'pnl_tax_jurisdiction' not in app_settings_columns:
        op.add_column(
            'app_settings',
            sa.Column('pnl_tax_jurisdiction', sa.String(), nullable=False, server_default='standard')
        )

    # 5. Create french_securities_tax_entries table
    if 'french_securities_tax_entries' not in existing_tables:
        op.create_table(
            'french_securities_tax_entries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('calculation_version_id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('realized_pnl_id', sa.Integer(), nullable=True),
        sa.Column('fiscal_year', sa.Integer(), nullable=False),
        sa.Column('trade_date', sa.DateTime(), nullable=False),
        sa.Column('asset_symbol', sa.String(), nullable=False),
        sa.Column('direction', sa.String(), nullable=False, server_default='sell'),
        sa.Column('qty', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('proceeds_per_unit', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('cump_at_time', sa.Numeric(precision=36, scale=18), nullable=False),
        sa.Column('gain_loss', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('tax_amount', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('note', sa.String(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id']),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.ForeignKeyConstraint(['realized_pnl_id'], ['realized_pnl.pnl_id']),
        sa.PrimaryKeyConstraint('id')
        )
        op.create_index('ix_french_securities_tax_entries_version_id', 'french_securities_tax_entries', ['calculation_version_id'])
        op.create_index('ix_french_securities_tax_entries_account_id', 'french_securities_tax_entries', ['account_id'])
        op.create_index('ix_french_securities_tax_entries_fiscal_year', 'french_securities_tax_entries', ['fiscal_year'])
        op.create_index('ix_french_securities_tax_entries_trade_date', 'french_securities_tax_entries', ['trade_date'])
        op.create_index('ix_french_securities_tax_entries_asset_symbol', 'french_securities_tax_entries', ['asset_symbol'])

    # 6. Create french_securities_tax_annual_summaries table
    if 'french_securities_tax_annual_summaries' not in existing_tables:
        op.create_table(
            'french_securities_tax_annual_summaries',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('calculation_version_id', sa.Integer(), nullable=False),
        sa.Column('account_id', sa.Integer(), nullable=False),
        sa.Column('fiscal_year', sa.Integer(), nullable=False),
        sa.Column('total_gains', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('total_losses', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('net_taxable', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('loss_carryforward_used', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('loss_carried_forward', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('tax_total', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
        sa.Column('transaction_count', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id']),
        sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
        sa.PrimaryKeyConstraint('id')
        )
        op.create_index('ix_french_sec_tax_annual_version_id', 'french_securities_tax_annual_summaries', ['calculation_version_id'])
        op.create_index('ix_french_sec_tax_annual_account_id', 'french_securities_tax_annual_summaries', ['account_id'])
        op.create_index('ix_french_sec_tax_annual_fiscal_year', 'french_securities_tax_annual_summaries', ['fiscal_year'])


def downgrade() -> None:
    # Drop securities tables
    op.drop_index('ix_french_sec_tax_annual_fiscal_year', table_name='french_securities_tax_annual_summaries')
    op.drop_index('ix_french_sec_tax_annual_account_id', table_name='french_securities_tax_annual_summaries')
    op.drop_index('ix_french_sec_tax_annual_version_id', table_name='french_securities_tax_annual_summaries')
    op.drop_table('french_securities_tax_annual_summaries')

    op.drop_index('ix_french_securities_tax_entries_asset_symbol', table_name='french_securities_tax_entries')
    op.drop_index('ix_french_securities_tax_entries_trade_date', table_name='french_securities_tax_entries')
    op.drop_index('ix_french_securities_tax_entries_fiscal_year', table_name='french_securities_tax_entries')
    op.drop_index('ix_french_securities_tax_entries_account_id', table_name='french_securities_tax_entries')
    op.drop_index('ix_french_securities_tax_entries_version_id', table_name='french_securities_tax_entries')
    op.drop_table('french_securities_tax_entries')

    # Remove pnl_tax_jurisdiction from app_settings
    op.drop_column('app_settings', 'pnl_tax_jurisdiction')

    # Rename back: tax_jurisdiction → tax_regime
    op.alter_column('calculation_versions', 'tax_jurisdiction', new_column_name='tax_regime')
    op.execute("UPDATE calculation_versions SET tax_regime = 'none' WHERE tax_regime = 'standard' OR tax_regime IS NULL")
    op.alter_column('calculation_versions', 'tax_regime', server_default='none')
