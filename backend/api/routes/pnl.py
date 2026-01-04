"""
P&L (Profit & Loss) API endpoints.

Provides endpoints for:
- Running P&L calculations (preview mode)
- Querying calculation versions
- Viewing cost lots, realized P&L, unrealized P&L
- Getting P&L summaries
"""

from collections import defaultdict
from decimal import Decimal
from typing import Optional, List, Dict, Any
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func
from sqlalchemy.orm import selectinload

from backend.db.database import get_session_dependency
from backend.db.models import (
    Asset, NormalizedTransaction, CalculationUnit,
    CalculationVersion, CostLot, RealizedPnl, PnlWarning, LotSettlement, ConsumedLotSlice, CostLotEvent, FeeEntry, CalculationUnitLeg
)
from backend.services.pnl.engine import PnLEngine
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.models import PnLResult
from backend.services.price_service import PriceService
from backend.config.loader import configure_logging

log = configure_logging("pnl_api")

router = APIRouter(prefix="/pnl", tags=["Profit & Loss"])


# =============================================================================
# Request/Response Models
# =============================================================================


class AssetRef(BaseModel):
    """Asset reference with id and name for display."""
    id: int
    name: str


class PnLCalculateRequest(BaseModel):
    """Request to run P&L calculation."""

    lot_method: str = Field(default="FIFO", description="Cost method: FIFO, LIFO, HIFO")
    lot_mode: str = Field(
        default="LOT_TRAVEL", description="Lot mode: LOT_TRAVEL, MEGA_WALLET"
    )
    # Accept either ID or symbol for base currency
    base_currency_id: Optional[int] = Field(
        default=None, description="Base currency asset ID"
    )
    base_currency_symbol: Optional[str] = Field(
        default=None, description="Base currency symbol (e.g., 'EUR', 'USD')"
    )
    residual_tolerance_pct: float = Field(
        default=0.05, description="Residual tolerance percentage"
    )
    allow_negative_balances: bool = Field(
        default=False, description="Allow negative balances"
    )
    # Account filtering - if provided, only include transactions from these accounts
    # Cross-account transfers are included if ANY leg belongs to a selected account
    account_ids: Optional[List[int]] = Field(
        default=None, description="Filter by account IDs. None means all accounts."
    )


class RealizedPnLResponse(BaseModel):
    """Realized P&L entry response."""

    asset: AssetRef
    qty: float
    proceeds_in_base: float
    cost_basis_in_base: float
    pnl_in_base: float
    taxable: bool
    transaction_id: Optional[int] = None
    unit_id: Optional[int] = None
    realized_at: datetime
    holding_period_days: Optional[int] = None
    # Proceeds tracking - how FMV was determined
    proceeds_source: Optional[str] = None
    proceeds_price: Optional[float] = None
    proceeds_price_source: Optional[str] = None
    proceeds_price_timestamp: Optional[datetime] = None


class FeeEntryResponse(BaseModel):
    """Fee entry response for detailed fee view."""
    
    id: int
    date: datetime
    asset_id: int
    asset_symbol: str
    fee_amount: float  # quantity
    fee_in_base: float  # proceeds_in_base (FMV)
    
    # Source/traceability
    transaction_id: Optional[int] = None
    unit_id: int
    source: Optional[str] = None  # connector/source name
    transaction_type: Optional[str] = None
    
    # Cost basis impact
    cost_basis_consumed: float
    realized_pnl: float
    
    # Related asset - the primary asset this fee relates to (non-base-currency side of trade)
    # Used for linking fee P&L to asset-level P&L summary
    related_asset_id: Optional[int] = None
    related_asset_symbol: Optional[str] = None


class FeeSummaryResponse(BaseModel):
    """Summary of fees for a version."""
    
    total_fees_in_base: float
    fees_by_asset: Dict[str, float]  # asset_symbol -> total_fees
    fees_by_source: Dict[str, float]  # source -> total_fees
    disposal_taxable_fee_count: int


class CostLotResponse(BaseModel):
    """Cost lot response for detailed view."""

    cost_lot_id: int
    asset: AssetRef
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    qty_original: float
    qty_remaining: float
    qty_consumed: float
    unit_cost_in_base: float
    total_cost_in_base: float
    remaining_cost_in_base: float
    acquired_at: datetime
    origin_transaction_id: Optional[int] = None  # Transaction that created this lot
    origin_unit_id: Optional[int] = None  # CalculationUnit that created this lot
    origin_unit_label: Optional[str] = None  # Human-readable label of origin unit
    is_zero_cost: bool = False
    is_negative: bool = False  # True if this is a negative lot (debt)
    is_fully_settled: bool = False  # True if negative lot is fully settled
    notes: Optional[str] = None  # Additional info (e.g., settlement details)
    
    # Settlement tracking for negative lots
    total_settled: Optional[float] = None  # Amount already settled
    settlement_count: int = 0  # Number of settlements


class WarningResponse(BaseModel):
    """Warning response."""

    warning_type: str
    message: str  # Self-sufficient message with all context (including asset names)
    timestamp: Optional[datetime] = None  # When the warning occurred
    transaction_id: Optional[int] = None
    unit_id: Optional[int] = None
    unit_label: Optional[str] = None  # Human-readable unit label for display


class SettlementResponse(BaseModel):
    """Settlement record for audit trail.
    
    Shows how negative lots (debts) were settled by inflows.
    Example: BUY BTC created EUR debt → SELL AAPL provided EUR to settle.
    """
    
    settlement_id: int
    negative_lot_id: int  # The debt being settled
    settling_lot_id: int  # The lot providing funds
    settling_transaction_id: Optional[int] = None  # Which transaction triggered this
    qty_settled: float  # How much was settled
    cost_basis_applied: Optional[float] = None  # For non-base: cost applied
    settled_at: datetime
    
    # Enriched fields for UI
    negative_lot_origin_tx_id: Optional[int] = None  # Transaction that created the debt
    settling_tx_label: Optional[str] = None  # Human-readable label


class CostLotEventResponse(BaseModel):
    """Cost lot event for audit trail."""
    
    event_id: int
    event_type: str  # created, consumed, settled, transferred, adjusted
    
    lot_id: int
    asset: Optional[AssetRef] = None
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    
    quantity_delta: float
    cost_basis_delta: Optional[float] = None
    qty_remaining_after: float
    cost_basis_remaining_after: Optional[float] = None
    
    related_lot_id: Optional[int] = None
    triggered_by_transaction_id: Optional[int] = None
    triggered_by_unit_id: Optional[int] = None
    triggered_by_unit_label: Optional[str] = None
    
    timestamp: datetime
    event_metadata: Optional[dict] = None


class ConsumedSliceResponse(BaseModel):
    """Details of a consumed lot slice for audit."""
    
    cost_lot_id: int
    asset: Optional[AssetRef] = None  # Asset of the consumed lot
    quantity: float
    unit_cost_in_base: float
    total_cost_in_base: float
    acquired_at: datetime
    holding_period_days: Optional[int] = None
    consumed_by_transaction_id: Optional[int] = None  # Transaction that consumed this slice
    consumed_by_unit_label: Optional[str] = None  # Human-readable label of consuming unit
    consumed_at: Optional[datetime] = None  # When the slice was consumed


class RealizedEntryDetailResponse(BaseModel):
    """Realized P&L entry detail for unit audit."""
    
    asset: AssetRef
    qty: float
    proceeds_in_base: float
    cost_basis_in_base: float
    pnl_in_base: float
    disposal_taxable: bool
    is_fee: bool = False  # True if this entry is from a fee disposal


class OriginTransactionDetail(BaseModel):
    """Origin transaction details for unit expanded view."""
    
    transaction_id: int
    date_time: Optional[datetime] = None
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    source: Optional[str] = None
    source_transaction_type: Optional[str] = None
    direction: Optional[str] = None
    
    # Base asset
    asset: Optional[AssetRef] = None
    quantity: Optional[float] = None
    
    # Pricing
    price: Optional[float] = None
    price_quote_asset: Optional[AssetRef] = None
    total: Optional[float] = None
    
    # Fee
    fee: Optional[float] = None
    fee_quote_asset: Optional[AssetRef] = None


class TransactionLegDetail(BaseModel):
    """Transaction leg with origin transaction reference."""
    
    transaction_id: int
    asset: AssetRef
    qty: float
    direction: str  # "outflow", "inflow", "fee"


class CostBasisTracking(BaseModel):
    """Grouping of cost basis related data."""
    
    lots: List[CostLotResponse] = []
    consumed: List[ConsumedSliceResponse] = []
    settlements: List[SettlementResponse] = []


class ProcessedUnitResponse(BaseModel):
    """Complete processed calculation unit with nested data.
    
    Returns full nested data in single request - no need for separate drill-down calls.
    """
    
    # Identity
    unit_id: Optional[int] = None
    unit_label: str = ""
    pattern: Optional[str] = None  # transfer, swap, split, unknown
    
    # Timestamp
    timestamp: datetime
    
    # Transaction legs (instead of transaction_ids and asset arrays)
    outflows: List[TransactionLegDetail] = []
    inflows: List[TransactionLegDetail] = []
    fees: List[TransactionLegDetail] = []
    
    # Cost basis tracking (grouped lots, consumed slices, settlements)
    cost_basis: CostBasisTracking
    
    # Realized P&L entries
    realized_entries: List[RealizedEntryDetailResponse] = []
    
    # Warnings
    warnings: List[WarningResponse] = []
    
    # Event IDs for counting (avoids loading full lot events)
    event_ids: List[int] = []
    
    # P&L summary
    realized_pnl_in_base: float = 0.0
    is_disposal_taxable: bool = False  # True if any leg has disposal_taxable=True
    
    # Fee indicator
    has_fees: bool = False  # True if unit has fee legs
    fee_count: int = 0  # Number of fee entries in this unit
    total_fees_in_base: float = 0.0  # Total fee value in base currency


class BalanceResponse(BaseModel):
    """Aggregated balance per asset (or asset+account)."""
    
    asset: AssetRef
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    account_ids: List[int] = []  # All account IDs holding this asset (for filtering)
    qty: float  # Consistent with other responses
    cost_basis_in_base: float
    avg_unit_cost_in_base: float  # Consistent naming
    lot_count: int
    # Aggregated P&L data (populated when group_by_asset=true)
    realized_pnl_in_base: float = 0.0
    realized_event_count: int = 0
    warning_count: int = 0
    # Fee tracking (populated when group_by_asset=true)
    total_fees_in_base: float = 0.0  # Total fees at FMV (proceeds from fee disposals)
    # Unsettled negative lot tracking (for filter indicator)
    unsettled_negative_count: int = 0  # Number of unsettled negative lots excluded/included


class PriceResponse(BaseModel):
    """Current price for an asset."""
    
    asset: AssetRef
    price: Optional[float] = None  # None if price unavailable
    price_quote: str  # e.g., "EUR"
    fetched_at: Optional[datetime] = None
    source: Optional[str] = None
    error: Optional[str] = None  # Error message if price fetch failed


# =============================================================================
# Helper Functions for Response Building (DRY)
# =============================================================================


def build_asset_ref(asset, asset_id: int) -> AssetRef:
    """Build AssetRef from asset object or ID."""
    if asset:
        return AssetRef(id=asset.asset_id, name=asset.symbol)
    return AssetRef(id=asset_id, name=f"#{asset_id}")


def build_cost_lot_response(lot: CostLot) -> CostLotResponse:
    """Build CostLotResponse from CostLot model."""
    return CostLotResponse(
        cost_lot_id=lot.cost_lot_id,
        asset=build_asset_ref(lot.asset, lot.asset_id),
        account_id=lot.account_id,
        account_name=lot.account.name if lot.account else None,
        qty_original=float(lot.qty),
        qty_remaining=float(lot.qty_remaining),
        qty_consumed=float(lot.qty - lot.qty_remaining),
        unit_cost_in_base=float(lot.unit_cost),
        total_cost_in_base=float(lot.total_cost),
        remaining_cost_in_base=float(lot.remaining_cost_in_base),
        acquired_at=lot.acquired_at,
        origin_transaction_id=lot.origin_transaction_id,
        origin_unit_id=lot.unit_id,
        origin_unit_label=lot.unit.unit_label if lot.unit else None,
        is_zero_cost=lot.is_zero_cost,
        is_negative=lot.is_negative,
        notes=lot.notes,
    )


def build_consumed_slice_response(
    slice: ConsumedLotSlice, 
    consumed_by_tx_id: Optional[int] = None,
    consumed_by_unit_label: Optional[str] = None,
    consumed_at: Optional[datetime] = None
) -> ConsumedSliceResponse:
    """Build ConsumedSliceResponse from ConsumedLotSlice model."""
    asset_ref = None
    if slice.cost_lot and slice.cost_lot.asset:
        asset_ref = build_asset_ref(slice.cost_lot.asset, slice.cost_lot.asset_id)
    elif slice.cost_lot:
        asset_ref = AssetRef(id=slice.cost_lot.asset_id, name=f"#{slice.cost_lot.asset_id}")
    
    return ConsumedSliceResponse(
        cost_lot_id=slice.cost_lot.cost_lot_id if slice.cost_lot else 0,
        asset=asset_ref,
        quantity=float(slice.quantity),
        unit_cost_in_base=float(slice.unit_cost_in_base),
        total_cost_in_base=float(slice.total_cost_in_base),
        acquired_at=slice.cost_lot.acquired_at if slice.cost_lot else slice.created_at,
        holding_period_days=slice.holding_period_days,
        consumed_by_transaction_id=consumed_by_tx_id,
        consumed_by_unit_label=consumed_by_unit_label,
        consumed_at=consumed_at,
    )


def build_realized_entry_response(entry: RealizedPnl, is_fee: bool = False) -> RealizedEntryDetailResponse:
    """Build RealizedEntryDetailResponse from RealizedPnl model."""
    return RealizedEntryDetailResponse(
        asset=build_asset_ref(entry.asset, entry.asset_id),
        qty=float(entry.qty),
        proceeds_in_base=float(entry.proceeds_in_base),
        cost_basis_in_base=float(entry.cost_basis_in_base),
        pnl_in_base=float(entry.pnl_in_base),
        disposal_taxable=entry.disposal_taxable,
        is_fee=is_fee,
    )


def build_warning_response(warning: PnlWarning, unit_label: Optional[str] = None) -> WarningResponse:
    """Build WarningResponse from PnlWarning model."""
    return WarningResponse(
        warning_type=warning.warning_type,
        message=warning.message,
        timestamp=warning.created_at,
        transaction_id=warning.transaction_id,
        unit_id=warning.unit_id,
        unit_label=unit_label,
    )


def build_settlement_response(settlement: LotSettlement) -> SettlementResponse:
    """Build SettlementResponse from LotSettlement model."""
    return SettlementResponse(
        settlement_id=settlement.settlement_id,
        negative_lot_id=settlement.negative_lot_id,
        settling_lot_id=settlement.settling_lot_id,
        settling_transaction_id=settlement.settling_transaction_id,
        qty_settled=float(settlement.qty_settled),
        cost_basis_applied=float(settlement.cost_basis_applied) if settlement.cost_basis_applied else None,
        settled_at=settlement.settled_at,
    )


class PricesResponse(BaseModel):
    """Response for bulk price lookup."""
    
    prices: List[PriceResponse]
    base_currency: str
    fetched_at: datetime
    successful_count: int
    failed_count: int
    warning: Optional[str] = None  # Set if any price fetch failed


# =============================================================================
# Endpoints
# =============================================================================


@router.get("/status")
def pnl_status():
    """Check P&L API status."""
    return {
        "status": "ready",
        "message": "P&L engine is available",
        "supported_methods": ["FIFO", "LIFO", "HIFO"],
        "supported_modes": ["LOT_TRAVEL", "MEGA_WALLET"],
    }


# =============================================================================
# Option D: Calculate and Persist
# =============================================================================
# This is the new preferred endpoint for P&L calculation.
# It calculates and immediately persists as draft, returning version_id.
# Clients then fetch data via /versions/{id}/* endpoints.


class BalanceItem(BaseModel):
    """Balance item for initial Asset P&L view."""
    asset: Dict[str, Any]  # {id, name}
    qty: float
    cost_basis_in_base: float
    avg_unit_cost_in_base: float
    lot_count: Optional[int] = None


class PnLVersionResponse(BaseModel):
    """
    Unified response for P&L calculation versions.
    
    Used by:
    - POST /calculate (fresh calculation)
    - GET /versions (list)
    - GET /versions/{id} (detail)
    
    ID arrays are populated for /calculate, empty/null for version retrieval.
    Balances are populated for /calculate and /versions/{id}, empty for list.
    """
    
    # Identity
    version_id: int
    description: Optional[str] = None
    created_at: Optional[datetime] = None  # None for fresh calculation
    expires_at: Optional[datetime] = None
    status: str  # 'draft', 'committed', 'active'
    
    # Config
    lot_method: str
    lot_mode: str
    base_currency_id: Optional[int] = None
    base_currency_symbol: Optional[str] = None
    allow_negative_balances: bool = False
    residual_tolerance_pct: float = 0.05
    
    # Account filter - which accounts were included in this calculation
    # None means all accounts were included
    account_ids: Optional[List[int]] = None
    
    # Summary
    total_realized_pnl: float
    
    # Fee summary (populated for /calculate, for immediate summary card display)
    total_fees_in_base: float = 0.0  # Total fee expense at FMV
    fee_entry_count: int = 0  # Number of fee entries
    
    # ID arrays for tab title counts (derive count from len())
    # Populated for /calculate, empty for version retrieval
    unit_ids: List[int] = []
    cost_lot_ids: List[int] = []
    consumed_slice_ids: List[int] = []
    realized_pnl_ids: List[int] = []
    warning_ids: List[int] = []
    settlement_ids: List[int] = []
    cost_lot_event_ids: List[int] = []


# Backwards compatibility alias
PnLCalculateResponse = PnLVersionResponse


class VersionListItem(BaseModel):
    """Lightweight version item for list endpoint (CQRS-lite: IDs only)."""
    version_id: int
    description: Optional[str] = None
    created_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    status: str
    # Config fields for display and filtering
    lot_method: str
    lot_mode: str
    base_currency_id: Optional[int] = None
    base_currency_symbol: Optional[str] = None
    allow_negative_balances: bool = False
    residual_tolerance_pct: float = 0.05


# =============================================================================
# Helper Functions
# =============================================================================


def _determine_related_asset(
    unit_legs: List[tuple],  # List of (CalculationUnitLeg, Asset) tuples
    base_currency_id: Optional[int]
) -> Optional[tuple]:
    """
    Determine the related asset for a fee based on the unit's non-fee legs.
    
    Logic:
    - If one side is base currency → use the non-base-currency asset
    - If crypto-to-crypto swap → use the outflow/disposed asset
    - If multiple non-base outflows → use the largest value leg
    
    Returns:
        Tuple of (asset_id, asset_symbol) or None if not determinable
    """
    if not unit_legs:
        return None
    
    # Separate outflows and inflows
    outflows = [(leg, asset) for leg, asset in unit_legs if leg.leg_type == "outflow"]
    inflows = [(leg, asset) for leg, asset in unit_legs if leg.leg_type == "inflow"]
    
    # Find non-base-currency legs
    non_base_outflows = [(leg, asset) for leg, asset in outflows if asset.asset_id != base_currency_id]
    non_base_inflows = [(leg, asset) for leg, asset in inflows if asset.asset_id != base_currency_id]
    
    # Case 1: One side is base currency → use non-base side
    if non_base_outflows and not non_base_inflows:
        # Outflow is non-base (e.g., sell BTC for EUR)
        leg, asset = max(non_base_outflows, key=lambda x: float(x[0].quantity) * float(getattr(x[0].transaction, 'price', 1) or 1))
        return (asset.asset_id, asset.symbol)
    
    if non_base_inflows and not non_base_outflows:
        # Inflow is non-base (e.g., buy BTC with EUR)
        leg, asset = max(non_base_inflows, key=lambda x: float(x[0].quantity) * float(getattr(x[0].transaction, 'price', 1) or 1))
        return (asset.asset_id, asset.symbol)
    
    # Case 2: Both sides are non-base (crypto-to-crypto) → use outflow
    if non_base_outflows:
        # Use largest value outflow
        leg, asset = max(non_base_outflows, key=lambda x: float(x[0].quantity) * float(getattr(x[0].transaction, 'price', 1) or 1))
        return (asset.asset_id, asset.symbol)
    
    # Case 3: All are base currency (edge case) → use largest leg
    all_legs = outflows + inflows
    if all_legs:
        leg, asset = max(all_legs, key=lambda x: float(x[0].quantity))
        return (asset.asset_id, asset.symbol)
    
    return None


def compute_total_realized_pnl(session: Session, version_id: int) -> Decimal:
    """
    Compute total taxable realized P&L for a version via SQL aggregation.
    
    Sums RealizedPnl.pnl_in_base WHERE disposal_taxable=True for all entries
    linked to the version via CalculationUnit.
    """
    result = session.exec(
        select(func.coalesce(func.sum(RealizedPnl.pnl_in_base), 0))
        .join(RealizedPnl.origin_unit)
        .where(CalculationUnit.version_id == version_id)
        .where(RealizedPnl.disposal_taxable == True)
    ).one()
    return Decimal(str(result)) if result else Decimal(0)


def build_balances_from_lots(
    lots: List[CostLot],
    cost_field: str = "unit_cost_in_base"
) -> List[BalanceItem]:
    """
    Build BalanceItem list from cost lots by aggregating per asset.
    
    Args:
        lots: List of CostLot objects (can be from DB or in-memory PnLResult)
        cost_field: Field name to use for unit cost:
            - "unit_cost_in_base" for runtime lots from PnLResult
            - "unit_cost" for DB CostLot model (uses unit_cost column)
    """
    balance_map = defaultdict(lambda: {
        "qty": Decimal(0),
        "cost": Decimal(0),
        "lots": 0,
        "asset": None,
    })
    
    for lot in lots:
        unit_cost = getattr(lot, cost_field, lot.unit_cost_in_base)
        balance_map[lot.asset_id]["qty"] += lot.qty_remaining
        balance_map[lot.asset_id]["cost"] += lot.qty_remaining * unit_cost
        balance_map[lot.asset_id]["lots"] += 1
        if balance_map[lot.asset_id]["asset"] is None:
            balance_map[lot.asset_id]["asset"] = lot.asset
    
    return [
        BalanceItem(
            asset={"id": asset_id, "name": data["asset"].symbol if data["asset"] else f"#{asset_id}"},
            qty=float(data["qty"]),
            cost_basis_in_base=float(data["cost"]),
            avg_unit_cost_in_base=float(data["cost"] / data["qty"]) if data["qty"] > 0 else 0.0,
            lot_count=data["lots"],
        )
        for asset_id, data in balance_map.items()
    ]


def build_version_response(
    version: CalculationVersion,
    base_currency_symbol: Optional[str] = None,
    total_realized_pnl: float = 0.0,
    total_fees_in_base: float = 0.0,
    fee_entry_count: int = 0,
    unit_ids: Optional[List[int]] = None,
    cost_lot_ids: Optional[List[int]] = None,
    consumed_slice_ids: Optional[List[int]] = None,
    realized_pnl_ids: Optional[List[int]] = None,
    warning_ids: Optional[List[int]] = None,
    settlement_ids: Optional[List[int]] = None,
    cost_lot_event_ids: Optional[List[int]] = None,
) -> PnLVersionResponse:
    """
    Build PnLVersionResponse from a CalculationVersion with optional enrichment.
    
    Centralizes the construction of PnLVersionResponse to avoid duplication
    across calculate_pnl, get_version, and list_versions endpoints.
    """
    return PnLVersionResponse(
        version_id=version.version_id,
        description=version.description,
        created_at=version.created_at,
        expires_at=version.expires_at,
        status=version.status,
        lot_method=version.method,
        lot_mode=version.lot_mode,
        base_currency_id=version.base_currency_id,
        base_currency_symbol=base_currency_symbol,
        allow_negative_balances=version.allow_negative_balances,
        residual_tolerance_pct=float(version.residual_tolerance_pct),
        account_ids=version.account_ids,  # Include account filter in response
        total_realized_pnl=total_realized_pnl,
        total_fees_in_base=total_fees_in_base,
        fee_entry_count=fee_entry_count,
        unit_ids=unit_ids or [],
        cost_lot_ids=cost_lot_ids or [],
        consumed_slice_ids=consumed_slice_ids or [],
        realized_pnl_ids=realized_pnl_ids or [],
        warning_ids=warning_ids or [],
        settlement_ids=settlement_ids or [],
        cost_lot_event_ids=cost_lot_event_ids or [],
    )


@router.post("/calculate", response_model=PnLCalculateResponse)
def calculate_pnl(
    request: PnLCalculateRequest,
    session: Session = Depends(get_session_dependency),
):
    """
    Run P&L calculation and persist as draft.
    
    This is the preferred endpoint for Option D (CQRS-Lite) architecture:
    1. Calculate P&L for all transactions
    2. Persist as draft (auto-expires in 1 hour)
    3. Return version_id + summary
    
    Client workflow:
    1. POST /calculate → get version_id
    2. GET /versions/{id}/balances → fetch balances
    3. GET /versions/{id}/lots → fetch lots (optional, for drilling down)
    4. GET /versions/{id}/realized-pnl → fetch P&L entries
    5. POST /versions/{id}/commit → make permanent if user saves
    
    This approach:
    - Separates calculation (write) from retrieval (read)
    - Enables efficient pagination/filtering on large datasets
    - Supports preview → review → save workflow
    """
    try:
        # Get base currency asset - accept either ID or symbol
        base_currency = None
        if request.base_currency_id:
            base_currency = session.get(Asset, request.base_currency_id)
            if not base_currency:
                raise HTTPException(
                    status_code=400,
                    detail=f"Base currency asset ID {request.base_currency_id} not found",
                )
        elif request.base_currency_symbol:
            base_currency = session.exec(
                select(Asset).where(Asset.symbol == request.base_currency_symbol)
            ).first()
            if not base_currency:
                raise HTTPException(
                    status_code=400,
                    detail=f"Base currency '{request.base_currency_symbol}' not found",
                )
        else:
            raise HTTPException(
                status_code=400,
                detail="Either base_currency_id or base_currency_symbol is required",
            )

        # Create config
        config = PnLConfig(
            lot_method=CostMethod(request.lot_method),
            lot_mode=LotMode(request.lot_mode),
            base_currency_id=base_currency.asset_id,
            base_currency_symbol=base_currency.symbol,
            residual_tolerance_pct=Decimal(request.residual_tolerance_pct),
            allow_negative_balances=request.allow_negative_balances,
        )

        # Create engine 
        price_service = PriceService(session=session)
        engine = PnLEngine(session=session, price_service=price_service, config=config)
        
        # Run P&L calculation (builds units and processes them)
        # Pass account_ids filter if provided (None means all accounts)
        result: PnLResult = engine.calculate(account_ids=request.account_ids)
        
        # Persist as draft (auto-expires in 1 hour)
        version = engine.persist_results(result, status="draft", expires_in_hours=1)

        log.info(
            "pnl_calculation_complete",
            version_id=version.version_id,
            units_processed=len(result.calculation_units),
            lot_method=request.lot_method,
            account_ids=request.account_ids,
        )

        # Build ID arrays for tab title counts
        unit_ids = [u.id for u in result.calculation_units if u.id]
        cost_lot_ids = [lot.cost_lot_id for lot in result.created_lots if lot.cost_lot_id]
        consumed_slice_ids = [s.slice_id for s in result.consumed_slices if s.slice_id]
        realized_pnl_ids = [r.pnl_id for r in result.realized_pnl_entries if r.pnl_id]
        warning_ids = [w.id for w in result.warnings if w.id]
        settlement_ids = [s.settlement_id for s in result.settlement_records if s.settlement_id]
        
        # Query cost lot event IDs for the version (events are linked via lot -> unit -> version)
        cost_lot_event_ids = list(session.exec(
            select(CostLotEvent.event_id)
            .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
            .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
            .where(CalculationUnit.version_id == version.version_id)
        ).all())

        # Compute fee summary from FeeEntry records (fee_value_in_base is stored directly)
        fee_summary = session.exec(
            select(
                func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0).label("total_fees"),
                func.count(FeeEntry.id).label("fee_count"),
            )
            .where(FeeEntry.version_id == version.version_id)
        ).first()
        
        total_fees_in_base = float(fee_summary.total_fees) if fee_summary else 0.0
        fee_entry_count = fee_summary.fee_count if fee_summary else 0

        return build_version_response(
            version=version,
            base_currency_symbol=base_currency.symbol,
            total_realized_pnl=float(result.total_realized_pnl),
            total_fees_in_base=total_fees_in_base,
            fee_entry_count=fee_entry_count,
            unit_ids=unit_ids,
            cost_lot_ids=cost_lot_ids,
            consumed_slice_ids=consumed_slice_ids,
            realized_pnl_ids=realized_pnl_ids,
            warning_ids=warning_ids,
            settlement_ids=settlement_ids,
            cost_lot_event_ids=cost_lot_event_ids,
        )

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        log.exception("pnl_calculation_failed", error=str(e))
        raise HTTPException(status_code=500, detail=f"P&L calculation failed: {str(e)}")


# =============================================================================
# Prices Endpoint (for Unrealized P&L refresh)
# =============================================================================


class PriceRequest(BaseModel):
    """Request for bulk price lookup."""
    
    asset_ids: List[int] = Field(..., description="List of asset IDs to fetch prices for")
    base_currency: str = Field(default="EUR", description="Quote currency for prices")


@router.post("/prices", response_model=PricesResponse)
def get_current_prices(
    request: PriceRequest,
    session: Session = Depends(get_session_dependency),
):
    """
    Fetch current prices for multiple assets.
    
    Use this endpoint to refresh unrealized P&L:
    1. Call /calculate/preview to get balances (qty, cost_basis)
    2. Call /prices with asset_ids from balances
    3. Compute unrealized P&L client-side: (qty * price) - cost_basis
    
    This endpoint is designed to be called frequently (e.g., every 30s).
    Price fetching is best-effort - failures are reported per-asset.
    """
    price_service = PriceService(session=session)
    fetched_at = datetime.utcnow()
    
    # Build asset lookup
    assets = session.exec(
        select(Asset).where(Asset.asset_id.in_(request.asset_ids))
    ).all()
    asset_map = {a.asset_id: a for a in assets}
    
    prices = []
    successful = 0
    failed = 0
    
    for asset_id in request.asset_ids:
        asset = asset_map.get(asset_id)
        if not asset:
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, name=f"#{asset_id}"),
                price=None,
                price_quote=request.base_currency,
                error=f"Asset {asset_id} not found",
            ))
            failed += 1
            continue
        
        try:
            result = price_service.get_current_price_with_metadata(
                asset_id=asset_id,
                price_quote=request.base_currency,
            )
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, name=asset.symbol),
                price=result.price,
                price_quote=request.base_currency,
                fetched_at=result.timestamp or fetched_at,
                source=result.source,
            ))
            successful += 1
        except Exception as e:
            log.warning("price_fetch_failed", asset_symbol=asset.symbol, error=str(e))
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, name=asset.symbol),
                price=None,
                price_quote=request.base_currency,
                error=str(e),
            ))
            failed += 1
    
    warning = None
    if failed > 0:
        warning = f"{failed} price(s) could not be retrieved. See 'prices' for details."
    return PricesResponse(
        prices=prices,
        base_currency=request.base_currency,
        fetched_at=fetched_at,
        successful_count=successful,
        failed_count=failed,
        warning=warning,
    )


# =============================================================================
# Version-Based Endpoints (Option D: CQRS-Lite)
# =============================================================================
# These endpoints read persisted P&L data from the database, using FK relationships
# and eager loading for efficient queries. This separates read path from write path.


# VersionSummaryResponse removed - use PnLVersionResponse for detail, VersionListItem for list


@router.get("/versions", response_model=List[VersionListItem])
def list_versions(
    status: Optional[str] = None,
    limit: int = 20,
    session: Session = Depends(get_session_dependency),
):
    """
    List calculation versions (lightweight).
    
    Returns minimal metadata only. Use GET /versions/{id} for full details
    including balances and total_realized_pnl (CQRS-lite pattern).
    
    Optionally filter by status: 'draft', 'committed', or 'active'.
    """
    query = select(CalculationVersion).order_by(CalculationVersion.created_at.desc())
    if status:
        query = query.where(CalculationVersion.status == status)
    query = query.limit(limit)
    
    versions = session.exec(query).all()
    
    # Get base currency symbols in batch
    base_currency_ids = [v.base_currency_id for v in versions if v.base_currency_id]
    base_currencies = {}
    if base_currency_ids:
        assets = session.exec(
            select(Asset).where(Asset.asset_id.in_(base_currency_ids))
        ).all()
        base_currencies = {a.asset_id: a.symbol for a in assets}
    
    return [
        VersionListItem(
            version_id=v.version_id,
            description=v.description,
            created_at=v.created_at,
            expires_at=v.expires_at,
            status=v.status,
            lot_method=v.method,
            lot_mode=v.lot_mode,
            base_currency_id=v.base_currency_id,
            base_currency_symbol=base_currencies.get(v.base_currency_id),
            allow_negative_balances=v.allow_negative_balances,
            residual_tolerance_pct=float(v.residual_tolerance_pct),
        )
        for v in versions
    ]


@router.get("/versions/{version_id}", response_model=PnLVersionResponse)
def get_version(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get details of a specific calculation version with balances and total P&L.
    
    Computes total_realized_pnl via SQL aggregation and builds balances from
    cost lots with qty_remaining > 0.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Get base currency symbol
    base_currency_symbol = None
    if version.base_currency_id:
        asset = session.get(Asset, version.base_currency_id)
        base_currency_symbol = asset.symbol if asset else None
    
    # Compute total realized P&L via SQL aggregation
    total_pnl = compute_total_realized_pnl(session, version_id)
    
    return build_version_response(
        version=version,
        base_currency_symbol=base_currency_symbol,
        total_realized_pnl=float(total_pnl),
    )


@router.get("/versions/{version_id}/summary", response_model=PnLVersionResponse)
def get_version_summary(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get summary of a calculation version with balances.
    
    Returns pre-computed metrics with balances.
    Ideal for initial page load and dashboard cards.
    """
    return get_version(version_id, session)


@router.get("/versions/{version_id}/lots", response_model=List[CostLotResponse])
def get_version_lots(
    version_id: int,
    include_zero_remaining: bool = True,
    include_unsettled_negative: bool = True,
    asset_id: Optional[int] = None,
    account_id: Optional[int] = None,
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get cost lots for a specific version.
    
    Supports pagination and filtering by asset_id and account_id.
    Uses eager loading to fetch asset relationships in a single query.
    
    Args:
        include_unsettled_negative: If False, excludes lots where is_negative=True AND is_settled=False.
                                    Default True shows all lots including unsettled negatives.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Query with eager loading of asset
    query = (
        select(CostLot)
        .join(CostLot.unit)  # join the related CalculationUnit
        .options(
            selectinload(CostLot.asset), 
            selectinload(CostLot.account),
            selectinload(CostLot.unit),  # Eager load unit for origin_unit_label
        )
        .where(CalculationUnit.version_id == version_id)
        .order_by(CostLot.acquired_at)
    )
    
    if not include_zero_remaining:
        query = query.where(CostLot.qty_remaining > 0)
    
    if not include_unsettled_negative:
        # Exclude lots that are negative AND not yet settled
        query = query.where(
            ~((CostLot.is_negative == True) & (CostLot.is_settled == False))
        )
    
    if asset_id:
        query = query.where(CostLot.asset_id == asset_id)
    
    if account_id:
        query = query.where(CostLot.account_id == account_id)
    
    # Apply pagination
    offset = (page - 1) * limit
    query = query.offset(offset).limit(limit)
    
    lots = session.exec(query).all()
    
    return [
        CostLotResponse(
            cost_lot_id=lot.cost_lot_id,
            asset=AssetRef(
                id=lot.asset.asset_id if lot.asset else lot.asset_id,
                name=lot.asset.symbol if lot.asset else f"#{lot.asset_id}"
            ),
            account_id=lot.account_id,
            account_name=lot.account.name if lot.account else None,
            qty_original=float(lot.qty),
            qty_remaining=float(lot.qty_remaining),
            qty_consumed=float(lot.qty - lot.qty_remaining),
            unit_cost_in_base=float(lot.unit_cost),
            total_cost_in_base=float(lot.total_cost),
            remaining_cost_in_base=float(lot.remaining_cost_in_base),
            acquired_at=lot.acquired_at,
            origin_transaction_id=lot.origin_transaction_id,
            origin_unit_id=lot.unit_id,  # DB field is now unit_id, API keeps origin_unit_id for compat
            origin_unit_label=lot.unit.label if lot.unit else None,
            is_zero_cost=lot.is_zero_cost,
            is_negative=lot.is_negative,
            notes=lot.notes,
        )
        for lot in lots
    ]


@router.get("/versions/{version_id}/consumed-slices", response_model=List[ConsumedSliceResponse])
def get_version_consumed_slices(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get consumed lot slices for a specific version.
    
    Returns detailed consumption history showing which lots were consumed
    and how much was taken from each.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Query consumed slices - join through CostLot -> CalculationUnit to filter by version
    # Also join RealizedPnl to get consuming unit info
    query = (
        select(ConsumedLotSlice)
        .join(ConsumedLotSlice.cost_lot)
        .join(CostLot.unit)
        .options(
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            selectinload(ConsumedLotSlice.pnl).selectinload(RealizedPnl.origin_unit),
        )
        .where(CalculationUnit.version_id == version_id)
        .order_by(ConsumedLotSlice.created_at)
    )
    
    slices = session.exec(query).all()
    
    return [
        ConsumedSliceResponse(
            cost_lot_id=s.cost_lot.cost_lot_id if s.cost_lot else 0,
            asset=AssetRef(
                id=s.cost_lot.asset.asset_id if s.cost_lot and s.cost_lot.asset else (s.cost_lot.asset_id if s.cost_lot else 0),
                name=s.cost_lot.asset.symbol if s.cost_lot and s.cost_lot.asset else f"#{s.cost_lot.asset_id if s.cost_lot else 0}"
            ) if s.cost_lot else None,
            quantity=float(s.quantity),
            unit_cost_in_base=float(s.unit_cost_in_base),
            total_cost_in_base=float(s.total_cost_in_base),
            acquired_at=s.cost_lot.acquired_at if s.cost_lot else s.created_at,
            holding_period_days=s.holding_period_days,
            consumed_by_transaction_id=s.pnl.transaction_id if s.pnl else None,
            consumed_by_unit_label=s.pnl.origin_unit.label if s.pnl and s.pnl.origin_unit else None,
            consumed_at=s.created_at,
        )
        for s in slices
    ]


@router.get("/versions/{version_id}/realized-pnl", response_model=List[RealizedPnLResponse])
def get_version_realized_pnl(
    version_id: int,
    asset_id: Optional[int] = None,
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get realized P&L entries for a specific version.
    
    Supports pagination and filtering by asset_id.
    Uses eager loading to fetch asset relationships in a single query.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Query with eager loading of asset
    query = (
        select(RealizedPnl)
        .join(RealizedPnl.origin_unit)
        .options(selectinload(RealizedPnl.asset))
        .where(CalculationUnit.version_id == version_id)
        .order_by(RealizedPnl.realized_at)
    )
    
    if asset_id:
        query = query.where(RealizedPnl.asset_id == asset_id)
    
    # Apply pagination
    offset = (page - 1) * limit
    query = query.offset(offset).limit(limit)
    
    entries = session.exec(query).all()
    
    return [
        RealizedPnLResponse(
            asset=AssetRef(
                id=e.asset.asset_id if e.asset else e.asset_id,
                name=e.asset.symbol if e.asset else f"#{e.asset_id}"
            ),
            qty=float(e.qty),
            proceeds_in_base=float(e.proceeds_in_base),
            cost_basis_in_base=float(e.cost_basis_in_base),
            pnl_in_base=float(e.pnl_in_base),
            taxable=e.disposal_taxable,
            transaction_id=e.transaction_id,
            unit_id=e.origin_unit_id,
            realized_at=e.realized_at,
            holding_period_days=e.holding_period_days,
            # Include proceeds tracking metadata
            proceeds_source=e.proceeds_source,
            proceeds_price=float(e.proceeds_price) if e.proceeds_price else None,
            proceeds_price_source=e.proceeds_price_source,
            proceeds_price_timestamp=e.proceeds_price_timestamp,
        )
        for e in entries
    ]


class FeesResponse(BaseModel):
    """Response for fees endpoint with items and summary."""
    fees: List[FeeEntryResponse]
    summary: FeeSummaryResponse


@router.get("/versions/{version_id}/fees", response_model=FeesResponse)
def get_version_fees(
    version_id: int,
    asset_id: Optional[int] = None,
    unit_id: Optional[int] = None,
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get fee entries for a specific version.
    
    Returns detailed fee data with summary statistics.
    Fee value is stored directly on FeeEntry.fee_value_in_base.
    RealizedPnl is optional (base currency fees don't have one).
    
    Supports filtering by asset_id and unit_id.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build query: FeeEntry with fee_leg (for asset/qty) + optional RealizedPnl (for cost basis/pnl)
    # Use outerjoin to RealizedPnl so base currency fees (no RealizedPnl) are included
    query = (
        select(FeeEntry, CalculationUnitLeg, Asset, RealizedPnl, NormalizedTransaction)
        .join(CalculationUnitLeg, FeeEntry.fee_leg_id == CalculationUnitLeg.id)
        .join(Asset, CalculationUnitLeg.asset_id == Asset.asset_id)
        .outerjoin(RealizedPnl, FeeEntry.realized_pnl_id == RealizedPnl.pnl_id)
        .outerjoin(NormalizedTransaction, CalculationUnitLeg.transaction_id == NormalizedTransaction.id)
        .where(FeeEntry.version_id == version_id)
        .order_by(NormalizedTransaction.date_time)
    )
    
    if asset_id:
        query = query.where(CalculationUnitLeg.asset_id == asset_id)
    if unit_id:
        query = query.where(FeeEntry.unit_id == unit_id)
    
    # Get all for summary calculation first
    all_results = session.exec(query).all()
    
    # Collect unique unit_ids to query related assets
    unit_ids = list(set(fee_entry.unit_id for fee_entry, _, _, _, _ in all_results))
    
    # Query non-fee legs for these units to determine related asset per unit
    # Related asset = non-base-currency asset (outflows preferred for crypto-to-crypto)
    related_asset_map: Dict[int, tuple] = {}  # unit_id -> (asset_id, asset_symbol)
    
    if unit_ids:
        # Get all non-fee legs for these units with their assets
        legs_query = (
            select(CalculationUnitLeg, Asset)
            .join(Asset, CalculationUnitLeg.asset_id == Asset.asset_id)
            .where(CalculationUnitLeg.unit_id.in_(unit_ids))
            .where(CalculationUnitLeg.leg_type != "fee")
        )
        legs_data = session.exec(legs_query).all()
        
        # Group legs by unit_id
        legs_by_unit: Dict[int, List[tuple]] = {}
        for leg, asset in legs_data:
            if leg.unit_id not in legs_by_unit:
                legs_by_unit[leg.unit_id] = []
            legs_by_unit[leg.unit_id].append((leg, asset))
        
        # Determine related asset for each unit
        for uid, unit_legs in legs_by_unit.items():
            related_asset = _determine_related_asset(unit_legs, version.base_currency_id)
            if related_asset:
                related_asset_map[uid] = related_asset
    
    # Calculate summary using fee_value_in_base (stored directly on FeeEntry)
    fees_by_asset: Dict[str, float] = {}
    fees_by_source: Dict[str, float] = {}
    disposal_taxable_count = 0
    total_fees = 0.0
    
    for fee_entry, leg, asset, rpnl, tx in all_results:
        symbol = asset.symbol
        source = tx.source if tx else "unknown"
        fee_value = float(fee_entry.fee_value_in_base)
        
        fees_by_asset[symbol] = fees_by_asset.get(symbol, 0) + fee_value
        fees_by_source[source] = fees_by_source.get(source, 0) + fee_value
        total_fees += fee_value
        
        # Only count disposal_taxable if RealizedPnl exists
        if rpnl and rpnl.disposal_taxable:
            disposal_taxable_count += 1
    
    # Apply pagination to results
    offset = (page - 1) * limit
    paginated_results = all_results[offset:offset + limit]
    
    # Build response
    fee_responses = []
    for fee_entry, leg, asset, rpnl, tx in paginated_results:
        # Look up related asset for this unit
        related = related_asset_map.get(fee_entry.unit_id)
        
        # For base currency fees: rpnl is None, cost_basis and pnl are 0
        fee_responses.append(FeeEntryResponse(
            id=fee_entry.id,
            date=rpnl.realized_at if rpnl else leg.date_time,
            asset_id=asset.asset_id,
            asset_symbol=asset.symbol,
            fee_amount=float(leg.quantity) if leg.quantity else 0.0,
            fee_in_base=float(fee_entry.fee_value_in_base),
            transaction_id=leg.transaction_id,
            unit_id=fee_entry.unit_id,
            source=tx.source if tx else None,
            transaction_type=tx.transaction_type if tx else None,
            cost_basis_consumed=float(rpnl.cost_basis_in_base) if rpnl else 0.0,
            realized_pnl=float(rpnl.pnl_in_base) if rpnl else 0.0,
            related_asset_id=related[0] if related else None,
            related_asset_symbol=related[1] if related else None,
        ))
    
    return FeesResponse(
        fees=fee_responses,
        summary=FeeSummaryResponse(
            total_fees_in_base=total_fees,
            fees_by_asset=fees_by_asset,
            fees_by_source=fees_by_source,
            disposal_taxable_fee_count=disposal_taxable_count,
        )
    )


@router.get("/versions/{version_id}/balances", response_model=List[BalanceResponse])
def get_version_balances(
    version_id: int,
    group_by_asset: bool = False,
    include_unsettled_negative: bool = False,
    session: Session = Depends(get_session_dependency),
):
    """
    Get asset balances for a specific version.
    
    Balances are computed on-demand from cost lots with remaining quantity.
    This avoids storing redundant data and ensures consistency.
    
    Args:
        version_id: The P&L version ID
        group_by_asset: If True, aggregate across all accounts per asset.
                        Also includes realized_pnl_in_base, realized_event_count, warning_count.
        include_unsettled_negative: If False (default), excludes lots where is_negative=True AND is_settled=False.
                                    The response includes unsettled_negative_count showing how many were excluded.
    """
    from collections import defaultdict
    
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Query cost lots with remaining qty, eager load asset and account
    query = (
        select(CostLot)
        .join(CostLot.unit)  # join the related CalculationUnit
        .options(selectinload(CostLot.asset), selectinload(CostLot.account))
        .where(CalculationUnit.version_id == version_id)
        #.where(CostLot.qty_remaining > 0)
    )
    lots = session.exec(query).all()
    
    # Separate lots into included and excluded based on unsettled negative filter
    unsettled_negative_by_asset = defaultdict(int)  # Track excluded count per asset
    filtered_lots = []
    for lot in lots:
        is_unsettled_negative = lot.is_negative and not lot.is_settled
        if is_unsettled_negative:
            unsettled_negative_by_asset[lot.asset_id] += 1
            if not include_unsettled_negative:
                continue  # Skip unsettled negative lots
        filtered_lots.append(lot)
    
    # Determine aggregation key based on group_by_asset
    if group_by_asset:
        # Aggregate by asset_id only
        balance_map = defaultdict(lambda: {
            "qty": Decimal(0), 
            "cost": Decimal(0), 
            "lots": 0,
            "asset": None,
            "account_ids": set(),  # Track all account IDs holding this asset
        })
        
        for lot in filtered_lots:
            key = lot.asset_id
            balance_map[key]["qty"] += lot.qty_remaining
            balance_map[key]["cost"] += lot.qty_remaining * lot.unit_cost
            balance_map[key]["lots"] += 1
            if lot.account_id:
                balance_map[key]["account_ids"].add(lot.account_id)
            if balance_map[key]["asset"] is None:
                balance_map[key]["asset"] = lot.asset
        
        # Query realized P&L aggregated by asset
        realized_query = (
            select(
                RealizedPnl.asset_id,
                func.sum(RealizedPnl.pnl_in_base).label("total_pnl"),
                func.count(RealizedPnl.pnl_id).label("event_count")
            )
            .join(RealizedPnl.origin_unit)
            .where(CalculationUnit.version_id == version_id)
            .group_by(RealizedPnl.asset_id)
        )
        realized_results = session.exec(realized_query).all()
        realized_map = {r.asset_id: {"pnl": float(r.total_pnl or 0), "count": r.event_count} for r in realized_results}
        
        # Query warnings aggregated by asset
        warning_query = (
            select(
                PnlWarning.asset_id,
                func.count(PnlWarning.id).label("warning_count")
            )
            .join(PnlWarning.unit)
            .where(CalculationUnit.version_id == version_id)
            .where(PnlWarning.asset_id.isnot(None))
            .group_by(PnlWarning.asset_id)
        )
        warning_results = session.exec(warning_query).all()
        warning_map = {w.asset_id: w.warning_count for w in warning_results}
        
        # Query fees aggregated by related asset (via FeeEntry)
        # FeeEntry.related_asset_id points to the asset the fee is associated with
        # (e.g., for BTC-to-ETH swap with USDT fee, fee is attributed to BTC)
        # fee_value_in_base is stored directly on FeeEntry, no join needed
        fee_query = (
            select(
                FeeEntry.related_asset_id,
                func.sum(FeeEntry.fee_value_in_base).label("total_fees_fmv")
            )
            .where(FeeEntry.version_id == version_id)
            .where(FeeEntry.related_asset_id.isnot(None))
            .group_by(FeeEntry.related_asset_id)
        )
        fee_results = session.exec(fee_query).all()
        fee_map = {r.related_asset_id: float(r.total_fees_fmv or 0) for r in fee_results}
        
        # Sort by cost basis descending
        sorted_balances = sorted(
            balance_map.items(),
            key=lambda x: x[1]["cost"],
            reverse=True
        )
        
        return [
            BalanceResponse(
                asset=AssetRef(
                    id=data["asset"].asset_id if data["asset"] else asset_id,
                    name=data["asset"].symbol if data["asset"] else f"#{asset_id}"
                ),
                account_id=None,  # Aggregated across accounts
                account_name=None,
                account_ids=sorted(list(data["account_ids"])),  # All accounts holding this asset
                qty=float(data["qty"]),
                cost_basis_in_base=float(data["cost"]),
                avg_unit_cost_in_base=float(data["cost"] / data["qty"]) if data["qty"] > 0 else 0.0,
                lot_count=data["lots"],
                realized_pnl_in_base=realized_map.get(asset_id, {}).get("pnl", 0.0),
                realized_event_count=realized_map.get(asset_id, {}).get("count", 0),
                warning_count=warning_map.get(asset_id, 0),
                total_fees_in_base=fee_map.get(asset_id, 0.0),
                unsettled_negative_count=unsettled_negative_by_asset.get(asset_id, 0),
            )
            for asset_id, data in sorted_balances
        ]
    else:
        # Original behavior: aggregate by (asset_id, account_id)
        # Track unsettled negatives by (asset_id, account_id)
        unsettled_negative_by_key = defaultdict(int)
        for lot in lots:
            if lot.is_negative and not lot.is_settled:
                unsettled_negative_by_key[(lot.asset_id, lot.account_id)] += 1
        
        balance_map = defaultdict(lambda: {
            "qty": Decimal(0), 
            "cost": Decimal(0), 
            "lots": 0,
            "asset": None,
            "account": None,
        })
        
        for lot in filtered_lots:
            key = (lot.asset_id, lot.account_id)
            balance_map[key]["qty"] += lot.qty_remaining
            balance_map[key]["cost"] += lot.qty_remaining * lot.unit_cost
            balance_map[key]["lots"] += 1
            if balance_map[key]["asset"] is None:
                balance_map[key]["asset"] = lot.asset
                balance_map[key]["account"] = lot.account
        
        # Sort by cost basis descending
        sorted_balances = sorted(
            balance_map.items(),
            key=lambda x: x[1]["cost"],
            reverse=True
        )
        
        return [
            BalanceResponse(
                asset=AssetRef(
                    id=data["asset"].asset_id if data["asset"] else asset_id,
                    name=data["asset"].symbol if data["asset"] else f"#{asset_id}"
                ),
                account_id=account_id,
                account_name=data["account"].name if data["account"] else None,
                qty=float(data["qty"]),
                cost_basis_in_base=float(data["cost"]),
                avg_unit_cost_in_base=float(data["cost"] / data["qty"]) if data["qty"] > 0 else 0.0,
                lot_count=data["lots"],
                unsettled_negative_count=unsettled_negative_by_key.get((asset_id, account_id), 0),
            )
            for (asset_id, account_id), data in sorted_balances
        ]


@router.get("/versions/{version_id}/warnings", response_model=List[WarningResponse])
def get_version_warnings(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Get warnings for a specific version."""
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    query = (
        select(PnlWarning)
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
        .order_by(PnlWarning.created_at)
    )
    
    warnings = session.exec(query).all()
    

    return [
        WarningResponse(
            warning_type=w.warning_type,
            message=w.message,
            timestamp=w.created_at,
            transaction_id=w.transaction_id,
            unit_id=w.unit_id,
            unit_label=w.unit.unit_label if w.unit_id else None,
        )
        for w in warnings
    ]


@router.get("/versions/{version_id}/settlements", response_model=List[SettlementResponse])
def get_version_settlements(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get lot settlements for a specific version.
    
    Returns settlements showing how negative lots (debts) were settled by inflows.
    Useful for the audit trail of cost basis transfers.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    query = (
        select(LotSettlement)
        .options(
            selectinload(LotSettlement.negative_lot),
            selectinload(LotSettlement.settling_lot)
        )
        .join(LotSettlement.negative_lot)
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
        .order_by(LotSettlement.settled_at)
    )
    
    settlements = session.exec(query).all()
    
    return [
        SettlementResponse(
            settlement_id=s.settlement_id,
            negative_lot_id=s.negative_lot_id,
            settling_lot_id=s.settling_lot_id,
            settling_transaction_id=s.settling_transaction_id,
            qty_settled=float(s.qty_settled),
            cost_basis_applied=float(s.cost_basis_applied) if s.cost_basis_applied else None,
            settled_at=s.settled_at,
        )
        for s in settlements
    ]


@router.get("/versions/{version_id}/lot-events", response_model=List[CostLotEventResponse])
def get_version_lot_events(
    version_id: int,
    lot_id: Optional[int] = None,
    event_type: Optional[str] = None,
    asset_id: Optional[int] = None,
    unit_id: Optional[int] = None,
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get cost lot events for a calculation version.
    
    Provides chronological audit trail of all lot state changes:
    - created: Lot created from acquisition
    - consumed: Lot consumed in disposal
    - settled: Negative lot settled by later inflow
    - transferred: Lot moved between accounts
    - adjusted: Manual cost basis adjustment
    
    Use for tax audit trail and lot history reconstruction.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build query with eager loading
    query = (
        select(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .options(
            selectinload(CostLotEvent.lot).selectinload(CostLot.asset),
            selectinload(CostLotEvent.lot).selectinload(CostLot.account),
            selectinload(CostLotEvent.related_lot),
            selectinload(CostLotEvent.triggered_by_unit),
        )
        .order_by(CostLotEvent.timestamp, CostLotEvent.sequence_num)
    )
    
    # Apply filters
    if lot_id:
        query = query.where(CostLotEvent.lot_id == lot_id)
    if event_type:
        query = query.where(CostLotEvent.event_type == event_type)
    if asset_id:
        query = query.where(CostLot.asset_id == asset_id)
    if unit_id:
        query = query.where(CostLotEvent.triggered_by_unit_id == unit_id)
    
    # Pagination
    offset = (page - 1) * limit
    query = query.offset(offset).limit(limit)
    
    events = session.exec(query).all()
    
    return [
        CostLotEventResponse(
            event_id=e.event_id,
            event_type=e.event_type,
            lot_id=e.lot_id,
            asset=build_asset_ref(e.lot.asset, e.lot.asset_id) if e.lot else None,
            account_id=e.lot.account_id if e.lot else None,
            account_name=e.lot.account.name if e.lot and e.lot.account else None,
            quantity_delta=float(e.quantity_delta),
            cost_basis_delta=float(e.cost_basis_delta) if e.cost_basis_delta else None,
            qty_remaining_after=float(e.qty_remaining_after),
            cost_basis_remaining_after=float(e.cost_basis_remaining_after) if e.cost_basis_remaining_after else None,
            related_lot_id=e.related_lot_id,
            triggered_by_transaction_id=e.triggered_by_transaction_id,
            triggered_by_unit_id=e.triggered_by_unit_id,
            triggered_by_unit_label=e.triggered_by_unit.unit_label if e.triggered_by_unit else None,
            timestamp=e.timestamp,
            event_metadata=e.event_metadata,
        )
        for e in events
    ]


# =============================================================================
# Unit Detail Endpoints (for drill-down from units list)
# =============================================================================


@router.get("/versions/{version_id}/units/{unit_id}/consumed-slices", response_model=List[ConsumedSliceResponse])
def get_unit_consumed_slices(
    version_id: int,
    unit_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get consumed lot slices for a specific calculation unit.
    
    Returns detailed consumption history for drilling down from unit summary.
    """
    # Verify version and unit exist
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    unit = session.get(CalculationUnit, unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Unit {unit_id} not found in version {version_id}")
    
    # Query consumed slices via realized entries for this unit
    realized_entries = session.exec(
        select(RealizedPnl)
        .options(selectinload(RealizedPnl.slices).selectinload(ConsumedLotSlice.cost_lot))
        .where(RealizedPnl.origin_unit_id == unit_id)
        .where(RealizedPnl.version_id == version_id)
    ).all()
    
    consumed_slices = []
    for e in realized_entries:
        if e.slices:
            for slice in e.slices:
                cost_lot = slice.cost_lot
                consumed_slices.append(
                    ConsumedSliceResponse(
                        cost_lot_id=cost_lot.cost_lot_id if cost_lot else 0,
                        quantity=float(slice.quantity),
                        unit_cost_in_base=float(slice.unit_cost_in_base),
                        total_cost_in_base=float(slice.total_cost_in_base),
                        acquired_at=cost_lot.acquired_at if cost_lot else slice.created_at,
                        holding_period_days=None,
                        consumed_by_transaction_id=e.transaction_id,
                    )
                )
    
    return consumed_slices


@router.get("/versions/{version_id}/units/{unit_id}/realized-pnl", response_model=List[RealizedEntryDetailResponse])
def get_unit_realized_pnl(
    version_id: int,
    unit_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get realized P&L entries for a specific calculation unit.
    
    Returns P&L breakdown for drilling down from unit summary.
    """
    # Verify version and unit exist
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    unit = session.get(CalculationUnit, unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Unit {unit_id} not found in version {version_id}")
    
    # Query realized entries for this unit
    realized_entries = session.exec(
        select(RealizedPnl)
        .options(selectinload(RealizedPnl.asset))
        .where(RealizedPnl.origin_unit_id == unit_id)
        .where(RealizedPnl.version_id == version_id)
    ).all()
    
    return [
        RealizedEntryDetailResponse(
            asset=AssetRef(id=e.asset_id, name=e.asset.symbol if e.asset else f"#{e.asset_id}"),
            qty=float(e.qty),
            proceeds_in_base=float(e.proceeds_in_base),
            cost_basis_in_base=float(e.cost_basis_in_base),
            pnl_in_base=float(e.pnl_in_base),
            disposal_taxable=e.disposal_taxable,
        )
        for e in realized_entries
    ]


@router.get("/versions/{version_id}/units/{unit_id}/warnings", response_model=List[WarningResponse])
def get_unit_warnings(
    version_id: int,
    unit_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get warnings for a specific calculation unit.
    
    Returns warnings specific to this unit for drilling down from unit summary.
    """
    # Verify version and unit exist
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    unit = session.get(CalculationUnit, unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Unit {unit_id} not found in version {version_id}")
    
    # Query warnings for this unit
    unit_warnings = session.exec(
        select(PnlWarning)
        .where(PnlWarning.unit_id == unit_id)
        .where(PnlWarning.version_id == version_id)
        .order_by(PnlWarning.created_at)
    ).all()
    
    return [
        WarningResponse(
            warning_type=w.warning_type,
            message=w.message,
            timestamp=w.created_at,
            transaction_id=w.transaction_id,
            unit_id=w.unit_id,
            unit_label=unit.unit_label if unit else None,
        )
        for w in unit_warnings
    ]


@router.get("/versions/{version_id}/units", response_model=List[ProcessedUnitResponse])
def get_version_units(
    version_id: int,
    asset_id: Optional[int] = None,
    page: int = 1,
    limit: int = 50,
    session: Session = Depends(get_session_dependency),
):
    """
    Get processed calculation units for a specific version.
    
    Returns complete nested data in single request - eliminates N+1 queries
    with comprehensive eager loading.
    
    Args:
        version_id: The P&L version ID
        asset_id: Optional filter to only return units involving this asset
                  (in outflows, inflows, or fees)
        page: Page number (1-indexed)
        limit: Items per page
    """
    from backend.db.models import CalculationUnitLeg
    
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query
    offset = (page - 1) * limit
    query = (
        select(CalculationUnit)
        .where(CalculationUnit.version_id == version_id)
    )
    
    # Filter by asset_id if provided
    # Units involve an asset if it appears in any leg (outflow, inflow, or fee)
    if asset_id is not None:
        query = query.join(CalculationUnit.legs).where(
            CalculationUnitLeg.asset_id == asset_id
        ).distinct()
    
    # Add eager loading and pagination
    query = (
        query.options(
            # Legs with assets
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.asset),
            # Cost lots with assets and accounts
            selectinload(CalculationUnit.cost_lots).selectinload(CostLot.asset),
            selectinload(CalculationUnit.cost_lots).selectinload(CostLot.account),
            # Realized entries with assets and consumed slices (with their cost_lots and assets)
            selectinload(CalculationUnit.realized_pnl_records).selectinload(RealizedPnl.asset),
            selectinload(CalculationUnit.realized_pnl_records).selectinload(RealizedPnl.slices).selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            # Fee entries (for direct fee value access)
            selectinload(CalculationUnit.fee_entries),
            # Warnings
            selectinload(CalculationUnit.warnings),
        )
        .order_by(CalculationUnit.timestamp)
        .offset(offset)
        .limit(limit)
    )
    
    units = session.exec(query).all()
    
    # Query settlements for this version (separate query, but efficient)
    settlements_query = (
        select(LotSettlement)
        .options(
            selectinload(LotSettlement.negative_lot),
            selectinload(LotSettlement.settling_lot)
        )
        .join(LotSettlement.negative_lot)
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
    )
    all_settlements = session.exec(settlements_query).all()
    
    # Build unit_id -> settlements mapping
    settlements_by_unit = {}
    for s in all_settlements:
        if s.negative_lot and s.negative_lot.unit_id:
            unit_id = s.negative_lot.unit_id
            if unit_id not in settlements_by_unit:
                settlements_by_unit[unit_id] = []
            settlements_by_unit[unit_id].append(s)
    
    # Query event_ids per unit (bulk query for efficiency)
    # Get all unit IDs for this page
    unit_ids = [u.id for u in units]
    events_by_unit: Dict[int, List[int]] = {uid: [] for uid in unit_ids}
    
    if unit_ids:
        events_query = (
            select(CostLotEvent.triggered_by_unit_id, CostLotEvent.event_id)
            .where(CostLotEvent.triggered_by_unit_id.in_(unit_ids))
        )
        event_rows = session.exec(events_query).all()
        for triggered_by_unit_id, event_id in event_rows:
            if triggered_by_unit_id in events_by_unit:
                events_by_unit[triggered_by_unit_id].append(event_id)
    
    # Query fee entries to identify which realized_pnl_ids are fees
    fee_pnl_ids: set[int] = set()
    if unit_ids:
        fee_query = select(FeeEntry.realized_pnl_id).where(FeeEntry.unit_id.in_(unit_ids))
        fee_pnl_ids = set(row for row in session.exec(fee_query).all())
    
    # Build response
    result = []
    for u in units:
        # Build transaction legs from unit legs
        outflows = [
            TransactionLegDetail(
                transaction_id=leg.transaction_id,
                asset=build_asset_ref(leg.asset, leg.asset_id),
                qty=float(leg.quantity),
                direction="outflow"
            )
            for leg in u.outflow_legs
        ]
        
        inflows = [
            TransactionLegDetail(
                transaction_id=leg.transaction_id,
                asset=build_asset_ref(leg.asset, leg.asset_id),
                qty=float(leg.quantity),
                direction="inflow"
            )
            for leg in u.inflow_legs
        ]
        
        fees = [
            TransactionLegDetail(
                transaction_id=leg.transaction_id,
                asset=build_asset_ref(leg.asset, leg.asset_id),
                qty=float(leg.quantity),
                direction="fee"
            )
            for leg in u.fee_legs
        ]
        
        # Build cost lots
        lots = [build_cost_lot_response(lot) for lot in u.cost_lots]
        
        # Build consumed slices from realized entries (with unit label and consumption timestamp)
        consumed = []
        for entry in u.realized_pnl_records:
            if entry.slices:
                for slice in entry.slices:
                    consumed.append(build_consumed_slice_response(
                        slice, 
                        consumed_by_tx_id=entry.transaction_id,
                        consumed_by_unit_label=u.unit_label,
                        consumed_at=entry.realized_at or u.timestamp,
                    ))
        
        # Build settlements for this unit
        unit_settlements = settlements_by_unit.get(u.id, [])
        settlements = [build_settlement_response(s) for s in unit_settlements]
        
        # Build cost basis tracking
        cost_basis = CostBasisTracking(
            lots=lots,
            consumed=consumed,
            settlements=settlements,
        )
        
        # Build realized entries (mark fees using fee_pnl_ids set)
        realized_entries = [
            build_realized_entry_response(e, is_fee=(e.pnl_id in fee_pnl_ids))
            for e in u.realized_pnl_records
        ]
        
        # Build warnings
        warnings = [build_warning_response(w, u.unit_label) for w in u.warnings]
        
        # Count fee entries for this unit and compute total fee value
        # Use fee_entries directly (includes base currency fees without RealizedPnl)
        unit_fee_count = len(u.fee_entries) if u.fee_entries else 0
        unit_total_fees = sum(float(fe.fee_value_in_base) for fe in (u.fee_entries or []))
        
        result.append(ProcessedUnitResponse(
            unit_id=u.id,
            unit_label=u.unit_label or "",
            pattern=u.pattern,
            timestamp=u.timestamp,
            outflows=outflows,
            inflows=inflows,
            fees=fees,
            cost_basis=cost_basis,
            realized_entries=realized_entries,
            warnings=warnings,
            event_ids=events_by_unit.get(u.id, []),
            realized_pnl_in_base=float(u.total_realized_pnl_in_base),
            # Unit is taxable if any leg has disposal_taxable=True
            is_disposal_taxable=any(leg.disposal_taxable for leg in u.legs if leg.leg_type in ("outflow", "fee")),
            # Fee indicators
            has_fees=len(fees) > 0 or unit_fee_count > 0,
            fee_count=unit_fee_count,
            total_fees_in_base=unit_total_fees,
        ))
    
    return result


@router.post("/versions/{version_id}/commit")
def commit_version(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Commit a draft version to make it permanent.
    
    Changes status from 'draft' to 'committed' and removes expiry.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    if version.status != "draft":
        raise HTTPException(
            status_code=400,
            detail=f"Version {version_id} is '{version.status}', not 'draft'. Only drafts can be committed."
        )
    
    version.status = "committed"
    version.expires_at = None
    session.commit()
    
    log.info("version_committed", version_id=version_id)
    
    return {"status": "committed", "version_id": version_id}


@router.delete("/versions/{version_id}")
def delete_version(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Delete a calculation version and all associated data.
    
    Use with caution - this permanently removes the version.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Delete in order due to FK constraints
    # (Most child tables have ON DELETE CASCADE in migrations, but be explicit)
    for w in session.exec(select(PnlWarning).where(PnlWarning.version_id == version_id)).all():
        session.delete(w)
    
    for s in session.exec(select(LotSettlement).where(LotSettlement.version_id == version_id)).all():
        session.delete(s)
    
    for cs in session.exec(select(ConsumedLotSlice).where(ConsumedLotSlice.version_id == version_id)).all():
        session.delete(cs)
    
    for r in session.exec(select(RealizedPnl).where(RealizedPnl.version_id == version_id)).all():
        session.delete(r)
    
    for l in session.exec(select(CostLot).where(CostLot.version_id == version_id)).all():
        session.delete(l)
    
    for u in session.exec(select(CalculationUnit).where(CalculationUnit.version_id == version_id)).all():
        session.delete(u)
    
    session.delete(version)
    session.commit()
    
    log.info("version_deleted", version_id=version_id)
    
    return {"status": "deleted", "version_id": version_id}
