"""Remove _FEES: asset naming convention from existing data.

Fee-only transactions should be identified by transaction_type='cost' and
direction='neutral', not by a _FEES:* prefix in source_asset_symbol.

This migration:
1. Saves the original _FEES: symbol into tags for traceability.
2. Clears source_asset_symbol and nullifies asset_id on those rows.
3. Ensures source_transaction_type='management_fee' on all such rows.
4. Deletes the fake _FEES Asset records and any raw_assets rows.

Downstream P&L pipeline already keys off transaction_type='cost' and
leg_type='fee', so no further changes are needed.

Revision ID: 054_cleanup_fees_convention
Revises: 053_add_pnl_defaults_and_trigger
Create Date: 2026-03-09
"""
from typing import Sequence, Union

from alembic import op


revision: str = "054_cleanup_fees_convention"
down_revision: Union[str, Sequence[str], None] = "053_add_pnl_defaults_and_trigger"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Save the original _FEES: symbol and asset_id into tags for traceability,
    #    then clear source_asset_symbol, null out asset_id, and normalize source_transaction_type.
    op.execute(
        """
        UPDATE normalized_transactions
        SET tags = COALESCE(tags, '{}'::jsonb)
                   || jsonb_build_object(
                        '_legacy_fees_symbol', source_asset_symbol,
                        '_legacy_fees_asset_id', asset_id::text
                      ),
            source_asset_symbol = '',
            asset_id = NULL,
            source_transaction_type = 'management_fee'
        WHERE source_asset_symbol LIKE '_FEES:%'
           OR asset_id IN (SELECT asset_id FROM assets WHERE symbol LIKE '_FEES:%')
        """
    )

    # 2. Delete FK references to _FEES Assets in child tables
    op.execute(
        """
        DELETE FROM asset_categories
        WHERE asset_id IN (SELECT asset_id FROM assets WHERE symbol LIKE '_FEES:%')
        """
    )
    op.execute(
        """
        DELETE FROM asset_price_getters
        WHERE asset_id IN (SELECT asset_id FROM assets WHERE symbol LIKE '_FEES:%')
        """
    )

    # 3. Delete the fake _FEES Asset records (no longer referenced)
    op.execute(
        """
        DELETE FROM assets
        WHERE symbol LIKE '_FEES:%'
        """
    )

    # 4. Remove any raw_assets with _FEES: symbols
    op.execute(
        """
        DELETE FROM raw_assets
        WHERE symbol LIKE '_FEES:%'
        """
    )


def downgrade() -> None:
    # Re-create the _FEES Asset records
    op.execute(
        """
        INSERT INTO assets (symbol, label, price_type, status)
        SELECT DISTINCT
            tags ->> '_legacy_fees_symbol',
            REPLACE(tags ->> '_legacy_fees_symbol', '_FEES:', 'FEES:'),
            'stock',
            0
        FROM normalized_transactions
        WHERE tags ? '_legacy_fees_symbol'
          AND (tags ->> '_legacy_fees_symbol') IS NOT NULL
        ON CONFLICT (symbol) DO NOTHING
        """
    )

    # Restore source_asset_symbol and asset_id from tags
    op.execute(
        """
        UPDATE normalized_transactions nt
        SET source_asset_symbol = nt.tags ->> '_legacy_fees_symbol',
            asset_id = a.asset_id,
            tags = nt.tags - '_legacy_fees_symbol' - '_legacy_fees_asset_id'
        FROM assets a
        WHERE nt.tags ? '_legacy_fees_symbol'
          AND (nt.tags ->> '_legacy_fees_symbol') IS NOT NULL
          AND a.symbol = nt.tags ->> '_legacy_fees_symbol'
        """
    )
