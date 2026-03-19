"""Add content_hash column to normalized_transactions

Revision ID: add_content_hash_column
Revises: 8e590afbb508
Create Date: 2026-01-17

Changes:
- Add 'content_hash' column for cross-source duplicate detection
- Add index on content_hash for efficient duplicate lookups
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers
revision = 'add_content_hash_column'
down_revision = '8e590afbb508'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add content_hash column with index for efficient duplicate detection
    op.add_column(
        'normalized_transactions',
        sa.Column('content_hash', sa.String(32), nullable=True)
    )
    
    # Create index for fast content_hash lookups
    op.create_index(
        'ix_normalized_transactions_content_hash',
        'normalized_transactions',
        ['content_hash']
    )


def downgrade() -> None:
    # Drop index first
    op.drop_index(
        'ix_normalized_transactions_content_hash',
        'normalized_transactions'
    )
    
    # Drop column
    op.drop_column('normalized_transactions', 'content_hash')
