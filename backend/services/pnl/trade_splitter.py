"""
Trade Splitter Service: Prepares transactions for P&L calculation.

Delegates to leg_expander for actual expansion logic, then aggregates
results into CalculationUnits.

Usage in P&L Engine:
    from backend.services.pnl.trade_splitter import prepare_transactions_for_pnl

    # Returns (pass_through_legs, calculation_units)
    pass_through, units = prepare_transactions_for_pnl(transactions)
"""

from typing import List, Optional, Tuple

from backend.config.loader import configure_logging
from backend.db.models import CalculationUnitLeg, NormalizedTransaction, CalculationUnit
from backend.services.pnl.leg_expander import _convert_to_leg, expand_transaction

log = configure_logging("trade_splitter")


def prepare_transactions_for_pnl(
    transactions: List[NormalizedTransaction],
    base_currency_id: Optional[int] = None,
) -> Tuple[List[CalculationUnitLeg], List[CalculationUnit]]:
    """
    Prepare transactions for P&L calculation by expanding composite trades.

    Called by P&L engine before processing. Expands buy/sell trades into
    atomic legs (including fee legs) and creates CalculationUnit containers.

    Args:
        transactions: List of normalized transactions
        base_currency_id: Unused, kept for backward compatibility

    Returns:
        Tuple of:
        - List of ExpandedLeg objects (pass-through, converted for consistency)
        - List of CalculationUnit objects with .legs list
    """
    pass_through: List[CalculationUnitLeg] = []
    paired_units: List[CalculationUnit] = []

    for tx in transactions:
        # Use expand_transaction which handles trades AND fee-only transactions
        expansion_result = expand_transaction(tx)

        if expansion_result:
            # Build members list from expansion result
            members = []
            if expansion_result.outflow:
                members.append(expansion_result.outflow)
            if expansion_result.inflow:
                members.append(expansion_result.inflow)
            if expansion_result.fee_leg:
                members.append(expansion_result.fee_leg)
            
            # Create CalculationUnit for the expanded transaction
            # Set unit_origin to tx:{id} format for single transactions
            unit = CalculationUnit(
                unit_origin=f"tx:{tx.id}",
                _label=expansion_result.label,
                bundle_id=getattr(tx, "unit_id", None),
            )
            unit.legs = members
            paired_units.append(unit)
        else:
            # Convert to CalculationUnitLeg to ensure origin_transaction_id is available
            pass_through.append(_convert_to_leg(tx))

    log.info(
        f"Prepared {len(transactions)} transactions for P&L: "
        f"{len(pass_through)} pass-through, {len(paired_units)} paired units"
    )

    return pass_through, paired_units
