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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from sqlalchemy import func, not_, or_, case, cast, String as SAString
from sqlalchemy.orm import selectinload

from backend.db.database import get_session_dependency
from backend.db.models import (
    Asset, NormalizedTransaction, CalculationUnit,
    CalculationVersion, CostLot, RealizedPnl, PnlWarning, LotSettlement, ConsumedLotSlice, CostLotEvent, FeeEntry, CalculationUnitLeg,
    AssetCategory, Category, Dimension, UnitPattern, Account, SyncJobConnectorRun, AppSettings,
    PriceSnapshot,
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


# =============================================================================
# Warning severity mapping (deterministic: warning_type -> level)
# =============================================================================

WARNING_SEVERITY_MAP: Dict[str, str] = {
    "insufficient_lots": "error",
    "negative_balance": "error",
    "unexpected_error": "error",
    "unmatched_internal_transfer": "warning",
    "missing_price": "warning",
    "stale_price": "warning",
    "residual_mismatch": "warning",
    "fmv_fetch_failed": "warning",
    "unmatched_group": "warning",
    "zero_cost_lot": "warning",  # Upgraded from "info" — zero-cost means phantom gains
    "provisional_cost_lot": "warning",  # FMV-based cost on negative lot
    "unsettled_negative_lot": "warning",  # Negative lot never settled by acquisition
    "fee_consumption_failed": "info",
}

SEVERITY_TO_WARNING_TYPES: Dict[str, List[str]] = {}
for _wt, _lvl in WARNING_SEVERITY_MAP.items():
    SEVERITY_TO_WARNING_TYPES.setdefault(_lvl, []).append(_wt)


def _get_warning_level(warning_type: str) -> str:
    return WARNING_SEVERITY_MAP.get(warning_type, "info")


# =============================================================================
# Audit summary response models
# =============================================================================

class AuditLotsSummary(BaseModel):
    total: int = 0
    open: int = 0
    exhausted: int = 0
    negative: int = 0

class AuditRealizedSummary(BaseModel):
    total: int = 0
    taxable: int = 0
    non_taxable: int = 0
    total_gain: float = 0.0
    total_loss: float = 0.0
    short_term: int = 0
    long_term: int = 0

class AuditFeeSourceCount(BaseModel):
    source: str
    count: int

class AuditFeesSummary(BaseModel):
    total: int = 0
    total_value_in_base: float = 0.0
    by_source: List[AuditFeeSourceCount] = []

class AuditWarningTypeCount(BaseModel):
    type: str
    count: int

class AuditWarningsByLevel(BaseModel):
    error: int = 0
    warning: int = 0
    info: int = 0

class AuditWarningsSummary(BaseModel):
    total: int = 0
    by_level: AuditWarningsByLevel = AuditWarningsByLevel()
    by_type: List[AuditWarningTypeCount] = []

class AuditTransactionsSummary(BaseModel):
    included: int = 0
    excluded: int = 0

class AuditSummaryResponse(BaseModel):
    units_count: int = 0
    lots: AuditLotsSummary = AuditLotsSummary()
    realized: AuditRealizedSummary = AuditRealizedSummary()
    fees: AuditFeesSummary = AuditFeesSummary()
    warnings: AuditWarningsSummary = AuditWarningsSummary()
    events_count: int = 0
    transactions: AuditTransactionsSummary = AuditTransactionsSummary()


# =============================================================================
# Per-tab filter options response models
# =============================================================================

class FilterOptionWithCount(BaseModel):
    value: str
    label: Optional[str] = None
    count: int = 0

class UnitsFilterOptionsResponse(BaseModel):
    patterns: List[FilterOptionWithCount] = []
    total_units: int = 0
    has_warnings_count: int = 0
    has_realized_pnl_count: int = 0
    has_fees_count: int = 0
    warning_types: List[FilterOptionWithCount] = []  # Per-type breakdown for multi-select

class LotsFilterOptionsResponse(BaseModel):
    assets: List[FilterOptionWithCount] = []
    accounts: List[FilterOptionWithCount] = []
    statuses: List[FilterOptionWithCount] = []

class RealizedPnLFilterOptionsResponse(BaseModel):
    assets: List[FilterOptionWithCount] = []
    taxable_options: List[FilterOptionWithCount] = []
    pnl_sign_options: List[FilterOptionWithCount] = []
    holding_period_options: List[FilterOptionWithCount] = []
    origin_type_options: List[FilterOptionWithCount] = []
    accounts: List[FilterOptionWithCount] = []
    date_range: Optional[Dict[str, str]] = None  # {"min": iso, "max": iso}

class FeesFilterOptionsResponse(BaseModel):
    assets: List[FilterOptionWithCount] = []
    related_assets: List[FilterOptionWithCount] = []

class WarningsFilterOptionsResponse(BaseModel):
    warning_types: List[FilterOptionWithCount] = []
    levels: List[FilterOptionWithCount] = []
    assets: List[FilterOptionWithCount] = []


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

    pnl_id: int
    asset: AssetRef
    qty: float
    proceeds_in_base: float
    cost_basis_in_base: float
    pnl_in_base: float
    taxable: bool
    is_fee: bool = False  # True if this entry originated from a fee leg
    transaction_id: Optional[int] = None
    unit_id: Optional[int] = None
    account_id: Optional[int] = None
    account_name: Optional[str] = None
    realized_at: datetime
    holding_period_days: Optional[int] = None
    # Proceeds tracking - how FMV was determined
    proceeds_source: Optional[str] = None
    proceeds_price: Optional[float] = None
    proceeds_price_source: Optional[str] = None
    proceeds_price_timestamp: Optional[datetime] = None
    related_asset_symbol: Optional[str] = None


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
    created_at: Optional[datetime] = None  # When the lot record was created in the PnL engine
    origin_transaction_id: Optional[int] = None  # Transaction that created this lot
    last_updated_by_tx_id: Optional[int] = None  # Transaction that last modified this lot (consumption/settlement)
    origin_unit_id: Optional[int] = None  # CalculationUnit that created this lot
    origin_unit_label: Optional[str] = None  # Human-readable label of origin unit
    is_zero_cost: bool = False
    is_negative: bool = False  # True if this is a negative lot (debt)
    is_fully_settled: bool = False  # True if negative lot is fully settled
    notes: Optional[str] = None  # Additional info (e.g., settlement details)
    
    # Cost provenance
    cost_source: Optional[str] = None  # "fmv", "proceeds", "inherited", "provisional", "base_currency"
    cost_fmv_price: Optional[float] = None  # FMV unit price used (if cost_source is fmv/provisional)
    cost_fmv_source: Optional[str] = None  # Price source (e.g., "coingecko", "fallback:cached")
    cost_fmv_timestamp: Optional[datetime] = None  # When the FMV price was snapped
    cost_fmv_stale: Optional[bool] = None  # Whether the FMV price was flagged stale
    
    # Cost basis chain (for transfers/splits — links to source lot)
    source_lot_id: Optional[int] = None  # The lot this was created from (if inherited/split)

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

    # FMV details for 'created' events where cost basis used FMV
    cost_source: Optional[str] = None
    cost_fmv_price: Optional[float] = None
    cost_fmv_source: Optional[str] = None
    cost_fmv_timestamp: Optional[datetime] = None
    cost_fmv_stale: Optional[bool] = None


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
    # Proceeds tracking - how FMV was determined
    proceeds_source: Optional[str] = None
    proceeds_price: Optional[float] = None
    proceeds_price_source: Optional[str] = None
    proceeds_price_timestamp: Optional[datetime] = None


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


class CostLotLineageResponse(BaseModel):
    """Full lineage/provenance for a single cost lot."""
    lot: CostLotResponse
    consumed_slices: List[ConsumedSliceResponse] = []       # Slices taken from this lot by disposals
    settlements: List[SettlementResponse] = []              # Settlements (for negative lots)
    events_count: int = 0                                   # Total event count
    recent_events: List[CostLotEventResponse] = []          # Last 5 events
    origin_transaction: Optional["TransactionSummary"] = None  # Transaction that created this lot


class RealizedPnlLineageResponse(BaseModel):
    """Full lineage/provenance for a single realized P&L entry."""
    pnl: RealizedPnLResponse
    source_lots: List[CostLotResponse] = []                 # Lots that contributed cost basis
    consumed_slices: List[ConsumedSliceResponse] = []       # Bridge records (lot → PnL)
    disposal_transaction: Optional["TransactionSummary"] = None  # Transaction that triggered disposal


class CostBasisChainNode(BaseModel):
    """Single node in the cost basis chain — one step in the provenance trail."""
    lot_id: int
    transaction_id: Optional[int] = None
    transaction_type: Optional[str] = None          # e.g. "buy", "transfer", "swap", "split"
    transaction_source_type: Optional[str] = None   # Source-level type (source_transaction_type)
    timestamp: Optional[datetime] = None            # Transaction or lot acquired_at
    asset_symbol: Optional[str] = None
    asset_id: Optional[int] = None
    account_name: Optional[str] = None
    account_id: Optional[int] = None
    qty: float = 0
    unit_cost: float = 0
    cost_source: Optional[str] = None               # "fmv", "inherited", "proceeds", "provisional", "base_currency"
    unit_pattern: Optional[str] = None              # "transfer", "swap", "split", "flow"
    children: List["CostBasisChainNode"] = []       # Source lots (backward, toward origin)


class CostBasisChainResponse(BaseModel):
    """Full backward cost basis chain for a lot, P&L entry, or event."""
    chain: List[CostBasisChainNode] = []
    depth: int = 0                                   # Maximum depth reached


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
    taxable_realized_pnl_in_base: float = 0.0  # Taxable portion of realized P&L
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
    # Last known price (included on error so the UI can display it)
    last_known_price: Optional[float] = None
    last_known_price_date: Optional[datetime] = None
    last_known_source: Optional[str] = None


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
        asset=AssetRef(id=tx.asset.asset_id, symbol=tx.asset.symbol, label=tx.asset.label, source_symbol=tx.source_asset_symbol) if tx.asset_id else None,
        quantity=float(tx.quantity) if tx.quantity else None,
        # Pricing
        price=float(tx.price) if tx.price else None,
        price_quote_asset=AssetRef(id=tx.price_quote_asset.asset_id, symbol=tx.price_quote_asset.symbol, label=tx.price_quote_asset.label) if tx.price_quote_asset_id else None,
        total=float(tx.total) if tx.total else None,
        # Fee
        fee=float(tx.fee) if tx.fee else None,
        fee_quote_asset=AssetRef(id=tx.fee_quote_asset.asset_id, symbol=tx.fee_quote_asset.symbol, label=tx.fee_quote_asset.label) if tx.fee_quote_asset_id else None,
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
        asset=AssetRef(id=lot.asset.asset_id, symbol=lot.asset.symbol, label=lot.asset.label),
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
        # Cost provenance
        cost_source=lot.cost_source,
        cost_fmv_price=float(lot.cost_fmv_price) if lot.cost_fmv_price is not None else None,
        cost_fmv_source=lot.cost_fmv_source,
        cost_fmv_timestamp=lot.cost_fmv_timestamp,
        cost_fmv_stale=lot.cost_fmv_stale,
        # Cost basis chain
        source_lot_id=getattr(lot, 'source_lot_id', None),
    )


def build_consumed_slice_response(
    slice: ConsumedLotSlice
) -> ConsumedSliceResponse:
    """Build ConsumedSliceResponse from ConsumedLotSlice model."""
    asset_ref = None
    if slice.cost_lot and slice.cost_lot.asset:
        asset_ref = AssetRef(id=slice.cost_lot.asset.asset_id, symbol=slice.cost_lot.asset.symbol, label=slice.cost_lot.asset.label)
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
        asset=AssetRef(id=entry.asset.asset_id, symbol=entry.asset.symbol, label=entry.asset.label),
        qty=float(entry.qty),
        proceeds_in_base=float(entry.proceeds_in_base),
        cost_basis_in_base=float(entry.cost_basis_in_base),
        pnl_in_base=float(entry.pnl_in_base),
        disposal_taxable=entry.disposal_taxable,
        is_fee=is_fee,
        proceeds_source=entry.proceeds_source,
        proceeds_price=float(entry.proceeds_price) if entry.proceeds_price else None,
        proceeds_price_source=entry.proceeds_price_source,
        proceeds_price_timestamp=entry.proceeds_price_timestamp,
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
# Background Calculation Status & Refresh
# =============================================================================


@router.get("/calculation-status")
def get_calculation_status():
    """
    Get the current P&L background calculation status.
    
    Used by the frontend to poll for:
    - Whether P&L is stale (data changed since last calculation)
    - Whether a calculation is in progress
    - The latest auto-calculated version ID
    - Error information if last calculation failed
    
    Recommended polling interval: 5s when P&L tab is active, 30s otherwise.
    """
    from backend.services.pnl_calculation_service import PnLCalculationService
    service = PnLCalculationService.get_instance()
    return service.get_status()


@router.post("/refresh")
def refresh_pnl():
    """
    Trigger a background P&L recalculation using default settings.
    
    Returns immediately — calculation runs in a background thread.
    Poll GET /pnl/calculation-status to track progress.
    
    Uses the default P&L configuration from AppSettings.
    The previous auto-draft is kept until the new one succeeds.
    
    Returns:
        {"started": true} if calculation was started
        {"started": false, "reason": "already_calculating"} if already running
    """
    from backend.services.pnl_calculation_service import PnLCalculationService
    service = PnLCalculationService.get_instance()
    started = service.start_calculation(trigger="refresh")
    if started:
        return {"started": True}
    else:
        return {"started": False, "reason": "already_calculating"}


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
    trigger: Optional[str] = None  # 'auto', 'manual', 'refresh'
    
    # Config
    lot_method: str
    lot_mode: str
    base_currency_id: Optional[int] = None
    base_currency_symbol: Optional[str] = None
    allow_negative_balances: bool = False
    residual_tolerance_pct: float = 0.05
    compute_residuals: bool = True
    # Full config for reproducibility
    crypto_swap_taxable: bool = False
    fee_taxable: bool = False
    use_price_fallback: bool = True
    price_staleness_window_days: int = 7
    
    # Account filter - which accounts were included in this calculation
    # None means all accounts were included
    account_ids: Optional[List[int]] = None
    
    # Summary
    total_realized_pnl: float
    taxable_realized_pnl: float = 0.0
    current_value: float = 0.0
    cost_basis: float = 0.0
    unrealized_pnl: float = 0.0
    
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
    trigger: Optional[str] = None  # 'auto', 'manual', 'refresh'
    # Config fields for display and filtering
    lot_method: str
    lot_mode: str
    base_currency_id: Optional[int] = None
    base_currency_symbol: Optional[str] = None
    allow_negative_balances: bool = False
    residual_tolerance_pct: float = 0.05
    compute_residuals: bool = True
    # Full config for display
    crypto_swap_taxable: bool = False
    fee_taxable: bool = False
    use_price_fallback: bool = True
    price_staleness_window_days: int = 7


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
        Tuple of (asset_id, asset_symbol, asset_label) or None if not determinable
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
        return (asset.asset_id, asset.symbol, asset.label)
    
    if non_base_inflows and not non_base_outflows:
        # Inflow is non-base (e.g., buy BTC with EUR)
        leg, asset = max(non_base_inflows, key=lambda x: float(x[0].quantity) * float(getattr(x[0].transaction, 'price', 1) or 1))
        return (asset.asset_id, asset.symbol, asset.label)
    
    # Case 2: Both sides are non-base (crypto-to-crypto) → use outflow
    if non_base_outflows:
        # Use largest value outflow
        leg, asset = max(non_base_outflows, key=lambda x: float(x[0].quantity) * float(getattr(x[0].transaction, 'price', 1) or 1))
        return (asset.asset_id, asset.symbol, asset.label)
    
    # Case 3: All are base currency (edge case) → use largest leg
    all_legs = outflows + inflows
    if all_legs:
        leg, asset = max(all_legs, key=lambda x: float(x[0].quantity))
        return (asset.asset_id, asset.symbol, asset.label)
    
    return None


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
    taxable_realized_pnl: float = 0.0,
    current_value: float = 0.0,
    cost_basis: float = 0.0,
    unrealized_pnl: float = 0.0,
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
        trigger=version.trigger,
        lot_method=version.method,
        lot_mode=version.lot_mode,
        base_currency_id=version.base_currency_id,
        base_currency_symbol=base_currency_symbol,
        allow_negative_balances=version.allow_negative_balances,
        residual_tolerance_pct=float(version.residual_tolerance_pct),
        compute_residuals=version.compute_residuals,
        crypto_swap_taxable=version.crypto_swap_taxable,
        fee_taxable=version.fee_taxable,
        use_price_fallback=version.use_price_fallback,
        price_staleness_window_days=version.price_staleness_window_days,
        account_ids=version.account_ids,
        total_realized_pnl=total_realized_pnl,
        taxable_realized_pnl=taxable_realized_pnl,
        current_value=current_value,
        cost_basis=cost_basis,
        unrealized_pnl=unrealized_pnl,
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
        version.trigger = "manual"
        session.add(version)
        session.commit()

        # Persist compute_residuals preference in AppSettings for future refresh calculations
        settings = session.get(AppSettings, 1)
        if settings and settings.pnl_compute_residuals != request.compute_residuals:
            settings.pnl_compute_residuals = request.compute_residuals
            session.add(settings)
            session.commit()

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
    max_timeout_seconds: int = Query(10, description="Max seconds before giving up live fetch and returning fallback"),
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
            max_timeout_seconds=max_timeout_seconds,
        )
        
        warning_msg = None
        if result.is_stale:
            warning_msg = f"Using stale price from {result.actual_price_date.strftime('%Y-%m-%d') if result.actual_price_date else 'unknown'} ({result.staleness_days} days old)"
        
        return PriceResponse(
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol or f"#{asset.asset_id}", label=asset.label),
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
        # Try to include last known cached price for context
        last_price = None
        last_date = None
        last_source = None
        try:
            snapshot = price_service.cache.get_latest_before(
                session, asset_id,
                price_service._get_quote_asset_id(session, base_currency),
                datetime.utcnow(),
                max_days_back=365,
            )
            if snapshot:
                last_price = float(snapshot.price)
                last_date = snapshot.snapshot_time
                last_source = snapshot.source
        except Exception:
            pass
        return PriceResponse(
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol or f"#{asset.asset_id}", label=asset.label),
            price=None,
            price_quote=base_currency,
            error=str(e),
            last_known_price=last_price,
            last_known_price_date=last_date,
            last_known_source=last_source,
        )


class PriceRequest(BaseModel):
    """Request for bulk price lookup."""
    
    asset_ids: List[int] = Field(..., description="List of asset IDs to fetch prices for")
    base_currency: str = Field(default="EUR", description="Quote currency for prices")
    use_fallback: bool = Field(default=True, description="Fall back to latest known price if fetch fails")
    staleness_window_days: int = Field(default=7, description="Max days to consider price fresh (for fallback)")
    max_timeout_seconds: int = Field(default=10, description="Max seconds before giving up live fetch and returning fallback")


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
                max_timeout_seconds=request.max_timeout_seconds,
            )
            
            warning_msg = None
            if result.is_stale:
                warning_msg = f"Using stale price from {result.actual_price_date.strftime('%Y-%m-%d') if result.actual_price_date else 'unknown'} ({result.staleness_days} days old)"
                stale_count += 1
            
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, symbol=asset.symbol, label=asset.label),
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
            # Try to include last known cached price for context
            last_price = None
            last_date = None
            last_source = None
            try:
                snapshot = price_service.cache.get_latest_before(
                    session, asset_id,
                    price_service._get_quote_asset_id(session, request.base_currency),
                    fetched_at,
                    max_days_back=365,
                )
                if snapshot:
                    last_price = float(snapshot.price)
                    last_date = snapshot.snapshot_time
                    last_source = snapshot.source
            except Exception:
                pass
            prices.append(PriceResponse(
                asset=AssetRef(id=asset_id, symbol=asset.symbol, label=asset.label),
                price=None,
                price_quote=request.base_currency,
                error=str(e),
                last_known_price=last_price,
                last_known_price_date=last_date,
                last_known_source=last_source,
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
            trigger=v.trigger,
            lot_method=v.method,
            lot_mode=v.lot_mode,
            base_currency_id=v.base_currency_id,
            base_currency_symbol=base_currencies.get(v.base_currency_id),
            allow_negative_balances=v.allow_negative_balances,
            residual_tolerance_pct=float(v.residual_tolerance_pct),
            compute_residuals=v.compute_residuals,
            crypto_swap_taxable=v.crypto_swap_taxable,
            fee_taxable=v.fee_taxable,
            use_price_fallback=v.use_price_fallback,
            price_staleness_window_days=v.price_staleness_window_days,
        )
        for v in versions
    ]


@router.get("/versions/{version_id}", response_model=PnLVersionResponse)
def get_version(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get metadata and summary for a specific calculation version.
    
    Returns version config, entity ID counts, and lightweight realized P&L / fee
    aggregates.  Price-dependent metrics (unrealized P&L, current value) are NOT
    computed here — use GET /versions/{id}/metrics for those.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")
    
    # Get base currency symbol
    base_currency_symbol = None
    if version.base_currency_id:
        asset = session.get(Asset, version.base_currency_id)
        base_currency_symbol = asset.symbol if asset else None
    
    # --- Lightweight DB aggregates (no price fetching) ---

    # Realized P&L totals (all + taxable-only)
    rpnl_query = (
        select(
            func.coalesce(func.sum(RealizedPnl.pnl_in_base), 0).label("total"),
        )
        .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    )
    total_realized_pnl = float(session.exec(rpnl_query).one())

    taxable_rpnl_query = (
        select(
            func.coalesce(func.sum(RealizedPnl.pnl_in_base), 0).label("total"),
        )
        .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .where(RealizedPnl.disposal_taxable == True)  # noqa: E712
    )
    taxable_realized_pnl = float(session.exec(taxable_rpnl_query).one())

    # Fee summary
    fee_summary = session.exec(
        select(
            func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0).label("total_fees"),
            func.count(FeeEntry.id).label("fee_count"),
        )
        .where(FeeEntry.version_id == version_id)
    ).first()
    total_fees_in_base = float(fee_summary.total_fees) if fee_summary else 0.0
    fee_entry_count = fee_summary.fee_count if fee_summary else 0
    
    # Fetch entity IDs for frontend count displays
    entity_ids = fetch_version_entity_ids(session, version_id)
    
    return build_version_response(
        version=version,
        base_currency_symbol=base_currency_symbol,
        total_realized_pnl=total_realized_pnl,
        taxable_realized_pnl=taxable_realized_pnl,
        total_fees_in_base=total_fees_in_base,
        fee_entry_count=fee_entry_count,
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
    lot_status: Optional[str] = None,  # Comma-sep: open,exhausted,negative
    search: Optional[str] = None,       # Search asset symbol / account name
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

    # Filter by lot_status (comma-separated: open, exhausted, negative)
    if lot_status:
        statuses = [s.strip() for s in lot_status.split(",") if s.strip()]
        status_conditions = []
        for s in statuses:
            if s == "open":
                status_conditions.append((CostLot.qty_remaining > 0) & (~CostLot.is_negative))
            elif s == "exhausted":
                status_conditions.append(CostLot.qty_remaining == 0)
            elif s == "negative":
                status_conditions.append(CostLot.is_negative == True)
        if status_conditions:
            base_query = base_query.where(or_(*status_conditions))

    # Search on asset symbol or account name
    if search:
        search_term = f"%{search}%"
        base_query = base_query.outerjoin(Asset, CostLot.asset_id == Asset.asset_id).outerjoin(
            Account, CostLot.account_id == Account.id
        ).where(
            or_(
                Asset.symbol.ilike(search_term),
                Asset.label.ilike(search_term),
                Account.name.ilike(search_term),
            )
        )
    
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
        .order_by(CostLot.cost_lot_id.desc())
        .offset(offset)
        .limit(limit)
    )
    
    lots = session.exec(query).all()
    
    # Batch-fetch "last updated by" transaction IDs for all lots on this page.
    # For each lot, find the most recent non-CREATED event's triggered_by_transaction_id.
    last_updated_map: dict[int, int] = {}
    lot_ids = [lot.cost_lot_id for lot in lots if lot.cost_lot_id]
    if lot_ids:
        # Use a subquery to get the max event_id per lot (excluding CREATED events)
        latest_event_sq = (
            select(
                CostLotEvent.lot_id,
                func.max(CostLotEvent.event_id).label("max_event_id"),
            )
            .where(CostLotEvent.lot_id.in_(lot_ids))
            .where(CostLotEvent.event_type != "CREATED")
            .where(CostLotEvent.event_type != "NEGATIVE_CREATED")
            .group_by(CostLotEvent.lot_id)
            .subquery()
        )
        rows = session.exec(
            select(latest_event_sq.c.lot_id, CostLotEvent.triggered_by_transaction_id)
            .join(CostLotEvent, CostLotEvent.event_id == latest_event_sq.c.max_event_id)
        ).all()
        last_updated_map = {row[0]: row[1] for row in rows if row[1] is not None}
    
    items = [
        CostLotResponse(
            cost_lot_id=lot.cost_lot_id,
            asset=AssetRef(
                id=lot.asset.asset_id if lot.asset else lot.asset_id,
                symbol=lot.asset.symbol if lot.asset else f"#{lot.asset_id}",
                label=lot.asset.label if lot.asset else None
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
            created_at=lot.created_at,
            origin_transaction_id=lot.origin_transaction_id,
            last_updated_by_tx_id=last_updated_map.get(lot.cost_lot_id),
            origin_unit_id=lot.unit_id,  # DB field is now unit_id, API keeps origin_unit_id for compat
            origin_unit_label=lot.unit.label if lot.unit else None,
            is_zero_cost=lot.is_zero_cost,
            is_negative=lot.is_negative,
            notes=lot.notes,
            # Cost provenance
            cost_source=lot.cost_source,
            cost_fmv_price=float(lot.cost_fmv_price) if lot.cost_fmv_price is not None else None,
            cost_fmv_source=lot.cost_fmv_source,
            cost_fmv_timestamp=lot.cost_fmv_timestamp,
            cost_fmv_stale=lot.cost_fmv_stale,
        )
        for lot in lots
    ]
    
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/versions/{version_id}/lots/filter-options", response_model=LotsFilterOptionsResponse)
def get_lots_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """Return available filter values for the lots list, scoped by context filters."""
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    base_q = (
        select(CostLot.cost_lot_id)
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
    )
    base_q, _ = _apply_unit_filter(base_q, tx_filters, version_id, session, unit_column=CostLot.unit_id)
    scoped_sq = base_q.subquery()

    # Assets with counts
    asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(CostLot.cost_lot_id))
        .join(CostLot, CostLot.asset_id == Asset.asset_id)
        .where(CostLot.cost_lot_id.in_(select(scoped_sq)))
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(func.count(CostLot.cost_lot_id).desc())
    )
    asset_rows = session.exec(asset_q).all()
    assets = [FilterOptionWithCount(value=str(aid), label=sym or lbl or str(aid), count=c)
              for aid, sym, lbl, c in asset_rows]

    # Accounts with counts
    acct_q = (
        select(Account.id, Account.name, func.count(CostLot.cost_lot_id))
        .join(CostLot, CostLot.account_id == Account.id)
        .where(CostLot.cost_lot_id.in_(select(scoped_sq)))
        .group_by(Account.id, Account.name)
        .order_by(func.count(CostLot.cost_lot_id).desc())
    )
    acct_rows = session.exec(acct_q).all()
    accounts = [FilterOptionWithCount(value=str(aid), label=name or str(aid), count=c)
                for aid, name, c in acct_rows]

    # Status counts:  open / exhausted / negative
    status_q = (
        select(
            func.count(CostLot.cost_lot_id).filter((CostLot.qty_remaining > 0) & (~CostLot.is_negative)),
            func.count(CostLot.cost_lot_id).filter(CostLot.qty_remaining == 0),
            func.count(CostLot.cost_lot_id).filter(CostLot.is_negative == True),
        )
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
        .where(CostLot.cost_lot_id.in_(select(scoped_sq)))
    )
    open_c, exhausted_c, negative_c = session.exec(status_q).one()

    statuses = [
        FilterOptionWithCount(value="open", label="Open", count=open_c or 0),
        FilterOptionWithCount(value="exhausted", label="Exhausted", count=exhausted_c or 0),
        FilterOptionWithCount(value="negative", label="Negative", count=negative_c or 0),
    ]

    return LotsFilterOptionsResponse(
        assets=assets,
        accounts=accounts,
        statuses=statuses,
    )


@router.get("/versions/{version_id}/lots/{lot_id}/lineage", response_model=CostLotLineageResponse)
def get_lot_lineage(
    version_id: int,
    lot_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get full lineage for a single cost lot.

    Returns the lot with consumed slices, settlements, recent events,
    and origin transaction — everything needed for a traceability tooltip.
    """
    lot = session.get(CostLot, lot_id)
    if not lot:
        raise HTTPException(status_code=404, detail=f"Cost lot {lot_id} not found")

    # Verify lot belongs to this version
    unit = session.get(CalculationUnit, lot.unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Cost lot {lot_id} not found in version {version_id}")

    # Eager-load asset/account for building response
    if not lot.asset:
        from sqlalchemy.orm import selectinload as _sil
        lot = session.exec(
            select(CostLot)
            .where(CostLot.cost_lot_id == lot_id)
            .options(_sil(CostLot.asset), _sil(CostLot.account), _sil(CostLot.unit))
        ).one()

    lot_response = build_cost_lot_response(lot)

    # Consumed slices (disposals that consumed from this lot)
    slices = session.exec(
        select(ConsumedLotSlice)
        .where(ConsumedLotSlice.cost_lot_id == lot_id)
        .options(
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            selectinload(ConsumedLotSlice.pnl).selectinload(RealizedPnl.origin_unit),
        )
        .order_by(ConsumedLotSlice.created_at)
    ).all()
    consumed = [build_consumed_slice_response(s) for s in slices]

    # Settlements (for negative lots)
    settlements_q = session.exec(
        select(LotSettlement)
        .where(LotSettlement.negative_lot_id == lot_id)
        .order_by(LotSettlement.settled_at)
    ).all()
    settlements = [build_settlement_response(s) for s in settlements_q]

    # Events (count + last 5)
    events_count_val = session.exec(
        select(func.count()).select_from(CostLotEvent).where(CostLotEvent.lot_id == lot_id)
    ).one()
    recent_events_q = session.exec(
        select(CostLotEvent)
        .where(CostLotEvent.lot_id == lot_id)
        .options(
            selectinload(CostLotEvent.lot).selectinload(CostLot.asset),
            selectinload(CostLotEvent.lot).selectinload(CostLot.account),
        )
        .order_by(CostLotEvent.timestamp.desc())
        .limit(5)
    ).all()
    recent_events = [
        CostLotEventResponse(
            event_id=ev.event_id,
            event_type=ev.event_type,
            lot_id=ev.lot_id,
            asset=AssetRef(
                id=ev.lot.asset.asset_id, symbol=ev.lot.asset.symbol, label=ev.lot.asset.label
            ) if ev.lot and ev.lot.asset else None,
            account_id=ev.lot.account_id if ev.lot else None,
            account_name=ev.lot.account.name if ev.lot and ev.lot.account else None,
            quantity_delta=float(ev.quantity_delta),
            cost_basis_delta=float(ev.cost_basis_delta) if ev.cost_basis_delta else None,
            qty_remaining_after=float(ev.qty_remaining_after),
            cost_basis_remaining_after=float(ev.cost_basis_remaining_after) if ev.cost_basis_remaining_after else None,
            related_lot_id=ev.related_lot_id,
            triggered_by_transaction_id=ev.triggered_by_transaction_id,
            triggered_by_unit_id=ev.triggered_by_unit_id,
            timestamp=ev.timestamp,
        )
        for ev in recent_events_q
    ]

    # Origin transaction
    origin_tx = None
    if lot.origin_transaction_id:
        tx = session.get(NormalizedTransaction, lot.origin_transaction_id)
        if tx:
            origin_tx = build_transaction_summary(tx)

    return CostLotLineageResponse(
        lot=lot_response,
        consumed_slices=consumed,
        settlements=settlements,
        events_count=events_count_val,
        recent_events=recent_events,
        origin_transaction=origin_tx,
    )


# ---------------------------------------------------------------------------
# Cost Basis Chain — recursive backward traversal
# ---------------------------------------------------------------------------

def _walk_lot_chain(
    lot: CostLot,
    session: Session,
    visited: set,
    max_depth: int = 100,
    current_depth: int = 0,
) -> CostBasisChainNode:
    """
    Recursively walk backward through the cost basis chain from a lot.

    Terminal conditions:
      - cost_source in ("fmv", "base_currency", "provisional") → origin acquisition
      - source_lot_id is None and cost_source != "proceeds" → origin lot
      - cost_source == "proceeds" → follows origin_pnl_id → consumed lots → recurse
      - max_depth reached or cycle detected → stop
    """
    # Build this node
    tx = session.get(NormalizedTransaction, lot.origin_transaction_id) if lot.origin_transaction_id else None
    unit = session.get(CalculationUnit, lot.unit_id) if lot.unit_id else None
    node = CostBasisChainNode(
        lot_id=lot.cost_lot_id,
        transaction_id=lot.origin_transaction_id,
        transaction_type=tx.transaction_type if tx else None,
        transaction_source_type=tx.source_transaction_type if tx else None,
        timestamp=tx.date_time if tx else lot.acquired_at,
        asset_symbol=lot.asset.symbol if lot.asset else None,
        asset_id=lot.asset_id,
        account_name=lot.account.name if lot.account else None,
        account_id=lot.account_id,
        qty=float(lot.qty),
        unit_cost=float(lot.unit_cost_in_base),
        cost_source=lot.cost_source,
        unit_pattern=unit.pattern if unit else None,
        children=[],
    )

    if current_depth >= max_depth or lot.cost_lot_id in visited:
        return node
    visited.add(lot.cost_lot_id)

    # Case 1: Inherited/split — follow source_lot_id
    if lot.cost_source == "inherited" and lot.source_lot_id:
        source = session.exec(
            select(CostLot)
            .where(CostLot.cost_lot_id == lot.source_lot_id)
            .options(
                selectinload(CostLot.asset),
                selectinload(CostLot.account),
            )
        ).first()
        if source and source.cost_lot_id not in visited:
            node.children.append(
                _walk_lot_chain(source, session, visited, max_depth, current_depth + 1)
            )

    # Case 2: Proceeds from swap — follow origin_pnl_id → consumed lots
    elif lot.cost_source == "proceeds" and lot.origin_pnl_id:
        slices = session.exec(
            select(ConsumedLotSlice)
            .where(ConsumedLotSlice.pnl_id == lot.origin_pnl_id)
            .options(
                selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
                selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.account),
            )
        ).all()
        for s in slices:
            if s.cost_lot and s.cost_lot.cost_lot_id not in visited:
                node.children.append(
                    _walk_lot_chain(s.cost_lot, session, visited, max_depth, current_depth + 1)
                )

    # Case 3: Inherited but no source_lot_id (old data without backfill)
    # Try to parse notes: "Transfer (from lot 123)"
    elif lot.cost_source == "inherited" and not lot.source_lot_id and lot.notes:
        import re
        m = re.search(r"from lot (\d+)", lot.notes)
        if m:
            parsed_id = int(m.group(1))
            source = session.exec(
                select(CostLot)
                .where(CostLot.cost_lot_id == parsed_id)
                .options(
                    selectinload(CostLot.asset),
                    selectinload(CostLot.account),
                )
            ).first()
            if source and source.cost_lot_id not in visited:
                node.children.append(
                    _walk_lot_chain(source, session, visited, max_depth, current_depth + 1)
                )

    # Cases "fmv", "base_currency", "provisional", or no further link → terminal
    return node


def _compute_chain_depth(node: CostBasisChainNode) -> int:
    """Compute the maximum depth of a chain tree rooted at node."""
    if not node.children:
        return 0
    return 1 + max(_compute_chain_depth(c) for c in node.children)


@router.get("/versions/{version_id}/lots/{lot_id}/chain", response_model=CostBasisChainResponse)
def get_lot_chain(
    version_id: int,
    lot_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get the full backward cost basis chain for a cost lot.

    Walks recursively through inherited/split lots (via source_lot_id) and
    swap proceeds (via origin_pnl_id → consumed lots) until reaching the
    original acquisition transaction.
    """
    lot = session.exec(
        select(CostLot)
        .where(CostLot.cost_lot_id == lot_id)
        .options(selectinload(CostLot.asset), selectinload(CostLot.account))
    ).first()
    if not lot:
        raise HTTPException(status_code=404, detail=f"Cost lot {lot_id} not found")

    unit = session.get(CalculationUnit, lot.unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Cost lot {lot_id} not found in version {version_id}")

    visited: set = set()
    root = _walk_lot_chain(lot, session, visited, max_depth=100)
    depth = _compute_chain_depth(root)

    return CostBasisChainResponse(chain=[root], depth=depth)


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
                symbol=s.cost_lot.asset.symbol if s.cost_lot and s.cost_lot.asset else f"#{s.cost_lot.asset_id if s.cost_lot else 0}",
                label=s.cost_lot.asset.label if s.cost_lot and s.cost_lot.asset else None
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
    is_taxable: Optional[bool] = None,         # Filter by disposal_taxable
    is_fee: Optional[bool] = None,             # Filter by origin type (fee vs disposal)
    pnl_sign: Optional[str] = None,            # "gain" or "loss"
    holding_period: Optional[str] = None,      # "short" (<=365d) or "long" (>365d)
    search: Optional[str] = None,              # Search asset symbol
    account_id: Optional[int] = None,          # Filter by account
    date_from: Optional[str] = None,           # ISO date string
    date_to: Optional[str] = None,             # ISO date string
    min_abs_pnl: Optional[float] = None,       # Minimum absolute P&L value to include
    sort_by: Optional[str] = None,             # "pnl" or "holding_period" or "date" (default)
    order: Optional[str] = None,               # "asc" or "desc"
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

    if is_taxable is not None:
        base_query = base_query.where(RealizedPnl.disposal_taxable == is_taxable)

    if pnl_sign == "gain":
        base_query = base_query.where(RealizedPnl.pnl_in_base > 0)
    elif pnl_sign == "loss":
        base_query = base_query.where(RealizedPnl.pnl_in_base < 0)

    if holding_period == "short":
        base_query = base_query.where(
            (RealizedPnl.holding_period_days != None) & (RealizedPnl.holding_period_days <= 365)
        )
    elif holding_period == "long":
        base_query = base_query.where(
            (RealizedPnl.holding_period_days != None) & (RealizedPnl.holding_period_days > 365)
        )

    if search:
        search_term = f"%{search}%"
        base_query = base_query.outerjoin(Asset, RealizedPnl.asset_id == Asset.asset_id).where(
            or_(
                Asset.symbol.ilike(search_term),
                Asset.label.ilike(search_term),
            )
        )

    # Filter by origin type (fee vs disposal)
    fee_pnl_ids_sq = select(FeeEntry.realized_pnl_id).where(FeeEntry.realized_pnl_id != None).correlate(None)
    if is_fee is True:
        base_query = base_query.where(RealizedPnl.pnl_id.in_(fee_pnl_ids_sq))
    elif is_fee is False:
        base_query = base_query.where(RealizedPnl.pnl_id.not_in(fee_pnl_ids_sq))

    # Filter by account (via transaction)
    if account_id is not None:
        base_query = base_query.join(
            NormalizedTransaction, RealizedPnl.transaction_id == NormalizedTransaction.id
        ).where(NormalizedTransaction.account_id == account_id)

    # Filter by date range
    if date_from:
        base_query = base_query.where(RealizedPnl.realized_at >= datetime.fromisoformat(date_from))
    if date_to:
        base_query = base_query.where(RealizedPnl.realized_at <= datetime.fromisoformat(date_to))

    # Filter by minimum absolute P&L value
    if min_abs_pnl is not None and min_abs_pnl > 0:
        base_query = base_query.where(func.abs(RealizedPnl.pnl_in_base) >= min_abs_pnl)

    # Get total count
    count_query = select(func.count()).select_from(base_query.subquery())
    total = session.exec(count_query).one()

    # Determine sort column
    sort_column = RealizedPnl.realized_at  # default
    if sort_by == "pnl":
        sort_column = RealizedPnl.pnl_in_base
    elif sort_by == "holding_period":
        sort_column = RealizedPnl.holding_period_days

    order_func = sort_column.desc() if order == "desc" else sort_column.asc()

    # Add eager loading and pagination
    offset = (page - 1) * limit
    query = (
        base_query.options(
            selectinload(RealizedPnl.asset),
            selectinload(RealizedPnl.transaction).selectinload(NormalizedTransaction.account_rel),
        )
        .order_by(order_func)
        .offset(offset)
        .limit(limit)
    )
    
    entries = session.exec(query).all()

    # Batch-check which entries are fee-originated
    entry_ids = [e.pnl_id for e in entries]
    fee_linked_ids = set()
    if entry_ids:
        fee_linked_rows = session.exec(
            select(FeeEntry.realized_pnl_id).where(FeeEntry.realized_pnl_id.in_(entry_ids))
        ).all()
        fee_linked_ids = set(fee_linked_rows)
    
    items = [
        RealizedPnLResponse(
            pnl_id=e.pnl_id,
            asset=AssetRef(
                id=e.asset.asset_id if e.asset else e.asset_id,
                symbol=e.asset.symbol if e.asset else f"#{e.asset_id}",
                label=e.asset.label if e.asset else None
            ),
            qty=float(e.qty),
            proceeds_in_base=float(e.proceeds_in_base),
            cost_basis_in_base=float(e.cost_basis_in_base),
            pnl_in_base=float(e.pnl_in_base),
            taxable=e.disposal_taxable,
            is_fee=e.pnl_id in fee_linked_ids,
            transaction_id=e.transaction_id,
            unit_id=e.origin_unit_id,
            account_id=e.transaction.account_id if e.transaction else None,
            account_name=e.transaction.account_rel.name if e.transaction and e.transaction.account_rel else None,
            realized_at=e.realized_at,
            holding_period_days=e.holding_period_days,
            # Include proceeds tracking metadata
            proceeds_source=e.proceeds_source,
            proceeds_price=float(e.proceeds_price) if e.proceeds_price else None,
            proceeds_price_source=e.proceeds_price_source,
            proceeds_price_timestamp=e.proceeds_price_timestamp,
            related_asset_symbol=e.related_asset_symbol,
        )
        for e in entries
    ]
    
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/versions/{version_id}/realized-pnl/filter-options", response_model=RealizedPnLFilterOptionsResponse)
def get_realized_pnl_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """Return available filter values for the realized P&L list."""
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    base_q = (
        select(RealizedPnl.pnl_id)
        .join(RealizedPnl.origin_unit)
        .where(CalculationUnit.version_id == version_id)
    )
    base_q, _ = _apply_unit_filter(base_q, tx_filters, version_id, session, unit_column=RealizedPnl.origin_unit_id)
    scoped_sq = base_q.subquery()

    # Assets
    asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(RealizedPnl.pnl_id))
        .join(RealizedPnl, RealizedPnl.asset_id == Asset.asset_id)
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(func.count(RealizedPnl.pnl_id).desc())
    )
    asset_rows = session.exec(asset_q).all()
    assets = [FilterOptionWithCount(value=str(aid), label=sym or lbl or str(aid), count=c)
              for aid, sym, lbl, c in asset_rows]

    # Taxable / non-taxable counts
    tax_q = (
        select(
            func.count(RealizedPnl.pnl_id).filter(RealizedPnl.disposal_taxable == True),
            func.count(RealizedPnl.pnl_id).filter(RealizedPnl.disposal_taxable == False),
        )
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
    )
    taxable_count, non_taxable_count = session.exec(tax_q).one()

    # Gain / loss counts
    sign_q = (
        select(
            func.count(RealizedPnl.pnl_id).filter(RealizedPnl.pnl_in_base > 0),
            func.count(RealizedPnl.pnl_id).filter(RealizedPnl.pnl_in_base < 0),
        )
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
    )
    gain_count, loss_count = session.exec(sign_q).one()

    # Holding period counts
    hp_q = (
        select(
            func.count(RealizedPnl.pnl_id).filter(
                (RealizedPnl.holding_period_days != None) & (RealizedPnl.holding_period_days <= 365)
            ),
            func.count(RealizedPnl.pnl_id).filter(
                (RealizedPnl.holding_period_days != None) & (RealizedPnl.holding_period_days > 365)
            ),
        )
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
    )
    short_count, long_count = session.exec(hp_q).one()

    # Origin type counts (fee vs disposal)
    fee_pnl_ids_sq = select(FeeEntry.realized_pnl_id).where(FeeEntry.realized_pnl_id != None)
    fee_count_q = (
        select(func.count(RealizedPnl.pnl_id))
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
        .where(RealizedPnl.pnl_id.in_(fee_pnl_ids_sq))
    )
    fee_count = session.exec(fee_count_q).one()
    total_scoped = session.exec(
        select(func.count(RealizedPnl.pnl_id)).where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
    ).one()
    disposal_count = (total_scoped or 0) - (fee_count or 0)

    # Account options (via transaction)
    acct_q = (
        select(Account.id, Account.name, func.count(RealizedPnl.pnl_id))
        .join(NormalizedTransaction, NormalizedTransaction.account_id == Account.id)
        .join(RealizedPnl, RealizedPnl.transaction_id == NormalizedTransaction.id)
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
        .group_by(Account.id, Account.name)
        .order_by(func.count(RealizedPnl.pnl_id).desc())
    )
    acct_rows = session.exec(acct_q).all()
    accounts = [FilterOptionWithCount(value=str(aid), label=name or str(aid), count=c)
                for aid, name, c in acct_rows]

    # Date range
    date_q = (
        select(func.min(RealizedPnl.realized_at), func.max(RealizedPnl.realized_at))
        .where(RealizedPnl.pnl_id.in_(select(scoped_sq)))
    )
    date_min, date_max = session.exec(date_q).one()
    date_range = None
    if date_min and date_max:
        date_range = {"min": date_min.isoformat(), "max": date_max.isoformat()}

    return RealizedPnLFilterOptionsResponse(
        assets=assets,
        taxable_options=[
            FilterOptionWithCount(value="true", label="Taxable", count=taxable_count or 0),
            FilterOptionWithCount(value="false", label="Non-taxable", count=non_taxable_count or 0),
        ],
        pnl_sign_options=[
            FilterOptionWithCount(value="gain", label="Gain", count=gain_count or 0),
            FilterOptionWithCount(value="loss", label="Loss", count=loss_count or 0),
        ],
        holding_period_options=[
            FilterOptionWithCount(value="short", label="Short-term (≤365d)", count=short_count or 0),
            FilterOptionWithCount(value="long", label="Long-term (>365d)", count=long_count or 0),
        ],
        origin_type_options=[
            FilterOptionWithCount(value="fee", label="Fee", count=fee_count or 0),
            FilterOptionWithCount(value="disposal", label="Disposal", count=disposal_count),
        ],
        accounts=accounts,
        date_range=date_range,
    )


@router.get("/versions/{version_id}/realized-pnl/{pnl_id}/lineage", response_model=RealizedPnlLineageResponse)
def get_realized_pnl_lineage(
    version_id: int,
    pnl_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get full lineage for a single realized P&L entry.

    Returns the PnL entry with source lots (via consumed slices),
    the consumed slice bridge records, and the disposal transaction.
    """
    rpnl = session.exec(
        select(RealizedPnl)
        .where(RealizedPnl.pnl_id == pnl_id)
        .options(selectinload(RealizedPnl.asset))
    ).first()
    if not rpnl:
        raise HTTPException(status_code=404, detail=f"Realized P&L entry {pnl_id} not found")

    # Verify belongs to version
    unit = session.get(CalculationUnit, rpnl.origin_unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Realized P&L {pnl_id} not found in version {version_id}")

    pnl_response = RealizedPnLResponse(
        pnl_id=rpnl.pnl_id,
        asset=AssetRef(
            id=rpnl.asset.asset_id if rpnl.asset else rpnl.asset_id,
            symbol=rpnl.asset.symbol if rpnl.asset else f"#{rpnl.asset_id}",
            label=rpnl.asset.label if rpnl.asset else None,
        ),
        qty=float(rpnl.qty),
        proceeds_in_base=float(rpnl.proceeds_in_base),
        cost_basis_in_base=float(rpnl.cost_basis_in_base),
        pnl_in_base=float(rpnl.pnl_in_base),
        taxable=rpnl.disposal_taxable,
        transaction_id=rpnl.transaction_id,
        unit_id=rpnl.origin_unit_id,
        realized_at=rpnl.realized_at,
        holding_period_days=rpnl.holding_period_days,
        proceeds_source=rpnl.proceeds_source,
        proceeds_price=float(rpnl.proceeds_price) if rpnl.proceeds_price else None,
        proceeds_price_source=rpnl.proceeds_price_source,
        proceeds_price_timestamp=rpnl.proceeds_price_timestamp,
        related_asset_symbol=rpnl.related_asset_symbol,
    )

    # Consumed slices for this PnL entry (bridge to source lots)
    slices = session.exec(
        select(ConsumedLotSlice)
        .where(ConsumedLotSlice.pnl_id == pnl_id)
        .options(
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.account),
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.unit),
        )
        .order_by(ConsumedLotSlice.created_at)
    ).all()

    consumed = [build_consumed_slice_response(s) for s in slices]
    source_lots = [build_cost_lot_response(s.cost_lot) for s in slices if s.cost_lot]

    # Disposal transaction
    disposal_tx = None
    if rpnl.transaction_id:
        tx = session.get(NormalizedTransaction, rpnl.transaction_id)
        if tx:
            disposal_tx = build_transaction_summary(tx)

    return RealizedPnlLineageResponse(
        pnl=pnl_response,
        source_lots=source_lots,
        consumed_slices=consumed,
        disposal_transaction=disposal_tx,
    )


# =============================================================================
# Override FMV for a realized P&L entry
# =============================================================================

class FMVOverrideRequest(BaseModel):
    """Request body for overriding the FMV of a realized P&L entry."""
    price: float = Field(..., gt=0, description="New FMV price per unit in base currency")


class FMVOverrideResponse(BaseModel):
    """Response after creating a manual price override and triggering recalculation."""
    snapshot_id: int
    asset_id: int
    asset_symbol: Optional[str] = None
    price: float
    snapshot_time: str
    recalculation_started: bool


@router.patch("/versions/{version_id}/realized-pnl/{pnl_id}/override-fmv", response_model=FMVOverrideResponse)
def override_realized_pnl_fmv(
    version_id: int,
    pnl_id: int,
    body: FMVOverrideRequest,
    session: Session = Depends(get_session_dependency),
):
    """
    Override the FMV used for a realized P&L entry's proceeds.

    Creates a manual PriceSnapshot for the disposal asset at the disposal time,
    then triggers a background P&L recalculation so the new price is picked up.

    The next recalculation will use the manual snapshot (highest priority)
    and recompute proceeds, PnL, and downstream cost basis.
    """
    # 1. Load and validate the PnL entry
    rpnl = session.exec(
        select(RealizedPnl)
        .where(RealizedPnl.pnl_id == pnl_id)
        .options(selectinload(RealizedPnl.asset))
    ).first()
    if not rpnl:
        raise HTTPException(status_code=404, detail=f"Realized P&L entry {pnl_id} not found")

    unit = session.get(CalculationUnit, rpnl.origin_unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Realized P&L {pnl_id} not found in version {version_id}")

    # 2. Resolve base currency from the calculation version
    version = session.get(CalculationVersion, version_id)
    if not version or not version.base_currency_id:
        raise HTTPException(status_code=400, detail="Version has no base currency configured")

    if rpnl.asset_id == version.base_currency_id:
        raise HTTPException(status_code=400, detail="Cannot override FMV for base currency disposals")

    if not rpnl.realized_at:
        raise HTTPException(status_code=400, detail="P&L entry has no disposal timestamp")

    # 3. Create manual PriceSnapshot (upsert: delete existing manual snapshot for same key)
    existing = session.exec(
        select(PriceSnapshot).where(
            PriceSnapshot.asset_id == rpnl.asset_id,
            PriceSnapshot.quote_asset_id == version.base_currency_id,
            PriceSnapshot.snapshot_time == rpnl.realized_at,
            PriceSnapshot.source == "manual",
        )
    ).first()
    if existing:
        existing.price = Decimal(str(body.price))
        session.add(existing)
        session.commit()
        session.refresh(existing)
        snapshot = existing
    else:
        snapshot = PriceSnapshot(
            asset_id=rpnl.asset_id,
            quote_asset_id=version.base_currency_id,
            snapshot_time=rpnl.realized_at,
            price=Decimal(str(body.price)),
            source="manual",
        )
        session.add(snapshot)
        session.commit()
        session.refresh(snapshot)

    # 4. Trigger background recalculation
    from backend.services.pnl_calculation_service import PnLCalculationService
    service = PnLCalculationService.get_instance()
    started = service.start_calculation(trigger="refresh")

    asset_symbol = rpnl.asset.symbol if rpnl.asset else None

    return FMVOverrideResponse(
        snapshot_id=snapshot.snapshot_id,
        asset_id=rpnl.asset_id,
        asset_symbol=asset_symbol,
        price=float(snapshot.price),
        snapshot_time=snapshot.snapshot_time.isoformat(),
        recalculation_started=started,
    )


@router.get("/versions/{version_id}/realized-pnl/{pnl_id}/chain", response_model=CostBasisChainResponse)
def get_realized_pnl_chain(
    version_id: int,
    pnl_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get the full backward cost basis chain for a realized P&L entry.

    Finds all lots consumed by this disposal, then walks each lot's
    backward chain to the original acquisition.
    """
    rpnl = session.exec(
        select(RealizedPnl).where(RealizedPnl.pnl_id == pnl_id)
    ).first()
    if not rpnl:
        raise HTTPException(status_code=404, detail=f"Realized P&L entry {pnl_id} not found")

    unit = session.get(CalculationUnit, rpnl.origin_unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Realized P&L {pnl_id} not found in version {version_id}")

    slices = session.exec(
        select(ConsumedLotSlice)
        .where(ConsumedLotSlice.pnl_id == pnl_id)
        .options(
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.account),
        )
    ).all()

    visited: set = set()
    chain_nodes = []
    max_d = 0
    for s in slices:
        if s.cost_lot and s.cost_lot.cost_lot_id not in visited:
            root = _walk_lot_chain(s.cost_lot, session, visited, max_depth=100)
            chain_nodes.append(root)
            d = _compute_chain_depth(root)
            if d > max_d:
                max_d = d

    return CostBasisChainResponse(chain=chain_nodes, depth=max_d)


@router.get("/versions/{version_id}/events/{event_id}/chain", response_model=CostBasisChainResponse)
def get_event_chain(
    version_id: int,
    event_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get the full backward cost basis chain for a cost lot event.

    Uses the event's lot_id to walk the chain backward.
    """
    event = session.get(CostLotEvent, event_id)
    if not event:
        raise HTTPException(status_code=404, detail=f"Cost lot event {event_id} not found")

    lot = session.exec(
        select(CostLot)
        .where(CostLot.cost_lot_id == event.lot_id)
        .options(selectinload(CostLot.asset), selectinload(CostLot.account))
    ).first()
    if not lot:
        raise HTTPException(status_code=404, detail=f"Cost lot {event.lot_id} not found")

    unit = session.get(CalculationUnit, lot.unit_id)
    if not unit or unit.version_id != version_id:
        raise HTTPException(status_code=404, detail=f"Event {event_id} not found in version {version_id}")

    visited: set = set()
    root = _walk_lot_chain(lot, session, visited, max_depth=100)
    depth = _compute_chain_depth(root)

    return CostBasisChainResponse(chain=[root], depth=depth)


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
    related_asset_id: Optional[int] = None,   # Filter by FeeEntry.related_asset_id
    search: Optional[str] = None,              # Search asset symbol
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

    if related_asset_id:
        query = query.where(FeeEntry.related_asset_id == related_asset_id)

    if search:
        search_term = f"%{search}%"
        query = query.where(
            or_(
                Asset.symbol.ilike(search_term),
                Asset.label.ilike(search_term),
            )
        )
    
    # Get all for summary calculation first
    all_results = session.exec(query).all()
    
    # Collect unique unit_ids to query related assets
    unit_ids = list(set(fee_entry.unit_id for fee_entry, _, _, _, _ in all_results))
    
    # Query non-fee legs for these units to determine related asset per unit
    # Related asset = non-base-currency asset (outflows preferred for crypto-to-crypto)
    related_asset_map: Dict[int, tuple] = {}  # unit_id -> (asset_id, asset_symbol, asset_label)
    
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
            asset=AssetRef(id=asset.asset_id, symbol=asset.symbol, label=asset.label),
            fee_amount=float(leg.quantity) if leg.quantity else 0.0,
            fee_in_base=float(fee_entry.fee_value_in_base),
            transaction_id=leg.transaction_id,
            unit_id=fee_entry.unit_id,
            source=tx.source if tx else None,
            transaction_type=tx.transaction_type if tx else None,
            cost_basis_consumed=float(rpnl.cost_basis_in_base) if rpnl else 0.0,
            realized_pnl=float(rpnl.pnl_in_base) if rpnl else 0.0,
            related_asset=AssetRef(id=related[0], symbol=related[1], label=related[2]) if related else None,
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


@router.get("/versions/{version_id}/fees/filter-options", response_model=FeesFilterOptionsResponse)
def get_fees_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """Return available filter values for the fees list."""
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # Base scoped FeeEntry ids
    base_q = (
        select(FeeEntry.id)
        .where(FeeEntry.version_id == version_id)
    )
    base_q, _ = _apply_unit_filter(base_q, tx_filters, version_id, session, unit_column=FeeEntry.unit_id)
    scoped_sq = base_q.subquery()

    # Fee assets (the asset on the leg, i.e. the fee currency)
    fee_asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(FeeEntry.id))
        .join(CalculationUnitLeg, FeeEntry.fee_leg_id == CalculationUnitLeg.id)
        .join(Asset, CalculationUnitLeg.asset_id == Asset.asset_id)
        .where(FeeEntry.id.in_(select(scoped_sq)))
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(func.count(FeeEntry.id).desc())
    )
    fee_asset_rows = session.exec(fee_asset_q).all()
    assets = [FilterOptionWithCount(value=str(aid), label=sym or lbl or str(aid), count=c)
              for aid, sym, lbl, c in fee_asset_rows]

    # Related assets (the asset being traded when the fee was incurred)
    related_asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(FeeEntry.id))
        .join(FeeEntry, FeeEntry.related_asset_id == Asset.asset_id)
        .where(FeeEntry.id.in_(select(scoped_sq)))
        .where(FeeEntry.related_asset_id != None)
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(func.count(FeeEntry.id).desc())
    )
    related_asset_rows = session.exec(related_asset_q).all()
    related_assets = [FilterOptionWithCount(value=str(aid), label=sym or lbl or str(aid), count=c)
                      for aid, sym, lbl, c in related_asset_rows]

    return FeesFilterOptionsResponse(
        assets=assets,
        related_assets=related_assets,
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
        # Exclude derivative settlements (redirected to underlying below)
        realized_query = (
            select(
                RealizedPnl.asset_id,
                func.sum(RealizedPnl.pnl_in_base).label("total_pnl"),
                func.count(RealizedPnl.pnl_id).label("event_count")
            )
            .join(RealizedPnl.origin_unit)
            .where(CalculationUnit.version_id == version_id)
            .where(RealizedPnl.related_asset_symbol.is_(None))
            .group_by(RealizedPnl.asset_id)
        )
        if filtered_unit_ids is not None:
            realized_query = realized_query.where(RealizedPnl.origin_unit_id.in_(filtered_unit_ids))
        realized_results = session.exec(realized_query).all()
        realized_map = {r.asset_id: {"pnl": float(r.total_pnl or 0), "count": r.event_count} for r in realized_results}

        # Query taxable realized P&L aggregated by asset
        taxable_rpnl_query = (
            select(
                RealizedPnl.asset_id,
                func.sum(RealizedPnl.pnl_in_base).label("total_pnl"),
            )
            .join(RealizedPnl.origin_unit)
            .where(CalculationUnit.version_id == version_id)
            .where(RealizedPnl.related_asset_symbol.is_(None))
            .where(RealizedPnl.disposal_taxable == True)
            .group_by(RealizedPnl.asset_id)
        )
        if filtered_unit_ids is not None:
            taxable_rpnl_query = taxable_rpnl_query.where(RealizedPnl.origin_unit_id.in_(filtered_unit_ids))
        taxable_rpnl_results = session.exec(taxable_rpnl_query).all()
        taxable_rpnl_map = {r.asset_id: float(r.total_pnl or 0) for r in taxable_rpnl_results}

        # Redirect derivative taxable P&L to the underlying asset
        taxable_deriv_query = (
            select(
                Asset.asset_id,
                func.sum(RealizedPnl.pnl_in_base).label("total_pnl"),
            )
            .join(RealizedPnl.origin_unit)
            .join(Asset, Asset.symbol == RealizedPnl.related_asset_symbol)
            .where(CalculationUnit.version_id == version_id)
            .where(RealizedPnl.related_asset_symbol.isnot(None))
            .where(RealizedPnl.disposal_taxable == True)
            .group_by(Asset.asset_id)
        )
        if filtered_unit_ids is not None:
            taxable_deriv_query = taxable_deriv_query.where(RealizedPnl.origin_unit_id.in_(filtered_unit_ids))
        taxable_deriv_results = session.exec(taxable_deriv_query).all()
        for r in taxable_deriv_results:
            taxable_rpnl_map[r.asset_id] = taxable_rpnl_map.get(r.asset_id, 0.0) + float(r.total_pnl or 0)

        # Redirect derivative P&L to the underlying asset via related_asset_symbol
        deriv_query = (
            select(
                Asset.asset_id,
                func.sum(RealizedPnl.pnl_in_base).label("total_pnl"),
                func.count(RealizedPnl.pnl_id).label("event_count")
            )
            .join(RealizedPnl.origin_unit)
            .join(Asset, Asset.symbol == RealizedPnl.related_asset_symbol)
            .where(CalculationUnit.version_id == version_id)
            .where(RealizedPnl.related_asset_symbol.isnot(None))
            .group_by(Asset.asset_id)
        )
        if filtered_unit_ids is not None:
            deriv_query = deriv_query.where(RealizedPnl.origin_unit_id.in_(filtered_unit_ids))
        deriv_results = session.exec(deriv_query).all()
        for r in deriv_results:
            if r.asset_id in realized_map:
                realized_map[r.asset_id]["pnl"] += float(r.total_pnl or 0)
                realized_map[r.asset_id]["count"] += r.event_count
            else:
                realized_map[r.asset_id] = {"pnl": float(r.total_pnl or 0), "count": r.event_count}
        
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
                    symbol=data["asset"].symbol if data["asset"] else f"#{asset_id}",
                    label=data["asset"].label if data["asset"] else None
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
                taxable_realized_pnl_in_base=taxable_rpnl_map.get(asset_id, 0.0),
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
                    symbol=data["asset"].symbol if data["asset"] else f"#{asset_id}",
                    label=data["asset"].label if data["asset"] else None
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
    warning_type: Optional[str] = None,   # Comma-sep warning types
    level: Optional[str] = None,           # "error", "warning", "info"
    asset_id: Optional[int] = None,
    search: Optional[str] = None,          # Search message text
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

    # Filter by warning_type (comma-separated)
    if warning_type:
        types = [t.strip() for t in warning_type.split(",") if t.strip()]
        if types:
            base_query = base_query.where(PnlWarning.warning_type.in_(types))

    # Filter by severity level
    if level:
        levels = [l.strip() for l in level.split(",") if l.strip()]
        matching_types = []
        for lv in levels:
            matching_types.extend(SEVERITY_TO_WARNING_TYPES.get(lv, []))
        if matching_types:
            base_query = base_query.where(PnlWarning.warning_type.in_(matching_types))

    # Filter by asset_id
    if asset_id is not None:
        base_query = base_query.where(PnlWarning.asset_id == asset_id)

    # Search on message text
    if search:
        base_query = base_query.where(PnlWarning.message.ilike(f"%{search}%"))
    
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
            asset_id=w.asset_id,
            details=w.details,
        )
        for w in warnings
    ]
    
    return {"items": items, "total": total, "page": page, "limit": limit}


@router.get("/versions/{version_id}/warnings/type-counts")
def get_version_warning_type_counts(
    version_id: int,
    session: Session = Depends(get_session_dependency),
):
    """
    Get per-type warning counts for a specific version.

    Returns: dict mapping warning_type → count, e.g. {"missing_price": 5, "unmatched": 2}
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    rows = session.exec(
        select(PnlWarning.warning_type, func.count())
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
        .group_by(PnlWarning.warning_type)
    ).all()

    return {wtype: count for wtype, count in rows}


@router.get("/versions/{version_id}/warnings/filter-options", response_model=WarningsFilterOptionsResponse)
def get_warnings_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """Return available filter values for the warnings list."""
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    base_q = (
        select(PnlWarning.id)
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
    )
    base_q, _ = _apply_unit_filter(base_q, tx_filters, version_id, session, unit_column=PnlWarning.unit_id)
    scoped_sq = base_q.subquery()

    # Warning types with counts
    type_q = (
        select(PnlWarning.warning_type, func.count(PnlWarning.id))
        .where(PnlWarning.id.in_(select(scoped_sq)))
        .group_by(PnlWarning.warning_type)
    )
    type_rows = session.exec(type_q).all()
    warning_types = [FilterOptionWithCount(value=wt, label=wt.replace("_", " ").title(), count=c)
                     for wt, c in type_rows]

    # Severity levels with counts (derived from warning_type)
    level_counts: Dict[str, int] = {"error": 0, "warning": 0, "info": 0}
    for wt, c in type_rows:
        lv = _get_warning_level(wt)
        level_counts[lv] = level_counts.get(lv, 0) + c
    levels = [FilterOptionWithCount(value=lv, label=lv.title(), count=cnt)
              for lv, cnt in level_counts.items() if cnt > 0]

    # Assets with counts (only warnings that have asset_id)
    asset_q = (
        select(Asset.asset_id, Asset.symbol, Asset.label, func.count(PnlWarning.id))
        .join(PnlWarning, PnlWarning.asset_id == Asset.asset_id)
        .where(PnlWarning.id.in_(select(scoped_sq)))
        .group_by(Asset.asset_id, Asset.symbol, Asset.label)
        .order_by(func.count(PnlWarning.id).desc())
    )
    asset_rows = session.exec(asset_q).all()
    assets = [FilterOptionWithCount(value=str(aid), label=sym or lbl or str(aid), count=c)
              for aid, sym, lbl, c in asset_rows]

    return WarningsFilterOptionsResponse(
        warning_types=warning_types,
        levels=levels,
        assets=assets,
    )


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
    search: Optional[str] = None,  # Search event description / asset symbol
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
    
    # Related-asset filter: handled at the unit level via tx_filters
    # (_apply_unit_filter resolves units whose legs involve this asset).
    # We do NOT further narrow by CostLot.asset_id here so that the
    # event list includes all lot movements from those units (e.g. EUR
    # counter-legs in a split unit), matching the audit-summary count.
    
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

    # Search on asset symbol
    if search:
        search_term = f"%{search}%"
        lot_asset_alias = Asset.__table__.alias("lot_asset_search")
        base_query = base_query.outerjoin(
            lot_asset_alias, CostLot.asset_id == lot_asset_alias.c.asset_id
        ).where(
            or_(
                lot_asset_alias.c.symbol.ilike(search_term),
                lot_asset_alias.c.label.ilike(search_term),
            )
        )
    
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
            asset=AssetRef(id=e.lot.asset.asset_id, symbol=e.lot.asset.symbol, label=e.lot.asset.label) if e.lot and e.lot.asset else None,
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
            # FMV details from the associated CostLot (for 'created' events with FMV cost)
            cost_source=e.lot.cost_source if e.lot and e.event_type in ('created', 'created-negative') and e.lot.cost_source in ('fmv', 'provisional') else None,
            cost_fmv_price=float(e.lot.cost_fmv_price) if e.lot and e.event_type in ('created', 'created-negative') and e.lot.cost_fmv_price is not None else None,
            cost_fmv_source=e.lot.cost_fmv_source if e.lot and e.event_type in ('created', 'created-negative') else None,
            cost_fmv_timestamp=e.lot.cost_fmv_timestamp if e.lot and e.event_type in ('created', 'created-negative') else None,
            cost_fmv_stale=e.lot.cost_fmv_stale if e.lot and e.event_type in ('created', 'created-negative') and e.lot.cost_fmv_stale else None,
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
    event_types: List[FilterOptionWithCount] = []
    unit_patterns: List[FilterOptionWithCount] = []


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
    
    # Get unique event types with counts
    event_type_query = (
        select(CostLotEvent.event_type, func.count())
        .select_from(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .group_by(CostLotEvent.event_type)
        .order_by(CostLotEvent.event_type)
    )
    event_types = session.exec(event_type_query).all()
    
    # Get unique unit patterns with counts
    unit_pattern_query = (
        select(CalculationUnit.pattern, func.count())
        .select_from(CostLotEvent)
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
        .group_by(CalculationUnit.pattern)
        .order_by(CalculationUnit.pattern)
    )
    unit_patterns = session.exec(unit_pattern_query).all()
    
    return LotEventsFilterOptionsResponse(
        assets=[FilterOptionsAsset(id=a[0], symbol=a[1], label=a[2]) for a in assets],
        accounts=[FilterOptionsAccount(id=acc[0], name=acc[1]) for acc in accounts],
        event_types=[FilterOptionWithCount(value=et[0], label=et[0], count=et[1]) for et in event_types],
        unit_patterns=[FilterOptionWithCount(value=up[0], label=up[0], count=up[1]) for up in unit_patterns],
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
            asset=AssetRef(id=e.asset_id, symbol=e.asset.symbol if e.asset else f"#{e.asset_id}", label=e.asset.label if e.asset else None),
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


# =============================================================================
# Investigation View endpoints
# =============================================================================


@router.get("/versions/{version_id}/audit-summary", response_model=AuditSummaryResponse)
def get_audit_summary(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """
    Get aggregate summary for the investigation view quick stats bar.

    Returns counts and breakdowns for units, lots, realized P&L, fees,
    and warnings — all scoped to the active transaction filters (investigation context).
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # Resolve filtered unit IDs once for reuse across all sub-queries
    filtered_unit_ids = None
    if tx_filters.has_active_filters:
        filtered_unit_ids = resolve_filtered_unit_ids(
            session, version_id, tx_filters.applied_filters,
            non_owned=tx_filters.non_owned,
        )

    def _unit_filter(query, col):
        if filtered_unit_ids is not None:
            return query.where(col.in_(filtered_unit_ids))
        return query

    # --- Units count ---
    units_q = (
        select(func.count(CalculationUnit.id))
        .where(CalculationUnit.version_id == version_id)
    )
    units_q = _unit_filter(units_q, CalculationUnit.id)
    units_count = session.exec(units_q).one()

    # --- Lots summary ---
    lots_base = (
        select(
            func.count(CostLot.cost_lot_id).label("total"),
            func.sum(case(
                (CostLot.is_negative == True, 1),  # noqa: E712
                else_=0
            )).label("negative"),
            func.sum(case(
                ((CostLot.is_negative == False) & (CostLot.qty_remaining > 0), 1),  # noqa: E712
                else_=0
            )).label("open"),
            func.sum(case(
                ((CostLot.is_negative == False) & (CostLot.qty_remaining <= 0), 1),  # noqa: E712
                else_=0
            )).label("exhausted"),
        )
        .join(CostLot.unit)
        .where(CalculationUnit.version_id == version_id)
    )
    lots_base = _unit_filter(lots_base, CostLot.unit_id)
    lots_row = session.exec(lots_base).one()
    lots_summary = AuditLotsSummary(
        total=lots_row.total or 0,
        open=lots_row.open or 0,
        exhausted=lots_row.exhausted or 0,
        negative=lots_row.negative or 0,
    )

    # --- Realized P&L summary ---
    rpnl_base = (
        select(
            func.count(RealizedPnl.pnl_id).label("total"),
            func.sum(case((RealizedPnl.disposal_taxable == True, 1), else_=0)).label("taxable"),  # noqa: E712
            func.sum(case((RealizedPnl.disposal_taxable == False, 1), else_=0)).label("non_taxable"),  # noqa: E712
            func.sum(case((RealizedPnl.pnl_in_base > 0, 1), else_=0)).label("gain"),
            func.sum(case((RealizedPnl.pnl_in_base < 0, 1), else_=0)).label("loss"),
            func.sum(case((RealizedPnl.holding_period_days < 365, 1), else_=0)).label("short_term"),
            func.sum(case(
                ((RealizedPnl.holding_period_days >= 365) | (RealizedPnl.holding_period_days == None), 1),  # noqa: E711
                else_=0
            )).label("long_term"),
            func.sum(case((RealizedPnl.pnl_in_base > 0, RealizedPnl.pnl_in_base), else_=0)).label("total_gain_val"),
            func.sum(case((RealizedPnl.pnl_in_base < 0, RealizedPnl.pnl_in_base), else_=0)).label("total_loss_val"),
        )
        .join(RealizedPnl.origin_unit)
        .where(CalculationUnit.version_id == version_id)
    )
    rpnl_base = _unit_filter(rpnl_base, RealizedPnl.origin_unit_id)
    rpnl_row = session.exec(rpnl_base).one()
    realized_summary = AuditRealizedSummary(
        total=rpnl_row.total or 0,
        taxable=rpnl_row.taxable or 0,
        non_taxable=rpnl_row.non_taxable or 0,
        total_gain=float(rpnl_row.total_gain_val or 0),
        total_loss=abs(float(rpnl_row.total_loss_val or 0)),
        short_term=rpnl_row.short_term or 0,
        long_term=rpnl_row.long_term or 0,
    )

    # --- Fees summary ---
    fees_count_q = (
        select(func.count(FeeEntry.id), func.coalesce(func.sum(FeeEntry.fee_value_in_base), 0))
        .where(FeeEntry.version_id == version_id)
    )
    fees_count_q = _unit_filter(fees_count_q, FeeEntry.unit_id)
    # Apply entity-level related_asset_id filter to match /fees endpoint behaviour
    if tx_filters.applied_filters.related_asset_ids:
        fees_count_q = fees_count_q.where(
            FeeEntry.related_asset_id.in_(tx_filters.applied_filters.related_asset_ids)
        )
    fees_total, fees_total_val = session.exec(fees_count_q).one()

    # Fees by source (join through leg → transaction)
    from backend.db.models import CalculationUnitLeg as CUL_alias
    fees_source_q = (
        select(NormalizedTransaction.source, func.count(FeeEntry.id))
        .join(CUL_alias, FeeEntry.fee_leg_id == CUL_alias.id)
        .outerjoin(NormalizedTransaction, CUL_alias.transaction_id == NormalizedTransaction.id)
        .where(FeeEntry.version_id == version_id)
        .group_by(NormalizedTransaction.source)
    )
    fees_source_q = _unit_filter(fees_source_q, FeeEntry.unit_id)
    if tx_filters.applied_filters.related_asset_ids:
        fees_source_q = fees_source_q.where(
            FeeEntry.related_asset_id.in_(tx_filters.applied_filters.related_asset_ids)
        )
    fees_by_source = [
        AuditFeeSourceCount(source=src or "unknown", count=cnt)
        for src, cnt in session.exec(fees_source_q).all()
    ]
    fees_summary = AuditFeesSummary(
        total=fees_total or 0,
        total_value_in_base=float(fees_total_val or 0),
        by_source=fees_by_source,
    )

    # --- Warnings summary ---
    warn_type_q = (
        select(PnlWarning.warning_type, func.count(PnlWarning.id))
        .join(PnlWarning.unit)
        .where(CalculationUnit.version_id == version_id)
        .group_by(PnlWarning.warning_type)
    )
    warn_type_q = _unit_filter(warn_type_q, PnlWarning.unit_id)
    warn_type_rows = session.exec(warn_type_q).all()

    warn_total = 0
    by_level = {"error": 0, "warning": 0, "info": 0}
    by_type = []
    for wtype, cnt in warn_type_rows:
        warn_total += cnt
        level = _get_warning_level(wtype)
        by_level[level] = by_level.get(level, 0) + cnt
        by_type.append(AuditWarningTypeCount(type=wtype, count=cnt))

    warnings_summary = AuditWarningsSummary(
        total=warn_total,
        by_level=AuditWarningsByLevel(**by_level),
        by_type=by_type,
    )

    # --- Cost Lot Events count ---
    events_q = (
        select(func.count(CostLotEvent.event_id))
        .join(CostLot, CostLotEvent.lot_id == CostLot.cost_lot_id)
        .join(CalculationUnit, CostLot.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    )
    events_q = _unit_filter(events_q, CostLot.unit_id)
    events_count = session.exec(events_q).one()

    # --- Transactions count (included / excluded) ---
    included_q = (
        select(func.count(func.distinct(NormalizedTransaction.id)))
        .join(CalculationUnitLeg, CalculationUnitLeg.transaction_id == NormalizedTransaction.id)
        .join(CalculationUnit, CalculationUnitLeg.unit_id == CalculationUnit.id)
        .where(CalculationUnit.version_id == version_id)
    )
    included_q = _unit_filter(included_q, CalculationUnitLeg.unit_id)
    included_count = session.exec(included_q).one()

    # Excluded = total transactions in date range minus included
    # For now, just provide included count; excluded requires knowing the full scope
    tx_summary = AuditTransactionsSummary(
        included=included_count,
        excluded=0,  # TODO: compute from full transaction scope if needed
    )

    return AuditSummaryResponse(
        units_count=units_count,
        lots=lots_summary,
        realized=realized_summary,
        fees=fees_summary,
        warnings=warnings_summary,
        events_count=events_count,
        transactions=tx_summary,
    )


@router.get("/versions/{version_id}/units/{unit_id}", response_model=ProcessedUnitResponse)
def get_unit_by_id(
    version_id: int,
    unit_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Get a single calculation unit by ID with full nested data."""
    from backend.db.models import CalculationUnitLeg

    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    query = (
        select(CalculationUnit)
        .where(CalculationUnit.version_id == version_id, CalculationUnit.id == unit_id)
        .options(
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.asset),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.account_rel),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.price_quote_asset),
            selectinload(CalculationUnit.legs).selectinload(CalculationUnitLeg.transaction).selectinload(NormalizedTransaction.fee_quote_asset),
            selectinload(CalculationUnit.cost_lots).selectinload(CostLot.asset),
            selectinload(CalculationUnit.cost_lots).selectinload(CostLot.account),
            selectinload(CalculationUnit.realized_pnl_records).selectinload(RealizedPnl.asset),
            selectinload(CalculationUnit.realized_pnl_records).selectinload(RealizedPnl.slices).selectinload(ConsumedLotSlice.cost_lot).selectinload(CostLot.asset),
            selectinload(CalculationUnit.fee_entries),
            selectinload(CalculationUnit.warnings),
        )
    )
    u = session.exec(query).first()
    if not u:
        raise HTTPException(status_code=404, detail=f"Unit {unit_id} not found in version {version_id}")

    # Settlements for this unit
    settlements_query = (
        select(LotSettlement)
        .options(selectinload(LotSettlement.negative_lot), selectinload(LotSettlement.settling_lot))
        .join(LotSettlement.negative_lot)
        .where(CostLot.unit_id == u.id)
    )
    settlements = [build_settlement_response(s) for s in session.exec(settlements_query).all()]

    # Event IDs
    event_rows = session.exec(
        select(CostLotEvent.event_id).where(CostLotEvent.triggered_by_unit_id == u.id)
    ).all()

    # Fee P&L IDs
    fee_pnl_ids = set(session.exec(
        select(FeeEntry.realized_pnl_id).where(FeeEntry.unit_id == u.id)
    ).all())

    # Build response (same structure as list endpoint)
    transactions_dict: Dict[int, TransactionSummary] = {}
    for leg in u.legs:
        if leg.transaction_id not in transactions_dict and leg.transaction:
            transactions_dict[leg.transaction_id] = build_transaction_summary(leg.transaction)

    legs = [
        LegWithTransaction(
            asset=AssetRef(id=leg.asset.asset_id, symbol=leg.asset.symbol, label=leg.asset.label),
            qty=float(leg.quantity),
            leg_type=leg.leg_type,
            direction=leg.direction,
            transaction_id=leg.transaction_id,
        )
        for leg in u.legs
    ]

    cost_basis = CostBasisTracking(
        lots=[build_cost_lot_response(lot) for lot in u.cost_lots],
        consumed=[build_consumed_slice_response(entry) for entry in u.consumed_slices],
        settlements=settlements,
    )

    realized_entries = [
        build_realized_entry_response(e, is_fee=(e.pnl_id in fee_pnl_ids))
        for e in u.realized_pnl_records
    ]

    warnings = [build_warning_response(w, u.unit_label) for w in u.warnings]

    unit_fee_count = len(u.fee_entries) if u.fee_entries else 0
    unit_total_fees = sum(float(fe.fee_value_in_base) for fe in (u.fee_entries or []))

    return ProcessedUnitResponse(
        unit_id=u.id,
        unit_label=u.unit_label or "",
        pattern=u.pattern,
        timestamp=u.timestamp,
        transactions=list(transactions_dict.values()),
        legs=legs,
        cost_basis=cost_basis,
        realized_entries=realized_entries,
        warnings=warnings,
        event_ids=list(event_rows),
        realized_pnl_in_base=float(u.total_realized_pnl_in_base),
        is_disposal_taxable=any(leg.disposal_taxable for leg in u.legs if leg.leg_type in ("outflow", "fee")),
        has_fees=any(leg.leg_type == "fee" for leg in u.legs),
        fee_count=unit_fee_count,
        total_fees_in_base=unit_total_fees,
    )


@router.get("/versions/{version_id}/units")
def get_version_units(
    version_id: int,
    asset_id: Optional[int] = None,
    unit_pattern: Optional[str] = None,   # Comma-separated patterns (swap, flow, etc.)
    has_warnings: Optional[bool] = None,   # Filter units with warnings
    warning_type: Optional[str] = None,    # Comma-separated warning types to filter by
    has_realized_pnl: Optional[bool] = None,  # Filter units with non-zero realized P&L
    has_fees: Optional[bool] = None,       # Filter units with fees
    search: Optional[str] = None,          # Search unit_id or unit_label
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

    # Filter by unit_pattern (comma-separated list, e.g. "swap,flow")
    if unit_pattern:
        patterns = [p.strip() for p in unit_pattern.split(",") if p.strip()]
        if patterns:
            base_query = base_query.where(CalculationUnit.pattern.in_(patterns))

    # Filter by has_warnings
    if has_warnings is not None:
        warning_exists = (
            select(PnlWarning.id)
            .where(PnlWarning.unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_warnings:
            base_query = base_query.where(warning_exists)
        else:
            base_query = base_query.where(~warning_exists)

    # Filter by specific warning_type(s) — units that have at least one warning of the given type(s)
    if warning_type:
        wt_list = [w.strip() for w in warning_type.split(",") if w.strip()]
        if wt_list:
            wt_exists = (
                select(PnlWarning.id)
                .where(PnlWarning.unit_id == CalculationUnit.id)
                .where(PnlWarning.warning_type.in_(wt_list))
                .correlate(CalculationUnit)
                .exists()
            )
            base_query = base_query.where(wt_exists)

    # Filter by has_realized_pnl (units with at least one RealizedPnl record)
    if has_realized_pnl is not None:
        rpnl_exists = (
            select(RealizedPnl.pnl_id)
            .where(RealizedPnl.origin_unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_realized_pnl:
            base_query = base_query.where(rpnl_exists)
        else:
            base_query = base_query.where(~rpnl_exists)

    # Filter by has_fees (units with at least one FeeEntry)
    if has_fees is not None:
        fee_exists = (
            select(FeeEntry.id)
            .where(FeeEntry.unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_fees:
            base_query = base_query.where(fee_exists)
        else:
            base_query = base_query.where(~fee_exists)

    # Search on unit_id (cast to text) or unit_label (ILIKE)
    if search:
        search_term = f"%{search}%"
        base_query = base_query.where(
            or_(
                cast(CalculationUnit.id, SAString).ilike(search_term),
                CalculationUnit.unit_label.ilike(search_term),
            )
        )

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
                asset=AssetRef(id=leg.asset.asset_id, symbol=leg.asset.symbol, label=leg.asset.label),
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


@router.get("/versions/{version_id}/units/filter-options", response_model=UnitsFilterOptionsResponse)
def get_units_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """
    Get available filter values for the units list.
    Returns patterns with counts, and boolean-filter counts, scoped by context filters.
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # Base scope: all units in version, filtered by context (tx_filters)
    base_q = select(CalculationUnit.id).where(CalculationUnit.version_id == version_id)
    base_q, _ = _apply_unit_filter(base_q, tx_filters, version_id, session, unit_column=CalculationUnit.id)
    scoped_ids_sq = base_q.subquery()

    # Pattern options with counts
    pattern_q = (
        select(CalculationUnit.pattern, func.count(CalculationUnit.id))
        .where(CalculationUnit.id.in_(select(scoped_ids_sq)))
        .group_by(CalculationUnit.pattern)
    )
    pattern_rows = session.exec(pattern_q).all()
    patterns = [FilterOptionWithCount(value=p or "unknown", count=c) for p, c in pattern_rows]

    # Counts for boolean toggles
    total_scoped = sum(c for _, c in pattern_rows)

    has_warnings_q = (
        select(func.count(func.distinct(PnlWarning.unit_id)))
        .where(PnlWarning.unit_id.in_(select(scoped_ids_sq)))
    )
    has_warnings_count = session.exec(has_warnings_q).one() or 0

    has_realized_q = (
        select(func.count(func.distinct(RealizedPnl.origin_unit_id)))
        .where(RealizedPnl.origin_unit_id.in_(select(scoped_ids_sq)))
    )
    has_realized_pnl_count = session.exec(has_realized_q).one() or 0

    has_fees_q = (
        select(func.count(func.distinct(FeeEntry.unit_id)))
        .where(FeeEntry.unit_id.in_(select(scoped_ids_sq)))
    )
    has_fees_count = session.exec(has_fees_q).one() or 0

    # Warning types with per-type unit counts (for multi-select dropdown)
    warning_type_q = (
        select(PnlWarning.warning_type, func.count(func.distinct(PnlWarning.unit_id)))
        .where(PnlWarning.unit_id.in_(select(scoped_ids_sq)))
        .group_by(PnlWarning.warning_type)
    )
    wt_rows = session.exec(warning_type_q).all()
    warning_types = [
        FilterOptionWithCount(
            value=wt,
            label=wt.replace('_', ' ').title(),
            count=c,
        )
        for wt, c in wt_rows
    ]

    return UnitsFilterOptionsResponse(
        patterns=patterns,
        total_units=total_scoped,
        has_warnings_count=has_warnings_count,
        has_realized_pnl_count=has_realized_pnl_count,
        has_fees_count=has_fees_count,
        warning_types=warning_types,
    )


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
    
    # Clear self-referencing FKs before deleting lots
    for unit in units:
        for lot in unit.cost_lots or []:
            if lot.settled_by_lot_id is not None:
                lot.settled_by_lot_id = None
            if lot.source_lot_id is not None:
                lot.source_lot_id = None
    session.flush()

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


# =============================================================================
# Portfolio Timeline (Charts Dashboard)
# =============================================================================

@router.get("/versions/{version_id}/portfolio-timeline")
def get_portfolio_timeline(
    version_id: int,
    granularity: str = Query("daily"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    include_unsettled_negative: bool = Query(False),
    session: Session = Depends(get_session_dependency),
):
    """Get portfolio value timeline for charts."""
    from backend.services.pnl.portfolio_timeline import compute_portfolio_timeline
    from datetime import datetime as dt_cls

    parsed_date_from = dt_cls.fromisoformat(date_from) if date_from else None
    parsed_date_to = dt_cls.fromisoformat(date_to) if date_to else None
    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    points = compute_portfolio_timeline(
        session=session,
        version_id=version_id,
        granularity=granularity,
        date_from=parsed_date_from,
        date_to=parsed_date_to,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    return {
        "version_id": version_id,
        "granularity": granularity,
        "points": [
            {
                "date": p.date,
                "total_value_in_base": p.total_value_in_base,
                "cost_basis_in_base": p.cost_basis_in_base,
                "unrealized_pnl": p.unrealized_pnl,
                "cumulative_realized_pnl": p.cumulative_realized_pnl,
                "breakdown": [
                    {
                        "asset_id": b.asset_id,
                        "symbol": b.symbol,
                        "label": b.label,
                        "value_in_base": b.value_in_base,
                        "qty": b.qty,
                        "cost_basis_in_base": b.cost_basis_in_base,
                        "realized_pnl_to_date": b.realized_pnl_to_date,
                    }
                    for b in p.breakdown
                ],
            }
            for p in points
        ],
    }


# =============================================================================
# Settled Metrics (cost-lot-based, no price lookup)
# =============================================================================

@router.get("/versions/{version_id}/metrics/settled")
def get_settled_metrics(
    version_id: int,
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    include_unsettled_negative: bool = Query(False),
    session: Session = Depends(get_session_dependency),
):
    """
    Compute cost-lot-based metrics that don't require market prices.
    Returns instantly: cost_basis, realized_pnl, fees, and per-period settled fields.
    """
    from backend.services.pnl.metrics_service import compute_settled_metrics

    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    metrics = compute_settled_metrics(
        session=session,
        version_id=version_id,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    if metrics is None:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    return {
        "version_id": metrics.version_id,
        "summary": {
            "cost_basis": metrics.summary.cost_basis,
            "realized_pnl": metrics.summary.realized_pnl,
            "taxable_realized_pnl": metrics.summary.taxable_realized_pnl,
            "total_fees": metrics.summary.total_fees,
            "fee_entry_count": metrics.summary.fee_entry_count,
        },
        "ranges": {
            key: {
                "cost_basis": m.cost_basis,
                "realized_pnl": m.realized_pnl,
                "taxable_realized_pnl": m.taxable_realized_pnl,
                "realized_in_period": m.realized_in_period,
                "cost_basis_in_period": m.cost_basis_in_period,
                "fees_in_period": m.fees_in_period,
            }
            for key, m in metrics.ranges.items()
        },
    }


# =============================================================================
# Market Metrics (price-dependent, reads PriceSnapshot)
# =============================================================================

@router.get("/versions/{version_id}/metrics/market")
def get_market_metrics(
    version_id: int,
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    include_unsettled_negative: bool = Query(False),
    session: Session = Depends(get_session_dependency),
):
    """
    Compute price-dependent metrics using prices already in PriceSnapshot.
    Does NOT refresh prices — trusts frontend already updated them.
    Call after frontend price fetch completes for accurate values.
    """
    from backend.services.pnl.metrics_service import compute_market_metrics

    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    metrics = compute_market_metrics(
        session=session,
        version_id=version_id,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    if metrics is None:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    return {
        "version_id": metrics.version_id,
        "summary": {
            "current_value": metrics.summary.current_value,
            "unrealized_pnl": metrics.summary.unrealized_pnl,
        },
        "ranges": {
            key: {
                "current_value": m.current_value,
                "unrealized_pnl": m.unrealized_pnl,
                "unrealized_in_period": m.unrealized_in_period,
                "total_return": m.total_return,
                "roi_pct": m.roi_pct,
            }
            for key, m in metrics.ranges.items()
        },
    }


# =============================================================================
# Performers (standalone performer ranking)
# =============================================================================

@router.get("/versions/{version_id}/performers")
def get_performers(
    version_id: int,
    period: str = Query("all"),
    group_by: str = Query("asset", regex="^(asset|account|category)$"),
    top_n: int = Query(5, ge=1, le=500),
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    dimension_id: Optional[int] = Query(None),
    include_unsettled_negative: bool = Query(False),
    session: Session = Depends(get_session_dependency),
):
    """
    Compute top/flop performers for a single period and group_by dimension.
    Isolated from period metrics — changing group_by only re-fetches this.
    """
    from backend.services.pnl.metrics_service import compute_performers

    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    result = compute_performers(
        session=session,
        version_id=version_id,
        period=period,
        group_by=group_by,
        top_n=top_n,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        dimension_id=dimension_id,
        include_unsettled_negative=include_unsettled_negative,
    )

    if result is None:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    def _serialize_performer(p):
        return {
            "id": p.id,
            "name": p.name,
            "label": p.label,
            "group_type": p.group_type,
            "total_return": p.total_return,
            "roi_pct": p.roi_pct,
            "unrealized_pnl": p.unrealized_pnl,
            "market_value": p.market_value,
            "cost_basis": p.cost_basis,
            "total_fees": p.total_fees,
            "efficiency": p.efficiency,
        }

    return {
        "version_id": result.version_id,
        "period": result.period,
        "group_type": result.group_type,
        "top_performers": [_serialize_performer(p) for p in result.top_performers],
        "flop_performers": [_serialize_performer(p) for p in result.flop_performers],
        "total_count": result.total_count,
    }


@router.get("/versions/{version_id}/asset-period-deltas")
def get_asset_period_deltas(
    version_id: int,
    period: str = Query("1m"),
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    include_unsettled_negative: bool = Query(False),
    session: Session = Depends(get_session_dependency),
):
    """
    Compute per-asset period delta metrics for ALL assets.
    Returns total_return, roi_pct, unrealized_change, etc. for each asset.
    Designed for period-aware asset cards.
    """
    from backend.services.pnl.metrics_service import compute_asset_period_deltas

    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    result = compute_asset_period_deltas(
        session=session,
        version_id=version_id,
        period=period,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        include_unsettled_negative=include_unsettled_negative,
    )

    if result is None:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    return {
        "version_id": version_id,
        "period": period,
        "deltas": [
            {
                "asset_id": d.asset_id,
                "symbol": d.symbol,
                "label": d.label,
                "total_return": d.total_return,
                "roi_pct": d.roi_pct,
                "unrealized_change": d.unrealized_change,
                "realized_in_period": d.realized_in_period,
                "cost_change": d.cost_change,
                "market_value_change": d.market_value_change,
            }
            for d in result
        ],
    }


# =============================================================================
# Version Metrics (replaces period-summary)
# =============================================================================

@router.get("/versions/{version_id}/metrics")
def get_version_metrics(
    version_id: int,
    group_by: str = Query("asset", regex="^(asset|account|category)$"),
    top_n: int = Query(5, ge=1, le=500),
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    dimension_id: Optional[int] = Query(None),
    include_unsettled_negative: bool = Query(True),
    session: Session = Depends(get_session_dependency),
):
    """
    Compute portfolio metrics for all standard ranges (all, 1y, 6m, 3m, 1m).

    Centralized metrics computation with server-side group_by for performers.
    Replaces the old /period-summary endpoint.

    Query params:
      - group_by: 'asset' (default), 'account', or 'category'
      - top_n: number of top/flop performers (1-25, default 5)
      - dimension_id: when group_by=category, restrict to this dimension
    """
    from backend.services.pnl.metrics_service import compute_version_metrics

    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    metrics = compute_version_metrics(
        session=session,
        version_id=version_id,
        group_by=group_by,
        top_n=top_n,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
        dimension_id=dimension_id,
        include_unsettled_negative=include_unsettled_negative,
        refresh_prices=False,
    )

    if metrics is None:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    def _serialize_performer(p):
        return {
            "id": p.id,
            "name": p.name,
            "label": p.label,
            "group_type": p.group_type,
            "total_return": p.total_return,
            "roi_pct": p.roi_pct,
            "unrealized_pnl": p.unrealized_pnl,
            "market_value": p.market_value,
            "cost_basis": p.cost_basis,
            "total_fees": p.total_fees,
            "efficiency": p.efficiency,
        }

    return {
        "version_id": metrics.version_id,
        "summary": {
            "current_value": metrics.summary.current_value,
            "cost_basis": metrics.summary.cost_basis,
            "unrealized_pnl": metrics.summary.unrealized_pnl,
            "realized_pnl": metrics.summary.realized_pnl,
            "taxable_realized_pnl": metrics.summary.taxable_realized_pnl,
            "total_fees": metrics.summary.total_fees,
            "fee_entry_count": metrics.summary.fee_entry_count,
        },
        "ranges": {
            key: {
                "total_return": m.total_return,
                "roi_pct": m.roi_pct,
                "current_value": m.current_value,
                "cost_basis": m.cost_basis,
                "unrealized_pnl": m.unrealized_pnl,
                "realized_pnl": m.realized_pnl,
                "taxable_realized_pnl": m.taxable_realized_pnl,
                "realized_in_period": m.realized_in_period,
                "cost_basis_in_period": m.cost_basis_in_period,
                "unrealized_in_period": m.unrealized_in_period,
                "fees_in_period": m.fees_in_period,
                "top_performers": [_serialize_performer(p) for p in m.top_performers],
                "flop_performers": [_serialize_performer(p) for p in m.flop_performers],
            }
            for key, m in metrics.ranges.items()
        },
    }


# =============================================================================
# Fee Summary by Period (Charts Dashboard)
# =============================================================================

@router.get("/versions/{version_id}/fee-summary-by-period")
def get_fee_summary_by_period(
    version_id: int,
    granularity: str = Query("monthly"),
    group_by: str = Query("asset"),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    asset_ids: Optional[str] = Query(None),
    account_ids: Optional[str] = Query(None),
    category_ids: Optional[str] = Query(None),
    session: Session = Depends(get_session_dependency),
):
    """Get fee summary aggregated by time period for charts."""
    from backend.services.pnl.fee_summary import compute_fee_summary_by_period
    from datetime import datetime as dt_cls

    parsed_date_from = dt_cls.fromisoformat(date_from) if date_from else None
    parsed_date_to = dt_cls.fromisoformat(date_to) if date_to else None
    parsed_asset_ids = [int(x) for x in asset_ids.split(",") if x.strip()] if asset_ids else None
    parsed_account_ids = [int(x) for x in account_ids.split(",") if x.strip()] if account_ids else None
    parsed_category_ids = [int(x) for x in category_ids.split(",") if x.strip()] if category_ids else None

    periods = compute_fee_summary_by_period(
        session=session,
        version_id=version_id,
        granularity=granularity,
        group_by=group_by,
        date_from=parsed_date_from,
        date_to=parsed_date_to,
        asset_ids=parsed_asset_ids,
        account_ids=parsed_account_ids,
        category_ids=parsed_category_ids,
    )

    return {
        "version_id": version_id,
        "granularity": granularity,
        "group_by": group_by,
        "periods": [
            {
                "period": bucket.period,
                "total_fees_in_base": bucket.total_fees_in_base,
                "count": bucket.count,
                "breakdown": [
                    {
                        "key": item.key,
                        "key_id": item.key_id,
                        "fees_in_base": item.fees_in_base,
                    }
                    for item in bucket.breakdown
                ],
            }
            for bucket in periods
        ],
    }


# =============================================================================
# Force-Settle Dust Lots
# =============================================================================

class ForceSettleResponse(BaseModel):
    lot_id: int
    settled: bool
    message: str

class BulkForceSettleRequest(BaseModel):
    lot_ids: List[int]

class BulkForceSettleResponse(BaseModel):
    settled: List[int]
    rejected: List[ForceSettleResponse]


@router.post("/cost-lots/{lot_id}/force-settle")
def force_settle_single(
    lot_id: int,
    session: Session = Depends(get_session_dependency),
):
    """Force-settle a small unsettled negative lot (dust < $1.00 base value)."""
    from backend.services.pnl.lot_manager import force_settle_lot

    try:
        force_settle_lot(session, lot_id)
        session.commit()
        return ForceSettleResponse(lot_id=lot_id, settled=True, message="Settled")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/cost-lots/bulk-force-settle")
def force_settle_bulk(
    body: BulkForceSettleRequest,
    session: Session = Depends(get_session_dependency),
):
    """Force-settle multiple small unsettled negative lots."""
    from backend.services.pnl.lot_manager import force_settle_lot

    settled: List[int] = []
    rejected: List[ForceSettleResponse] = []
    for lid in body.lot_ids:
        try:
            force_settle_lot(session, lid)
            settled.append(lid)
        except ValueError as e:
            rejected.append(ForceSettleResponse(lot_id=lid, settled=False, message=str(e)))
    session.commit()
    return BulkForceSettleResponse(settled=settled, rejected=rejected)


# =============================================================================
# Benchmark Series (External Index Data)
# =============================================================================

# Whitelisted benchmark tickers (prevent arbitrary Yahoo Finance queries)
BENCHMARK_PRESETS: Dict[str, str] = {
    "^GSPC": "S&P 500",
    "^IXIC": "NASDAQ Composite",
    "^STOXX50E": "Euro Stoxx 50",
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "GC=F": "Gold",
}

# Simple in-memory cache: (ticker, start, end) -> (timestamp, data)
_benchmark_cache: Dict[tuple, tuple] = {}
_BENCHMARK_CACHE_TTL = 300  # 5 minutes


@router.get("/benchmark-series")
def get_benchmark_series(
    ticker: str = Query(..., description="Yahoo Finance ticker (e.g., ^GSPC)"),
    start_date: str = Query(..., description="Start date YYYY-MM-DD"),
    end_date: str = Query(..., description="End date YYYY-MM-DD"),
):
    """
    Fetch daily close prices for an external benchmark index.

    Returns rebased-ready daily price series from Yahoo Finance.
    Only whitelisted tickers are allowed.
    """
    import time as _time
    from datetime import date as date_cls

    if ticker not in BENCHMARK_PRESETS:
        raise HTTPException(
            status_code=400,
            detail=f"Ticker '{ticker}' not in allowed benchmarks. "
                   f"Available: {list(BENCHMARK_PRESETS.keys())}",
        )

    try:
        parsed_start = date_cls.fromisoformat(start_date)
        parsed_end = date_cls.fromisoformat(end_date)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format. Use YYYY-MM-DD.")

    # Check cache
    cache_key = (ticker, start_date, end_date)
    now = _time.time()
    if cache_key in _benchmark_cache:
        cached_at, cached_data = _benchmark_cache[cache_key]
        if now - cached_at < _BENCHMARK_CACHE_TTL:
            return cached_data

    # Fetch from Yahoo Direct
    from backend.services.price_getters.registry import get_price_getter
    from backend.services.price_getters.base import PriceGetterError

    try:
        getter = get_price_getter("yahoo_direct")
        points = getter.get_daily_series(ticker, parsed_start, parsed_end)
    except PriceGetterError as e:
        log.warning(f"Benchmark fetch failed for {ticker}: {e}")
        raise HTTPException(status_code=502, detail=f"Failed to fetch benchmark data: {e.message}")
    except Exception as e:
        log.error(f"Unexpected error fetching benchmark {ticker}: {e}")
        raise HTTPException(status_code=500, detail="Internal error fetching benchmark data.")

    response = {
        "ticker": ticker,
        "label": BENCHMARK_PRESETS[ticker],
        "points": points,
    }

    # Store in cache
    _benchmark_cache[cache_key] = (now, response)

    return response


# =============================================================================
# Enriched Transactions (PnL Audit — Transaction-level view)
# =============================================================================


class EnrichedTransactionFeeDetail(BaseModel):
    """Fee detail for an enriched transaction."""
    fee_amount: float
    fee_in_base: float
    asset: Optional[AssetRef] = None


class CostLotEventSummaryItem(BaseModel):
    """Compact cost lot event summary."""
    event_type: str
    quantity_delta: float
    lot_id: Optional[int] = None


class EnrichedTransactionResponse(BaseModel):
    """Transaction extended with P&L enrichment data.

    Contains all standard TransactionResponse fields plus unit-level P&L info
    so the frontend can render enriched rows without extra requests.
    """

    # --- Standard transaction fields (flat copy from TransactionResponse) ---
    id: Optional[int] = None
    source: Optional[str] = None
    source_transaction_id: Optional[str] = None
    source_transaction_type: Optional[str] = None
    source_asset_symbol: Optional[str] = None
    source_price_quote_asset_symbol: Optional[str] = None
    source_fee_quote_asset_symbol: Optional[str] = None
    account_id: Optional[int] = None
    raw_transaction_id: Optional[int] = None
    asset_id: Optional[int] = None
    price_quote_asset_id: Optional[int] = None
    fee_quote_asset_id: Optional[int] = None
    user_calculation_unit_id: Optional[int] = None
    date_time: Optional[Any] = None
    direction: Optional[str] = None
    transaction_type: Optional[str] = None
    quantity: Optional[float] = None
    price: Optional[float] = None
    total: Optional[float] = None
    fee: Optional[float] = None
    include_fee: Optional[bool] = False
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None
    from_account_id: Optional[int] = None
    to_account_id: Optional[int] = None
    network: Optional[str] = None
    network_transaction_id: Optional[str] = None
    token_contract_address: Optional[str] = None
    review_status: Optional[str] = "pending"
    taxability_status: Optional[str] = "unknown"
    review_notes: Optional[str] = None
    synced_at: Optional[str] = None
    sync_connector_run_id: Optional[int] = None
    connector_name: Optional[str] = None
    run_datetime: Optional[str] = None
    tags: List[Dict[str, Any]] = Field(default_factory=list)
    linked_asset: Optional[AssetRef] = None
    price_quote_asset: Optional[AssetRef] = None
    fee_quote_asset: Optional[AssetRef] = None
    linked_asset_symbol: Optional[str] = None
    linked_price_quote_asset_symbol: Optional[str] = None
    linked_fee_quote_asset_symbol: Optional[str] = None
    account_name: Optional[str] = None
    from_account_name: Optional[str] = None
    to_account_name: Optional[str] = None

    # --- P&L enrichment fields ---
    unit_id: Optional[int] = None
    unit_pattern: Optional[str] = None
    unit_label: Optional[str] = None
    realized_entries: List[RealizedEntryDetailResponse] = Field(default_factory=list)
    realized_pnl_in_base: Optional[float] = None
    fee_entries: List[EnrichedTransactionFeeDetail] = Field(default_factory=list)
    total_fees_in_base: Optional[float] = None
    cost_lot_event_summary: List[CostLotEventSummaryItem] = Field(default_factory=list)
    is_disposal_taxable: Optional[bool] = None


class EnrichedTransactionsFilterOptionsResponse(BaseModel):
    """Filter options for enriched transactions — mirrors UnitsFilterOptionsResponse
    but counts reflect transactions, not units."""
    patterns: List[FilterOptionWithCount] = []
    total_transactions: int = 0
    has_warnings_count: int = 0
    has_realized_pnl_count: int = 0
    has_fees_count: int = 0
    warning_types: List[FilterOptionWithCount] = []


@router.get("/versions/{version_id}/enriched-transactions")
def get_enriched_transactions(
    version_id: int,
    # PnL-specific filters
    unit_pattern: Optional[str] = None,
    has_realized_pnl: Optional[bool] = None,
    has_fees: Optional[bool] = None,
    has_warnings: Optional[bool] = None,
    warning_type: Optional[str] = None,
    search: Optional[str] = None,
    # Standard pagination & sorting
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    sort_by: Optional[str] = "date_time",
    sort_dir: Optional[str] = "desc",
    # Context filters (account, asset, etc.)
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """
    Get transactions enriched with P&L data for the transaction-level audit view.

    Returns standard TransactionListResponse shape with extra P&L fields per transaction.
    Supports both PnL-specific filters (unit_pattern, has_realized_pnl, has_fees, etc.)
    and standard transaction filters (account, asset, direction, date range, etc.).
    """
    from backend.api.routes.transactions import _build_transaction_response
    from backend.api.schemas import FilterMetadata, AppliedFilters

    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # Step 1: Resolve which unit IDs match PnL-specific + context filters
    # Start with all units in this version, filtered by context (tx_filters)
    unit_q = select(CalculationUnit.id).where(CalculationUnit.version_id == version_id)
    unit_q, _ = _apply_unit_filter(unit_q, tx_filters, version_id, session, unit_column=CalculationUnit.id)

    if unit_pattern:
        patterns = [p.strip() for p in unit_pattern.split(",") if p.strip()]
        if patterns:
            unit_q = unit_q.where(CalculationUnit.pattern.in_(patterns))

    if has_realized_pnl is not None:
        rpnl_exists = (
            select(RealizedPnl.pnl_id)
            .where(RealizedPnl.origin_unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_realized_pnl:
            unit_q = unit_q.where(rpnl_exists)
        else:
            unit_q = unit_q.where(~rpnl_exists)

    if has_fees is not None:
        fee_exists = (
            select(FeeEntry.id)
            .where(FeeEntry.unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_fees:
            unit_q = unit_q.where(fee_exists)
        else:
            unit_q = unit_q.where(~fee_exists)

    if has_warnings is not None:
        warning_exists = (
            select(PnlWarning.id)
            .where(PnlWarning.unit_id == CalculationUnit.id)
            .correlate(CalculationUnit)
            .exists()
        )
        if has_warnings:
            unit_q = unit_q.where(warning_exists)
        else:
            unit_q = unit_q.where(~warning_exists)

    if warning_type:
        wt_list = [w.strip() for w in warning_type.split(",") if w.strip()]
        if wt_list:
            wt_exists = (
                select(PnlWarning.id)
                .where(PnlWarning.unit_id == CalculationUnit.id)
                .where(PnlWarning.warning_type.in_(wt_list))
                .correlate(CalculationUnit)
                .exists()
            )
            unit_q = unit_q.where(wt_exists)

    if search:
        search_term = f"%{search}%"
        unit_q = unit_q.where(
            or_(
                cast(CalculationUnit.id, SAString).ilike(search_term),
                CalculationUnit.unit_label.ilike(search_term),
            )
        )

    matched_unit_ids_sq = unit_q.subquery()

    # Step 2: Get transactions linked to those units via CalculationUnitLeg
    # A single transaction may appear in multiple legs (e.g. inflow + fee) — deduplicate.
    tx_ids_q = (
        select(CalculationUnitLeg.transaction_id)
        .where(CalculationUnitLeg.unit_id.in_(select(matched_unit_ids_sq)))
        .distinct()
    )
    tx_ids_sq = tx_ids_q.subquery()

    # Step 3: Build the NormalizedTransaction query (standard shape for TransactionsTable)
    base_statement = (
        select(NormalizedTransaction)
        .where(NormalizedTransaction.id.in_(select(tx_ids_sq)))
        .options(
            selectinload(NormalizedTransaction.asset),
            selectinload(NormalizedTransaction.price_quote_asset),
            selectinload(NormalizedTransaction.fee_quote_asset),
            selectinload(NormalizedTransaction.account_rel),
            selectinload(NormalizedTransaction.from_account),
            selectinload(NormalizedTransaction.to_account),
            selectinload(NormalizedTransaction.sync_connector_run),
        )
    )

    # Total count (all transactions in matching units)
    total_count_q = select(func.count()).select_from(
        select(NormalizedTransaction.id)
        .where(NormalizedTransaction.id.in_(select(tx_ids_sq)))
        .subquery()
    )
    total_count = session.exec(total_count_q).one()

    # Apply standard transaction filters from context
    if tx_filters.has_active_filters:
        from backend.services.filters.transaction_filter import build_transaction_filter_predicates
        for predicate in build_transaction_filter_predicates(tx_filters.applied_filters, non_owned=tx_filters.non_owned):
            base_statement = base_statement.where(predicate)

    # Get filtered count
    filtered_count_q = select(func.count()).select_from(base_statement.subquery())
    filtered_count = session.exec(filtered_count_q).one()

    # Sorting
    SORTABLE_COLUMNS = {
        'date_time': NormalizedTransaction.date_time,
        'date': NormalizedTransaction.date_time,
        'id': NormalizedTransaction.id,
        'source': NormalizedTransaction.source,
        'direction': NormalizedTransaction.direction,
        'quantity': NormalizedTransaction.quantity,
        'price': NormalizedTransaction.price,
        'fee': NormalizedTransaction.fee,
    }
    sort_column = SORTABLE_COLUMNS.get(sort_by or 'date_time', NormalizedTransaction.date_time)
    if sort_dir and sort_dir.lower() == 'asc':
        base_statement = base_statement.order_by(sort_column.asc())
    else:
        base_statement = base_statement.order_by(sort_column.desc())

    base_statement = base_statement.offset(offset).limit(limit)
    transactions = session.exec(base_statement).all()

    if not transactions:
        return {
            "results": [],
            "metadata": {
                "applied_filters": tx_filters.applied_filters.model_dump() if tx_filters.has_active_filters else {},
                "validation_warnings": [],
                "total_count": total_count,
                "filtered_count": filtered_count,
                "limit": limit,
                "offset": offset,
            },
        }

    # Step 4: Bulk-load enrichment data for this page of transactions
    tx_ids = [tx.id for tx in transactions]

    # 4a. Legs → unit mapping (tx_id → list of (unit_id, unit_pattern, unit_label, leg_type))
    leg_rows = session.exec(
        select(
            CalculationUnitLeg.transaction_id,
            CalculationUnitLeg.unit_id,
            CalculationUnitLeg.leg_type,
            CalculationUnit.pattern,
            CalculationUnit.unit_label,
        )
        .join(CalculationUnit, CalculationUnit.id == CalculationUnitLeg.unit_id)
        .where(CalculationUnitLeg.transaction_id.in_(tx_ids))
        .where(CalculationUnit.version_id == version_id)
    ).all()

    # Build tx_id → primary unit mapping (pick first unit)
    tx_unit_map: Dict[int, Dict[str, Any]] = {}
    tx_disposal_map: Dict[int, bool] = {}
    for tx_id, uid, leg_type, pattern, label in leg_rows:
        if tx_id not in tx_unit_map:
            tx_unit_map[tx_id] = {"unit_id": uid, "pattern": pattern, "label": label}
        # Track disposal: outflow or fee leg means disposal
        lt = leg_type.value if hasattr(leg_type, 'value') else str(leg_type)
        if lt in ("outflow", "fee"):
            tx_disposal_map[tx_id] = True

    # 4b. Realized P&L entries per transaction (scoped to this version)
    rpnl_rows = session.exec(
        select(RealizedPnl)
        .options(selectinload(RealizedPnl.asset))
        .where(RealizedPnl.transaction_id.in_(tx_ids))
        .where(RealizedPnl.origin_unit_id.in_(
            select(CalculationUnit.id).where(CalculationUnit.version_id == version_id)
        ))
    ).all()

    # Also get fee pnl_ids to mark is_fee
    fee_pnl_id_rows = session.exec(
        select(FeeEntry.realized_pnl_id)
        .where(FeeEntry.version_id == version_id)
        .where(FeeEntry.realized_pnl_id.isnot(None))
    ).all()
    fee_pnl_ids = set(fee_pnl_id_rows)

    rpnl_by_tx: Dict[int, List[RealizedPnl]] = defaultdict(list)
    for entry in rpnl_rows:
        if entry.transaction_id:
            rpnl_by_tx[entry.transaction_id].append(entry)

    # 4c. Fee entries per transaction (via fee_leg → leg.transaction_id, scoped to this version)
    fee_rows = session.exec(
        select(
            CalculationUnitLeg.transaction_id,
            FeeEntry.fee_value_in_base,
            CalculationUnitLeg.asset_id,
        )
        .join(CalculationUnitLeg, CalculationUnitLeg.id == FeeEntry.fee_leg_id)
        .where(CalculationUnitLeg.transaction_id.in_(tx_ids))
        .where(FeeEntry.version_id == version_id)
    ).all()

    # Load asset symbols for fee entries
    fee_asset_ids = list(set(r[2] for r in fee_rows if r[2]))
    fee_assets_map: Dict[int, Asset] = {}
    if fee_asset_ids:
        fee_assets = session.exec(select(Asset).where(Asset.asset_id.in_(fee_asset_ids))).all()
        fee_assets_map = {a.asset_id: a for a in fee_assets}

    fees_by_tx: Dict[int, List[EnrichedTransactionFeeDetail]] = defaultdict(list)
    for tx_id, fv_base, a_id in fee_rows:
        asset_ref = None
        if a_id and a_id in fee_assets_map:
            a = fee_assets_map[a_id]
            asset_ref = AssetRef(id=a.asset_id, symbol=a.symbol, label=a.label)
        fees_by_tx[tx_id].append(EnrichedTransactionFeeDetail(
            fee_amount=0,  # quantity not stored on FeeEntry, lives on leg
            fee_in_base=float(fv_base) if fv_base else 0,
            asset=asset_ref,
        ))

    # 4d. Cost lot events per transaction (scoped to this version via triggered_by_unit_id)
    event_rows = session.exec(
        select(
            CostLotEvent.triggered_by_transaction_id,
            CostLotEvent.event_type,
            CostLotEvent.quantity_delta,
            CostLotEvent.lot_id,
        )
        .where(CostLotEvent.triggered_by_transaction_id.in_(tx_ids))
        .where(CostLotEvent.triggered_by_unit_id.in_(
            select(CalculationUnit.id).where(CalculationUnit.version_id == version_id)
        ))
    ).all()

    events_by_tx: Dict[int, List[CostLotEventSummaryItem]] = defaultdict(list)
    for tx_id, etype, qdelta, lid in event_rows:
        events_by_tx[tx_id].append(CostLotEventSummaryItem(
            event_type=etype,
            quantity_delta=float(qdelta) if qdelta else 0,
            lot_id=lid,
        ))

    # Step 5: Build enriched response
    results = []
    for tx in transactions:
        # Build standard transaction response
        base_resp = _build_transaction_response(tx, session)
        base_dict = base_resp.model_dump()

        unit_info = tx_unit_map.get(tx.id, {})
        rpnl_entries = rpnl_by_tx.get(tx.id, [])
        realized_entries = [
            build_realized_entry_response(e, is_fee=(e.pnl_id in fee_pnl_ids))
            for e in rpnl_entries
        ]
        realized_total = sum(float(e.pnl_in_base) for e in rpnl_entries) if rpnl_entries else None

        tx_fees = fees_by_tx.get(tx.id, [])
        fees_total = sum(f.fee_in_base for f in tx_fees) if tx_fees else None

        results.append(EnrichedTransactionResponse(
            **base_dict,
            unit_id=unit_info.get("unit_id"),
            unit_pattern=unit_info.get("pattern"),
            unit_label=unit_info.get("label"),
            realized_entries=realized_entries,
            realized_pnl_in_base=realized_total,
            fee_entries=tx_fees,
            total_fees_in_base=fees_total,
            cost_lot_event_summary=events_by_tx.get(tx.id, []),
            is_disposal_taxable=tx_disposal_map.get(tx.id, False),
        ))

    return {
        "results": [r.model_dump() for r in results],
        "metadata": {
            "applied_filters": tx_filters.applied_filters.model_dump() if tx_filters.has_active_filters else {},
            "validation_warnings": [w.model_dump() for w in tx_filters.warnings] if tx_filters.warnings else [],
            "total_count": total_count,
            "filtered_count": filtered_count,
            "limit": limit,
            "offset": offset,
        },
    }


@router.get("/versions/{version_id}/enriched-transactions/filter-options")
def get_enriched_transactions_filter_options(
    version_id: int,
    tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
    session: Session = Depends(get_session_dependency),
):
    """
    Get filter options for the enriched transactions view.

    Returns pattern counts, boolean-filter counts, and warning types
    with counts reflecting *transaction* counts (not unit counts).
    """
    version = session.get(CalculationVersion, version_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version {version_id} not found")

    # Base scope: all units in this version, filtered by context
    base_unit_q = select(CalculationUnit.id).where(CalculationUnit.version_id == version_id)
    base_unit_q, _ = _apply_unit_filter(base_unit_q, tx_filters, version_id, session, unit_column=CalculationUnit.id)
    scoped_unit_ids = base_unit_q.subquery()

    # All transaction IDs in scoped units
    tx_in_scope = (
        select(CalculationUnitLeg.transaction_id)
        .where(CalculationUnitLeg.unit_id.in_(select(scoped_unit_ids)))
        .distinct()
    ).subquery()

    total_tx = session.exec(
        select(func.count()).select_from(tx_in_scope)
    ).one() or 0

    # Pattern counts (transaction count per pattern)
    pattern_q = (
        select(CalculationUnit.pattern, func.count(func.distinct(CalculationUnitLeg.transaction_id)))
        .join(CalculationUnitLeg, CalculationUnitLeg.unit_id == CalculationUnit.id)
        .where(CalculationUnit.id.in_(select(scoped_unit_ids)))
        .group_by(CalculationUnit.pattern)
    )
    pattern_rows = session.exec(pattern_q).all()
    patterns = [FilterOptionWithCount(value=p or "unknown", count=c) for p, c in pattern_rows]

    # has_realized_pnl_count: # of transactions that have at least one RealizedPnl
    has_rpnl_q = (
        select(func.count(func.distinct(RealizedPnl.transaction_id)))
        .where(RealizedPnl.transaction_id.in_(select(tx_in_scope)))
    )
    has_realized_pnl_count = session.exec(has_rpnl_q).one() or 0

    # has_fees_count: # of transactions that are fee legs
    has_fees_q = (
        select(func.count(func.distinct(CalculationUnitLeg.transaction_id)))
        .join(FeeEntry, FeeEntry.fee_leg_id == CalculationUnitLeg.id)
        .where(CalculationUnitLeg.unit_id.in_(select(scoped_unit_ids)))
    )
    has_fees_count = session.exec(has_fees_q).one() or 0

    # has_warnings_count: # of transactions in units with warnings
    warned_unit_ids = (
        select(func.distinct(PnlWarning.unit_id))
        .where(PnlWarning.unit_id.in_(select(scoped_unit_ids)))
    ).subquery()
    has_warnings_q = (
        select(func.count(func.distinct(CalculationUnitLeg.transaction_id)))
        .where(CalculationUnitLeg.unit_id.in_(select(warned_unit_ids)))
    )
    has_warnings_count = session.exec(has_warnings_q).one() or 0

    # Warning types with per-type transaction counts
    warning_type_q = (
        select(PnlWarning.warning_type, func.count(func.distinct(CalculationUnitLeg.transaction_id)))
        .join(CalculationUnitLeg, CalculationUnitLeg.unit_id == PnlWarning.unit_id)
        .where(PnlWarning.unit_id.in_(select(scoped_unit_ids)))
        .group_by(PnlWarning.warning_type)
    )
    wt_rows = session.exec(warning_type_q).all()
    warning_types = [
        FilterOptionWithCount(value=wt, label=wt.replace('_', ' ').title(), count=c)
        for wt, c in wt_rows
    ]

    return EnrichedTransactionsFilterOptionsResponse(
        patterns=patterns,
        total_transactions=total_tx,
        has_warnings_count=has_warnings_count,
        has_realized_pnl_count=has_realized_pnl_count,
        has_fees_count=has_fees_count,
        warning_types=warning_types,
    )
