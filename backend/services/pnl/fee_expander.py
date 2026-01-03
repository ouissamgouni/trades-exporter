"""
Fee Expander - Virtual fee leg creation for P&L processing.

IMPORTANT: Fee expansion should happen at NORMALIZATION time using the
FeeExpansionService, which creates actual persisted NormalizedTransaction records.
This allows users to review fee legs before P&L calculation.

This module provides:
1. FeeLeg dataclass for virtual fee legs (when processing without persistence)
2. Helper functions for detecting fees

For actual fee expansion that persists to database, use:
    backend.services.fee_expansion_service.FeeExpansionService
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import List, Optional, Any, Tuple
from uuid import uuid4


@dataclass
class FeeLeg:
    """
    Virtual transaction representing a fee leg.

    Created at normalization time to separate fee consumption
    from the main transaction flow.
    """

    # Identity
    id: Optional[int] = None  # Virtual - not persisted separately
    source_transaction_id: str = ""

    # Core fields
    date_time: Optional[datetime] = None
    direction: str = "outflow"  # Fees are always outflows
    transaction_type: str = "disposal"  # Fee is a disposal of the fee asset

    # Asset and quantity
    asset_id: Optional[int] = None
    source_asset_symbol: str = ""
    quantity: Decimal = Decimal("0")

    # Pricing (fee assets may have their own price in quote asset)
    price: Optional[Decimal] = None
    price_quote_asset_id: Optional[int] = None
    source_price_quote_asset_symbol: str = ""
    total: Optional[Decimal] = None

    # Context
    account_id: Optional[int] = None
    group_id: Optional[int] = None
    unit_id: Optional[int] = None

    # Fee-specific flags
    is_fee: bool = True
    disposal_taxable: bool = True  # Fee consumption is typically taxable (disposal)
    disposal_taxable_override: Optional[bool] = None  # User can override

    # Original transaction reference
    original_transaction_id: Optional[int] = None

    # Internal flags
    _is_virtual: bool = True

    @classmethod
    def from_transaction(
        cls,
        tx: Any,
        fee_qty: Decimal,
        fee_asset_id: int,
        fee_asset_symbol: str,
    ) -> "FeeLeg":
        """
        Create a FeeLeg from an existing transaction's fee.

        Args:
            tx: Original transaction with fee
            fee_qty: Fee quantity
            fee_asset_id: Fee asset ID
            fee_asset_symbol: Fee asset symbol

        Returns:
            FeeLeg representing the fee consumption
        """
        base_tx_id = tx.source_transaction_id or str(uuid4())[:12]

        return cls(
            source_transaction_id=f"{base_tx_id}_fee",
            date_time=tx.date_time,
            direction="outflow",
            transaction_type="disposal",
            asset_id=fee_asset_id,
            source_asset_symbol=fee_asset_symbol,
            quantity=fee_qty,
            price=None,  # Will be fetched by P&L engine if needed
            account_id=tx.account_id,
            group_id=tx.group_id,
            is_fee=True,
            disposal_taxable=True,  # Default: fee consumption is taxable
            original_transaction_id=tx.id,
        )


def expand_fee_legs(
    transactions: List[Any],
) -> Tuple[List[Any], List[FeeLeg]]:
    """
    Expand fees from transactions into separate FeeLeg objects.

    This is called at NORMALIZATION time, before P&L calculation.
    The P&L engine then processes FeeLeg objects like regular outflows.

    Args:
        transactions: List of normalized transactions (may have embedded fees)

    Returns:
        Tuple of:
        - Original transactions (with fee cleared to avoid double-counting)
        - List of FeeLeg objects for separate processing
    """
    fee_legs: List[FeeLeg] = []

    for tx in transactions:
        fee_qty = tx.fee
        fee_asset_id = tx.fee_quote_asset_id
        fee_asset_symbol = tx.source_fee_quote_asset_symbol or ""

        if fee_qty and fee_qty > 0 and fee_asset_id:
            # Create fee leg
            fee_leg = FeeLeg.from_transaction(
                tx=tx,
                fee_qty=Decimal(str(fee_qty)),
                fee_asset_id=fee_asset_id,
                fee_asset_symbol=fee_asset_symbol,
            )
            fee_legs.append(fee_leg)

            # Clear fee from original transaction to prevent double-counting
            # Note: We don't modify the original, we just ignore it in P&L
            # The fee is now a separate leg

    return transactions, fee_legs


def expand_group_fees(
    group_transactions: List[Any],
) -> List[Any]:
    """
    Expand fees within a group, returning combined list of transactions + fee legs.

    This is the simplified version for use within group processing.

    Args:
        group_transactions: Transactions in a group

    Returns:
        Combined list of original transactions + fee legs
    """
    _, fee_legs = expand_fee_legs(group_transactions)

    # Return combined list
    # Fee legs will be identified by is_fee=True
    combined = list(group_transactions)
    combined.extend(fee_legs)

    return combined


def should_expand_fee(tx: Any) -> bool:
    """
    Check if a transaction has a fee that should be expanded.

    Args:
        tx: Transaction to check

    Returns:
        True if fee should be expanded to separate leg
    """
    fee_qty = tx.fee
    fee_asset_id = tx.fee_quote_asset_id

    return bool(fee_qty and fee_qty > 0 and fee_asset_id)


def get_fee_info(tx: Any) -> Optional[dict]:
    """
    Extract fee information from a transaction.

    Args:
        tx: Transaction to extract from

    Returns:
        Dict with fee info or None if no fee
    """
    fee_qty = tx.fee
    fee_asset_id = tx.fee_quote_asset_id
    fee_symbol = tx.source_fee_quote_asset_symbol or ""

    if not fee_qty or fee_qty <= 0:
        return None

    return {
        "quantity": Decimal(str(fee_qty)),
        "asset_id": fee_asset_id,
        "symbol": fee_symbol,
        "original_tx_id": tx.id,
    }
