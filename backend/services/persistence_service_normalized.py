"""
DEPRECATED: This module is no longer used in the current architecture.

Transaction persistence is now handled by the pipeline stages in:
backend/services/pipeline/stages/persistence.py

This file is kept for reference purposes only and documents the fields
that should be compared for transaction updates.
"""

# Fields to compare for updates (excluding metadata fields that shouldn't trigger updates)
# Note: *_in_base fields removed - base currency is a P&L runtime config, not normalization-time
# This list is used by: backend/services/pipeline/stages/persistence.py
COMPARABLE_FIELDS = [
    # Source metadata
    "source_transaction_type",
    "source_asset_symbol",
    "source_price_quote_asset_symbol",
    "source_fee_quote_asset_symbol",
    
    # Asset resolution
    "asset_id",
    "price_quote_asset_id",
    "fee_quote_asset_id",
    
    # Core transaction data
    "date_time",
    "direction",
    "transaction_type",
    "quantity",
    "price",
    "fee",
    
    # Account ownership and transfer fields
    "source_account",         # Raw account ownership identifier
    "source_from_account",    # Raw source account for transfers
    "source_to_account",      # Raw destination account for transfers
    "from_account_id",        # Resolved source account FK
    "to_account_id",          # Resolved destination account FK
    
    # Blockchain fields
    "network",
    "network_transaction_id",
    "token_contract_address",
    
    # NOTE: include_fee, taxability_status, and review_status are intentionally
    # excluded — these are user-editable settings that should NOT be overwritten
    # by a connector resync. They are only set on initial insert.
]


# ============================================================================
# DEPRECATED CODE BELOW - Kept for reference only
# ============================================================================


class _DeprecatedPersistenceServiceNormalizedTrx:
    """
    DEPRECATED: This class is no longer used.
    
    Transaction persistence is now handled by the pipeline system.
    See: backend/services/pipeline/stages/persistence.py
    
    This code is kept for reference only.
    """
    pass
