"""Add group to accounts and connector_id to raw/normalized transactions.

Phase 0 of the balance feature:
- accounts.group: optional grouping label for related accounts (e.g. 'Tangem EVM')
- raw_transactions.connector_id: FK to account_connectors for provenance tracking
- normalized_transactions.connector_id: FK to account_connectors for provenance tracking

Revision ID: 044_add_group_and_connector_id
Revises: 043_normalize_network_values
Create Date: 2025-07-21

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '044_add_group_and_connector_id'
down_revision: Union[str, Sequence[str], None] = '043_normalize_network_values'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    """Check if a column already exists in a table."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = :column"
        ),
        {"table": table, "column": column},
    )
    return result.scalar() is not None


def _index_exists(index_name: str) -> bool:
    """Check if an index already exists."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :name"),
        {"name": index_name},
    )
    return result.scalar() is not None


def _fk_exists(constraint_name: str) -> bool:
    """Check if a foreign key constraint already exists."""
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.table_constraints "
            "WHERE constraint_name = :name AND constraint_type = 'FOREIGN KEY'"
        ),
        {"name": constraint_name},
    )
    return result.scalar() is not None


def upgrade() -> None:
    # --- accounts.group ---
    if not _column_exists('accounts', 'group'):
        op.add_column('accounts', sa.Column('group', sa.String(), nullable=True))
    if not _index_exists('ix_accounts_group'):
        op.create_index('ix_accounts_group', 'accounts', ['group'])

    # --- raw_transactions.connector_id ---
    if not _column_exists('raw_transactions', 'connector_id'):
        op.add_column(
            'raw_transactions',
            sa.Column('connector_id', sa.Integer(), nullable=True),
        )
    if not _index_exists('ix_raw_transactions_connector_id'):
        op.create_index('ix_raw_transactions_connector_id', 'raw_transactions', ['connector_id'])
    if not _fk_exists('fk_raw_transactions_connector_id'):
        op.create_foreign_key(
            'fk_raw_transactions_connector_id',
            'raw_transactions',
            'account_connectors',
            ['connector_id'],
            ['id'],
        )

    # --- normalized_transactions.connector_id ---
    if not _column_exists('normalized_transactions', 'connector_id'):
        op.add_column(
            'normalized_transactions',
            sa.Column('connector_id', sa.Integer(), nullable=True),
        )
    if not _index_exists('ix_normalized_transactions_connector_id'):
        op.create_index('ix_normalized_transactions_connector_id', 'normalized_transactions', ['connector_id'])
    if not _fk_exists('fk_normalized_transactions_connector_id'):
        op.create_foreign_key(
            'fk_normalized_transactions_connector_id',
            'normalized_transactions',
            'account_connectors',
            ['connector_id'],
            ['id'],
        )


def downgrade() -> None:
    op.drop_constraint('fk_normalized_transactions_connector_id', 'normalized_transactions', type_='foreignkey')
    op.drop_index('ix_normalized_transactions_connector_id', table_name='normalized_transactions')
    op.drop_column('normalized_transactions', 'connector_id')

    op.drop_constraint('fk_raw_transactions_connector_id', 'raw_transactions', type_='foreignkey')
    op.drop_index('ix_raw_transactions_connector_id', table_name='raw_transactions')
    op.drop_column('raw_transactions', 'connector_id')

    op.drop_index('ix_accounts_group', table_name='accounts')
    op.drop_column('accounts', 'group')
