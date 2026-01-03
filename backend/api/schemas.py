"""
Pydantic request/response schemas for the Trade Exporter API.

This module contains all API request and response models.
For SQLModel ORM classes (NormalizedTransaction, Group, Asset, etc.),
use backend.db.models instead.

SQLModel classes ARE Pydantic models, so they can be used directly
for validation and serialization without separate Pydantic duplicates.
"""

from decimal import Decimal
from pydantic import BaseModel, Field, ConfigDict, field_serializer
from typing import Optional, List, Dict, Any, Union
from datetime import datetime

# Re-export SQLModel classes for convenience (these ARE Pydantic models)
from backend.db.models import (
    NormalizedTransaction,
    Asset,
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
# Transaction API Models
# =============================================================================


class TransactionUpdate(BaseModel):
    """Request model for partially updating transaction review fields."""

    model_config = ConfigDict(extra="ignore")  # Ignore extra fields from frontend

    asset_id: Optional[int] = None
    price_quote_asset_id: Optional[int] = None
    fee_quote_asset_id: Optional[int] = None
    account: Optional[str] = None
    account_id: Optional[int] = None
    source: Optional[str] = None
    direction: Optional[str] = Field(None, pattern="^(inflow|outflow|internal)$")
    source_asset_symbol: Optional[str] = None
    source_transaction_type: Optional[str] = Field(
        None, description="Source transaction type (e.g., airdrop, buy, sell)"
    )
    quantity: Optional[float] = None
    price: Optional[float] = None
    fee: Optional[float] = None
    include_fee: Optional[bool] = None
    disposal_taxable: Optional[bool] = None
    transaction_type: Optional[str] = Field(
        None, description="Transaction type (predefined or custom)"
    )
    group_id: Optional[int] = None
    review_status: Optional[str] = Field(None, pattern="^(valid|pending|invalid)$")
    review_notes: Optional[str] = None

    # Taxability status
    taxability_status: Optional[str] = Field(
        None, pattern="^(taxable|non_taxable|unknown)$", description="Taxability status"
    )
    unit_id: Optional[int] = Field(
        None, description="Unit ID (null to remove from unit)"
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
    account: Optional[str] = None
    account_id: Optional[int] = None

    # Foreign keys
    raw_transaction_id: Optional[int] = None
    asset_id: Optional[int] = None
    price_quote_asset_id: Optional[int] = None
    fee_quote_asset_id: Optional[int] = None
    group_id: Optional[int] = None

    # Normalized fields
    date_time: Optional[Union[datetime, int]] = None
    direction: Optional[str] = None
    transaction_type: Optional[str] = None
    quantity: Optional[float] = None

    # Pricing information (in quote asset - base is runtime P&L config)
    price: Optional[float] = None
    total: Optional[float] = None

    # Fee information (in fee quote asset)
    fee: Optional[float] = None
    include_fee: Optional[bool] = False

    # Tax fields - disposal_taxable indicates if disposing this asset is a taxable event
    disposal_taxable: Optional[bool] = False

    # Blockchain/transfer fields
    source_from_account: Optional[str] = None
    source_to_account: Optional[str] = None
    from_account_id: Optional[int] = None
    to_account_id: Optional[int] = None
    network: Optional[str] = None
    network_transaction_id: Optional[str] = None
    token_contract_address: Optional[str] = None

    # Leg expansion - links expanded legs to parent transaction
    parent_transaction_id: Optional[int] = None
    leg_type: Optional[str] = None  # cost, proceeds, acquired, disposed, fee

    # Review status and taxability
    review_status: Optional[str] = "pending"  # valid, pending, invalid
    taxability_status: Optional[str] = "unknown"  # taxable, non_taxable, unknown
    unit_id: Optional[int] = None  # User-created unit

    # Review notes
    review_notes: Optional[str] = None

    # Sync metadata
    synced_at: Optional[str] = None

    # Metadata
    tags: Optional[Dict[str, Any]] = None

    # Additional fields from JOIN with assets table
    linked_asset_symbol: Optional[str] = None
    linked_price_quote_asset_symbol: Optional[str] = None
    linked_fee_quote_asset_symbol: Optional[str] = None


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

    pnl_id: int
    asset_id: int
    asset_symbol: Optional[str] = None
    qty: float
    proceeds_in_base: float
    cost_basis_in_base: float
    pnl_in_base: float
    disposal_taxable: bool = False
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
# Exports
# =============================================================================

__all__ = [
    # SQLModel re-exports
    "NormalizedTransaction",
    "Asset",
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
]
