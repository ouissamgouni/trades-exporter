"""add income tracking tables and dividend enum value

Revision ID: 062_add_income_tracking
Revises: 061_add_isin
Create Date: 2026-04-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect as sa_inspect


revision: str = '062_add_income_tracking'
down_revision: Union[str, None] = '061_add_isin'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    conn = op.get_bind()
    insp = sa_inspect(conn)
    existing_tables = insp.get_table_names()

    # --- Add 'dividend' to TransactionType enum ---
    # PostgreSQL requires ALTER TYPE to add a new enum value.
    # Skip if column uses varchar instead of a PG enum.
    has_enum = conn.execute(
        sa.text("SELECT 1 FROM pg_type WHERE typname = 'transactiontype'")
    ).scalar()
    if has_enum:
        op.execute("ALTER TYPE transactiontype ADD VALUE IF NOT EXISTS 'dividend'")

    # --- income_events table ---
    if 'income_events' not in existing_tables:
        op.create_table(
            'income_events',
            sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
            sa.Column('version_id', sa.Integer(), nullable=False),
            sa.Column('unit_id', sa.Integer(), nullable=False),
            sa.Column('income_type', sa.String(), nullable=False),
            sa.Column('asset_id', sa.Integer(), nullable=False),
            sa.Column('attributed_asset_id', sa.Integer(), nullable=True),
            sa.Column('transaction_id', sa.Integer(), nullable=True),
            sa.Column('gross_amount_in_base', sa.Numeric(precision=36, scale=18), nullable=False),
            sa.Column('net_amount_in_base', sa.Numeric(precision=36, scale=18), nullable=False),
            sa.Column('withholding_amount_in_base', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('withholding_jurisdiction', sa.String(length=10), nullable=True),
            sa.Column('withholding_rate', sa.Numeric(precision=10, scale=6), nullable=True),
            sa.Column('income_at', sa.DateTime(), nullable=False),
            sa.Column('notes', sa.Text(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
            sa.ForeignKeyConstraint(['version_id'], ['calculation_versions.version_id']),
            sa.ForeignKeyConstraint(['unit_id'], ['calculation_units.id']),
            sa.ForeignKeyConstraint(['asset_id'], ['assets.asset_id']),
            sa.ForeignKeyConstraint(['attributed_asset_id'], ['assets.asset_id']),
            sa.ForeignKeyConstraint(['transaction_id'], ['normalized_transactions.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_income_events_version_id', 'income_events', ['version_id'])
        op.create_index('ix_income_events_unit_id', 'income_events', ['unit_id'])
        op.create_index('ix_income_events_income_type', 'income_events', ['income_type'])
        op.create_index('ix_income_events_asset_id', 'income_events', ['asset_id'])
        op.create_index('ix_income_events_attributed_asset_id', 'income_events', ['attributed_asset_id'])
        op.create_index('ix_income_events_transaction_id', 'income_events', ['transaction_id'])
        op.create_index('ix_income_events_income_at', 'income_events', ['income_at'])

    # --- dividend_income_tax_entries table ---
    if 'dividend_income_tax_entries' not in existing_tables:
        op.create_table(
            'dividend_income_tax_entries',
            sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
            sa.Column('calculation_version_id', sa.Integer(), nullable=False),
            sa.Column('account_id', sa.Integer(), nullable=True),
            sa.Column('income_event_id', sa.Integer(), nullable=True),
            sa.Column('fiscal_year', sa.Integer(), nullable=False),
            sa.Column('asset_symbol', sa.String(), nullable=False),
            sa.Column('income_type', sa.String(), nullable=False, server_default='dividend'),
            sa.Column('gross_income', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('withholding_tax_credit', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('net_taxable', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('tax_amount', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
            sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
            sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id']),
            sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
            sa.ForeignKeyConstraint(['income_event_id'], ['income_events.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_dividend_income_tax_entries_version_id', 'dividend_income_tax_entries', ['calculation_version_id'])
        op.create_index('ix_dividend_income_tax_entries_account_id', 'dividend_income_tax_entries', ['account_id'])
        op.create_index('ix_dividend_income_tax_entries_income_event_id', 'dividend_income_tax_entries', ['income_event_id'])
        op.create_index('ix_dividend_income_tax_entries_fiscal_year', 'dividend_income_tax_entries', ['fiscal_year'])
        op.create_index('ix_dividend_income_tax_entries_asset_symbol', 'dividend_income_tax_entries', ['asset_symbol'])

    # --- dividend_income_annual_summaries table ---
    if 'dividend_income_annual_summaries' not in existing_tables:
        op.create_table(
            'dividend_income_annual_summaries',
            sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
            sa.Column('calculation_version_id', sa.Integer(), nullable=False),
            sa.Column('account_id', sa.Integer(), nullable=True),
            sa.Column('fiscal_year', sa.Integer(), nullable=False),
            sa.Column('total_gross_income', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('total_withholding_credits', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('net_taxable', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('tax_total', sa.Numeric(precision=36, scale=18), nullable=False, server_default='0'),
            sa.Column('event_count', sa.Integer(), nullable=False, server_default='0'),
            sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
            sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
            sa.ForeignKeyConstraint(['calculation_version_id'], ['calculation_versions.version_id']),
            sa.ForeignKeyConstraint(['account_id'], ['accounts.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_dividend_income_annual_summaries_version_id', 'dividend_income_annual_summaries', ['calculation_version_id'])
        op.create_index('ix_dividend_income_annual_summaries_account_id', 'dividend_income_annual_summaries', ['account_id'])
        op.create_index('ix_dividend_income_annual_summaries_fiscal_year', 'dividend_income_annual_summaries', ['fiscal_year'])


def downgrade() -> None:
    op.drop_table('dividend_income_annual_summaries')
    op.drop_table('dividend_income_tax_entries')
    op.drop_table('income_events')
    # Note: PostgreSQL does not support removing enum values easily.
    # The 'dividend' value in transactiontype will remain but is harmless.
