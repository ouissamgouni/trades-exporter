"""Add dismissed fields to raw_accounts table

Revision ID: 032_add_dismissed_fields
Revises: 031_add_staleness_window_days
Create Date: 2026-02-05

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '032_add_dismissed_fields'
down_revision: Union[str, Sequence[str], None] = '031_add_staleness_window_days'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add dismissed, dismissed_at, dismissed_reason columns to raw_accounts table."""
    # Add dismissed column with default False
    op.add_column(
        'raw_accounts',
        sa.Column('dismissed', sa.Boolean(), nullable=False, server_default='false')
    )
    
    # Add dismissed_at column
    op.add_column(
        'raw_accounts',
        sa.Column('dismissed_at', sa.DateTime(timezone=True), nullable=True)
    )
    
    # Add dismissed_reason column
    op.add_column(
        'raw_accounts',
        sa.Column('dismissed_reason', sa.String(), nullable=True)
    )
    
    # Create index on dismissed for efficient filtering
    op.create_index(
        'ix_raw_accounts_dismissed',
        'raw_accounts',
        ['dismissed']
    )


def downgrade() -> None:
    """Remove dismissed fields from raw_accounts table."""
    # Drop index first
    op.drop_index('ix_raw_accounts_dismissed', table_name='raw_accounts')
    
    # Drop columns
    op.drop_column('raw_accounts', 'dismissed_reason')
    op.drop_column('raw_accounts', 'dismissed_at')
    op.drop_column('raw_accounts', 'dismissed')
