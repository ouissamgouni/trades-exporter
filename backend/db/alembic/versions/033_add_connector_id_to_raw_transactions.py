"""Add connector_id FK to raw_transactions table

Revision ID: 033_connector_id
Revises: 032_add_account_enabled
Create Date: 2026-01-14

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '033_connector_id'
down_revision: Union[str, None] = '032_add_account_enabled'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add connector_id column to raw_transactions table (nullable for legacy data)
    op.add_column(
        'raw_transactions',
        sa.Column('connector_id', sa.Integer(), nullable=True)
    )
    
    # Create index for connector_id
    op.create_index(
        'ix_raw_transactions_connector_id',
        'raw_transactions',
        ['connector_id'],
        unique=False
    )
    
    # Add foreign key constraint to account_connectors
    op.create_foreign_key(
        'fk_raw_transactions_connector_id',
        'raw_transactions',
        'account_connectors',
        ['connector_id'],
        ['id'],
        ondelete='SET NULL'
    )


def downgrade() -> None:
    # Drop foreign key constraint
    op.drop_constraint('fk_raw_transactions_connector_id', 'raw_transactions', type_='foreignkey')
    
    # Drop index
    op.drop_index('ix_raw_transactions_connector_id', table_name='raw_transactions')
    
    # Drop column
    op.drop_column('raw_transactions', 'connector_id')
