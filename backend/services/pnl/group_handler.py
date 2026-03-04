"""
Group Handler - Unified function to process transaction groups.

This module implements the core P&L logic:
- Splits are treated as non-taxable swaps (cost basis transfers)
- Transfers are non-taxable with cost basis travel
- Swaps are (configurable) taxable with new cost basis = proceeds

Note: Fee expansion should happen before P&L calculation (in leg_expander),
so users can review fee legs. This module assumes fees are already expanded.
"""

from datetime import datetime
from decimal import Decimal
from typing import Dict, List, Optional, Union
from uuid import uuid4

from backend.config.loader import configure_logging
from backend.services.pnl.config import PnLConfig, WarningType
from backend.services.pnl.models import (
    CalculationUnit,
    PnlWarning,
)
from backend.db.models import CalculationUnitLeg, CostLot, ConsumedLotSlice, RealizedPnl, FeeEntry, LotSettlement, ensure_utc, utc_now, UnitPattern
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.fmv_service import FMVService, compute_group_residual
from backend.services.pnl.taxability import TaxabilityCalculator



log = configure_logging("pnl_group_handler")


def handle_unit(
    unit: CalculationUnit,
    lot_manager: LotManager,
    fmv_service: FMVService,
    config: PnLConfig,
) -> CalculationUnit:
    """
    Process one economic operation (CalculationUnit) in chronological order.

    This is the UNIFIED handler for all transaction types:
    - Buy (EUR → Asset): Not taxable, creates cost lot
    - Sell (Asset → EUR): Taxable, realizes P&L
    - Swap (Asset1 → Asset2): Configurable, cost basis transfers or realizes
    - Transfer (same asset, different accounts): Not taxable, lot travels
    - Split (same asset, qty changes): Not taxable, cost basis preserved
    - Payment (outflow only): Taxable disposal
    - Airdrop (inflow only): Not taxable acquisition
    - Fee: Separate leg (expanded), configurable taxability

    Note: Legs should have `asset_symbol` enriched by the engine before processing.

    Args:
        unit: CalculationUnit to process (provides outflows/inflows/fees properties)
        lot_manager: Manages cost lots
        fmv_service: For FMV lookups (with fallbacks)
        config: P&L configuration

    Returns:
        The CalculationUnit with entities attached to relationships
    """
    # Get unit ID - either from persisted id or None for new units
    unit_id = unit.id

    # Use unit's pre-categorized properties
    fees = unit.fee_legs
    outflows = unit.outflow_legs
    inflows = unit.inflow_legs

    # Example: catch and record any unexpected error in unit processing
    try:

        log.debug(
            "processing_unit",
            unit_label=unit.label,
            unit_id=unit_id,
            legs=len(unit.legs),
            fees=len(fees),
            outflows=len(outflows),
            inflows=len(inflows),
            pattern=unit.pattern,
        )


        disposal_legs = outflows + fees

        # 2. Process disposals (outflows + fees) - consume lots and compute P&L
        consumed_slices, absorbed_fee_cost = _process_disposals(
            disposals=disposal_legs,
            inflows=inflows,
            unit=unit,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
        )

        # 4. Handle inflows based on pattern
        _process_inflows(
            unit=unit,
            consumed_slices=consumed_slices,
            absorbed_fee_cost=absorbed_fee_cost,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
        )

        # 5. Compute residuals (optional)
        _compute_residuals(
            inflows=inflows,
            outflows=outflows,
            fees=fees,
            fmv_service=fmv_service,
            config=config,
            unit=unit,
        )
    except Exception as e:
        # Catch any error, attach as a unit-level error warning
        log.error("unit_processing_exception", error=str(e), unit_id=unit_id)

        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.UNEXPECTED_ERROR.value if hasattr(WarningType, 'UNEXPECTED_ERROR') else 'unexpected_error',
                message=f"Exception during unit processing: {str(e)}",
                unit=unit,
            )
        )

    log.debug(
        "unit_completed",
        unit_id=unit_id,
        lots_created=len(unit.cost_lots) if unit.cost_lots else 0,
        slices_consumed=len([s for lot in (unit.cost_lots or []) for s in (lot.consumed_slices or [])]),
        realized_entries=len(unit.realized_pnl_records) if unit.realized_pnl_records else 0,
        warnings=len(unit.warnings) if unit.warnings else 0,
    )

    return unit


def _process_disposals(
    disposals: List[CalculationUnitLeg],
    inflows: List[CalculationUnitLeg],
    unit: CalculationUnit,
    lot_manager: LotManager,
    fmv_service: FMVService,
    config: PnLConfig,
) -> List[ConsumedLotSlice]:
    """
    Process all disposal transactions - consume lots and compute P&L.
    
    For pending transfers (outflow-only with transfer tx_type):
    - Lots are consumed normally
    - P&L realization is SKIPPED (no RealizedPnl created)
    - Warning is emitted with consumed slice details for user visibility
    
    For cost-basis transfers (transfer/split patterns):
    - Lots are consumed normally
    - P&L realization is SKIPPED (no RealizedPnl created)
    - Cost basis is preserved and transferred to new lots

    Returns:
        Tuple of (consumed_slices, absorbed_fee_cost) where absorbed_fee_cost
        is the total cost basis of non-taxable fee slices on cost-basis transfers
        that should be rolled into the transferred asset's cost basis.
    """
    all_consumed_slices: List[ConsumedLotSlice] = []
    absorbed_fee_cost: Decimal = Decimal(0)
    taxability_calculator = TaxabilityCalculator(config)
    is_unmatched_internal_transfer = unit.pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
    is_cost_basis_transfer = unit.is_cost_basis_transfer

    for disposal in disposals:
        asset_id = disposal.asset_id
        asset_symbol = disposal.asset_symbol
        account_id = disposal.account_id
        qty = Decimal(disposal.quantity) if disposal.quantity else Decimal(0)
        leg_id = disposal.id
        is_fee = disposal.is_fee

        if not asset_id or qty <= 0:
            continue

        # Compute and store taxability on the leg
        disposal.disposal_taxable = taxability_calculator.compute(disposal)

        log.debug(
            "disposal_processing",
            leg_id=leg_id,
            asset_id=asset_id,
            asset_symbol=asset_symbol,
            qty=float(qty),
            account_id=account_id,
            disposal_taxable=disposal.disposal_taxable,
            is_fee=is_fee,
            is_unmatched_internal_transfer=is_unmatched_internal_transfer,
        )

        # Consume lots
        slices, negative_lot = _consume_lots(
            disposal=disposal,
            lot_manager=lot_manager,
            config=config,
            unit=unit,
        )

        if negative_lot:
            if unit.cost_lots is None:
                unit.cost_lots = []
            if negative_lot not in unit.cost_lots:
                unit.cost_lots.append(negative_lot)

        if not slices:
            continue

        # ═══════════════════════════════════════════════════════════════
        # FEE HANDLING - Fees are processed BEFORE pattern checks.
        # On cost-basis transfers, fee treatment depends on config:
        #   - fee_taxable_by_default=False: fee cost is ABSORBED into the
        #     transferred asset's cost basis (no RealizedPnl, no phantom lots).
        #   - fee_taxable_by_default=True: fee creates a separate RealizedPnl
        #     and its slices are excluded from cost basis transfer.
        # On non-transfer units, fees always create RealizedPnl.
        # ═══════════════════════════════════════════════════════════════
        if disposal.is_fee:
            if is_cost_basis_transfer and not config.fee_taxable_by_default:
                # Absorb fee cost into transfer: accumulate cost basis from
                # fee slices, but do NOT add them to all_consumed_slices
                # (they would create phantom lots in _handle_cost_basis_transfer).
                absorbed_fee_cost += sum(s.total_cost_in_base for s in slices)
                log.debug(
                    "fee_absorbed_into_transfer",
                    asset_id=disposal.asset_id,
                    asset_symbol=disposal.asset_symbol,
                    qty=float(qty),
                    absorbed_cost=float(sum(s.total_cost_in_base for s in slices)),
                )
            else:
                # Fee creates a separate RealizedPnl disposal event.
                # Do NOT add fee slices to all_consumed_slices when on a
                # cost-basis transfer — they would create phantom lots.
                if not is_cost_basis_transfer:
                    all_consumed_slices.extend(slices)
                _proceeds_and_pnl_entry(
                    disposal=disposal,
                    slices=slices,
                    inflows=inflows,
                    non_fee_outflows=[d for d in disposals if not d.is_fee],
                    fmv_service=fmv_service,
                    config=config,
                    unit=unit,
                )
            continue  # Skip pattern checks for fees

        # Non-fee legs always contribute to all_consumed_slices
        all_consumed_slices.extend(slices)

        # ═══════════════════════════════════════════════════════════════
        # PATTERN-BASED HANDLING - Only for non-fee disposals
        # ═══════════════════════════════════════════════════════════════
        
        # For unmatched internal transfers: skip P&L realization, emit warning instead
        if slices:
            if is_unmatched_internal_transfer :
                _create_unmatched_internal_transfer_warning(
                    unit=unit,
                    direction="outflow",
                    legs=[disposal],
                    slices=slices,
                )
                continue  # Skip P&L realization
            # For cost-basis transfers (internal_transfer/split): skip P&L realization
            # Cost basis will be preserved and transferred to new lots in _handle_cost_basis_transfer
            if is_cost_basis_transfer :
                continue  # No P&L realization for transfers/splits
            
            # Compute P&L for taxable disposals (not transfers/splits)
            _proceeds_and_pnl_entry(
                disposal=disposal,
                slices=slices,
                inflows=inflows,
                non_fee_outflows=[d for d in disposals if not d.is_fee],
                fmv_service=fmv_service,
                config=config,
                unit=unit,
            )
       

    return all_consumed_slices, absorbed_fee_cost


def _create_unmatched_internal_transfer_warning(
    unit: CalculationUnit,
    direction: str,
    legs: List[CalculationUnitLeg],
    slices: Optional[List[ConsumedLotSlice]] = None,
) -> None:
    """
    Create warning for unmatched internal transfer (outflow or inflow).
    
    Args:
        unit: The calculation unit
        direction: "outflow" or "inflow"
        legs: The legs being processed (outflows or inflows)
        slices: Consumed lot slices (only for outflows)
    """
    if not legs:
        return
        
    leg = legs[0]
    asset_symbol = leg.asset_symbol
    asset_id = leg.asset_id
    account_id = leg.account_id
    timestamp = leg.date_time.isoformat() if leg.date_time else None
    
    # Build details based on direction
    if direction == "outflow" and slices:
        total_qty = sum(s.quantity for s in slices)
        total_cost = sum(s.total_cost_in_base for s in slices)
        
        slice_details = [{
            "slice_id": s.slice_id,
            "cost_lot_id": s.cost_lot_id,
            "quantity": float(s.quantity),
            "cost_in_base": float(s.total_cost_in_base),
            "unit_cost": float(s.total_cost_in_base / s.quantity) if s.quantity else 0,
            "acquired_at": s.cost_lot.acquired_at.isoformat() if s.cost_lot and s.cost_lot.acquired_at else None,
            "holding_period_days": s.holding_period_days,
        } for s in slices]
        
        message = (
            f"Transfer outflow missing inflow - {float(total_qty):.6g} {asset_symbol} "
            f"(cost basis: {float(total_cost):.2f}). "
            f"Link matching deposit to preserve cost basis and holding period."
        )
        details = {
            "transfer_direction": "outflow",
            "asset_id": asset_id,
            "asset_symbol": asset_symbol,
            "account_id": account_id,
            "total_quantity": float(total_qty),
            "total_cost_in_base": float(total_cost),
            "timestamp": timestamp,
            "consumed_slices": slice_details,
        }
        log_extra = {"cost_basis": float(total_cost), "slices_count": len(slices)}
    else:
        total_qty = sum(Decimal(i.quantity) if i.quantity else Decimal(0) for i in legs)
        
        message = (
            f"Transfer inflow missing outflow - {float(total_qty):.6g} {asset_symbol}. "
            f"Provisional lot created with FMV cost basis. Link matching withdrawal to establish actual cost basis."
        )
        details = {
            "transfer_direction": "inflow",
            "asset_id": asset_id,
            "asset_symbol": asset_symbol,
            "account_id": account_id,
            "total_quantity": float(total_qty),
            "timestamp": timestamp,
            "provisional_cost_basis": "fmv_at_acquisition",
            "note": "Provisional lot will be replaced with actual cost basis when transfer is linked and P&L recalculated",
            "inflows": [{
                "transaction_id": i.origin_transaction_id,
                "quantity": float(i.quantity) if i.quantity else 0,
                "account_id": i.account_id,
            } for i in legs],
        }
        log_extra = {"account_id": account_id}
    
    warning = PnlWarning(
        warning_type=WarningType.UNMATCHED_INTERNAL_TRANSFER.value,
        message=message,
        transaction_id=leg.origin_transaction_id,
        asset_id=asset_id,
        unit=unit,
        details=details,
    )
    
    if unit.warnings is None:
        unit.warnings = []
    unit.warnings.append(warning)
    
    log.info(
        "unmatched_internal_transfer_warning_created",
        direction=direction,
        asset_symbol=asset_symbol,
        qty=float(total_qty),
        unit_id=unit.id,
        **log_extra,
    )


def _consume_lots(
    disposal: CalculationUnitLeg,
    lot_manager: LotManager,
    config: PnLConfig,
    unit: CalculationUnit,
) -> tuple[List[ConsumedLotSlice], Optional[CostLot]]:
    """Consume lots for a disposal transaction."""
    asset_id = disposal.asset_id
    asset_symbol = disposal.asset_symbol
    account_id = disposal.transaction.account_id if disposal.transaction else None
    qty = Decimal(disposal.quantity) if disposal.quantity else Decimal(0)
    tx_id = disposal.id
    # Use origin_transaction_id for traceability (links to user-visible transaction)
    origin_tx_id = disposal.origin_transaction_id if hasattr(disposal, 'origin_transaction_id') else tx_id
    unit_id = unit.id
    disposal_dt = ensure_utc(disposal.date_time) if hasattr(disposal, 'date_time') and disposal.date_time else None
    

    try:
        slices, negative_lot = lot_manager.consume_lots(
            account_id=account_id,
            asset_id=asset_id,
            asset_symbol=asset_symbol,
            qty=qty,
            allow_negative=config.allow_negative_balances,
            triggered_by_transaction=disposal.transaction,
            triggered_by_unit=unit
        )
    except ValueError as e:
        if unit.warnings is None:
            unit.warnings = []
        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.INSUFFICIENT_LOTS.value,
                message=f"Insufficient lots for {asset_symbol} (id={asset_id}): {str(e)}",
                transaction_id=origin_tx_id,
                unit=unit,
            )
        )
        return [], None

    # Set consumed_at, consumed_by_transaction_id, and consumed_by_leg_id on all slices
    for slice in slices:
        slice.consumed_at = disposal_dt
        slice.consumed_by_leg_id = disposal.id  # Link to the leg that consumed this slice
        slice.unit_id = unit.id  # Link to the unit that consumed this slice
        slice.unit = unit  # Set relationship for auto-population of unit.consumed_slices
        # Manually add to unit.consumed_slices since relationship might not be bidirectional
        if unit.consumed_slices is None:
            unit.consumed_slices = []
        unit.consumed_slices.append(slice)

    if negative_lot:
        # Set origin traceability on the negative lot
        negative_lot.origin_transaction = disposal.transaction
        # Set unit_id (FK to calculation_units)
        negative_lot.unit_id = unit.id
        
        if unit.warnings is None:
            unit.warnings = []
        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.NEGATIVE_BALANCE.value,
                message=f"Created negative lot for {asset_symbol} (id={asset_id}) (insufficient balance)",
                transaction_id=origin_tx_id,
                unit=unit,
            )
        )

    return slices, negative_lot


def _proceeds_and_pnl_entry(
    disposal: CalculationUnitLeg,
    slices: List[ConsumedLotSlice],
    inflows: List[CalculationUnitLeg],
    non_fee_outflows: List[CalculationUnitLeg],
    fmv_service: FMVService,
    config: PnLConfig,
    unit: CalculationUnit,
) -> None:
    """Create a realized P&L entry for a taxable disposal."""
    entry = None  # Initialize to handle cases where RealizedPnl is not created
    
    asset_id = disposal.asset_id
    asset_symbol = disposal.asset_symbol
    qty = Decimal(disposal.quantity) if disposal.quantity else Decimal(0)
    tx_id = disposal.origin_transaction_id
    origin_tx_id = disposal.origin_transaction_id if hasattr(disposal, 'origin_transaction_id') else tx_id
    disposal_dt = disposal.date_time if disposal.date_time else datetime.utcnow()

    cost_basis = sum(s.total_cost_in_base for s in slices)
    proceeds, price_error, proceeds_metadata = _compute_proceeds(
        disposal=disposal,
        inflows=inflows,
        all_non_fee_outflows=non_fee_outflows,
        fmv_service=fmv_service,
        config=config,
    )
    
    # Track price lookup failures as warnings
    if price_error:
        if unit.warnings is None:
            unit.warnings = []
        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.MISSING_PRICE.value,
                message=f"Price lookup failed for {asset_symbol} (id={asset_id}): {price_error}",
                transaction_id=origin_tx_id,
                asset_id=asset_id,
                unit=unit,
                details={
                    "error": price_error,
                    "proceeds_used": float(proceeds),
                    "transaction_date": disposal_dt.isoformat() if disposal_dt else None,
                },
            )
        )
    
    # Track stale price warnings (fallback used and outside staleness window)
    if proceeds_metadata.get("is_stale"):
        if unit.warnings is None:
            unit.warnings = []
        staleness_days = proceeds_metadata.get("staleness_days", 0)
        actual_price_date = proceeds_metadata.get("actual_price_date")
        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.STALE_PRICE.value,
                message=f"Using stale price for {asset_symbol}: price from {actual_price_date.strftime('%Y-%m-%d') if actual_price_date else 'unknown'} ({staleness_days} days old)",
                transaction_id=origin_tx_id,
                asset_id=asset_id,
                unit=unit,
                details={
                    "staleness_days": staleness_days,
                    "actual_price_date": actual_price_date.isoformat() if actual_price_date else None,
                    "price_used": float(proceeds_metadata.get("price", 0)) if proceeds_metadata.get("price") else None,
                    "price_source": proceeds_metadata.get("price_source"),
                    "transaction_date": disposal_dt.isoformat() if disposal_dt else None,
                },
            )
        )

    
    
    pnl = proceeds - cost_basis

    # Calculate holding period (now uses slice.holding_period_days property)
    min_acquired = min(s.cost_lot.acquired_at for s in slices)
    holding_days = (ensure_utc(disposal_dt) - ensure_utc(min_acquired)).days
    
    # Always create RealizedPnl for all real disposals.
    # The disposal_taxable flag is preserved on each entry for downstream filtering
    # (e.g. total_realized_pnl sums only taxable, total_all_pnl sums everything).
    entry = RealizedPnl(
        # Set both FK IDs and relationship objects (FK IDs needed for runtime access,
        # relationship objects needed for persistence when objects aren't yet persisted)
        asset_id=asset_id,  # FK for runtime access
        asset=disposal.asset,  # Relationship object for persistence
        qty=qty,
        proceeds_in_base=proceeds,
        cost_basis_in_base=cost_basis,
        pnl_in_base=pnl,
        disposal_taxable=disposal.disposal_taxable,
        transaction_id=origin_tx_id,  # FK for runtime access
        transaction=disposal.origin_transaction,  # Relationship object for persistence
        origin_unit=unit,  # FK to calculation_units
        realized_at=disposal_dt,
        holding_period_days=holding_days,
        slices=slices,
        # Store proceeds metadata for transparency
        proceeds_source=proceeds_metadata.get("source"),
        proceeds_price=proceeds_metadata.get("price"),
        proceeds_price_source=proceeds_metadata.get("price_source"),
        proceeds_price_timestamp=proceeds_metadata.get("timestamp"),
    )

    log.info(
        "pnl_realized",
        tx_id=tx_id,
        unit_id=unit.id,
        asset_id=asset_id,
        asset_symbol=asset_symbol,
        qty=float(qty),
        proceeds=float(proceeds),
        cost_basis=float(cost_basis),
        pnl=float(pnl),
        holding_days=holding_days,
        slices_used=len(slices),
        disposal_taxable=disposal.disposal_taxable,
    )

    # Manual append needed - SQLAlchemy back-population doesn't work reliably
    # for transient objects (not yet in a session)
    if unit.realized_pnl_records is None:
        unit.realized_pnl_records = []
    if entry not in unit.realized_pnl_records:
        unit.realized_pnl_records.append(entry)

    # Create FeeEntry index for fee disposals (links to RealizedPnl)
    if disposal.is_fee:
        _create_fee_entry(
            disposal=disposal,
            unit=unit,
            realized_pnl=entry if entry else None,
            base_currency_id=config.base_currency_id,
            fee_value_in_base=proceeds,
        )


def _process_inflows(
    unit: CalculationUnit,
    consumed_slices: List[ConsumedLotSlice],
    absorbed_fee_cost: Decimal,
    lot_manager: LotManager,
    fmv_service: FMVService,
    config: PnLConfig,
) -> None:
    """
    Handle inflows based on the unit pattern.
    
    For unmatched internal transfers (inflow-only with internal_transfer tx_type):
    - Provisional lot IS created using FMV as temporary cost basis
    - Warning is emitted with FMV details for user visibility
    - Provisional lots prevent negative lot errors when assets are later disposed
    - When transfer is linked and P&L recalculated, provisional lots are replaced
      with proper lots using inherited cost basis from the matching outflow
    
    Args:
        unit: The calculation unit being processed
        consumed_slices: All consumed slices from disposals (non-fee outflows only)
        absorbed_fee_cost: Fee cost basis to absorb into transfer lots (0 when not applicable)
        lot_manager: For creating new lots
        fmv_service: For FMV lookups
        config: P&L configuration
    """
    inflows = unit.inflow_legs
    if not inflows:
        return
    
    # Check if this is an unmatched internal transfer (inflow-only)
    is_unmatched_internal_transfer = unit.pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
    
    if is_unmatched_internal_transfer:
        # Create warning for user visibility (was missing for inflows)
        _create_unmatched_internal_transfer_warning(
            unit=unit,
            direction="inflow",
            legs=inflows,
            slices=None,
        )
        
    # Use unified is_cost_basis_transfer for non-taxable transfers
    if unit.is_cost_basis_transfer:
        _handle_cost_basis_transfer(
            inflows=inflows,
            consumed_slices=consumed_slices,
            absorbed_fee_cost=absorbed_fee_cost,
            lot_manager=lot_manager,
            unit=unit,
        )
    else:
        _handle_acquisition(
            inflows=inflows,
            consumed_slices=consumed_slices,
            lot_manager=lot_manager,
            fmv_service=fmv_service,
            config=config,
            unit=unit,
        )


def _compute_residuals(
    inflows: List[CalculationUnitLeg],
    outflows: List[CalculationUnitLeg],
    fees: List[CalculationUnitLeg],
    fmv_service: FMVService,
    config: PnLConfig,
    unit: CalculationUnit,
) -> None:
    """Compute residuals if enabled in config."""
    if not config.compute_residuals:
        return

    residual_info = compute_group_residual(
        inflows=inflows,
        outflows=outflows,
        fees=fees,
        fmv_service=fmv_service,
        config=config,
    )

    if not residual_info:
        return

    unit.residual_pct = residual_info["residual_pct"]

    if residual_info["residual_pct"] > config.residual_tolerance_pct:
        # Create a regular warning with residual details
        unit.warnings.append(
            PnlWarning(
                warning_type=WarningType.RESIDUAL_MISMATCH.value,
                message=(
                    f"Value residual {residual_info['residual_pct']:.2%} "
                    f"exceeds tolerance {config.residual_tolerance_pct:.2%}"
                ),
                unit=unit,
                details={
                    "residual_in_base": float(residual_info["residual"]),
                    "residual_pct": float(residual_info["residual_pct"]),
                    "inflow_total": float(residual_info["inflow_value"]),
                    "outflow_total": float(residual_info["outflow_value"]),
                    "fees_total": float(residual_info["fee_value"]),
                },
            )
        )


def _create_fee_entry(
    disposal: CalculationUnitLeg,
    unit: CalculationUnit,
    realized_pnl: Optional[RealizedPnl],
    base_currency_id: int,
    fee_value_in_base: Decimal,
) -> None:
    """
    Create a FeeEntry index record linking fee leg to its RealizedPnl.
    
    Fee value is stored directly on FeeEntry for efficient queries,
    especially for base currency fees which don't have a RealizedPnl record.
    
    Args:
        disposal: The fee leg being processed
        unit: The calculation unit
        realized_pnl: The RealizedPnl entry for this fee (None for base currency fees)
        base_currency_id: The base currency ID for determining related asset
        fee_value_in_base: The fee value in base currency (proceeds from disposal)
    """
    # Determine related_asset_id: find non-fee, non-base asset from unit legs
    # Priority: outflow (crypto sold) > inflow (crypto received) > largest value
    related_asset_id = _determine_related_asset_for_fee(
        unit=unit,
        base_currency_id=base_currency_id,
        fee_asset_id=disposal.asset_id,
    )
    
    # Use relationship objects instead of IDs - SQLAlchemy will resolve IDs on flush
    # This handles the case where entities haven't been persisted yet
    # Setting fee_leg=disposal auto-populates disposal.fee_entries via back_populates
    fee_entry = FeeEntry(
        fee_leg=disposal,
        realized_pnl=realized_pnl,
        unit=unit,
        version=unit.version,
        related_asset_id=related_asset_id,
        fee_value_in_base=fee_value_in_base,
    )
    
    log.debug(
        "fee_entry_created",
        fee_leg_id=disposal.id,
        realized_pnl_id=realized_pnl.pnl_id if realized_pnl else None,
        asset_id=disposal.asset_id,
        related_asset_id=related_asset_id,
        fee_value_in_base=float(fee_value_in_base),
    )


def _determine_related_asset_for_fee(
    unit: CalculationUnit,
    base_currency_id: int,
    fee_asset_id: int,
) -> Optional[int]:
    """
    Determine the related asset for a fee entry.
    
    Rules:
    - Exclude base currency and the fee asset itself
    - For crypto-to-crypto: prefer outflow (the asset being sold)
    - For simple trades: use the non-base-currency asset
    - For multiple candidates: use the one with largest quantity
    
    Returns:
        Asset ID of the related asset, or None if no suitable asset found
    """
    candidates = []
    
    for leg in unit.legs:
        # Skip base currency and the fee itself
        if leg.asset_id == base_currency_id or leg.asset_id == fee_asset_id:
            continue
        if leg.is_fee:
            continue
            
        candidates.append(leg)
    
    if not candidates:
        return None
    
    # If only one candidate, return it
    if len(candidates) == 1:
        return candidates[0].asset_id
    
    # Multiple candidates - prefer outflows
    # Note: quantities are positive, use leg_type to identify outflows
    outflows = [c for c in candidates if c.leg_type == "outflow"]
    if len(outflows) == 1:
        return outflows[0].asset_id
    
    # Multiple outflows or no outflows - pick largest quantity
    # Fallback since value_in_base is not available at this stage
    target = outflows if outflows else candidates
    largest = max(target, key=lambda c: c.quantity)
    return largest.asset_id


def _compute_proceeds(
    disposal: CalculationUnitLeg,
    inflows: List[CalculationUnitLeg],
    all_non_fee_outflows: List[CalculationUnitLeg],
    fmv_service: FMVService,
    config: PnLConfig,
) -> tuple[Decimal, Optional[str], dict]:
    """
    Compute proceeds for a disposal.

    Returns:
        Tuple of (proceeds_value, error_message or None, proceeds_metadata)
        
    Rules:
    - Fee legs: ALWAYS use FMV (fees don't receive base currency inflows)
    - Sell to base currency: proceeds = pro-rata share of base currency received
    - Swap to another asset: proceeds = FMV of disposed asset
    - Payment (no inflow): proceeds = FMV of disposed asset
    
    Args:
        disposal: The leg being disposed
        inflows: All inflow legs in the unit
        all_outflows: All non-fee outflow legs (for pro-rata calculation)
        fmv_service: For FMV lookups
        config: P&L configuration
    """
    # Fee legs always use FMV - they don't "receive" the base currency inflows
    # The base currency inflow is payment FOR the main transaction, not for fees
    if disposal.is_fee:
        if disposal.asset_id == config.base_currency_id:
            qty = Decimal(disposal.quantity) if disposal.quantity else Decimal(0)
            metadata = {
                "source": "base_currency",
                "price": Decimal("1"),
                "price_source": "direct",
                "timestamp": disposal.date_time,
            }
            return qty, None, metadata
        fmv_result = fmv_service.get_fmv_in_base(disposal, skip_on_error=True)
        error = fmv_result.error if not fmv_result.success else None
        metadata = {
            "source": "fmv_lookup",
            "price": fmv_result.price,
            "price_source": fmv_result.source,
            "timestamp": fmv_result.timestamp,
            "is_stale": fmv_result.is_stale,
            "is_fallback": fmv_result.is_fallback,
            "staleness_days": fmv_result.staleness_days,
            "actual_price_date": fmv_result.actual_price_date,
        }
        return fmv_result.value, error, metadata

    # Check if we receive base currency
    base_inflows = [i for i in inflows if i.asset_id and i.asset_id == config.base_currency_id]

    if base_inflows:
        # Selling to fiat: proceeds = pro-rata share of fiat received
        total_base_received = sum(
            Decimal(i.quantity) if i.quantity else Decimal(0)
            for i in base_inflows
        )
        
        # Pro-rata allocation if multiple outflows share base currency inflows
        # All outflows in a unit are the same asset, so allocate by quantity
        disposal_qty = Decimal(disposal.quantity) if disposal.quantity else Decimal(0)
        total_outflow_qty = sum(
                Decimal(o.quantity) if o.quantity else Decimal(0)
                for o in all_non_fee_outflows
         )
            
        if total_outflow_qty > 0:
            proportion = disposal_qty / total_outflow_qty
            proceeds = total_base_received * proportion

            
        metadata = {
            "source": "base_currency",
            "price": Decimal("1"),
            "price_source": "direct",
            "timestamp": disposal.date_time,
        }
        return proceeds, None, metadata

    # Swap or payment: proceeds = FMV of disposed asset
    fmv_result = fmv_service.get_fmv_in_base(disposal, skip_on_error=True)
    error = fmv_result.error if not fmv_result.success else None
    
    metadata = {
        "source": "fmv_lookup",
        "price": fmv_result.price,
        "price_source": fmv_result.source,  # coingecko, fallback, etc.
        "timestamp": fmv_result.timestamp,
        "is_stale": fmv_result.is_stale,
        "is_fallback": fmv_result.is_fallback,
        "staleness_days": fmv_result.staleness_days,
        "actual_price_date": fmv_result.actual_price_date,
    }
    
    return fmv_result.value, error, metadata


def _handle_cost_basis_transfer(
    inflows: List[CalculationUnitLeg],
    consumed_slices: List[ConsumedLotSlice],
    absorbed_fee_cost: Decimal,
    lot_manager: LotManager,
    unit: CalculationUnit,
) -> None:
    """
    Handle transfer or same-asset swap by preserving individual lot slices.

    For transfers: each consumed slice becomes a new lot (preserves holding period per-lot)
    For same-asset swaps (splits/reverse splits): qty scales proportionally, cost preserved per-slice
    
    When absorbed_fee_cost > 0, the fee's cost basis is distributed proportionally
    across the new lots (by each slice's share of total cost), increasing their
    unit_cost_in_base. This implements the "fee absorbed into transfer cost" approach
    for jurisdictions where crypto fees are non-taxable (e.g., France).
    """
    if not inflows or not consumed_slices:
        return

    total_outflow_qty = sum(s.quantity for s in consumed_slices)
    total_inflow_qty = sum(
        Decimal(i.quantity) if i.quantity else Decimal(0) for i in inflows
    )

    if total_inflow_qty <= 0 or total_outflow_qty <= 0:
        return

    # For same-asset swaps (splits), qty ratio determines scaling
    # For transfers, ratio should be 1.0 (qty unchanged)
    qty_ratio = total_inflow_qty / total_outflow_qty

    # Total cost from transfer slices (used to distribute absorbed_fee_cost proportionally)
    total_transfer_cost = sum(s.total_cost_in_base for s in consumed_slices)

    log.debug(
        "cost_basis_transfer",
        asset_id=inflows[0].asset_id,
        asset_symbol=inflows[0].asset_symbol,
        slices=len(consumed_slices),
        outflow_qty=float(total_outflow_qty),
        inflow_qty=float(total_inflow_qty),
        qty_ratio=float(qty_ratio),
        absorbed_fee_cost=float(absorbed_fee_cost),
    )

    # Get inflow metadata (use first inflow for now - typically there's one)
    inflow = inflows[0]

    # Create one lot per consumed slice (preserves individual holding periods)
    for slice in consumed_slices:
        # Scale qty for splits, preserve cost basis
        new_qty = slice.quantity * qty_ratio
        
        # Base cost from the consumed slice
        slice_cost = slice.total_cost_in_base
        
        # Distribute absorbed fee cost proportionally by each slice's share of total cost
        if absorbed_fee_cost > 0 and total_transfer_cost > 0:
            fee_share = (slice.total_cost_in_base / total_transfer_cost) * absorbed_fee_cost
            slice_cost += fee_share
        
        unit_cost = slice_cost / new_qty if new_qty > 0 else Decimal(0)
        
        # Preserve original holding period from the source lot
        original_acquired_at = None
        if slice.cost_lot and slice.cost_lot.acquired_at:
            original_acquired_at = ensure_utc(slice.cost_lot.acquired_at)
        if not original_acquired_at:
            original_acquired_at = utc_now()

        new_lot = CostLot(
            # FK IDs for runtime access; relationship objects set separately below
            # to avoid triggering dual cascade collections simultaneously in the
            # constructor (CalculationUnit.cost_lots + NormalizedTransaction.cost_lots
            # both track CostLot — setting both relationship objects at once in the
            # constructor caused autoflush orphan-detection misfires).
            asset_id=inflow.asset_id,
            asset=inflow.asset,
            account_id=inflow.account_id,
            account=inflow.account,
            qty=new_qty,
            qty_remaining=new_qty,
            unit_cost_in_base=unit_cost,
            acquired_at=original_acquired_at,  # Preserve original holding period
            origin_transaction_id=inflow.origin_transaction_id,
            origin_transaction=inflow.origin_transaction,
            unit_id=unit.id,  # FK only — relationship set via manual append below
            notes=f"Transfer (from lot {slice.cost_lot_id if hasattr(slice, 'cost_lot_id') and slice.cost_lot_id else 'unknown'})",
        )
        lot_manager.add_lot(
            new_lot,
            triggered_by_transaction=inflow.transaction,
            triggered_by_unit=unit,
            transfer_metadata={"is_transfer": True},
        )
        # Manual append needed when objects aren't persisted yet
        # SQLAlchemy relationship auto-population doesn't work reliably until commit
        # Check if already added via back-populate to avoid duplicates
        if unit.cost_lots is None:
            unit.cost_lots = []
        if new_lot not in unit.cost_lots:
            unit.cost_lots.append(new_lot)

        log.debug(
            "transfer_lot_created",
            tx_id=inflow.origin_transaction_id,
            asset_id=inflow.asset_id,
            asset_symbol=inflow.asset_symbol,
            qty=float(new_qty),
            unit_cost=float(unit_cost),
            acquired_at=str(slice.cost_lot.acquired_at) if slice.cost_lot and slice.cost_lot.acquired_at else None,
            from_lot_id=slice.cost_lot.cost_lot_id if slice.cost_lot else None,
            unit_id=unit.id,
        )


def _handle_acquisition(
    inflows: List[CalculationUnitLeg],
    consumed_slices: List[ConsumedLotSlice],
    lot_manager: LotManager,
    fmv_service: FMVService,
    config: PnLConfig,
    unit: CalculationUnit,
) -> None:
    """
    Handle swap/acquisition by creating new lots.

    Cost basis for new lots:
    - If taxable disposal: new cost = proceeds (FMV at swap time)
    - If non-taxable: new cost = original cost basis (transferred)
    - If pure acquisition (airdrop): new cost = FMV at acquisition
    
    Also handles negative lot settlement:
    - If there are unsettled negative lots for this asset, settle them first
    - Create adjustment P&L entries to correct provisional entries
    """
    # Determine total cost to allocate
    # Bug #2 fix: Exclude fee RealizedPnl entries from total_cost to avoid
    # double-counting fees (they already have their own RealizedPnl disposal event).
    realized_entries = unit.realized_pnl_records or []
    fee_origin_tx_ids = {leg.origin_transaction_id for leg in unit.fee_legs}
    non_fee_entries = [e for e in realized_entries if e.transaction_id not in fee_origin_tx_ids]
    
    # Only use proceeds from taxable disposals for cost basis of new lots.
    # Non-taxable entries (e.g. derivative settlements, non-taxable swaps) should
    # still inherit cost basis from consumed slices.
    taxable_non_fee_entries = [e for e in non_fee_entries if e.disposal_taxable]
    
    if taxable_non_fee_entries:
        # Taxable disposals: new asset cost = proceeds from non-fee disposals only
        total_cost = sum(e.proceeds_in_base for e in taxable_non_fee_entries)
        cost_source = "realized_proceeds"
    elif consumed_slices:
        # Non-taxable disposals: new asset inherits cost basis from all consumed slices
        total_cost = sum(s.total_cost_in_base for s in consumed_slices)
        cost_source = "inherited_cost_basis"
    else:
        # Pure acquisition (airdrop, deposit): cost = FMV
        total_cost = Decimal(0)
        for inflow in inflows:
            fmv_result = fmv_service.get_fmv_in_base(inflow, skip_on_error=True)
            total_cost += fmv_result.value
        cost_source = "fmv_at_acquisition"

    # Bug #3 fix: Use FMV-based allocation when inflows contain different assets.
    # When all inflows are the same asset, quantity-based allocation is used (backward compat).
    inflow_asset_ids = {i.asset_id for i in inflows if i.asset_id}
    multi_asset_inflows = len(inflow_asset_ids) > 1
    
    if multi_asset_inflows:
        # Compute FMV for each inflow to allocate cost proportionally by value
        inflow_fmvs: dict[int, Decimal] = {}
        total_inflow_fmv = Decimal(0)
        for idx, inf in enumerate(inflows):
            fmv_result = fmv_service.get_fmv_in_base(inf, skip_on_error=True)
            inflow_fmvs[idx] = fmv_result.value
            total_inflow_fmv += fmv_result.value
    
    # For single-asset inflows, use quantity-based allocation (original behavior)
    total_inflow_qty = sum(
        Decimal(i.quantity) if i.quantity else Decimal(0)
        for i in inflows
    )

    log.debug(
        "acquisition_processing",
        asset_id=inflows[0].asset_id,
        asset_symbol=inflows[0].asset_symbol,
        inflows=len(inflows),
        total_cost=float(total_cost),
        total_inflow_qty=float(total_inflow_qty),
        cost_source=cost_source,
        realized_entries=len(non_fee_entries),
        multi_asset_inflows=multi_asset_inflows,
    )

    # Create lots (and handle negative lot settlement)
    for idx, inflow in enumerate(inflows):
        inflow_qty = Decimal(inflow.quantity) if inflow.quantity else Decimal(0)
        if inflow_qty <= 0:
            continue

        # Special case: base currency (e.g., EUR) always has unit_cost = 1.0
        if inflow.asset_id == config.base_currency_id:
            unit_cost = Decimal(1)
        else:
            if multi_asset_inflows:
                # Allocate cost proportionally by FMV (handles different asset units correctly)
                if total_inflow_fmv > 0:
                    proportion = inflow_fmvs[idx] / total_inflow_fmv
                    allocated_cost = total_cost * proportion
                else:
                    allocated_cost = Decimal(0)
            else:
                # Single-asset: allocate proportionally by quantity (backward compatible)
                if total_inflow_qty > 0:
                    proportion = inflow_qty / total_inflow_qty
                    allocated_cost = total_cost * proportion
                else:
                    allocated_cost = Decimal(0)

            unit_cost = allocated_cost / inflow_qty if inflow_qty > 0 else Decimal(0)


        inflow_date = ensure_utc(inflow.date_time)

        # Create the settling lot first (with full qty_remaining)
        # It will be updated after settlement to reflect remaining quantity
        # For unmatched internal transfers, mark as provisional with FMV cost basis
        is_unmatched_internal_transfer = unit.pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value
        notes = None
        if is_unmatched_internal_transfer and cost_source == "fmv_at_acquisition":
            notes = "Unmatched internal transfer (provisional FMV cost basis)"
        
        settling_lot = CostLot(
            # Set both FK IDs and relationship objects (FK IDs needed for runtime access,
            # relationship objects needed for persistence when objects aren't yet persisted)
            asset_id=inflow.asset_id,
            asset=inflow.asset,
            account_id=inflow.account_id,
            account=inflow.account,
            qty=inflow_qty,
            qty_remaining=inflow_qty,  # Will be updated after settlement
            unit_cost_in_base=unit_cost,
            acquired_at=inflow_date,
            origin_transaction_id=inflow.origin_transaction_id,
            origin_transaction=inflow.origin_transaction,  # Use relationship object from ExpandedLeg
            unit_id=unit.id,  # FK to calculation_units
            notes=notes,
        )

        # Check for negative lots to settle (pass the settling_lot for relationship)
        remaining_qty, settlement_records = lot_manager.settle_negative_lots(
            account=inflow.account,
            asset=inflow.asset,
            available_qty=inflow_qty,
            unit_cost=unit_cost,
            settling_transaction=inflow.origin_transaction,  # Use object
            settling_lot=settling_lot,  # Pass lot for relationship setting
            triggered_by_unit=unit,  # Required for event audit trail
        )
        
        # Update lot's qty_remaining after settlement
        remaining_qty_normalized = remaining_qty if remaining_qty > Decimal("0.00000001") else Decimal(0)
        settled_qty = inflow_qty - remaining_qty_normalized
        settling_lot.qty_remaining = remaining_qty_normalized
        if settled_qty > 0:
            settling_lot.notes = f"Settled {settled_qty:.4f} against negative lot(s)"
        
        # Add lot to manager and result
        lot_manager.add_lot(
            settling_lot,
            triggered_by_transaction=inflow.transaction,
            triggered_by_unit=unit,
        )
        if unit.cost_lots is None:
            unit.cost_lots = []
        if settling_lot not in unit.cost_lots:
            unit.cost_lots.append(settling_lot)
        
        log.debug(
            "acquisition_lot_created",
            tx_id=inflow.origin_transaction_id,
            asset_id=inflow.asset_id,
            asset_symbol=inflow.asset_symbol,
            qty=float(inflow_qty),
            qty_remaining=float(remaining_qty_normalized),
            unit_cost=float(unit_cost),
            acquired_at=str(inflow_date),
            settled=float(settled_qty),
        )
        
        # Settlement records are automatically available via lot.outgoing_settlements relationship
        # No need to collect them separately - they're owned by the CostLot
        
        # Create adjustment P&L entries for settled negative lots
        # EXCEPT for base currency - there's no real P&L for base currency
        # (1 EUR = 1 EUR always, spending and receiving is not a taxable event)
        is_base_currency = config.base_currency_id and inflow.asset_id == config.base_currency_id
        
        for settlement in settlement_records:
            if is_base_currency:
                # Skip P&L adjustment for base currency - no real gain/loss
                log.debug(
                    "pnl_adjustment_skipped_base_currency",
                    qty=float(settlement.qty_settled),
                    negative_lot_id=settlement.negative_lot_id,
                )
                continue
                
            # Create adjustment entry to correct provisional P&L for non-base currencies
            cost_applied = settlement.cost_basis_applied or Decimal(0)
            adjustment_entry = RealizedPnl(
                # Set both FK IDs and relationship objects (FK IDs needed for runtime access,
                # relationship objects needed for persistence when objects aren't yet persisted)
                asset=inflow.asset,  # Use relationship object
                qty=settlement.qty_settled,
                proceeds_in_base=Decimal(0),  # Adjustment only affects cost
                cost_basis_in_base=cost_applied,
                pnl_in_base=-cost_applied,  # Reduces P&L (cost was 0, now has real cost)
                disposal_taxable=True,  # Non-base currency adjustments are taxable
                transaction=inflow.origin_transaction,  # Use relationship object
                origin_unit=unit,  # FK to calculation_units
                realized_at=inflow_date,
                notes=f"Cost basis settlement for negative lot #{settlement.negative_lot_id}",
            )
            # Manual append - back-population unreliable for transient objects
            if unit.realized_pnl_records is None:
                unit.realized_pnl_records = []
            if adjustment_entry not in unit.realized_pnl_records:
                unit.realized_pnl_records.append(adjustment_entry)
            log.info(
                "pnl_adjustment_created",
                cost_applied=float(cost_applied),
                qty=float(settlement.qty_settled),
                negative_lot_id=settlement.negative_lot_id,
            )

