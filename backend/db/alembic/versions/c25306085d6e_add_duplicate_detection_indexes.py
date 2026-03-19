"""add_duplicate_detection_indexes

Revision ID: c25306085d6e
Revises: 038_add_file_imports
Create Date: 2026-01-21 14:38:15.206121

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c25306085d6e'
down_revision: Union[str, Sequence[str], None] = '038_add_file_imports'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # Create composite index for duplicate detection queries
    # This speeds up queries that filter by account_id, asset, direction, and date range
    op.create_index(
        'ix_normalized_transactions_duplicate_detection',
        'normalized_transactions',
        ['account_id', 'source_asset_symbol', 'direction', 'date_time'],
        postgresql_using='btree',
    )
    
    # Note: GIN index on JSON column is skipped because tags column is JSON type (not JSONB)
    # JSON type doesn't support GIN indexes well in PostgreSQL
    # If needed in the future, we can convert the column to JSONB type first
    # For now, tag-based queries will use sequential scans or B-tree indexes on other columns


def downgrade() -> None:
    """Downgrade schema."""
    # Drop the composite index
    op.drop_index('ix_normalized_transactions_duplicate_detection', table_name='normalized_transactions')
