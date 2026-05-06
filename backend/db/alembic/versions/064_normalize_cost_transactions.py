"""Normalize existing COST transactions to new format.

Revision ID: 064_normalize_cost_txs
Revises: 063_add_memo_tx_type
Create Date: 2026-04-13

Promotes fee amount into quantity, sets price=1, moves fee currency
to price_quote_asset_id, clears legacy fee fields.

New COST format:
  - asset_id = NULL
  - quantity = fee amount
  - price = 1
  - price_quote_asset_id = fee currency asset
  - source_price_quote_asset_symbol = fee currency symbol
  - fee = NULL, fee_quote_asset_id = NULL, source_fee_quote_asset_symbol = ''
  - include_fee = false
  - direction = 'outflow'
"""
from alembic import op

revision = '064_normalize_cost_txs'
down_revision = '063_add_memo_tx_type'
branch_labels = None
depends_on = None


def upgrade():
    # Migrate old-format COST rows (qty=0, fee>0) to new format
    op.execute("""
        UPDATE normalized_transactions
        SET
            quantity      = fee,
            price         = 1,
            price_quote_asset_id = fee_quote_asset_id,
            source_price_quote_asset_symbol = source_fee_quote_asset_symbol,
            asset_id      = NULL,
            fee           = NULL,
            fee_quote_asset_id = NULL,
            source_fee_quote_asset_symbol = '',
            include_fee   = false,
            direction     = 'outflow'
        WHERE transaction_type = 'cost'
          AND quantity = 0
          AND fee > 0
          AND fee_quote_asset_id IS NOT NULL
    """)


def downgrade():
    # Revert new-format COST rows back to old format
    op.execute("""
        UPDATE normalized_transactions
        SET
            fee           = quantity,
            fee_quote_asset_id = price_quote_asset_id,
            source_fee_quote_asset_symbol = source_price_quote_asset_symbol,
            quantity      = 0,
            price         = 0,
            price_quote_asset_id = NULL,
            source_price_quote_asset_symbol = '',
            asset_id      = NULL,
            include_fee   = true,
            direction     = 'neutral'
        WHERE transaction_type = 'cost'
          AND quantity > 0
          AND price = 1
          AND price_quote_asset_id IS NOT NULL
          AND (fee IS NULL OR fee = 0)
    """)
