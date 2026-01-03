"""Add account_ids column to calculation_versions table

Revision ID: add_account_ids_to_versions
Revises: add_calculation_unit_legs
Create Date: 2026-01-03

Stores which accounts were included in a P&L calculation.
NULL means all accounts were included (no filter).
Array of integers stores specific account IDs when filtered.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import ARRAY

# revision identifiers
revision = 'add_account_ids_to_versions'
down_revision = 'add_calculation_unit_legs'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add account_ids column to calculation_versions
    # Using PostgreSQL ARRAY type for storing list of account IDs
    op.add_column(
        'calculation_versions',
        sa.Column('account_ids', ARRAY(sa.Integer()), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('calculation_versions', 'account_ids')
