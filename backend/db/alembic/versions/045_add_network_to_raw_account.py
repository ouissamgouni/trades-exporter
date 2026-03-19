"""Add network column to raw_accounts and update unique constraint.

Disambiguates raw accounts that share the same address across different
chains (e.g. same EVM address on Base vs BSC).

- raw_accounts.network: chain/network identifier (default '')
- Drops old unique constraint (source, label)
- Adds new unique constraint (source, label, network)

Revision ID: 045_add_network_to_raw_account
Revises: 044_add_group_and_connector_id
Create Date: 2025-07-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '045_add_network_to_raw_account'
down_revision: Union[str, Sequence[str], None] = '044_add_group_and_connector_id'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _column_exists(table: str, column: str) -> bool:
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = :table AND column_name = :column"
        ),
        {"table": table, "column": column},
    )
    return result.scalar() is not None


def _constraint_exists(constraint_name: str) -> bool:
    conn = op.get_bind()
    result = conn.execute(
        sa.text(
            "SELECT 1 FROM information_schema.table_constraints "
            "WHERE constraint_name = :name"
        ),
        {"name": constraint_name},
    )
    return result.scalar() is not None


def _index_exists(index_name: str) -> bool:
    conn = op.get_bind()
    result = conn.execute(
        sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :name"),
        {"name": index_name},
    )
    return result.scalar() is not None


def upgrade() -> None:
    # 1. Add network column
    if not _column_exists("raw_accounts", "network"):
        op.add_column(
            "raw_accounts",
            sa.Column("network", sa.String(), server_default="", nullable=False),
        )

    # 2. Add index on network
    if not _index_exists("ix_raw_accounts_network"):
        op.create_index("ix_raw_accounts_network", "raw_accounts", ["network"])

    # 3. Drop old unique constraint (source, label)
    if _constraint_exists("uq_raw_account"):
        op.drop_constraint("uq_raw_account", "raw_accounts", type_="unique")

    # 4. Create new unique constraint (source, label, network)
    if not _constraint_exists("uq_raw_account_network"):
        op.create_unique_constraint(
            "uq_raw_account_network",
            "raw_accounts",
            ["source", "label", "network"],
        )


def downgrade() -> None:
    if _constraint_exists("uq_raw_account_network"):
        op.drop_constraint("uq_raw_account_network", "raw_accounts", type_="unique")

    if not _constraint_exists("uq_raw_account"):
        op.create_unique_constraint(
            "uq_raw_account", "raw_accounts", ["source", "label"]
        )

    if _index_exists("ix_raw_accounts_network"):
        op.drop_index("ix_raw_accounts_network", "raw_accounts")

    if _column_exists("raw_accounts", "network"):
        op.drop_column("raw_accounts", "network")
