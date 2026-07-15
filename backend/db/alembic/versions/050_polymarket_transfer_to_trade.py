"""Reclassify Polymarket hub buy/sell/redeem from 'transfer' to 'trade'.

Polymarket bets are USDC ↔ outcome-share exchanges (trades), not transfers.
The connector was fixed in the same commit; this migrates existing rows.

Revision ID: 050_polymarket_transfer_to_trade
Revises: 049_expand_transaction_types
Create Date: 2026-03-03
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "050_polymarket_transfer_to_trade"
down_revision: Union[str, Sequence[str], None] = "049_expand_transaction_types"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'trade'
        WHERE source = 'polymarket'
          AND source_transaction_type IN ('buy', 'sell', 'redeem', 'trade')
          AND transaction_type = 'transfer'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE normalized_transactions
        SET transaction_type = 'transfer'
        WHERE source = 'polymarket'
          AND source_transaction_type IN ('buy', 'sell', 'redeem', 'trade')
          AND transaction_type = 'trade'
        """
    )
