"""
Pydantic request/response schemas for the Trade Exporter API.

This module contains all API request and response models.
For SQLModel ORM classes (NormalizedTransaction, Group, Asset, etc.),
use backend.db.models instead.

SQLModel classes ARE Pydantic models, so they can be used directly
for validation and serialization without separate Pydantic duplicates.
"""

from decimal import Decimal
from pydantic import BaseModel, Field, ConfigDict, field_serializer, field_validator
from typing import Optional, List, Dict, Any, Union
from datetime import datetime, timezone

# Re-export SQLModel classes for convenience (these ARE Pydantic models)
from backend.db.models import (
    NormalizedTransaction,
    Asset,
)


# =============================================================================
# Common Reference Types
# =============================================================================


class AssetRef(BaseModel):
    """
    Lightweight asset reference for embedding in responses.
    Contains minimal fields for display without relationships.
    """
    asset_id: Optional[int] = None
    symbol: Optional[str] = None
    label: Optional[str] = None


# =============================================================================
# Sync Job Schemas
# =============================================================================


class ConnectorOverrideRequest(BaseModel):
    """Per-sync override for a single connector (enable/disable, test mode, since datetime, symbols/currencies)."""
    
    connector_id: int = Field(..., description="ID of the connector to override")
    enabled: Optional[bool] = Field(None, description="Override enabled status for this sync")
    test_mode: Optional[bool] = Field(None, description="Override test mode for this sync")
    test_file_path: Optional[str] = Field(None, description="Override test file path for this sync")
    since_datetime: Optional[str] = Field(None, description="ISO datetime for incremental sync, null for full sync")
    symbols: Optional[List[str]] = Field(None, description="Override symbols list for trade connectors")
    currencies: Optional[List[str]] = Field(None, description="Override currencies list for deposit/withdrawal connectors")


class SyncJobStartRequest(BaseModel):
    """Request body for starting a sync job with optional overrides."""
    
    connector_overrides: Optional[List[ConnectorOverrideRequest]] = Field(
        None,
        description="List of per-connector overrides (enable/disable, test mode, since datetime) for this sync only"
    )
    renormalize: Optional[bool] = Field(
        False,
        description="If true, re-normalize from stored raw data instead of fetching from APIs"
    )


# =============================================================================
# Helpers
# =============================================================================


def _serialize_decimal(v: Any) -> Optional[float]:
    """Convert Decimal to float for JSON serialization."""
    if v is None:
        return None
    if isinstance(v, Decimal):
        return float(v)
    return v


# =============================================================================
# Filter Response Wrapper Models
# =============================================================================


class ValidationWarning(BaseModel):
    """Warning about a filter parameter that was skipped or invalid."""
    
    filter_name: str = Field(..., description="Name of the filter field")
    provided_value: str = Field(..., description="Value that was provided")
    reason: str = Field(..., description="Why it was invalid/skipped")
    severity: str = Field("warning", pattern="^(warning|error)$", description="Severity level")


class AppliedFilters(BaseModel):
    """Filters that were actually applied to the query."""
    
    review_statuses: List[str] = Field(default_factory=list)
    taxability: Optional[str] = None
    sources: List[str] = Field(default_factory=list)
    account_ids: List[Any] = Field(default_factory=list)  # int IDs + "unmapped" sentinel
    from_account_ids: List[Any] = Field(default_factory=list)  # int IDs + "unmapped" sentinel
    to_account_ids: List[Any] = Field(default_factory=list)  # int IDs + "unmapped" sentinel
    related_account_ids: List[Any] = Field(default_factory=list)  # matches account_id OR from_account_id OR to_account_id
    asset_ids: List[int] = Field(default_factory=list)
    related_asset_ids: List[int] = Field(default_factory=list)  # matches asset_id OR price_quote_asset_id OR fee_quote_asset_id
    category_ids: List[int] = Field(default_factory=list)
    transaction_types: List[str] = Field(default_factory=list)
    directions: List[str] = Field(default_factory=list)
    connector_run_ids: List[int] = Field(default_factory=list)
    tag_keys: List[str] = Field(default_factory=list)
    networks: List[str] = Field(default_factory=list)
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    pnl_cal_version: Optional[int] = None
    pnl_cal_inclusions_status: Optional[str] = None


class FilterMetadata(BaseModel):
    """Metadata about applied filters and result counts."""
    
    applied_filters: AppliedFilters = Field(
        default_factory=AppliedFilters,
        description="Filters that were actually applied after validation"
    )
    validation_warnings: List[ValidationWarning] = Field(
        default_factory=list,
        description="Warnings about invalid or skipped filters"
    )
    total_count: int = Field(..., description="Total records without filters")
    filtered_count: int = Field(..., description="Records after applying filters")
    limit: int = Field(..., description="Max results returned")
    offset: int = Field(0, description="Pagination offset")


class TransactionListResponse(BaseModel):
    """Wrapped response for transaction list with metadata."""
    
    results: List["TransactionResponse"] = Field(
        default_factory=list,
        description="Transaction records"
    )
    metadata: FilterMetadata = Field(..., description="Filter and pagination metadata")


# =============================================================================
# Transaction API Models
# =============================================================================


class TransactionUpdate(BaseModel):
    """Request model for partially updating transaction review fields."""

    model_config = ConfigDict(extra="ignore")  # Ignore extra fields from frontend

    asset_id: Optional[int] = None
    price_quote_asset_id: Optional[int] = None
    fee_quote_asset_id: Optional[int] = None
    account_id: Optional[int] = None
    source: Optional[str] = None
    source_transaction_id: Optional[str] = Field(
        None, description="Source transaction ID (external reference)"
    )
    direction: Optional[str] = Field(None, pattern="^(inflow|outflow|internal)$")
    source_asset_symbol: Optional[str] = None
    source_price_quote_asset_symbol: Optional[str] = Field(
        None, description="Source price quote asset symbol"
    )
    source_fee_quote_asset_symbol: Optional[str] = Field(
        None, description="Source fee quote asset symbol"
    )
    source_transaction_type: Optional[str] = Field(
        None, description="Source transaction type (e.g., airdrop, buy, sell)"
    )
    quantity: Optional[float] = None
    price: Optional[float] = None
    fee: Optional[float] = None
    include_fee: Optional[bool] = None
    transaction_type: Optional[str] = Field(
        None, description="Transaction type (predefined or custom)"
    )
    review_status: Optional[str] = Field(None, pattern="^(valid|pending|invalid)$")
    review_notes: Optional[str] = None

    # Taxability status
    taxability_status: Optional[str] = Field(
        None, pattern="^(taxable|non_taxable|unknown)$", description="Taxability status"
    )
    user_calculation_unit_id: Optional[int] = Field(
        None, description="Calculation unit ID (null to remove from unit)"
    )
    
    # Transfer/network fields
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None
    from_account_id: Optional[int] = None
    to_account_id: Optional[int] = None
    network: Optional[str] = None
    network_transaction_id: Optional[str] = None
    token_contract_address: Optional[str] = None
    
    # Date/time
    date_time: Optional[datetime] = None
    
    # Tags
    tags: Optional[List[Dict[str, Any]]] = Field(
        None, description="Tags as list of {key: value} pairs"
    )


class TransactionResponse(BaseModel):
    """
    Response model for normalized transaction API endpoint.
    Standalone Pydantic model that mirrors NormalizedTransaction fields
    plus additional JOIN fields for the API response.
    """

    model_config = ConfigDict(
        from_attributes=True,
        ser_json_inf_nan="constants",
    )

    @field_serializer(
        "quantity",
        "price",
        "total",
        "fee",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("date_time", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        """Ensure all datetime fields are serialized with explicit UTC timezone marker."""
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v

    @field_validator("tags", mode="before")
    @classmethod
    def normalize_tags(cls, v: Any) -> List[Dict[str, Any]]:
        """Normalize tags to always be a list, converting dicts with numeric keys."""
        if v is None:
            return []
        if isinstance(v, list):
            return v
        if isinstance(v, dict):
            # Empty dict should return empty list
            if not v:
                return []
            # If it's a dict with numeric keys, convert to list
            if all(str(k).isdigit() for k in v.keys()):
                sorted_keys = sorted(v.keys(), key=lambda x: int(str(x)))
                return [v[k] for k in sorted_keys]
            # Otherwise wrap in list
            return [v]
        return []

    # Primary key
    id: Optional[int] = None

    # Source fields
    source: Optional[str] = None
    source_transaction_id: Optional[str] = None
    source_transaction_type: Optional[str] = None
    source_asset_symbol: Optional[str] = None
    source_price_quote_asset_symbol: Optional[str] = None
    source_fee_quote_asset_symbol: Optional[str] = None

    # Account fields
    account_id: Optional[int] = None

    # Foreign keys
    raw_transaction_id: Optional[int] = None
    asset_id: Optional[int] = None
    price_quote_asset_id: Optional[int] = None
    fee_quote_asset_id: Optional[int] = None
    user_calculation_unit_id: Optional[int] = None

    # Normalized fields
    date_time: Optional[Union[datetime, int]] = None
    direction: Optional[str] = None
    transaction_type: Optional[str] = None
    quantity: Optional[float] = None

    # Pricing information (in quote asset - base is runtime P&L config)
    price: Optional[float] = None
    total: Optional[float] = None  # Computed: price * quantity

    # Fee information (in fee quote asset)
    fee: Optional[float] = None
    include_fee: Optional[bool] = False

    # Blockchain/transfer fields
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None
    from_account_id: Optional[int] = None
    to_account_id: Optional[int] = None
    network: Optional[str] = None
    network_transaction_id: Optional[str] = None
    token_contract_address: Optional[str] = None

    # Review status and taxability
    review_status: Optional[str] = "pending"  # valid, pending, invalid
    taxability_status: Optional[str] = "unknown"  # taxable, non_taxable, unknown

    # Review notes
    review_notes: Optional[str] = None

    # Sync metadata
    synced_at: Optional[str] = None
    sync_connector_run_id: Optional[int] = None
    connector_name: Optional[str] = None
    run_datetime: Optional[str] = None

    # Metadata
    tags: List[Dict[str, Any]] = Field(default_factory=list)

    # Nested asset references (replaces flat linked_*_symbol fields)
    linked_asset: Optional[AssetRef] = None
    price_quote_asset: Optional[AssetRef] = None
    fee_quote_asset: Optional[AssetRef] = None

    # Backward compatibility: flat symbol fields (deprecated, prefer nested objects)
    linked_asset_symbol: Optional[str] = None
    linked_price_quote_asset_symbol: Optional[str] = None
    linked_fee_quote_asset_symbol: Optional[str] = None

    # Additional fields from JOIN with accounts table (server-side resolved)
    account_name: Optional[str] = None
    from_account_name: Optional[str] = None
    to_account_name: Optional[str] = None


# =============================================================================
# Unit API Models
# =============================================================================


class CreateUnitRequest(BaseModel):
    """Request model for creating a new calculation unit."""

    unit_label: str = Field(..., min_length=1, max_length=255)
    transaction_ids: List[int] = Field(..., min_length=1)


class UnitResponse(BaseModel):
    """Response model for unit with additional computed fields."""

    unit_id: int
    unit_label: str
    transaction_ids: List[int]
    transaction_count: Optional[int] = None


class SuggestedUnit(BaseModel):
    """Response model for AI-suggested transaction grouping."""

    pattern: str = Field(
        ..., description="Pattern of unit: transfer, swap, split, unknown"
    )
    reason: str = Field(..., description="Explanation for the suggested grouping")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score (0-1)")
    transaction_ids: List[int] = Field(..., min_length=1)
    suggested_label: str = Field(..., description="Suggested name for the unit")
    transactions: Optional[List[Dict[str, Any]]] = Field(
        None,
        description="Transaction details: date, source, direction, quantity, symbol",
    )


# =============================================================================
# P&L Calculation Models
# =============================================================================


class CostLotResponse(BaseModel):
    """Response model for a cost lot."""

    model_config = ConfigDict(from_attributes=True)

    @field_serializer(
        "qty",
        "qty_remaining",
        "total_cost_in_base",
        "unit_cost_in_base",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("acquired_at", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        """Ensure datetime fields are serialized with explicit UTC timezone marker."""
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v

    cost_lot_id: int
    asset_id: int
    asset_symbol: Optional[str] = None
    qty: float
    qty_remaining: float
    total_cost_in_base: float
    unit_cost_in_base: float
    transaction_id: Optional[int] = None
    unit_id: Optional[int] = None
    version_id: Optional[int] = None
    acquired_at: Optional[datetime] = None
    is_zero_cost: bool = False
    notes: Optional[str] = None


class ConsumedLotDetail(BaseModel):
    """Detail of a consumed cost lot slice."""

    @field_serializer("qty_consumed", "unit_cost", when_used="always")
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    lot_id: Optional[int] = None
    qty_consumed: float
    unit_cost: float


class RealizedPnLResponse(BaseModel):
    """Response model for a realized P&L entry."""

    model_config = ConfigDict(from_attributes=True)

    @field_serializer(
        "qty",
        "proceeds_in_base",
        "cost_basis_in_base",
        "pnl_in_base",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("realized_at", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        """Ensure datetime fields are serialized with explicit UTC timezone marker."""
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v

    pnl_id: int
    asset_id: int
    asset_symbol: Optional[str] = None
    qty: float
    proceeds_in_base: float
    cost_basis_in_base: float
    pnl_in_base: float
    transaction_id: Optional[int] = None
    group_id: Optional[int] = None
    consumed_cost_lot_ids: List[int] = Field(default_factory=list)
    consumed_lot_details: List[ConsumedLotDetail] = Field(default_factory=list)
    version_id: Optional[int] = None
    realized_at: Optional[datetime] = None
    holding_period_days: Optional[int] = None
    notes: Optional[str] = None


class UnrealizedPnLResponse(BaseModel):
    """Response model for unrealized P&L entry."""

    model_config = ConfigDict(from_attributes=True)

    @field_serializer(
        "balance",
        "cost_basis_in_base",
        "market_price",
        "market_value_in_base",
        "unrealized_pnl_in_base",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    asset_id: int
    asset_symbol: Optional[str] = None
    balance: float
    cost_basis_in_base: float
    market_price: Optional[float] = None
    market_value_in_base: Optional[float] = None
    unrealized_pnl_in_base: Optional[float] = None
    version_id: Optional[int] = None


class CalculationVersionResponse(BaseModel):
    """Response model for a calculation version."""

    model_config = ConfigDict(from_attributes=True)

    @field_serializer("total_realized_pnl", "total_unrealized_pnl", when_used="always")
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("created_at", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        """Ensure datetime fields are serialized with explicit UTC timezone marker."""
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v

    version_id: int
    description: Optional[str] = None
    created_at: datetime
    is_active: bool = False
    method: str = "FIFO"
    total_realized_pnl: Optional[float] = None
    total_unrealized_pnl: Optional[float] = None
    transaction_count: int = 0
    status: str = "pending"


class AssetBalanceResponse(BaseModel):
    """Response model for asset balance."""

    @field_serializer(
        "balance", "cost_basis_in_base", "avg_cost_per_unit", when_used="always"
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    asset_id: int
    asset_symbol: Optional[str] = None
    balance: float
    cost_basis_in_base: float
    avg_cost_per_unit: float


class PnLCalculationRequest(BaseModel):
    """Request model for triggering P&L calculation."""

    description: Optional[str] = Field(
        None, description="Description for this calculation run"
    )
    method: str = Field("FIFO", description="Cost method: FIFO or LIFO")
    recalculate_all: bool = Field(
        False, description="If true, recalculates from scratch; otherwise incremental"
    )
    include_unrealized: bool = Field(
        True, description="Whether to calculate unrealized P&L"
    )


class PnLCalculationResponse(BaseModel):
    """Response model for P&L calculation results."""

    @field_serializer("total_realized_pnl", "total_unrealized_pnl", when_used="always")
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("created_at", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        """Ensure datetime fields are serialized with explicit UTC timezone marker."""
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v

    version_id: int
    method: str
    status: str
    transaction_count: int
    total_realized_pnl: float
    total_unrealized_pnl: Optional[float] = None
    realized_pnl_count: int
    cost_lot_count: int
    asset_balance_count: int
    residuals: List[Dict[str, Any]] = Field(default_factory=list)
    created_at: datetime


class PnLSummaryResponse(BaseModel):
    """Summary response for P&L overview."""

    @field_serializer(
        "total_realized_pnl",
        "total_unrealized_pnl",
        "total_pnl",
        "taxable_realized_pnl",
        "non_taxable_realized_pnl",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    version: CalculationVersionResponse
    total_realized_pnl: float
    total_unrealized_pnl: Optional[float] = None
    total_pnl: Optional[float] = None
    asset_balances: List[AssetBalanceResponse] = Field(default_factory=list)
    realized_pnl_by_asset: Dict[int, float] = Field(default_factory=dict)
    taxable_realized_pnl: float = 0.0
    non_taxable_realized_pnl: float = 0.0


# =============================================================================
# Data Health Check Models
# =============================================================================


from enum import Enum


class IssueType(str, Enum):
    """Types of data issues in transactions."""
    # Missing data issues - required source data not provided by connector
    MISSING_SOURCE = "missing_source"
    MISSING_SOURCE_ASSET = "missing_source_asset"
    MISSING_SOURCE_ACCOUNT = "missing_source_account"
    # Linkage issues - source data exists but not linked to master data
    UNLINKED_ASSET = "unlinked_asset"
    UNLINKED_ACCOUNT = "unlinked_account"
    UNLINKED_PRICE_QUOTE = "unlinked_price_quote"
    UNLINKED_FEE_QUOTE = "unlinked_fee_quote"
    # Transfer issues - missing source data from connector
    MISSING_TRANSFER_FROM_ACCOUNT = "missing_transfer_from_account"
    MISSING_TRANSFER_TO_ACCOUNT = "missing_transfer_to_account"
    # Transfer issues - source data exists but not linked to account
    UNLINKED_TRANSFER_FROM_ACCOUNT = "unlinked_transfer_from_account"
    UNLINKED_TRANSFER_TO_ACCOUNT = "unlinked_transfer_to_account"
    # Workflow status
    PENDING_REVIEW = "pending_review"


class SuggestionInfo(BaseModel):
    """Fuzzy match suggestion for a raw asset or raw account."""
    id: int = Field(..., description="Suggested asset_id or account_id")
    name: str = Field(..., description="Display name (symbol/label)")
    confidence: float = Field(..., description="Match confidence (0-1)")


class RawAssetIssue(BaseModel):
    """Raw asset that needs mapping."""
    symbol: str = Field(..., description="Raw symbol from source")
    source: str = Field(..., description="Source platform/exchange")
    affected_count: int = Field(..., description="Number of affected transactions")
    suggestion: Optional[SuggestionInfo] = Field(None, description="Best fuzzy match suggestion")


class RawAccountIssue(BaseModel):
    """Raw account that needs mapping."""
    id: int = Field(..., description="Raw account ID")
    label: str = Field(..., description="Raw account label from source")
    source: str = Field(..., description="Source platform/exchange")
    affected_count: int = Field(..., description="Number of affected transactions")
    suggestion: Optional[SuggestionInfo] = Field(None, description="Best fuzzy match suggestion")


class DataHealthCheckResponse(BaseModel):
    """
    Comprehensive data health check response (legacy unified endpoint).
    
    Aggregates transaction status, missing data counts, and optionally
    detailed lists of unmapped raw values with suggestions.
    """
    model_config = ConfigDict(from_attributes=True)
    
    # Transaction counts by status
    total_count: int = Field(0, description="Total number of transactions (excluding invalid)")
    valid_count: int = Field(0, description="Transactions with review_status='valid'")
    pending_count: int = Field(0, description="Transactions with review_status='pending'")
    invalid_count: int = Field(0, description="Transactions with review_status='invalid'")
    
    # Missing data counts
    missing_asset_count: int = Field(0, description="Transactions missing asset_id")
    missing_account_count: int = Field(0, description="Transactions missing account_id")
    missing_price_quote_count: int = Field(0, description="Transactions missing price_quote_asset_id when price exists")
    missing_fee_quote_count: int = Field(0, description="Transactions missing fee_quote_asset_id when fee > 0")
    
    # Bundle suggestions
    bundle_suggestions_count: int = Field(0, description="Number of unhandled bundle suggestions")
    
    # Aggregate flags
    has_issues: bool = Field(False, description="True if any issues exist")
    total_issues: int = Field(0, description="Total number of issues (sum of all missing data + pending)")
    
    # Optional detail lists (when include_details=true)
    missing_assets_detail: Optional[List[RawAssetIssue]] = Field(None, description="Detailed list of raw assets needing mapping")
    missing_accounts_detail: Optional[List[RawAccountIssue]] = Field(None, description="Detailed list of raw accounts needing mapping")
    missing_price_quotes_detail: Optional[List[RawAssetIssue]] = Field(None, description="Detailed list of raw price quote assets needing mapping")
    missing_fee_quotes_detail: Optional[List[RawAssetIssue]] = Field(None, description="Detailed list of raw fee quote assets needing mapping")
    
    # Transaction-centric issues list with pagination
    issues_list: Optional[List["TransactionIssue"]] = Field(None, description="Paginated list of transaction issues")
    issues_total_count: Optional[int] = Field(None, description="Total count of transaction issues")
    issues_page: Optional[int] = Field(None, description="Current page number")
    issues_per_page: Optional[int] = Field(None, description="Issues per page")


# =============================================================================
# Data Health Check - New Split Endpoints
# =============================================================================

class TransactionStatusResponse(BaseModel):
    """Response model for /transactions/data-health-check/status endpoint."""
    model_config = ConfigDict(from_attributes=True)
    
    total_count: int = Field(0, description="Total number of transactions (excluding invalid)")
    valid_count: int = Field(0, description="Transactions with review_status='valid'")
    pending_count: int = Field(0, description="Transactions with review_status='pending'")
    invalid_count: int = Field(0, description="Transactions with review_status='invalid'")
    bundle_suggestions_count: int = Field(0, description="Number of unhandled bundle suggestions")
    
    # Data completeness issue counts
    missing_data_issues_count: int = Field(0, description="Count of missing data issues (missing source/asset/account)")
    linkage_issues_count: int = Field(0, description="Count of linkage issues (missing asset/account/price_quote/fee_quote)")
    transfer_issues_count: int = Field(0, description="Count of transfer issues (missing from/to accounts)")
    duplicate_count: int = Field(0, description="Count of unresolved duplicate transactions")
    unmapped_accounts_transaction_count: int = Field(0, description="Count of transactions with unmapped raw accounts")
    
    # Aggregated totals
    total_issues: int = Field(0, description="Total data issues: missing data + linkage + transfer + duplicates + pending")
    has_issues: bool = Field(False, description="True if any data issues exist")


class PaginationMetadata(BaseModel):
    """Pagination metadata for list endpoints."""
    page: int = Field(..., description="Current page number")
    per_page: int = Field(..., description="Items per page")
    total_count: int = Field(..., description="Total number of items")
    total_pages: Optional[int] = Field(None, description="Total number of pages")


class LinkageIssuesResponse(BaseModel):
    """Response model for /transactions/data-health-check/linkage-issues endpoint."""
    model_config = ConfigDict(from_attributes=True)
    
    issues: List["TransactionIssue"] = Field([], description="List of linkage issues")
    pagination: PaginationMetadata = Field(..., description="Pagination metadata")


class TransferIssuesResponse(BaseModel):
    """Response model for /transactions/data-health-check/transfer-issues endpoint."""
    model_config = ConfigDict(from_attributes=True)
    
    issues: List["TransactionIssue"] = Field([], description="List of transfer issues")
    pagination: PaginationMetadata = Field(..., description="Pagination metadata")


class MissingDataIssuesResponse(BaseModel):
    """Response model for /transactions/data-health-check/missing-data-issues endpoint."""
    model_config = ConfigDict(from_attributes=True)
    
    issues: List["TransactionIssue"] = Field([], description="List of missing data issues")
    pagination: PaginationMetadata = Field(..., description="Pagination metadata")



class TransactionIssue(BaseModel):
    """
    A single data issue for a specific transaction.
    
    Used for transaction-centric display with inline fix actions.
    """
    # Transaction info (compact display)
    transaction_id: int = Field(..., description="Transaction ID")
    date_time: str = Field(..., description="Transaction datetime (ISO format)")
    direction: str = Field(..., description="inflow/outflow/internal")
    quantity: float = Field(..., description="Transaction quantity")
    source_asset_symbol: str = Field(..., description="Raw asset symbol from source")
    source: str = Field(..., description="Source platform/exchange")
    network: Optional[str] = Field(None, description="Blockchain network (e.g., ethereum, polygon)")
    
    # Issue details
    issue_type: IssueType = Field(..., description="Type of issue")
    raw_value: str = Field(..., description="Raw value needing fix (symbol or label)")
    
    # Fix suggestion
    suggestion: Optional[SuggestionInfo] = Field(None, description="Best match suggestion")
    
    # Account info (for source info column)
    account_id: Optional[int] = Field(None, description="Account ID if linked")
    account_name: Optional[str] = Field(None, description="Account name if resolved")
    source_account: Optional[str] = Field(None, description="Raw source account")
    
    # Connector info (for source info column)
    connector_name: Optional[str] = Field(None, description="Connector name if synced")
    sync_connector_run_id: Optional[int] = Field(None, description="Sync run ID")
    run_datetime: Optional[str] = Field(None, description="Sync run datetime")


# Update model references to TransactionIssue
DataHealthCheckResponse.model_rebuild()
LinkageIssuesResponse.model_rebuild()
TransferIssuesResponse.model_rebuild()


# =============================================================================
# Derivative Position Models
# =============================================================================


class DerivativePositionResponse(BaseModel):
    """Response model for a derivative (perp) position."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    account_id: int
    exchange: str
    coin: str
    side: str
    status: str

    entry_price: Optional[float] = None
    exit_price: Optional[float] = None
    size: Optional[float] = None
    remaining_size: Optional[float] = None

    margin_currency: str = "USDC"
    realized_pnl: Optional[float] = None
    total_fees: Optional[float] = None

    opened_at: Optional[Union[datetime, str]] = None
    closed_at: Optional[Union[datetime, str]] = None

    open_transaction_id: Optional[int] = None
    close_transaction_ids: List[int] = Field(default_factory=list)

    # Computed fields (set by the API route, not the ORM)
    net_pnl: Optional[float] = None
    duration_hours: Optional[float] = None
    return_pct: Optional[float] = None

    # Nested transaction summaries (optional, populated on detail endpoint)
    open_transaction: Optional[TransactionResponse] = None
    close_transactions: List[TransactionResponse] = Field(default_factory=list)

    @field_serializer(
        "entry_price", "exit_price", "size", "remaining_size",
        "realized_pnl", "total_fees",
        when_used="always",
    )
    def serialize_decimal(self, v: Any) -> Optional[float]:
        return _serialize_decimal(v)

    @field_serializer("opened_at", "closed_at", when_used="always")
    def serialize_datetime_utc(self, v: Any) -> Optional[str]:
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=timezone.utc)
            return v.isoformat()
        return v


# =============================================================================
# Account delete preview
# =============================================================================


class AccountDeletePreviewResponse(BaseModel):
    """Preview of what will be affected when deleting an account."""

    account_id: int
    account_name: str
    transactions: int = 0
    connectors: int = 0
    cost_lots: int = 0
    derivative_positions: int = 0
    raw_accounts: int = 0
    transfer_references: int = 0  # txs from OTHER accounts referencing this one via from/to_account_id
    sync_runs: int = 0
    file_imports: int = 0


# =============================================================================
# Data Cleanup (Connector / Account purge)
# =============================================================================


class CleanupRequest(BaseModel):
    """Request body for connector data cleanup."""

    connector_ids: List[int] = Field(..., description="IDs of connectors to clean up")
    delete_connectors: bool = Field(
        default=False,
        description="If true, delete connector rows. If false, purge data but keep connector config.",
    )


class CleanupPreviewResponse(BaseModel):
    """Preview of what will be affected by a cleanup operation."""

    connector_ids: List[int]
    connector_names: List[str]
    transactions: int = 0
    raw_transactions: int = 0
    cost_lots: int = 0
    sync_runs: int = 0
    file_imports: int = 0
    transfer_references: int = 0
    derivative_positions: int = 0
    pnl_legs_affected: int = 0


class CleanupResultResponse(BaseModel):
    """Result summary of a completed cleanup operation."""

    connectors_deleted: int = 0
    connectors_reset: int = 0
    transactions_deleted: int = 0
    raw_transactions_deleted: int = 0
    cost_lots_deleted: int = 0
    sync_runs_deleted: int = 0
    file_imports_deleted: int = 0
    derivative_positions_deleted: int = 0


# =============================================================================
# Exports
# =============================================================================

__all__ = [
    # SQLModel re-exports
    "NormalizedTransaction",
    "Asset",
    # Filter response wrappers
    "TransactionListResponse",
    "FilterMetadata",
    "AppliedFilters",
    "ValidationWarning",
    # Transaction models
    "TransactionUpdate",
    "TransactionResponse",
    # Unit models
    "CreateUnitRequest",
    "UnitResponse",
    "SuggestedUnit",
    # P&L models
    "CostLotResponse",
    "ConsumedLotDetail",
    "RealizedPnLResponse",
    "UnrealizedPnLResponse",
    "CalculationVersionResponse",
    "AssetBalanceResponse",
    "PnLCalculationRequest",
    "PnLCalculationResponse",
    "PnLSummaryResponse",
    # Data Health Check models (new split endpoints)
    "TransactionStatusResponse",
    "PaginationMetadata",
    "LinkageIssuesResponse",
    "TransferIssuesResponse",
    # Data Health Check models (legacy)
    "DataHealthCheckResponse",
    "SuggestionInfo",
    "RawAssetIssue",
    "RawAccountIssue",
    "TransactionIssue",
    "IssueType",
    # Derivative positions
    "DerivativePositionResponse",
    # Account delete preview
    "AccountDeletePreviewResponse",
    # Data cleanup
    "CleanupRequest",
    "CleanupPreviewResponse",
    "CleanupResultResponse",
]
