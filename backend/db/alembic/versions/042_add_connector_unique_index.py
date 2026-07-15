"""Add unique index on account_connectors (account_id, connector_type, chain)

Prevents duplicate connectors for the same (account, type, chain) combination.
Uses COALESCE so that single-chain connectors (NULL chain) are still covered
by the uniqueness constraint.

Revision ID: 042_add_connector_unique_index
Revises: 1a07528b699a
Create Date: 2026-02-18

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '042_add_connector_unique_index'
down_revision: Union[str, Sequence[str], None] = '1a07528b699a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # First, remove any existing duplicate connectors that would violate
    # the new unique constraint.  Keep the row with the lowest id (oldest).
    op.execute(
        """
        DELETE FROM account_connectors
        WHERE id NOT IN (
            SELECT MIN(id)
            FROM account_connectors
            GROUP BY account_id, connector_type, COALESCE(config->>'chain', '')
        );
        """
    )

    # Add a unique index that distinguishes connectors by (account, type, chain).
    # COALESCE handles connectors without a chain config (single-chain types)
    # by mapping NULL → '' so that the standard (account_id, connector_type)
    # uniqueness is preserved for them.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_connector_account_type_chain
        ON account_connectors (
            account_id,
            connector_type,
            COALESCE((config->>'chain'), '')
        );
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_connector_account_type_chain;")
