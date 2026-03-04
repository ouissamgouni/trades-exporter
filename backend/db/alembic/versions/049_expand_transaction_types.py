"""Expand transaction types: add 'margin', rename 'technical' to 'cost'.

New 4-value type system:
  trade    – bilateral exchange (buy/sell)
  transfer – asset movement between accounts (deposit, withdrawal, etc.)
  margin   – derivative cash flow (funding rate, perp open/close PnL)
  cost     – fee-only transaction (gas, management fee, approval cost)

Data migration only – the column is already a plain VARCHAR, so no DDL needed.

Revision ID: 049_expand_transaction_types
Revises: 048_add_connector_id_to_dp
Create Date: 2026-03-03
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "049_expand_transaction_types"
down_revision: Union[str, Sequence[str], None] = "048_add_connector_id_to_dp"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Rename 'technical' -> 'cost'
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'cost'
        WHERE transaction_type = 'technical'
        """
    )

    # 2. Reclassify derivative settlements from 'transfer' -> 'margin'
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'margin'
        WHERE transaction_type = 'transfer'
          AND source_transaction_type IN ('funding', 'perp_open', 'perp_close')
        """
    )


def downgrade() -> None:
    # Revert 'margin' -> 'transfer'
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'transfer'
        WHERE transaction_type = 'margin'
        """
    )

    # Revert 'cost' -> 'technical'
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'technical'
        WHERE transaction_type = 'cost'
        """
    )
