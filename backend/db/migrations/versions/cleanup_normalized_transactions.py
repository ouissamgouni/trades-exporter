"""Cleanup normalized_transactions: remove account and total columns

Revision ID: cleanup_normalized_transactions
Revises: add_account_ids_to_versions
Create Date: 2026-01-03

Changes:
- Drop 'account' column (legacy string field, replaced by account_id FK)
- Drop 'total' column (now computed as price * quantity)
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers
revision = 'cleanup_normalized_transactions'
down_revision = 'add_account_ids_to_versions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Drop the legacy 'account' string column (replaced by account_id FK)
    op.drop_column('normalized_transactions', 'account')
    
    # Drop 'total' column (now computed as price * quantity)
    op.drop_column('normalized_transactions', 'total')


def downgrade() -> None:
    # Re-add 'total' column
    op.add_column(
        'normalized_transactions',
        sa.Column('total', sa.Numeric(36, 18), nullable=True)
    )
    
    # Re-add 'account' column  
    op.add_column(
        'normalized_transactions',
        sa.Column('account', sa.String(), nullable=True, index=True)
    )
