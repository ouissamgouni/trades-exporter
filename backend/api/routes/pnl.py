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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func, not_, or_
from sqlalchemy.orm import selectinload

from backend.db.database import get_session_dependency
from backend.db.models import (
    Asset, NormalizedTransaction, CalculationUnit,
    CalculationVersion, CostLot, RealizedPnl, PnlWarning, LotSettlement, ConsumedLotSlice, CostLotEvent, FeeEntry, CalculationUnitLeg,
    AssetCategory, Category, Dimension, UnitPattern, Account, SyncJobConnectorRun,
)
from backend.services.pnl.engine import PnLEngine
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.models import PnLResult
from backend.services.price_service import PriceService
from backend.services.pnl.filter_utils import resolve_filtered_unit_ids
from backend.api.routes.pnl_filter_depends import PnLTransactionFilters, get_pnl_transaction_filters
from backend.config.loader import configure_logging

log = configure_logging("pnl_api")

router = APIRouter(prefix="/pnl", tags=["Profit & Loss"])


# =============================================================================
# Shared filter helper
# =============================================================================

def _apply_unit_filter(query, tx_filters: PnLTransactionFilters, version_id: int, session: Session, *, unit_column=None):
    """
    Apply transaction-level filters to a P&L query by resolving matching unit IDs.

    Args:
        query: The SQLAlchemy Select query to filter
        tx_filters: Resolved transaction filter state from the Depends
        version_id: The P&L version ID
        session: DB session
        unit_column: The column to filter on (defaults to CalculationUnit.id).
                     For RealizedPnl use RealizedPnl.origin_unit_id,
                     for FeeEntry use FeeEntry.unit_id, etc.

    Returns:
        Tuple of (filtered_query, unit_ids_or_none)
    """
    if not tx_filters.has_active_filters:
        return query, None

    unit_ids = resolve_filtered_unit_ids(
        session, version_id, tx_filters.applied_filters,
        non_owned=tx_filters.non_owned,
    )

    if unit_ids is not None:
        col = unit_column if unit_column is not None else CalculationUnit.id
        query = query.where(col.in_(unit_ids))

    return query, unit_ids


# =============================================================================
# Request/Response Models
# =============================================================================

from typing import Generic, TypeVar

T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    """Generic paginated response wrapper."""
    items: List[T]
    total: int
    page: int
    limit: int


class AssetRef(BaseModel):
    """Asset reference with id and name for display."""
    id: Optional[int] = None
    symbol: Optional[str] = None
    label: Optional[str] = None
    source_symbol: Optional[str] = None  # Fallback for unlinked assets



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
    # Advanced settings
    compute_residuals: bool = Field(
        default=False, description="Compute residual lots"
    )
    crypto_swap_taxable_by_default: bool = Field(
        default=False, description="Treat crypto-to-crypto swaps as taxable by default"
    )
    fee_taxable_by_default: bool = Field(
        default=False, description="Treat fees as taxable by default"
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
    asset: AssetRef
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
    related_asset: Optional[AssetRef] = None


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
    asset_id: Optional[int] = None  # Asset involved in the warning (for price errors)
    details: Optional[Dict[str, Any]] = None  # Additional context (transaction_date, error, etc.)


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
    
    # Asset and account-level balances after this event
    balance_after: Optional[float] = None  # Total asset balance across all accounts
    account_balance_after: Optional[float] = None  # Balance for this specific account
    
    related_lot_id: Optional[int] = None
    triggered_by_transaction_id: Optional[int] = None
    triggered_by_unit_id: Optional[int] = None
    triggered_by_unit_label: Optional[str] = None
    triggered_by_unit_pattern: Optional[str] = None
    
    timestamp: datetime


class ConsumedSliceResponse(BaseModel):
    """Details of a consumed lot slice for audit."""
    
    cost_lot_id: int
    asset: Optional[AssetRef] = None  # Asset of the consumed lot
    quantity: float
    unit_cost_in_base: float
    total_cost_in_base: float
    acquired_at: datetime
    holding_period_days: Optional[int] = None
    consumed_by_leg_id: Optional[int] = None  # Transaction that consumed this slice
    consumed_by_unit_id: Optional[int] = None  # Human-readable label of consuming unit
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


class TransactionSummary(BaseModel):
    """Lightweight transaction reference for leg display.
    
    Shared model used by bundles and P&L endpoints.
    Provides essential transaction context without full object duplication.
    """
    
    id: int
    date_time: Optional[datetime] = None
    
    # Account info
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    
    # Source info
    source: Optional[str] = None
    transaction_type: Optional[str] = None
    source_transaction_type: Optional[str] = None
    source_transaction_id: Optional[str] = None
    direction: Optional[str] = None
    
    # Primary asset
    asset: Optional[AssetRef] = None
    quantity: Optional[float] = None
    
    # Pricing
    price: Optional[float] = None
    price_quote_asset: Optional[AssetRef] = None
    total: Optional[float] = None
    
    # Fee
    fee: Optional[float] = None
    fee_quote_asset: Optional[AssetRef] = None
    
    # Transfer-specific
    from_account_name: Optional[str] = None
    to_account_name: Optional[str] = None
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None
    
    # On-chain
    network: Optional[str] = None
    network_transaction_id: Optional[str] = None
    source_asset_symbol: Optional[str] = None


class LegWithTransaction(BaseModel):
    """Calculation unit leg with transaction reference.
    
    Legs are the building blocks of P&L calculation.
    Transaction details stored once at unit level, legs reference by index.
    """
    
    asset: AssetRef
    qty: float
    leg_type: str  # "outflow", "inflow", "fee"
    direction: Optional[str] = None
    transaction_id: int  # Transaction ID reference


class CostBasisTracking(BaseModel):
    """Grouping of cost basis related data."""
    
    lots: List[CostLotResponse] = []
    consumed: List[ConsumedSliceResponse] = []
    settlements: List[SettlementResponse] = []


class ProcessedUnitResponse(BaseModel):
    """Complete processed calculation unit with nested data.
    
    Returns full nested data in single request - no need for separate drill-down calls.
    
    Structure: Unit → Transactions → Legs
    """
    
    # Identity
    unit_id: Optional[int] = None
    unit_label: str = ""
    pattern: Optional[str] = None  # transfer, swap, split, pending_transfer, unknown
    
    # Timestamp
    timestamp: datetime
    
    # Transactions (now as a list for array access)
    transactions: List[TransactionSummary] = []  # List of TransactionSummary objects
    
    # Legs with transaction references (by index)
    legs: List[LegWithTransaction] = []
    
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
    # Category IDs for client-side filtering (populated when group_by_asset=true)
    category_ids: List[int] = []  # Category IDs assigned to this asset


class PriceResponse(BaseModel):
    """Current price for an asset."""
    
    asset: AssetRef
    price: Optional[float] = None  # None if price unavailable
    price_quote: str  # e.g., "EUR"
    fetched_at: Optional[datetime] = None
    source: Optional[str] = None
    error: Optional[str] = None  # Error message if price fetch failed
    # Staleness/fallback fields
    is_fallback: bool = False  # True if fallback price was used
    is_stale: bool = False  # True if price is outside staleness window
    actual_price_date: Optional[datetime] = None  # The actual date of the price used
    staleness_days: Optional[int] = None  # Days between requested and actual price date
    warning: Optional[str] = None  # Warning message for stale prices


# =============================================================================
# Helper Functions for Response Building (DRY)
# =============================================================================


def build_transaction_summary(tx: NormalizedTransaction) -> TransactionSummary:
    """Build TransactionSummary from NormalizedTransaction with resolved relationships.
    
    Args:
        tx: NormalizedTransaction with eager-loaded relationships (account_rel, 
            price_quote_asset, fee_quote_asset)
    
    Returns:
        TransactionSummary with all fields populated
    """
    return TransactionSummary(
        id=tx.id,
        date_time=tx.date_time,
        # Account
        account_id=tx.account_id,
        account_name=tx.account_rel.name if tx.account_rel else None,
        # Source
        source=tx.source,
        transaction_type=tx.transaction_type,
        source_transaction_type=tx.source_transaction_type,
        source_transaction_id=tx.source_transaction_id,
        direction=tx.direction,
        # asset
        asset=AssetRef(id=tx.asset.asset_id, symbol=tx.asset.symbol, source_symbol=tx.source_asset_symbol) if tx.asset_id else None,
        quantity=float(tx.quantity) if tx.quantity else None,
        # Pricing
        price=float(tx.price) if tx.price else None,
        price_quote_asset=AssetRef(id=tx.price_quote_asset.asset_id, symbol=tx.price_quote_asset.symbol) if tx.price_quote_asset_id else None,
        total=float(tx.total) if tx.total else None,
        # Fee
        fee=float(tx.fee) if tx.fee else None,
        fee_quote_asset=AssetRef(id=tx.fee_quote_asset.asset_id, symbol=tx.fee_quote_asset.symbol) if tx.fee_quote_asset_id else None,
        # Transfer-specific
        from_account_name=tx.from_account.name if tx.from_account else None,
        to_account_name=tx.to_account.name if tx.to_account else None,
        source_from_account=tx.source_from_account,
        source_to_account=tx.source_to_account,
        # On-chain
        network=tx.network,
        network_transaction_id=tx.network_transaction_id,
        source_asset_symbol=tx.source_asset_symbol,
    )


def build_cost_lot_response(lot: CostLot) -> CostLotResponse:
    """Build CostLotResponse from CostLot model."""
    return CostLotResponse(
        cost_lot_id=lot.cost_lot_id,
        asset=AssetRef(id=lot.asset.asset_id, symbol=lot.asset.symbol),
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
    slice: ConsumedLotSlice
) -> ConsumedSliceResponse:
    """Build ConsumedSliceResponse from ConsumedLotSlice model."""
    asset_ref = None
    if slice.cost_lot and slice.cost_lot.asset:
        asset_ref = AssetRef(id=slice.cost_lot.asset.asset_id, symbol=slice.cost_lot.asset.symbol)
    elif slice.cost_lot:
        asset_ref = AssetRef(id=slice.cost_lot.asset_id, symbol=f"#{slice.cost_lot.asset_id}")
    
    return ConsumedSliceResponse(
        cost_lot_id=slice.cost_lot.cost_lot_id if slice.cost_lot else 0,
        asset=asset_ref,
        quantity=float(slice.quantity),
        unit_cost_in_base=float(slice.unit_cost_in_base),
        total_cost_in_base=float(slice.total_cost_in_base),
        acquired_at=slice.cost_lot.acquired_at if slice.cost_lot else slice.created_at,
        holding_period_days=slice.holding_period_days,
        consumed_by_leg_id=slice.consumed_by_leg_id,
        consumed_by_unit_id=slice.unit_id,
        consumed_at=slice.consumed_at,
    )


def build_realized_entry_response(entry: RealizedPnl, is_fee: bool = False) -> RealizedEntryDetailResponse:
    """Build RealizedEntryDetailResponse from RealizedPnl model."""
    return RealizedEntryDetailResponse(
        asset=AssetRef(id=entry.asset.asset_id, symbol=entry.asset.symbol),
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
        asset_id=warning.asset_id,
        details=warning.details,
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
    asset: AssetRef
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
    
    # Entity ID lists for frontend count displays (populated for /calculate and /versions/{id})
    calculation_unit_ids: List[int] = []  # IDs of CalculationUnit records
    warning_ids: List[int] = []  # IDs of PnlWarning records
    cost_lot_ids: List[int] = []  # IDs of CostLot records
    realized_pnl_ids: List[int] = []  # IDs of RealizedPnl records
    fee_ids: List[int] = []  # IDs of FeeEntry records
    cost_lot_event_ids: List[int] = []  # IDs of CostLotEvent records


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


def fetch_version_entity_ids(session: Session, version_id: int) -> Dict[str, List[int]]:
    """
    Fetch all entity IDs for a version for frontend count displays.
    
    Returns a dict with keys: calculation_unit_ids, warning_ids, cost_lot_ids, 
    realized_pnl_ids, fee_ids, cost_lot_event_ids.
    
    This function is used by both /calculate and /versions/{id} endpoints to 
    populate the ID lists in PnLVersionResponse.
    """
    # Fetch CalculationUnit IDs (direct version_id FK)
    calculation_unit_ids = session.exec(
        select(CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    ).all()
    
    # Fetch FeeEntry IDs (direct version_id FK)
    fee_ids = session.exec(
        select(FeeEntry.id)
        .where(FeeEntry.version_id == version_id)
    ).all()
    
    # Fetch CostLot IDs (via CalculationUnit)
    cost_lot_ids = session.exec(
        select(CostLot.cost_lot_id)
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
    ).all()
    
    # Fetch RealizedPnl IDs (via CalculationUnit)
    realized_pnl_ids = session.exec(
        select(RealizedPnl.pnl_id)
        .join(RealizedPnl.origin_unit)
        .where(CalculationUnit.version_id == version_id)
    ).all()
    
    # Fetch PnlWarning IDs (via CalculationUnit)
    warning_ids = session.exec(
        select(PnlWarning.id)
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
    ).all()
    
    # Fetch CostLotEvent IDs (via CostLot → CalculationUnit)
    cost_lot_event_ids = session.exec(
        select(CostLotEvent.event_id)
        .join(CostLotEvent.lot)
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
    ).all()
    
    return {
        "calculation_unit_ids": list(calculation_unit_ids),
        "warning_ids": list(warning_ids),
        "cost_lot_ids": list(cost_lot_ids),
        "realized_pnl_ids": list(realized_pnl_ids),
        "fee_ids": list(fee_ids),
        "cost_lot_event_ids": list(cost_lot_event_ids),
    }


def build_version_response(
    version: CalculationVersion,
    base_currency_symbol: Optional[str] = None,
    total_realized_pnl: float = 0.0,
    total_fees_in_base: float = 0.0,
    fee_entry_count: int = 0,
    calculation_unit_ids: List[int] = [],
    warning_ids: List[int] = [],
    cost_lot_ids: List[int] = [],
    realized_pnl_ids: List[int] = [],
    fee_ids: List[int] = [],
    cost_lot_event_ids: List[int] = [],
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
        calculation_unit_ids=calculation_unit_ids,
        warning_ids=warning_ids,
        cost_lot_ids=cost_lot_ids,
        realized_pnl_ids=realized_pnl_ids,
        fee_ids=fee_ids,
        cost_lot_event_ids=cost_lot_event_ids,
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
        # Get base currency asset - prefer symbol over ID (symbol is stable across DB resets)
        base_currency = None
        if request.base_currency_symbol:
            base_currency = session.exec(
                select(Asset).where(Asset.symbol == request.base_currency_symbol)
            ).first()
            if not base_currency:
                raise HTTPException(
                    status_code=400,
                    detail=f"Base currency '{request.base_currency_symbol}' not found",
                )
        elif request.base_currency_id:
            base_currency = session.get(Asset, request.base_currency_id)
            if not base_currency:
                raise HTTPException(
                    status_code=400,
                    detail=f"Base currency asset ID {request.base_currency_id} not found",
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
            compute_residuals=request.compute_residuals,
            crypto_swap_taxable_by_default=request.crypto_swap_taxable_by_default,
            fee_taxable_by_default=request.fee_taxable_by_default,  
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
        
        # Fetch entity IDs for frontend count displays
        entity_ids = fetch_version_entity_ids(session, version.version_id)

        return build_version_response(
            version=version,
            base_currency_symbol=base_currency.symbol,
            total_realized_pnl=float(result.total_realized_pnl),
            total_fees_in_base=total_fees_in_base,
            fee_entry_count=fee_entry_count,
            calculation_unit_ids=entity_ids["calculation_unit_ids"],
            warning_ids=entity_ids["warning_ids"],
            cost_lot_ids=entity_ids["cost_lot_ids"],
            realized_pnl_ids=entity_ids["realized_pnl_ids"],
            fee_ids=entity_ids["fee_ids"],
            cost_lot_event_ids=entity_ids["cost_lot_event_ids"],
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


@router.get("/prices/{asset_id}", response_model=PriceResponse)
def get_asset_price(
    asset_id: int,
    base_currency: str = Query("EUR", description="Quote currency for price"),
    use_fallback: bool = Query(True, description="Fall back to latest known price if fetch fails"),
    staleness_window_days: int = Query(7, description="Max days to consider price fresh (for fallback)"),
    session: Session = Depends(get_session_dependency),
):
    """
    Fetch current price for a single asset.
    
    If use_fallback is True and the live price fetch fails, will return the latest
    cached price. If that cached price is older than staleness_window_days, the
    response will include is_stale=True and a warning message.
    """
    from datetime import datetime
    price_service = PriceService(session=session)
    
    asset = session.get(Asset, asset_id)
    if not asset:
        return PriceResponse(
            asset=AssetRef(id=asset_id, symbol=f"#{asset_id}"),
            price=None,
            price_quote=base_currency,
            error=f"Asset {asset_id} not found",
        )
    
    try:
        # Use fallback method for current price
        result = price_service.get_price_with_fallback(
            asset_id=asset_id,
            dt=datetime.utcnow(),
            price_quote=base_currency,
            use_fallback=use_fallback,
            staleness_window_days=staleness_window_days,
        )
        
        warning_msg = None
        if result.is_stale:
            warning_msg = f"Using stale price from {result.actual_price_date.strftime('%Y-%m-%d') if result.actual_price_date else 'unknown'} ({result.staleness_days} days old)"
        
        return PriceResponse(
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol or f"#{asset.asset_id}"),
            price=result.price,
            price_quote=base_currency,
            fetched_at=result.timestamp,
            source=result.source,
            error=None,
            is_fallback=result.is_fallback,
            is_stale=result.is_stale,
            actual_price_date=result.actual_price_date,
            staleness_days=result.staleness_days,
            warning=warning_msg,
        )
    except Exception as e:
        log.error(f"Failed to fetch price for asset {asset_id}: {e}")
        return PriceResponse(
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol or f"#{asset.asset_id}"),
            price=None,
            price_quote=base_currency,
            error=str(e),
        )


class PriceRequest(BaseModel):
    """Request for bulk price lookup."""
    
    asset_ids: List[int] = Field(..., description="List of asset IDs to fetch prices for")
    base_currency: str = Field(default="EUR", description="Quote currency for prices")
    use_fallback: bool = Field(default=True, description="Fall back to latest known price if fetch fails")
    staleness_window_days: int = Field(default=7, description="Max days to consider price fresh (for fallback)")


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
    
    If use_fallback is True and live fetch fails, returns the latest cached price.
    Stale prices (older than staleness_window_days) will have is_stale=True and a warning.
    """
    from datetime import datetime
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
    stale_count = 0
    
    for asset_id in request.asset_ids:
        asset = asset_map.get(asset_id)
        if not asset:
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, symbol=f"#{asset_id}"),
                price=None,
                price_quote=request.base_currency,
                error=f"Asset {asset_id} not found",
            ))
            failed += 1
            continue
        
        try:
            result = price_service.get_price_with_fallback(
                asset_id=asset_id,
                dt=fetched_at,
                price_quote=request.base_currency,
                use_fallback=request.use_fallback,
                staleness_window_days=request.staleness_window_days,
            )
            
            warning_msg = None
            if result.is_stale:
                warning_msg = f"Using stale price from {result.actual_price_date.strftime('%Y-%m-%d') if result.actual_price_date else 'unknown'} ({result.staleness_days} days old)"
                stale_count += 1
            
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, symbol=asset.symbol),
                price=result.price,
                price_quote=request.base_currency,
                fetched_at=result.timestamp or fetched_at,
                source=result.source,
                is_fallback=result.is_fallback,
                is_stale=result.is_stale,
                actual_price_date=result.actual_price_date,
                staleness_days=result.staleness_days,
                warning=warning_msg,
            ))
            successful += 1
        except Exception as e:
            log.warning("price_fetch_failed", asset_symbol=asset.symbol, error=str(e))
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, symbol=asset.symbol),
                price=None,
                price_quote=request.base_currency,
                error=str(e),
            ))
            failed += 1
    
    warning = None
    warnings = []
    if failed > 0:
        warnings.append(f"{failed} price(s) could not be retrieved")
    if stale_count > 0:
        warnings.append(f"{stale_count} price(s) are stale (older than {request.staleness_window_days} days)")
    if warnings:
        warning = ". ".join(warnings) + ". See 'prices' for details."
    
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
    
    # Fetch entity IDs for frontend count displays
    entity_ids = fetch_version_entity_ids(session, version_id)
    
    return build_version_response(
        version=version,
        base_currency_symbol=base_currency_symbol,
        total_realized_pnl=float(total_pnl),
        calculation_unit_ids=entity_ids["calculation_unit_ids"],
        warning_ids=entity_ids["warning_ids"],
        cost_lot_ids=entity_ids["cost_lot_ids"],
        realized_pnl_ids=entity_ids["realized_pnl_ids"],
        fee_ids=entity_ids["fee_ids"],
        cost_lot_event_ids=entity_ids["cost_lot_event_ids"],
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


@router.get("/versions/{version_id}/lots")
def get_version_lots(
    version_id: int,
    include_zero_remaining: bool = True,
    include_unsettled_negative: bool = True,
    asset_id: Optional[int] = None,
    account_id: Optional[int] = None,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
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
                                    
    Returns:
        PaginatedResponse with items, total, page, limit
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query for counting and pagination
    base_query = (
        select(CostLot)
        .join(CostLot.unit)  # join the related CalculationUnit
        .where(CalculationUnit.version_id == version_id)
    )
    base_query, _ = _apply_unit_filter(base_query, tx_filters, version_id, session, unit_column=CostLot.unit_id)
    
    if not include_zero_remaining:
        base_query = base_query.where(CostLot.qty_remaining > 0)
    
    if not include_unsettled_negative:
        # Exclude lots that are negative AND not yet settled
        base_query = base_query.where(
            not_(CostLot.is_negative) | CostLot.is_settled
        )
    
    if asset_id:
        base_query = base_query.where(CostLot.asset_id == asset_id)
    
    if account_id:
        base_query = base_query.where(CostLot.account_id == account_id)
    
    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()
    
    # Add eager loading and pagination
    offset = (page - 1) * limit
    query = (
        base_query.options(
            selectinload(CostLot.asset), 
            selectinload(CostLot.account),
            selectinload(CostLot.unit),  # Eager load unit for origin_unit_label
        )
        .order_by(CostLot.acquired_at)
        .offset(offset)
        .limit(limit)
    )
    
    lots = session.exec(query).all()
    
    items = [
        CostLotResponse(
            cost_lot_id=lot.cost_lot_id,
            asset=AssetRef(
                id=lot.asset.asset_id if lot.asset else lot.asset_id,
                symbol=lot.asset.symbol if lot.asset else f"#{lot.asset_id}"
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
    
    return {"items": items, "total": total, "page": page, "limit": limit}


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
                symbol=s.cost_lot.asset.symbol if s.cost_lot and s.cost_lot.asset else f"#{s.cost_lot.asset_id if s.cost_lot else 0}"
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


@router.get("/versions/{version_id}/realized-pnl")
def get_version_realized_pnl(
    version_id: int,
    asset_id: Optional[int] = None,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get realized P&L entries for a specific version.
    
    Supports pagination and filtering by asset_id.
    Uses eager loading to fetch asset relationships in a single query.
    
    Returns:
        PaginatedResponse with items, total, page, limit
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query for counting
    base_query = (
        select(RealizedPnl)
        .join(RealizedPnl.origin_unit)
        .where(CalculationUnit.version_id == version_id)
    )
    base_query, _ = _apply_unit_filter(base_query, tx_filters, version_id, session, unit_column=RealizedPnl.origin_unit_id)
    
    if asset_id:
        base_query = base_query.where(RealizedPnl.asset_id == asset_id)
    
    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()
    
    # Add eager loading and pagination
    offset = (page - 1) * limit
    query = (
        base_query.options(selectinload(RealizedPnl.asset))
        .order_by(RealizedPnl.realized_at)
        .offset(offset)
        .limit(limit)
    )
    
    entries = session.exec(query).all()
    
    items = [
        RealizedPnLResponse(
            asset=AssetRef(
                id=e.asset.asset_id if e.asset else e.asset_id,
                symbol=e.asset.symbol if e.asset else f"#{e.asset_id}"
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
    
    return {"items": items, "total": total, "page": page, "limit": limit}


class FeesResponse(BaseModel):
    """Response for fees endpoint with items, summary, and pagination."""
    fees: List[FeeEntryResponse]
    summary: FeeSummaryResponse
    total: int
    page: int
    limit: int


@router.get("/versions/{version_id}/fees", response_model=FeesResponse)
def get_version_fees(
    version_id: int,
    asset_id: Optional[int] = None,
    unit_id: Optional[int] = None,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
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
    query, _ = _apply_unit_filter(query, tx_filters, version_id, session, unit_column=FeeEntry.unit_id)
    
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
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol),
            fee_amount=float(leg.quantity) if leg.quantity else 0.0,
            fee_in_base=float(fee_entry.fee_value_in_base),
            transaction_id=leg.transaction_id,
            unit_id=fee_entry.unit_id,
            source=tx.source if tx else None,
            transaction_type=tx.transaction_type if tx else None,
            cost_basis_consumed=float(rpnl.cost_basis_in_base) if rpnl else 0.0,
            realized_pnl=float(rpnl.pnl_in_base) if rpnl else 0.0,
            related_asset=AssetRef(id=related[0], symbol=related[1]) if related else None,
        ))
    
    return FeesResponse(
        fees=fee_responses,
        summary=FeeSummaryResponse(
            total_fees_in_base=total_fees,
            fees_by_asset=fees_by_asset,
            fees_by_source=fees_by_source,
            disposal_taxable_fee_count=disposal_taxable_count,
        ),
        total=len(all_results),
        page=page,
        limit=limit,
    )


@router.get("/versions/{version_id}/balances", response_model=List[BalanceResponse])
def get_version_balances(
    version_id: int,
    group_by_asset: bool = False,
    include_unsettled_negative: bool = False,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
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
    
    # Resolve unit-level filter from transaction filters
    filtered_unit_ids = None
    if tx_filters.has_active_filters:
        filtered_unit_ids = resolve_filtered_unit_ids(
            session, version_id, tx_filters.applied_filters,
            non_owned=tx_filters.non_owned,
        )

    # Query cost lots with remaining qty, eager load asset and account
    query = (
        select(CostLot)
        .join(CostLot.unit)  # join the related CalculationUnit
        .options(selectinload(CostLot.asset), selectinload(CostLot.account))
        .where(CalculationUnit.version_id == version_id)
        #.where(CostLot.qty_remaining > 0)
    )
    if filtered_unit_ids is not None:
        query = query.where(CostLot.unit_id.in_(filtered_unit_ids))
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
        if filtered_unit_ids is not None:
            realized_query = realized_query.where(RealizedPnl.origin_unit_id.in_(filtered_unit_ids))
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
        if filtered_unit_ids is not None:
            warning_query = warning_query.where(PnlWarning.unit_id.in_(filtered_unit_ids))
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
        if filtered_unit_ids is not None:
            fee_query = fee_query.where(FeeEntry.unit_id.in_(filtered_unit_ids))
        fee_results = session.exec(fee_query).all()
        fee_map = {r.related_asset_id: float(r.total_fees_fmv or 0) for r in fee_results}
        
        # Query category IDs for all assets in the balance
        asset_ids_in_balance = list(balance_map.keys())
        category_query = (
            select(AssetCategory.asset_id, AssetCategory.category_id)
            .where(AssetCategory.asset_id.in_(asset_ids_in_balance))
        )
        category_results = session.exec(category_query).all()
        # Build map of asset_id -> list of category_ids
        category_map: Dict[int, List[int]] = defaultdict(list)
        for row in category_results:
            category_map[row.asset_id].append(row.category_id)
        
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
                    symbol=data["asset"].symbol if data["asset"] else f"#{asset_id}"
                ),
                account_id=None,  # Aggregated across accounts
                account_name=None,
                account_ids=sorted(list(data["account_ids"])),  # All accounts holding this asset
                qty=float(data["qty"]),
                cost_basis_in_base=float(data["cost"]),
                avg_unit_cost_in_base=float(data["cost"] / data["qty"]) if data["qty"] > 0 else 0.0,
                lot_count=data["lots"],
                # Aggregated P&L data
                realized_pnl_in_base=realized_map.get(asset_id, {}).get("pnl", 0.0),
                realized_event_count=realized_map.get(asset_id, {}).get("count", 0),
                warning_count=warning_map.get(asset_id, 0),
                # Fee tracking
                total_fees_in_base=fee_map.get(asset_id, 0.0),
                unsettled_negative_count=unsettled_negative_by_asset.get(asset_id, 0),
                category_ids=sorted(category_map.get(asset_id, [])),
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
                    symbol=data["asset"].symbol if data["asset"] else f"#{asset_id}"
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


@router.get("/versions/{version_id}/warnings")
def get_version_warnings(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get warnings for a specific version.
    
    Returns:
        PaginatedResponse with items, total, page, limit
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query for counting
    base_query = (
        select(PnlWarning)
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
    )
    base_query, _ = _apply_unit_filter(base_query, tx_filters, version_id, session, unit_column=PnlWarning.unit_id)
    
    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()
    
    # Add pagination
    offset = (page - 1) * limit
    query = base_query.order_by(PnlWarning.created_at).offset(offset).limit(limit)
    
    warnings = session.exec(query).all()
    
    items = [
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
    
    return {"items": items, "total": total, "page": page, "limit": limit}


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


@router.get("/versions/{version_id}/lot-events")
def get_version_lot_events(
    version_id: int,
    lot_id: Optional[int] = None,
    event_type: Optional[str] = None,  # Comma-separated
    asset_id: Optional[str] = None,  # Comma-separated
    related_asset_id: Optional[str] = None,  # Comma-separated – broader than asset_id
    account_id: Optional[str] = None,  # Comma-separated
    unit_pattern: Optional[str] = None,  # Comma-separated: 'transfer', 'pending_transfer', etc.
    unit_id: Optional[int] = None,
    date_start: Optional[str] = None,  # ISO datetime string for filtering
    date_end: Optional[str] = None,  # ISO datetime string for filtering
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    page: int = 1,
    limit: int = 100,
    session: Session = Depends(get_session_dependency),
):
    """
    Get cost lot events for a calculation version with filtering.
    
    Provides chronological audit trail of all lot state changes:
    - created: Lot created from acquisition
    - consumed: Lot consumed in disposal
    - settled: Negative lot settled by later inflow
    - transferred: Lot moved between accounts
    - adjusted: Manual cost basis adjustment
    
    Query params:
        event_type: Comma-separated event types to filter
        asset_id: Comma-separated asset IDs to filter (lots whose primary asset matches)
        related_asset_id: Comma-separated asset IDs – returns events on lots of this
            asset AND events triggered by units that have a leg involving this asset
            (e.g. price-quote, fee-quote). Broader than asset_id.
        account_id: Comma-separated account IDs to filter
        unit_pattern: Comma-separated unit patterns ('transfer', 'pending_transfer', 'swap', etc.)
        date_start: ISO datetime string for start of date range filter
        date_end: ISO datetime string for end of date range filter
    
    Returns:
        PaginatedResponse with items, total, page, limit
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query for counting
    base_query = (
        select(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    )
    base_query, _ = _apply_unit_filter(base_query, tx_filters, version_id, session, unit_column=CostLot.unit_id)
    
    # Apply filters
    if lot_id:
        base_query = base_query.where(CostLotEvent.lot_id == lot_id)
    
    # Event type filter (comma-separated)
    if event_type:
        types = [t.strip() for t in event_type.split(',')]
        base_query = base_query.where(CostLotEvent.event_type.in_(types))
    
    # Asset filter (comma-separated)
    if asset_id:
        asset_ids = [int(id.strip()) for id in asset_id.split(',')]
        base_query = base_query.where(CostLot.asset_id.in_(asset_ids))
    
    # Related-asset filter: cost lot events are always about one specific asset
    # (the lot's asset), so filter directly on CostLot.asset_id.
    if related_asset_id:
        related_ids = [int(id.strip()) for id in related_asset_id.split(',')]
        base_query = base_query.where(CostLot.asset_id.in_(related_ids))
    
    # Account filter (comma-separated)
    if account_id:
        account_ids = [int(id.strip()) for id in account_id.split(',')]
        base_query = base_query.where(CostLot.account_id.in_(account_ids))
    
    # Unit pattern filter (comma-separated)
    if unit_pattern:
        patterns = [p.strip() for p in unit_pattern.split(',')]
        base_query = base_query.where(CalculationUnit.pattern.in_(patterns))
    
    # Specific unit filter
    if unit_id:
        base_query = base_query.where(CostLotEvent.triggered_by_unit_id == unit_id)
    
    # Date range filter (using centralized helpers for date-only support)
    if date_start:
        try:
            from backend.core.utils import parse_date_from
            start_dt = parse_date_from(date_start)
            base_query = base_query.where(CostLotEvent.timestamp >= start_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date_start format: {date_start}")
    
    if date_end:
        try:
            from backend.core.utils import parse_date_to
            end_dt = parse_date_to(date_end)
            base_query = base_query.where(CostLotEvent.timestamp <= end_dt)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date_end format: {date_end}")
    
    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()
    
    # Add eager loading and pagination
    offset = (page - 1) * limit
    query = (
        base_query.options(
            selectinload(CostLotEvent.lot).selectinload(CostLot.asset),
            selectinload(CostLotEvent.lot).selectinload(CostLot.account),
            selectinload(CostLotEvent.related_lot),
            selectinload(CostLotEvent.triggered_by_unit),
        )
        .order_by(CostLotEvent.timestamp.desc(), CostLotEvent.sequence_num.desc())
        .offset(offset)
        .limit(limit)
    )
    
    events = session.exec(query).all()
    
    items = [
        CostLotEventResponse(
            event_id=e.event_id,
            event_type=e.event_type,
            lot_id=e.lot_id,
            asset=AssetRef(id=e.lot.asset.asset_id, symbol=e.lot.asset.symbol) if e.lot and e.lot.asset else None,
            account_id=e.lot.account_id if e.lot else None,
            account_name=e.lot.account.name if e.lot and e.lot.account else None,
            quantity_delta=float(e.quantity_delta),
            cost_basis_delta=float(e.cost_basis_delta) if e.cost_basis_delta else None,
            qty_remaining_after=float(e.qty_remaining_after),
            cost_basis_remaining_after=float(e.cost_basis_remaining_after) if e.cost_basis_remaining_after else None,
            balance_after=float(e.balance_after) if e.balance_after is not None else None,
            account_balance_after=float(e.account_balance_after) if e.account_balance_after is not None else None,
            related_lot_id=e.related_lot_id,
            triggered_by_transaction_id=e.triggered_by_transaction_id,
            triggered_by_unit_id=e.triggered_by_unit_id,
            triggered_by_unit_label=e.triggered_by_unit.unit_label if e.triggered_by_unit else None,
            triggered_by_unit_pattern=e.triggered_by_unit.pattern if e.triggered_by_unit else None,
            timestamp=e.timestamp,
        )
        for e in events
    ]
    
    return {"items": items, "total": total, "page": page, "limit": limit}


class FilterOptionsAsset(BaseModel):
    """Asset option for filter dropdown."""
    id: int
    symbol: str
    label: Optional[str] = None


class FilterOptionsAccount(BaseModel):
    """Account option for filter dropdown."""
    id: int
    name: str


class LotEventsFilterOptionsResponse(BaseModel):
    """Response for lot events filter options endpoint."""
    assets: List[FilterOptionsAsset]
    accounts: List[FilterOptionsAccount]


@router.get("/versions/{version_id}/lot-events/filter-options", response_model=LotEventsFilterOptionsResponse)
def get_lot_events_filter_options(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get all available filter options for lot events in a calculation version.
    
    Returns unique assets and accounts that have lot events in this version,
    allowing the filter dropdowns to show ALL options regardless of current filter state.
    
    This enables filtering by any asset/account that exists in the version,
    not just those currently displayed after filtering.
    """
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Get unique assets from lot events in this version
    asset_query = (
        select(Asset.asset_id, Asset.symbol, Asset.label)
        .select_from(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(Asset, CostLot.asset_id == Asset.asset_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .distinct()
        .order_by(Asset.symbol)
    )
    assets = session.exec(asset_query).all()
    
    # Get unique accounts from lot events in this version
    from backend.db.models import Account
    account_query = (
        select(Account.id, Account.name)
        .select_from(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(Account, CostLot.account_id == Account.id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(CostLot.account_id.isnot(None))
        .distinct()
        .order_by(Account.name)
    )
    accounts = session.exec(account_query).all()
    
    return LotEventsFilterOptionsResponse(
        assets=[FilterOptionsAsset(id=a[0], symbol=a[1], label=a[2]) for a in assets],
        accounts=[FilterOptionsAccount(id=acc[0], name=acc[1]) for acc in accounts],
    )


# =============================================================================
# P&L Transaction Filter Options
# =============================================================================


class PnLFilterOption(BaseModel):
    """A single filter option with value and label."""
    value: str
    label: str
    count: Optional[int] = None


class PnLDimensionWithCategories(BaseModel):
    """Dimension with its categories."""
    id: int
    label: str
    categories: List[PnLFilterOption]


class PnLFilterOptionsResponse(BaseModel):
    """
    Response for P&L filter options – same shape as the transaction filter options
    so the frontend TransactionFilters component can consume it directly.
    Adds non_owned_count for the Counterparty filter card.
    """
    sources: List[PnLFilterOption]
    accounts: List[PnLFilterOption]
    from_accounts: List[PnLFilterOption]
    to_accounts: List[PnLFilterOption]
    assets: List[PnLFilterOption]
    categories: List[PnLFilterOption]
    categories_by_dimension: List[PnLDimensionWithCategories]
    dimensions: List[PnLFilterOption]
    transaction_types: List[PnLFilterOption]
    directions: List[PnLFilterOption]
    review_statuses: List[PnLFilterOption]
    taxability_statuses: List[PnLFilterOption]
    connector_runs: List[PnLFilterOption]
    tags: List[PnLFilterOption]
    networks: List[PnLFilterOption]
    non_owned_count: int = 0


@router.get("/versions/{version_id}/filter-options", response_model=PnLFilterOptionsResponse)
def get_pnl_filter_options(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get all available filter options scoped to a P&L calculation version.

    Returns the same shape as the transactions filter-options endpoint so the
    shared TransactionFilters component can be reused.  Options are scoped to
    the transactions that participate in this version (via CalculationUnitLeg).
    """
    from sqlalchemy import distinct, or_, cast, String

    # ------------------------------------------------------------------
    # Verify version
    # ------------------------------------------------------------------
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # ------------------------------------------------------------------
    # CTE: transaction IDs that belong to this version
    # ------------------------------------------------------------------
    version_txs = (
        select(distinct(CalculationUnitLeg.transaction_id).label("id"))
        .join(CalculationUnit, CalculationUnitLeg.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    ).cte("version_txs")

    # Shorthand for joining NormalizedTransaction to the version CTE
    def _versioned_count():
        return (
            select(func.count(version_txs.c.id))
            .join(NormalizedTransaction, NormalizedTransaction.id == version_txs.c.id)
        )

    # ------------------------------------------------------------------
    # Sources
    # ------------------------------------------------------------------
    source_q = (
        select(NormalizedTransaction.source, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(NormalizedTransaction.source)
        .order_by(NormalizedTransaction.source)
    )
    source_options = [
        PnLFilterOption(value=s[0], label=s[0], count=s[1])
        for s in session.exec(source_q).all() if s[0]
    ]

    # ------------------------------------------------------------------
    # Accounts (main account_id) + unmapped
    # ------------------------------------------------------------------
    account_q = (
        select(Account.id, Account.name, func.count(version_txs.c.id).label("cnt"))
        .outerjoin(NormalizedTransaction, NormalizedTransaction.account_id == Account.id)
        .outerjoin(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(Account.id, Account.name)
        .order_by(Account.name)
    )
    account_options = [
        PnLFilterOption(value=str(a[0]), label=a[1], count=a[2] or 0)
        for a in session.exec(account_q).all()
    ]
    # Undefined (NULL account_id)
    unmapped_account_cnt = session.exec(
        select(func.count(NormalizedTransaction.id))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .where(NormalizedTransaction.account_id.is_(None))
    ).one()
    if unmapped_account_cnt > 0:
        account_options.append(
            PnLFilterOption(value="undefined", label="\u2753 Undefined", count=unmapped_account_cnt)
        )

    # ------------------------------------------------------------------
    # From accounts + undefined (NULL) + non-owned count
    # ------------------------------------------------------------------
    from_q = (
        select(Account.id, Account.name, Account.owned, func.count(version_txs.c.id).label("cnt"))
        .join(NormalizedTransaction, NormalizedTransaction.from_account_id == Account.id)
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(Account.id, Account.name, Account.owned)
        .order_by(Account.name)
    )
    from_rows = session.exec(from_q).all()
    from_account_options: List[PnLFilterOption] = [
        PnLFilterOption(value=str(r[0]), label=r[1], count=r[3] or 0)
        for r in from_rows
    ]
    # Undefined (NULL from_account_id)
    undefined_from_cnt = session.exec(
        select(func.count(NormalizedTransaction.id))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .where(NormalizedTransaction.from_account_id.is_(None))
    ).one()
    if undefined_from_cnt > 0:
        from_account_options.insert(
            0, PnLFilterOption(value="undefined", label="\u2753 Undefined", count=undefined_from_cnt)
        )

    # ------------------------------------------------------------------
    # To accounts + undefined (NULL) + non-owned count
    # ------------------------------------------------------------------
    to_q = (
        select(Account.id, Account.name, Account.owned, func.count(version_txs.c.id).label("cnt"))
        .join(NormalizedTransaction, NormalizedTransaction.to_account_id == Account.id)
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(Account.id, Account.name, Account.owned)
        .order_by(Account.name)
    )
    to_rows = session.exec(to_q).all()
    to_account_options: List[PnLFilterOption] = [
        PnLFilterOption(value=str(r[0]), label=r[1], count=r[3] or 0)
        for r in to_rows
    ]
    undefined_to_cnt = session.exec(
        select(func.count(NormalizedTransaction.id))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .where(NormalizedTransaction.to_account_id.is_(None))
    ).one()
    if undefined_to_cnt > 0:
        to_account_options.insert(
            0, PnLFilterOption(value="undefined", label="\u2753 Undefined", count=undefined_to_cnt)
        )

    # ------------------------------------------------------------------
    # Non-owned count (includes unmapped / NULL from/to)
    # A transaction is "non-owned" if *any* of its account references
    # points to a non-owned account or is NULL.
    # ------------------------------------------------------------------
    non_owned_subq = (
        select(func.count(distinct(NormalizedTransaction.id)))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .where(
            or_(
                NormalizedTransaction.from_account_id.in_(
                    select(Account.id).where(Account.owned == False)
                ),
                NormalizedTransaction.to_account_id.in_(
                    select(Account.id).where(Account.owned == False)
                ),
                NormalizedTransaction.from_account_id.is_(None),
                NormalizedTransaction.to_account_id.is_(None),
            )
        )
    )
    non_owned_count = session.exec(non_owned_subq).one() or 0

    # ------------------------------------------------------------------
    # Assets
    # ------------------------------------------------------------------
    asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(version_txs.c.id).label("cnt"))
        .join(NormalizedTransaction, NormalizedTransaction.asset_id == Asset.asset_id)
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(Asset.symbol)
    )
    asset_options = [
        PnLFilterOption(
            value=str(a[0]),
            label=f"{a[1]}" + (f" ({a[2]})" if a[2] else ""),
            count=a[3],
        )
        for a in session.exec(asset_q).all()
    ]

    # ------------------------------------------------------------------
    # Categories + dimensions
    # ------------------------------------------------------------------
    cat_q = (
        select(Category, Dimension)
        .join(Dimension, Category.dimension_id == Dimension.id)
        .order_by(Dimension.ordinal, Category.label)
    )
    cat_results = session.exec(cat_q).all()
    category_options = [PnLFilterOption(value=str(c.id), label=c.label) for c, _ in cat_results]

    dims_dict: Dict[int, PnLDimensionWithCategories] = {}
    for cat, dim in cat_results:
        if dim.id not in dims_dict:
            dims_dict[dim.id] = PnLDimensionWithCategories(id=dim.id, label=dim.label, categories=[])
        dims_dict[dim.id].categories.append(
            PnLFilterOption(value=str(cat.id), label=cat.label)
        )
    categories_by_dimension = list(dims_dict.values())

    dim_q = select(Dimension).order_by(Dimension.ordinal)
    dimension_options = [PnLFilterOption(value=str(d.id), label=d.label) for d in session.exec(dim_q).all()]

    # ------------------------------------------------------------------
    # Transaction types
    # ------------------------------------------------------------------
    type_q = (
        select(NormalizedTransaction.transaction_type, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(NormalizedTransaction.transaction_type)
        .order_by(NormalizedTransaction.transaction_type)
    )
    type_options = [
        PnLFilterOption(value=t[0], label=t[0].title() if t[0] else "Unknown", count=t[1])
        for t in session.exec(type_q).all() if t[0]
    ]

    # ------------------------------------------------------------------
    # Directions
    # ------------------------------------------------------------------
    dir_q = (
        select(NormalizedTransaction.direction, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(NormalizedTransaction.direction)
        .order_by(NormalizedTransaction.direction)
    )
    direction_options = [
        PnLFilterOption(value=d[0], label=d[0].title() if d[0] else "Unknown", count=d[1])
        for d in session.exec(dir_q).all() if d[0]
    ]

    # ------------------------------------------------------------------
    # Review statuses (included for shape compatibility – P&L hides these)
    # ------------------------------------------------------------------
    review_q = (
        select(NormalizedTransaction.review_status, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(NormalizedTransaction.review_status)
    )
    review_counts = {r[0]: r[1] for r in session.exec(review_q).all()}
    review_status_options = [
        PnLFilterOption(value="pending", label="Pending", count=review_counts.get("pending", 0)),
        PnLFilterOption(value="valid", label="Valid", count=review_counts.get("valid", 0)),
        PnLFilterOption(value="invalid", label="Invalid", count=review_counts.get("invalid", 0)),
    ]

    # ------------------------------------------------------------------
    # Taxability statuses (included for shape compatibility – P&L hides these)
    # ------------------------------------------------------------------
    tax_q = (
        select(NormalizedTransaction.taxability_status, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(NormalizedTransaction.taxability_status)
    )
    tax_counts = {t[0]: t[1] for t in session.exec(tax_q).all()}
    taxability_options = [
        PnLFilterOption(value="taxable", label="Taxable", count=tax_counts.get("taxable", 0)),
        PnLFilterOption(value="non_taxable", label="Non-Taxable", count=tax_counts.get("non_taxable", 0)),
        PnLFilterOption(value="unknown", label="Unknown", count=tax_counts.get("unknown", 0)),
    ]

    # ------------------------------------------------------------------
    # Connector runs
    # ------------------------------------------------------------------
    cr_q = (
        select(
            SyncJobConnectorRun.id, SyncJobConnectorRun.connector_type,
            SyncJobConnectorRun.account_name, SyncJobConnectorRun.started_at,
            func.count(version_txs.c.id).label("cnt"),
        )
        .outerjoin(NormalizedTransaction, NormalizedTransaction.sync_connector_run_id == SyncJobConnectorRun.id)
        .outerjoin(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .group_by(
            SyncJobConnectorRun.id, SyncJobConnectorRun.connector_type,
            SyncJobConnectorRun.account_name, SyncJobConnectorRun.started_at,
        )
        .having(func.count(version_txs.c.id) > 0)
        .order_by(SyncJobConnectorRun.started_at.desc())
        .limit(50)
    )
    connector_run_options = [
        PnLFilterOption(
            value=str(cr[0]),
            label=f"{cr[2] or 'Unknown'} {cr[1]} #{cr[0]} - ({cr[3].strftime('%m/%d %H:%M') if cr[3] else 'N/A'})",
            count=cr[4],
        )
        for cr in session.exec(cr_q).all()
    ]

    # ------------------------------------------------------------------
    # Tags
    # ------------------------------------------------------------------
    try:
        tag_stmt = (
            select(NormalizedTransaction.tags)
            .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
            .where(NormalizedTransaction.tags.isnot(None))
        )
        unique_tags: set[str] = set()
        for tags in session.exec(tag_stmt).all():
            if tags and isinstance(tags, list):
                for tag in tags:
                    if isinstance(tag, dict):
                        for k, v in tag.items():
                            unique_tags.add(f"{k}:{v}")
        tag_options = [
            PnLFilterOption(value=ts, label=ts.replace("_", " ").replace(":", ": "))
            for ts in sorted(unique_tags) if ts
        ]
    except Exception:
        tag_options = []

    # ------------------------------------------------------------------
    # Networks
    # ------------------------------------------------------------------
    from backend.core.network_normalizer import get_network_display_name

    net_q = (
        select(NormalizedTransaction.network, func.count(version_txs.c.id).label("cnt"))
        .join(version_txs, NormalizedTransaction.id == version_txs.c.id)
        .where(NormalizedTransaction.network.isnot(None))
        .where(NormalizedTransaction.network != "")
        .group_by(NormalizedTransaction.network)
        .order_by(NormalizedTransaction.network)
    )
    network_options = [
        PnLFilterOption(value=n[0], label=get_network_display_name(n[0]), count=n[1])
        for n in session.exec(net_q).all() if n[0]
    ]

    # ------------------------------------------------------------------
    # Build response
    # ------------------------------------------------------------------
    return PnLFilterOptionsResponse(
        sources=source_options,
        accounts=account_options,
        from_accounts=from_account_options,
        to_accounts=to_account_options,
        assets=asset_options,
        categories=category_options,
        categories_by_dimension=categories_by_dimension,
        dimensions=dimension_options,
        transaction_types=type_options,
        directions=direction_options,
        review_statuses=review_status_options,
        taxability_statuses=taxability_options,
        connector_runs=connector_run_options,
        tags=tag_options,
        networks=network_options,
        non_owned_count=non_owned_count,
    )


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
            asset=AssetRef(id=e.asset_id, symbol=e.asset.symbol if e.asset else f"#{e.asset_id}"),
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


@router.get("/versions/{version_id}/units")
def get_version_units(
    version_id: int,
    asset_id: Optional[int] = None,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
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
        
    Returns:
        PaginatedResponse with items, total, page, limit
    """
    from backend.db.models import CalculationUnitLeg
    
    # Verify version exists
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Build base query for counting
    base_query = select(CalculationUnit).where(CalculationUnit.version_id == version_id)
    base_query, _ = _apply_unit_filter(base_query, tx_filters, version_id, session, unit_column=CalculationUnit.id)
    
    # Filter by asset_id if provided
    if asset_id is not None:
        base_query = base_query.join(CalculationUnit.legs).where(
            CalculationUnitLeg.asset_id == asset_id
        ).distinct()
    
    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()
    
    # Build paginated query with eager loading
    offset = (page - 1) * limit
    query = (
        base_query.options(
            # Legs with assets and full transaction details (for compact display)
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.asset),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.account_rel),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.price_quote_asset),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.fee_quote_asset),
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
        .order_by(CalculationUnit.timestamp.desc())  # Most recent first
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
        # Build deduplicated transactions dictionary (temporary for mapping)
        transactions_dict: Dict[int, TransactionSummary] = {}
        for leg in u.legs:
            if leg.transaction_id not in transactions_dict and leg.transaction:
                transactions_dict[leg.transaction_id] = build_transaction_summary(leg.transaction)
        
        # Convert to list and create ID-to-index mapping
        transactions_list = list(transactions_dict.values())

        # Build legs with transaction references (now by index)
        legs = [
            LegWithTransaction(
                asset=AssetRef(id=leg.asset.asset_id, symbol=leg.asset.symbol),
                qty=float(leg.quantity),
                leg_type=leg.leg_type,
                direction=leg.direction,
                transaction_id=leg.transaction_id,
            )
            for leg in u.legs
        ]
        
        # Build cost lots
        lots = [build_cost_lot_response(lot) for lot in u.cost_lots]
        
        # Build consumed slices for this unit
        consumed = []
        for entry in u.consumed_slices:
            consumed.append(build_consumed_slice_response(
                    entry
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
            # Deduplicated transactions and legs
            transactions=transactions_list,  # Now a list instead of dict
            legs=legs,
            cost_basis=cost_basis,
            realized_entries=realized_entries,
            warnings=warnings,
            event_ids=events_by_unit.get(u.id, []),
            realized_pnl_in_base=float(u.total_realized_pnl_in_base),
            # Unit is taxable if any leg has disposal_taxable=True
            is_disposal_taxable=any(leg.disposal_taxable for leg in u.legs if leg.leg_type in ("outflow", "fee")),
            # Fee indicators
            has_fees=any(leg.leg_type == "fee" for leg in u.legs),
            fee_count=unit_fee_count,
            total_fees_in_base=unit_total_fees,
        ))
    
    return {"items": result, "total": total, "page": page, "limit": limit}


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
    Cannot delete committed versions.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    if version.status == "committed":
        raise HTTPException(
            status_code=400, 
            detail=f"Cannot delete committed version {version_id}"
        )
    
    # Delete in order due to FK constraints
    # Delete child records. Most have ON DELETE CASCADE in the DB, but we explicitly
    # delete them here for clarity and to ensure proper cleanup.
    # Note: Many child tables don't have direct version_id FK - they access version via
    # parent relationships (e.g., PnlWarning→unit→version, CostLot→unit→version).
    
    # Get all units for this version first
    units = session.exec(select(CalculationUnit).where(CalculationUnit.version_id == version_id)).all()
    
    # Delete PnlWarnings (owned by units, no direct version_id FK)
    for unit in units:
        for w in unit.warnings or []:
            session.delete(w)
    
    # Delete LotSettlements (owned by lots, no direct version_id FK)
    for unit in units:
        for lot in unit.cost_lots or []:
            for s in lot.outgoing_settlements or []:
                session.delete(s)
    
    # Delete ConsumedLotSlices (owned by lots, no direct version_id FK)
    for unit in units:
        for lot in unit.cost_lots or []:
            for cs in lot.consumed_slices or []:
                session.delete(cs)
    
    # Delete RealizedPnl (owned by units, no direct version_id FK)
    for unit in units:
        for r in unit.realized_pnl_records or []:
            session.delete(r)
    
    # Delete CostLots (owned by units, no direct version_id FK)
    for unit in units:
        for lot in unit.cost_lots or []:
            session.delete(lot)
    
    # Finally delete the units themselves
    for u in units:
        session.delete(u)
    
    session.delete(version)
    session.commit()
    
    log.info("version_deleted", version_id=version_id)
    
    return {"status": "deleted", "version_id": version_id}
