"""
Leg Expander - Simplified transaction expansion for P&L calculation.

This service expands composite transactions (trades) into atomic legs:
- Buy/Sell trades → outflow leg + inflow leg + optional fee leg
- Neutral with fees → fee leg only
- Regular transactions → pass through with origin_id preserved

Returns a flat list of transaction-like objects, each with origin_transaction_id
for aggregation into CalculationUnits.

ARCHITECTURE NOTE:
ExpandedLeg is used during transaction parsing/expansion phase only.
Once legs are aggregated into CalculationUnits, they are converted to 
CalculationUnitLeg (db.models) which serves as the unified interface for 
both persistence and runtime. CalculationUnitLeg has computed properties 
that provide the same interface as ExpandedLeg by accessing data through 
relationships (transaction, asset, unit).
"""

from dataclasses import dataclass
from typing import List, Optional, Any, Tuple
from decimal import Decimal
from datetime import datetime
import uuid

from backend.config.loader import configure_logging
from backend.db.models import Account, Asset, CalculationUnitLeg, CalculationVersion, LegType, NormalizedTransaction, TransactionType

log = configure_logging("leg_expander")



# =============================================================================
# Detection Functions
# =============================================================================


def should_expand_as_trade(tx: NormalizedTransaction) -> bool:
    """
    Determine if a transaction should be expanded as a trade.
    
    A trade should be expanded if:
    - transaction_type is 'trade'
    - direction is 'inflow' (buy) or 'outflow' (sell)
    - Has base asset with quantity > 0
    - Has different quote asset
    """
    # Check transaction_type instead of source_transaction_type
    tx_type = (tx.transaction_type or "").lower()
    if tx_type != TransactionType.TRADE.value:
        return False
    
    # Ensure valid direction for trade expansion
    direction = (tx.direction or "").lower()
    if direction not in ("inflow", "outflow"):
        return False
    
    quantity = tx.quantity
    if not quantity or quantity <= 0:
        return False
    
    # Check by symbol first (if available)
    base_symbol = tx.source_asset_symbol or ""
    quote_symbol = tx.source_price_quote_asset_symbol or ""
    if base_symbol and quote_symbol and base_symbol.upper() == quote_symbol.upper():
        return False
    
    # Check by ID (for resolved assets)
    asset_id = tx.asset_id
    quote_id = tx.price_quote_asset_id
    if not asset_id or not quote_id:
        return False
    
    # Must be different assets
    if asset_id == quote_id:
        return False
    
    return True


def has_fee(tx: NormalizedTransaction) -> bool:
    """Check if transaction has a non-zero fee with a valid fee asset AND should be included in P&L."""
    fee = tx.fee
    fee_asset_id = tx.fee_quote_asset_id
    include_fee = getattr(tx, 'include_fee', True)  # Default True for backward compatibility
    return bool(fee and fee > 0 and fee_asset_id and include_fee)


def is_neutral_transaction(tx: NormalizedTransaction) -> bool:
    """
    Check if transaction is neutral (no value movement, just fee).
    Examples: Token approval, failed transaction, contract interaction.
    """
    # Check transaction_type for technical transactions
    tx_type = (tx.transaction_type or "").lower()
    is_technical = tx_type == "technical"
    
    quantity = tx.quantity or 0
    is_zero_quantity = float(quantity) == 0
    
    return is_technical or (is_zero_quantity and has_fee(tx))


# =============================================================================
# Leg Creation Functions
# =============================================================================


def _convert_to_leg(tx: NormalizedTransaction) -> CalculationUnitLeg:
    """
    Convert any NormalizedTransaction to an CalculationUnitLeg.
    
    This ensures all transactions in unit.legs are CalculationUnitLeg objects,
    guaranteeing origin_transaction_id is always available for tracking.
    """
    direction = (tx.direction or "").lower()
    quantity = Decimal(str(tx.quantity)) if tx.quantity else Decimal("0")
    
    # Determine leg type from direction
    leg_type = LegType.INFLOW if direction == "inflow" else LegType.OUTFLOW
    
    # Use relationships if available, otherwise create from IDs
    asset_rel = tx.asset
    if asset_rel is None and tx.asset_id:
        asset_rel = Asset(
            asset_id=tx.asset_id,
            symbol=tx.source_asset_symbol or f"#{tx.asset_id}",
        )
    
    # Create leg with only database fields and relationships
    return CalculationUnitLeg(
        unit_id=tx.user_calculation_unit_id,  # FK to calculation_unit (will be set by parent)
        transaction_id=tx.id,
        asset_id=tx.asset_id,
        leg_type=leg_type,
        quantity=quantity,
        transaction=tx,  # Set relationship for property access
        asset=asset_rel,  # Set relationship for property access
    )


def _create_fee_leg(tx: NormalizedTransaction) -> CalculationUnitLeg:
    """Create a fee leg from a transaction's fee information."""
    # Use fee_quote_asset relationship if available, otherwise create from ID
    fee_asset = tx.fee_quote_asset
    if fee_asset is None and tx.fee_quote_asset_id:
        fee_asset = Asset(
            asset_id=tx.fee_quote_asset_id,
            symbol=tx.source_fee_quote_asset_symbol or f"#{tx.fee_quote_asset_id}",
        )
    
    # Create fee leg with only database fields and relationships
    return CalculationUnitLeg(
        unit_id=tx.user_calculation_unit_id,  # FK to calculation_unit (will be set by parent)
        transaction_id=tx.id,
        asset_id=tx.fee_quote_asset_id,
        leg_type=LegType.FEE,
        quantity=Decimal(str(tx.fee)),
        transaction=tx,  # Set relationship for property access
        asset=fee_asset,  # Set relationship for property access
    )


def _expand_trade(tx: NormalizedTransaction) -> List[CalculationUnitLeg]:
    """Expand a buy/sell trade into outflow, inflow, and optional fee legs."""
    legs = []
    
    quantity = Decimal(str(tx.quantity))
    total = tx.total  # Computed property: price * quantity
    
    direction = (tx.direction or "").lower()

    
    # Use relationships if available, otherwise create from IDs/symbols
    base_rel = tx.asset
    if base_rel is None and tx.asset_id:
        base_rel = Asset(
            asset_id=tx.asset_id,
            symbol=tx.source_asset_symbol or f"#{tx.asset_id}",
        )
    
    quote_rel = tx.price_quote_asset
    if quote_rel is None and tx.price_quote_asset_id:
        quote_rel = Asset(
            asset_id=tx.price_quote_asset_id,
            symbol=tx.source_price_quote_asset_symbol or f"#{tx.price_quote_asset_id}",
        )
    
    if direction == "inflow":
        # BUY: outflow quote asset, inflow base asset
        legs.append(CalculationUnitLeg(
            unit_id=tx.user_calculation_unit_id,
            transaction_id=tx.id,
            asset_id=tx.price_quote_asset_id,
            leg_type=LegType.OUTFLOW,
            quantity=total or Decimal("0"),
            transaction=tx,
            asset=quote_rel,
        ))
        legs.append(CalculationUnitLeg(
            unit_id=tx.user_calculation_unit_id,
            transaction_id=tx.id,
            asset_id=tx.asset_id,
            leg_type=LegType.INFLOW,
            quantity=quantity,
            transaction=tx,
            asset=base_rel,
        ))
    else:
        # SELL: outflow base asset, inflow quote asset
        legs.append(CalculationUnitLeg(
            unit_id=tx.user_calculation_unit_id,
            transaction_id=tx.id,
            asset_id=tx.asset_id,
            leg_type=LegType.OUTFLOW,
            quantity=quantity,
            transaction=tx,
            asset=base_rel,
        ))
        legs.append(CalculationUnitLeg(
            unit_id=tx.user_calculation_unit_id,
            transaction_id=tx.id,
            asset_id=tx.price_quote_asset_id,
            leg_type=LegType.INFLOW,
            quantity=total or Decimal("0"),
            transaction=tx,
            asset=quote_rel,
        ))
    
    # Add fee leg if present
    if has_fee(tx):
        legs.append(_create_fee_leg(tx))
    
    log.debug(
        f"Expanded trade {tx.id}: {len(legs)} legs "
        f"({tx.transaction_type}/{tx.direction} {quantity} "
        f"{tx.source_asset_symbol or 'unknown'})"
    )
    
    return legs


# =============================================================================
# Main Expansion Functions
# =============================================================================


@dataclass
class ExpansionResult:
    """
    Result of expanding a transaction into legs.
    Backward-compatible wrapper around list of legs.
    """
    outflow: Optional[CalculationUnitLeg]
    inflow: Optional[CalculationUnitLeg]
    fee_leg: Optional[CalculationUnitLeg]
    label: str
    expansion_type: str  # "trade", "fee_only", "none"


def expand_transaction(tx: NormalizedTransaction) -> Optional[ExpansionResult]:
    """
    Expand a single transaction into its component legs.
    
    Returns ExpansionResult with outflow, inflow, and fee_leg if expanded,
    or None if no expansion needed.
    """
    # Case 1: Trade (buy/sell) - expand to outflow + inflow + optional fee
    if should_expand_as_trade(tx):
        legs = _expand_trade(tx)
        outflow = next((leg for leg in legs if leg.direction == "outflow" and not leg.is_fee), None)
        inflow = next((leg for leg in legs if leg.direction == "inflow"), None)
        fee_leg = next((leg for leg in legs if leg.is_fee), None)
        
        tx_type = tx.source_transaction_type or "trade"
        symbol = tx.source_asset_symbol or ""
        return ExpansionResult(
            outflow=outflow,
            inflow=inflow,
            fee_leg=fee_leg,
            label=f"{tx_type} {symbol}",
            expansion_type="trade",
        )
    
    # Case 2: Neutral transaction with fee (approval, failed, etc.)
    if is_neutral_transaction(tx) and has_fee(tx):
        fee_leg = _create_fee_leg(tx)
        tx_type = tx.source_transaction_type or "fee"
        return ExpansionResult(
            outflow=None,
            inflow=None,
            fee_leg=fee_leg,
            label=f"{tx_type} fee",
            expansion_type="fee_only",
        )
    
    # No expansion needed
    return None


def expand_transaction_to_list(tx: NormalizedTransaction) -> List[CalculationUnitLeg]:
    """
    Expand a single transaction into a list of CalculationUnitLeg objects.
    
    IMPORTANT: Always returns at least one CalculationUnitLeg to ensure all transactions
    are converted, guaranteeing origin_transaction_id is always available.
    """
    # Case 1: Trade (buy/sell) - expand to outflow + inflow + optional fee
    if should_expand_as_trade(tx):
        return _expand_trade(tx)
    
    # Case 2: Neutral transaction with fee only (approval, failed, etc.)
    if is_neutral_transaction(tx) and has_fee(tx):
        return [_create_fee_leg(tx)]
    
    # Case 3: Regular transaction - convert to CalculationUnitLeg, add fee leg if present
    legs: List[CalculationUnitLeg] = [_convert_to_leg(tx)]
    
    if has_fee(tx):
        legs.append(_create_fee_leg(tx))
    
    return legs


def expand_transactions(transactions: List[Any]) -> List[CalculationUnitLeg]:
    """
    Expand all transactions into CalculationUnitLeg objects.
    
    ALL transactions are converted to CalculationUnitLeg objects to ensure:
    - Consistent interface for P&L engine
    - origin_transaction_id is always available for tracking
    - No mixed types in unit.legs
    """
    result: List[CalculationUnitLeg] = []
    
    for tx in transactions:
        expanded = expand_transaction_to_list(tx)
        result.extend(expanded)
    
    log.info(
        f"Expanded {len(transactions)} transactions into {len(result)} CalculationUnitLeg objects"
    )
    
    return result



