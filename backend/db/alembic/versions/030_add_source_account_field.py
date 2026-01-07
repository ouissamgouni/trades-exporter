"""Add source_account field to normalized_transactions

Revision ID: 030_add_source_account
Revises: 
Create Date: 2026-01-05

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '030_add_source_account'
down_revision = '029_cleanup_unused_schema'  # Previous head
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add source_account column to normalized_transactions table."""
    op.add_column(
        'normalized_transactions',
        sa.Column('source_account', sa.String(), nullable=True)
    )
    # Add index for efficient lookups during raw account mapping propagation
    op.create_index(
        'ix_normalized_transactions_source_account',
        'normalized_transactions',
        ['source_account']
    )


def downgrade() -> None:
    """Remove source_account column from normalized_transactions table."""
    op.drop_index('ix_normalized_transactions_source_account', table_name='normalized_transactions')
    op.drop_column('normalized_transactions', 'source_account')
