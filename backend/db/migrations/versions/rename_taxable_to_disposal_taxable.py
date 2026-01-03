"""Rename taxable fields to disposal_taxable for clarity.

This migration renames:
- normalized_transactions.taxable → disposal_taxable
- realized_pnl.taxable → disposal_taxable

The rename makes explicit that these fields indicate whether DISPOSING
an asset triggers a taxable gain/loss event (capital gains tax), leaving
room for future acquisition_taxable (income tax on receipt) fields.

Revision ID: 023_rename_taxable_disposal
Revises: 022_add_config_fields_to_calculation_versions
Create Date: 2025-12-31
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers
revision = '023_rename_taxable_disposal'
down_revision = '022_add_config_fields_to_calculation_versions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Rename taxable columns to disposal_taxable."""
    # Rename normalized_transactions.taxable → disposal_taxable
    op.alter_column(
        'normalized_transactions',
        'taxable',
        new_column_name='disposal_taxable',
        existing_type=sa.Boolean(),
        existing_nullable=True
    )
    
    # Rename realized_pnl.taxable → disposal_taxable
    op.alter_column(
        'realized_pnl',
        'taxable',
        new_column_name='disposal_taxable',
        existing_type=sa.Boolean(),
        existing_nullable=True
    )


def downgrade() -> None:
    """Revert column renames."""
    # Revert realized_pnl.disposal_taxable → taxable
    op.alter_column(
        'realized_pnl',
        'disposal_taxable',
        new_column_name='taxable',
        existing_type=sa.Boolean(),
        existing_nullable=True
    )
    
    # Revert normalized_transactions.disposal_taxable → taxable
    op.alter_column(
        'normalized_transactions',
        'disposal_taxable',
        new_column_name='taxable',
        existing_type=sa.Boolean(),
        existing_nullable=True
    )
