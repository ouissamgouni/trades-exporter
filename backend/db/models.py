"""
SQLModel ORM models for the Trade Exporter database.

Schema v2: Updated with proper relationships, high-precision numerics,
and normalized structure for P&L calculations.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, List, Any, Dict
from sqlmodel import SQLModel, Field, Relationship, Column, JSON
from sqlalchemy import UniqueConstraint, Text, ARRAY, Numeric, case, Integer
from enum import Enum
from sqlalchemy.ext.hybrid import hybrid_property


def utc_now() -> datetime:
    """Return current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """
    Ensure a datetime is timezone-aware (UTC).
    
    If the datetime is naive (no timezone), assume it's UTC and add timezone info.
    If it's already aware, return as-is.
    Returns None if input is None.
    """
    if dt is None:
        return None
    if dt.tzinfo is None:
        # Naive datetime - assume UTC and add timezone info
        return dt.replace(tzinfo=timezone.utc)
    # Already timezone-aware
    return dt


# ============================================================================
# Enums
# ============================================================================


class SyncStatus(str, Enum):
    """Sync status enum for account connectors."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class PriceType(str, Enum):
    """
    Price type for determining which price getter to use.
    
    Simple 3-value enum:
    - crypto: Use CoinGecko (covers tokens, stablecoins, NFTs, etc.)
    - stock: Use DataReader/Yahoo (covers ETFs, indices, commodities, etc.)
    - fiat: Use Forex getter
    """

    CRYPTO = "crypto"  # All crypto assets (BTC, ETH, tokens, stablecoins, NFTs)
    STOCK = "stock"  # All traditional assets (stocks, ETFs, indices, commodities)
    FIAT = "fiat"  # Fiat currencies (USD, EUR, GBP)


# Keep AssetType as alias for backward compatibility
AssetType = PriceType


class UnitPattern(str, Enum):
    """Pattern types for calculation units.
    
    Simplified to fundamental operations:
    - TRANSFER: Same asset moves between owned accounts (non-taxable)
    - SWAP: Exchange of value (taxability depends on asset types)
    - SPLIT: Same asset, quantity changes (stock split - non-taxable)
    - PENDING_TRANSFER: Transfer with missing counterpart leg (awaiting reconciliation)
    - UNKNOWN: Needs user review
    """

    TRANSFER = "transfer"  # Self-transfer between owned accounts (non-taxable)
    SWAP = "swap"  # Exchange of value (taxable/non-taxable based on config)
    SPLIT = "split"  # Stock split - same asset, qty changes (non-taxable)
    PENDING_TRANSFER = "pending_transfer"  # Transfer missing inflow or outflow leg
    UNKNOWN = "unknown"  # Needs review


class LotEventType(str, Enum):
    """Event types for cost lot lifecycle tracking.
    
    Provides full audit trail for all lot state changes:
    - CREATED: Lot created from acquisition
    - CONSUMED: Lot partially/fully consumed in disposal
    - SETTLED: Negative lot settled by later inflow
    - TRANSFERRED: Lot moved between accounts (LOT_TRAVEL mode)
    - ADJUSTED: Manual cost basis adjustment
    """
    
    CREATED = "created"
    CONSUMED = "consumed"
    SETTLED = "settled"
    TRANSFERRED = "transferred"
    ADJUSTED = "adjusted"


class TransactionType(str, Enum):
    """Transaction type for P&L calculation and leg expansion.
    
    Simplified 3-value enum:
    - TRADE: Buy/sell exchange of assets (expand to inflow + outflow legs)
    - TRANSFER: Movement of assets between accounts (deposits, withdrawals, internal transfers)
    - TECHNICAL: Zero-value transactions (approvals, failed txs, contract interactions)
    """
    
    TRADE = "trade"  # Buy/sell - will be expanded to inflow + outflow legs
    TRANSFER = "transfer"  # Deposits, withdrawals, internal transfers
    TECHNICAL = "technical"  # Zero-value: approvals, failed txs, contract calls


class TaxabilityStatus(str, Enum):
    """Taxability status for transactions.
    
    Values:
    - TAXABLE: Transaction is a taxable event (capital gains/losses)
    - NON_TAXABLE: Transaction is not taxable (transfers, gifts received)
    - UNKNOWN: Needs user review to determine taxability
    """
    
    TAXABLE = "taxable"
    NON_TAXABLE = "non_taxable"
    UNKNOWN = "unknown"


class Direction(str, Enum):
    """Transaction direction for flow classification.
    
    Values:
    - INFLOW: Assets coming into the account (buys, deposits, receives)
    - OUTFLOW: Assets leaving the account (sells, withdrawals, sends)
    - NEUTRAL: No asset movement (approvals, contract interactions)
    """
    
    INFLOW = "inflow"
    OUTFLOW = "outflow"
    NEUTRAL = "neutral"


class ReviewStatus(str, Enum):
    """Review status for transaction workflow.
    
    Values:
    - VALID: Transaction has been reviewed and validated
    - PENDING: Transaction awaits user review
    - INVALID: Transaction marked as invalid/error
    """
    
    VALID = "valid"
    PENDING = "pending"
    INVALID = "invalid"


class AccountType(str, Enum):
    """Account type classification.
    
    Values:
    - CEX: Centralized exchange account (Binance, Coinbase, etc.)
    - BROKER: Traditional broker account (stocks, ETFs)
    - WALLET: On-chain wallet (MetaMask, hardware wallets)
    """
    
    CEX = "cex"
    BROKER = "broker"
    WALLET = "wallet"


class ConnectorCategory(str, Enum):
    """Connector category for data sources.
    
    Values:
    - CEX: Centralized exchange connectors (API-based)
    - ONCHAIN: On-chain/blockchain connectors (address-based)
    - BROKER: Traditional broker connectors
    """
    
    CEX = "cex"
    ONCHAIN = "onchain"
    BROKER = "broker"


# ============================================================================
# App Settings
# ============================================================================


class AppSettings(SQLModel, table=True):
    """
    Application-wide settings stored in database.
    
    Stores user preferences that can be modified via UI:
    - base_currency: Default currency for P&L calculations
    - theme preferences, etc.
    
    This is a single-row table (id=1 always).
    """

    __tablename__ = "app_settings"

    id: int = Field(default=1, primary_key=True)
    base_currency: str = Field(default="EUR")  # Default base currency symbol
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# ============================================================================
# Account Models
# ============================================================================


class Account(SQLModel, table=True):
    """
    Account model representing different trading/wallet accounts.
    Examples: CEX accounts, broker accounts, wallet addresses.
    """

    __tablename__ = "accounts"

    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(nullable=False, index=True)
    account_type: str = Field(nullable=False, index=True)  # 'cex', 'broker', 'wallet'
    address_or_identifier: Optional[str] = Field(default=None, index=True)
    tags: Optional[List[str]] = Field(default=None, sa_column=Column(ARRAY(Text)))
    owned: bool = Field(default=True)  # Whether this account is owned by the user
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    connectors: List["AccountConnector"] = Relationship(back_populates="account")
    raw_accounts: List["RawAccount"] = Relationship(back_populates="account")
    transactions: List["NormalizedTransaction"] = Relationship(
        back_populates="account_rel",
        sa_relationship_kwargs={"foreign_keys": "[NormalizedTransaction.account_id]"},
    )
    cost_lots: List["CostLot"] = Relationship(back_populates="account")


class AccountConnector(SQLModel, table=True):
    """
    Account connector configuration.
    Links an account to a specific connector type with its configuration.
    """

    __tablename__ = "account_connectors"

    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: int = Field(foreign_key="accounts.id", nullable=False, index=True)
    connector_type: str = Field(nullable=False, index=True)
    enabled: bool = Field(default=True, index=True)
    config: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    credentials_ref: Optional[str] = Field(default=None)
    sync_priority: int = Field(default=100, index=True)
    last_sync_at: Optional[datetime] = Field(default=None)
    last_sync_status: Optional[str] = Field(default="pending")
    last_error: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    # Relationships
    account: Optional[Account] = Relationship(back_populates="connectors")


# ============================================================================
# Asset Models
# ============================================================================


class Asset(SQLModel, table=True):
    """
    Asset (cryptocurrency/token/fiat) model.
    """

    __tablename__ = "assets"

    asset_id: Optional[int] = Field(default=None, primary_key=True)
    symbol: str = Field(index=True, unique=True, nullable=False)
    label: Optional[str] = None
    price_type: Optional[str] = Field(
        default=None, index=True
    )  # 'crypto', 'stock', 'fiat' - for price getter selection
    tags: Optional[List[str]] = Field(default=None, sa_column=Column(ARRAY(Text)))
    created_at: Optional[datetime] = Field(default_factory=utc_now)
    status: int = Field(default=0)

    # Relationships
    price_snapshots: List["PriceSnapshot"] = Relationship(
        back_populates="asset",
        sa_relationship_kwargs={"foreign_keys": "[PriceSnapshot.asset_id]"},
    )
    raw_assets: List["RawAsset"] = Relationship(back_populates="asset")
    price_getters: List["AssetPriceGetter"] = Relationship(back_populates="asset")
    # Note: categories relationship defined via AssetCategory junction table
    # Access via: select(Category).join(AssetCategory).where(AssetCategory.asset_id == asset_id)


class AssetPriceGetter(SQLModel, table=True):
    """
    Asset price getter configuration.

    Links an asset to a price getter with specific parameters.
    Multiple price getters can be configured per asset with priority ordering.
    The price service will try each getter in priority order until a price is found.

    Fields:
    - external_id: The identifier used by the external API (e.g., "BTC-USD" for Yahoo,
      "bitcoin" for CoinGecko). This is the primary override for ticker resolution.
    - params: Additional getter-specific parameters (e.g., native_quote_currency, source).

    Example configurations:
    - asset_id=1, price_getter="yahoo", external_id="BTC-USD", params={}
    - asset_id=1, price_getter="coingecko", external_id="bitcoin", params={"native_quote_currency": "EUR"}
    """

    __tablename__ = "asset_price_getters"
    __table_args__ = (
        UniqueConstraint("asset_id", "price_getter", name="uq_asset_price_getter"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    asset_id: int = Field(foreign_key="assets.asset_id", nullable=False, index=True)
    price_getter: str = Field(nullable=False, index=True)  # e.g., 'yahoo', 'coingecko'
    external_id: Optional[str] = Field(default=None)  # API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: int = Field(default=100, index=True)  # Lower = higher priority
    enabled: bool = Field(default=True, index=True)
    params: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    # Extra params (getter-specific):
    # - native_quote_currency: Currency the ticker returns (e.g., "USD", "EUR")
    # - source: DataReader source (e.g., "stooq", "fred")
    # - to_currency: Forex target currency
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    # Relationships
    asset: Optional[Asset] = Relationship(back_populates="price_getters")


class PriceSnapshot(SQLModel, table=True):
    """
    Immutable price snapshot for a specific point in time.
    Used for accurate P&L calculations with quote asset reference.
    """

    __tablename__ = "price_snapshots"
    __table_args__ = (
        UniqueConstraint(
            "asset_id",
            "quote_asset_id",
            "snapshot_time",
            "source",
            name="uq_price_snapshot",
        ),
    )

    snapshot_id: Optional[int] = Field(default=None, primary_key=True)
    asset_id: int = Field(foreign_key="assets.asset_id", nullable=False, index=True)
    quote_asset_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id")
    price: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    source: Optional[str] = None
    snapshot_time: datetime = Field(nullable=False, index=True)
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    asset: Optional[Asset] = Relationship(
        back_populates="price_snapshots",
        sa_relationship_kwargs={"foreign_keys": "[PriceSnapshot.asset_id]"},
    )
    quote_asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[PriceSnapshot.quote_asset_id]"},
    )


class RawAsset(SQLModel, table=True):
    """
    Raw asset mapping table.
    Maps (symbol, source) pairs to asset_id in the assets table.
    """

    __tablename__ = "raw_assets"
    __table_args__ = (UniqueConstraint("symbol", "source", name="uq_raw_asset"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    symbol: str = Field(nullable=False, index=True)
    source: str = Field(nullable=False, index=True)
    asset_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id")

    # Relationships
    asset: Optional[Asset] = Relationship(back_populates="raw_assets")


# ============================================================================
# Category Models (for flexible asset classification)
# ============================================================================


class Dimension(SQLModel, table=True):
    """
    Dimension for asset classification (e.g., "Asset Class", "Sector", "Region").
    
    Dimensions are orthogonal facets for categorizing assets.
    Each dimension can have multiple category values.
    Assets can belong to at most one category per dimension.
    
    Examples:
    - label="Asset Class" (with categories: Crypto, Stock, Fixed Income)
    - label="Sector" (with categories: DeFi, Gaming, Infrastructure)
    """

    __tablename__ = "dimensions"

    id: Optional[int] = Field(default=None, primary_key=True)
    label: str = Field(nullable=False, unique=True)  # "Asset Class", "Sector", "Region"
    ordinal: int = Field(default=0)  # Display order
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    categories: List["Category"] = Relationship(back_populates="dimension")


class Category(SQLModel, table=True):
    """
    Category value within a dimension for asset classification.
    
    Examples:
    - dimension_id=1 (Asset Class), label="Cryptocurrency"
    - dimension_id=2 (Sector), label="DeFi"
    """

    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("dimension_id", "label", name="uq_category_dimension_label"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    dimension_id: int = Field(foreign_key="dimensions.id", nullable=False, index=True)
    label: str = Field(nullable=False)  # "Cryptocurrency", "DeFi", "United States"
    color: Optional[str] = Field(default=None)  # Hex color for UI (e.g., "#3B82F6")
    ordinal: int = Field(default=0)  # Display order within dimension
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    dimension: Optional[Dimension] = Relationship(back_populates="categories")
    # Note: Relationship to assets via AssetCategory junction table


class AssetCategory(SQLModel, table=True):
    """
    Junction table linking assets to categories (many-to-many).
    """

    __tablename__ = "asset_categories"
    __table_args__ = (
        UniqueConstraint("asset_id", "category_id", name="uq_asset_category"),
    )

    asset_id: int = Field(foreign_key="assets.asset_id", primary_key=True)
    category_id: int = Field(foreign_key="categories.id", primary_key=True)
    created_at: datetime = Field(default_factory=utc_now)


# ============================================================================
# Transaction Models
# ============================================================================


class RawTransaction(SQLModel, table=True):
    """
    Raw transaction storage.
    Stores the original JSON data from exchange APIs.
    """

    __tablename__ = "raw_transactions"
    __table_args__ = (
        UniqueConstraint("source", "source_transaction_id", name="uq_raw_transaction"),
    )

    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(nullable=False, index=True)
    source_transaction_id: str = Field(nullable=False, index=True)
    raw_data: Dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    ingestion_time: datetime = Field(default_factory=utc_now)

    # Relationships
    normalized_transactions: List["NormalizedTransaction"] = Relationship(
        back_populates="raw_transaction"
    )


class NormalizedTransaction(SQLModel, table=True):
    """
    Normalized transaction model.
    Standardized cryptocurrency transaction from any source.

    Can be used both as:
    - ORM model for database persistence (table=True)
    - DTO for data transfer between layers (connectors, pipeline, etc.)
    """

    __tablename__ = "normalized_transactions"

    id: Optional[int] = Field(default=None, primary_key=True)

    # Source traceability
    raw_transaction_id: Optional[int] = Field(
        default=None, foreign_key="raw_transactions.id"
    )
    source: str = Field(default="", index=True)
    source_asset_symbol: str = Field(default="")
    source_transaction_type: Optional[str] = Field(default=None)
    source_transaction_id: Optional[str] = Field(default=None, index=True)

    # Account ownership
    account_id: Optional[int] = Field(
        default=None, foreign_key="accounts.id", index=True
    )

    # Core transaction fields
    date_time: Optional[datetime] = Field(default=None, index=True)
    direction: str = Field(default="")  # 'inflow', 'outflow', 'neutral'
    transaction_type: str = Field(
        default=""
    )  # 'trade', 'transfer', 'technical' (see TransactionType enum)

    # Asset and quantity
    asset_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id")
    quantity: Decimal = Field(
        default=Decimal(0), sa_column=Column(Numeric(36, 18), nullable=False, default=0)
    )

    # Pricing (in quote asset, not base - base currency is a P&L runtime config)
    price: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(36, 18)))
    price_snapshot_id: Optional[int] = Field(
        default=None, foreign_key="price_snapshots.snapshot_id"
    )
    source_price_quote_asset_symbol: str = Field(default="")
    price_quote_asset_id: Optional[int] = Field(
        default=None, foreign_key="assets.asset_id"
    )

    # Fees (in fee quote asset)
    fee: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(36, 18)))
    source_fee_quote_asset_symbol: str = Field(default="")
    fee_quote_asset_id: Optional[int] = Field(
        default=None, foreign_key="assets.asset_id"
    )
    include_fee: bool = Field(
        default=False
    )  # Whether to include fee in P&L calculation

    # Tax - disposal_taxable indicates if disposing this asset is a taxable event (capital gains)
    disposal_taxable: bool = Field(default=False)

    # NOTE: group_id removed in V2 architecture - use calculation_unit_id instead
    # Migration 004 drops the groups tables entirely

    # Transfer accounts (for internal transfers - resolved account IDs)
    from_account_id: Optional[int] = Field(default=None, foreign_key="accounts.id")
    to_account_id: Optional[int] = Field(default=None, foreign_key="accounts.id")

    # Source account identifiers (raw from connector, before mapping)
    source_from_account: Optional[str] = Field(default=None)  # Raw source address/identifier
    source_to_account: Optional[str] = Field(default=None)  # Raw destination address/identifier
    network: Optional[str] = Field(default=None)
    network_transaction_id: Optional[str] = Field(default=None)
    token_contract_address: Optional[str] = Field(default=None)

    # Metadata
    tags: Optional[List[Dict[str, str]]] = Field(default=None, sa_column=Column(JSON))
    synced_at: Optional[datetime] = Field(default=None)

    # Review status and taxability
    review_status: str = Field(default="pending", index=True)  # valid, pending, invalid
    taxability_status: str = Field(
        default="unknown", index=True
    )  # taxable, non_taxable, unknown

    # V3 Architecture: CalculationUnit (user-defined transaction grouping)
    user_calculation_unit_id: Optional[int] = Field(
        default=None, foreign_key="bundles.id", index=True
    )

    # Totals (in quote asset)
    total: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(36, 18)))

    # Review notes
    review_notes: Optional[str] = Field(default=None, sa_column=Column(Text))

    # Timestamps
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    # Relationships
    raw_transaction: Optional[RawTransaction] = Relationship(
        back_populates="normalized_transactions"
    )
    account_rel: Optional[Account] = Relationship(
        back_populates="transactions",
        sa_relationship_kwargs={"foreign_keys": "[NormalizedTransaction.account_id]"},
    )
    asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[NormalizedTransaction.asset_id]"},
    )
    price_quote_asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={
            "foreign_keys": "[NormalizedTransaction.price_quote_asset_id]"
        },
    )
    fee_quote_asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={
            "foreign_keys": "[NormalizedTransaction.fee_quote_asset_id]"
        },
    )
    price_snapshot: Optional[PriceSnapshot] = Relationship()
    # V3: UserCalculationBundle relationship (user-defined groupings)
    user_calculation_unit: Optional["UserCalculationBundle"] = Relationship(
        back_populates="transactions",
        sa_relationship_kwargs={
            "foreign_keys": "[NormalizedTransaction.user_calculation_unit_id]"
        },
    )
    
    from_account: Optional[Account] = Relationship(
        sa_relationship_kwargs={
            "foreign_keys": "[NormalizedTransaction.from_account_id]"
        },
    )
    to_account: Optional[Account] = Relationship(
        sa_relationship_kwargs={
            "foreign_keys": "[NormalizedTransaction.to_account_id]"
        },
    )


# ============================================================================
# Unknown Addresses (for review)
# ============================================================================


class RawAccount(SQLModel, table=True):
    """
    Raw account mapping table.
    Maps (source, label) pairs to account_id in the accounts table.
    Similar to raw_assets but for accounts/addresses.
    Used to map source_from_account and source_to_account to resolved accounts.
    """

    __tablename__ = "raw_accounts"
    __table_args__ = (UniqueConstraint("source", "label", name="uq_raw_account"),)

    id: Optional[int] = Field(default=None, primary_key=True)
    source: str = Field(
        nullable=False, index=True
    )  # e.g., 'binance', 'blockscout', 'manual'
    label: str = Field(nullable=False, index=True)  # Raw address or identifier
    account_id: Optional[int] = Field(
        default=None, foreign_key="accounts.id", index=True
    )
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    account: Optional[Account] = Relationship(back_populates="raw_accounts")


# ============================================================================
# UserCalculationBundle Model (User-defined transaction groupings)
# ============================================================================


class UserCalculationBundle(SQLModel, table=True):
    """
    User-defined grouping of transactions for P&L calculation.
    
    This stores user-created bundles (manual groupings):
    - Links transactions that should be processed together
    - Can be a suggestion (confidence set) or confirmed (confidence=None)
    
    At P&L runtime, the engine creates CalculationUnit records with
    unit_origin="bundle:{id}" or "tx:{id}" for processing and audit.
    """

    __tablename__ = "bundles"  # Table named 'bundles' for DB compatibility

    id: Optional[int] = Field(default=None, primary_key=True)
    label: Optional[str] = Field(default=None)
    pattern: Optional[str] = Field(default=None)  # transfer, swap, split, unknown
    notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    taxability_override: Optional[str] = Field(
        default=None
    )  # taxable, non_taxable, or None (use computed)
    
    # Suggestion metadata (set when created from GroupingEngine)
    confidence: Optional[float] = Field(default=None)  # 0.0-1.0 for suggestions
    reason: Optional[str] = Field(default=None)  # Human-readable explanation
    
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)

    # Relationships
    transactions: List["NormalizedTransaction"] = Relationship(
        back_populates="user_calculation_unit"
    )
    
    @property
    def is_suggestion(self) -> bool:
        """True if this is an unconfirmed suggestion."""
        return self.confidence is not None
    
    @property
    def is_confirmed(self) -> bool:
        """True if user has confirmed this grouping."""
        return self.confidence is None


# ============================================================================
# Calculation Models (Versions, Cost Lots, Realized PnL)
# ============================================================================


class CalculationVersion(SQLModel, table=True):
    """
    Calculation version for tracking P&L computation runs.
    Each run creates a new version for idempotency and auditability.
    
    Status values:
    - draft: Preview calculation, not yet committed (auto-expires)
    - committed: User confirmed and saved this version
    - active: The current active version used for reporting
    """

    __tablename__ = "calculation_versions"

    version_id: Optional[int] = Field(default=None, primary_key=True)
    description: Optional[str] = Field(default=None, sa_column=Column(Text))
    created_at: datetime = Field(default_factory=utc_now)
    expires_at: Optional[datetime] = Field(default=None, index=True)  # For draft cleanup
    method: str = Field(default="FIFO")  # FIFO, LIFO, HIFO, SPECIFIC
    lot_mode: str = Field(default="LOT_TRAVEL")  # LOT_TRAVEL, MEGA_WALLET
    base_currency_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id")
    # Additional config fields for reproducibility
    allow_negative_balances: bool = Field(default=False)
    residual_tolerance_pct: Decimal = Field(
        default=Decimal("0.05"),
        sa_column=Column(Numeric(10, 4), nullable=False, default=0.05)
    )
    status: str = Field(
        default="draft", index=True
    )  # draft, committed, active
    # Account filter - stores which accounts were included in this calculation
    # NULL means all accounts, empty array means none (though that would be unusual)
    account_ids: Optional[List[int]] = Field(
        default=None, sa_column=Column(ARRAY(Integer), nullable=True)
    )

    # Relationships - Only calculation_units with cascade
    # All other children (cost_lots, realized_pnl, etc.) are owned by CalculationUnit
    calculation_units: List["CalculationUnit"] = Relationship(
        back_populates="version",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


# AssetBalance model DELETED - use CostLot aggregations instead


class CostLot(SQLModel, table=True):
    """
    Cost lot for FIFO/LIFO tax lot tracking.
    Tracks individual acquisition lots and their remaining quantities.
    
    Used both for persistence (SQLModel table) and runtime P&L calculation.
    The consume() method provides lot consumption logic for the P&L engine.
    
    Supports negative lots for out-of-order transactions:
    - is_negative=True indicates this lot represents a debt (disposal before acquisition)
    - qty and qty_remaining are negative for negative lots
    - is_settled=True when the debt has been fully resolved by later inflows
    
    Cost basis handling:
    - Set unit_cost_in_base OR total_cost_in_base at creation
    - The other will be computed automatically from qty
    - If both are provided, unit_cost_in_base takes precedence
    """

    __tablename__ = "cost_lots"

    cost_lot_id: Optional[int] = Field(default=None, primary_key=True)
    # version_id removed - version now accessed via unit.version
    asset_id: Optional[int] = Field(
        default=None, foreign_key="assets.asset_id", index=True
    )
    account_id: Optional[int] = Field(
        default=None, foreign_key="accounts.id", index=True
    )
    qty: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    qty_remaining: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    unit_cost_in_base: Decimal = Field(
        default=Decimal("0"), sa_column=Column(Numeric(36, 18), nullable=False, default=0)
    )
    acquired_at: datetime = Field(default_factory=utc_now, index=True)
    
    # Traceability
    origin_transaction_id: Optional[int] = Field(
        default=None, foreign_key="normalized_transactions.id", index=True
    )
    unit_id: Optional[int] = Field(
        default=None, foreign_key="calculation_units.id", index=True
    )  # FK to CalculationUnit (processing record)
    notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    
    # Negative lot tracking
    is_negative: bool = Field(default=False, index=True)
    is_zero_cost: bool = Field(default=False)
    is_settled: bool = Field(default=False, index=True)
    settled_by_lot_id: Optional[int] = Field(default=None, foreign_key="cost_lots.cost_lot_id", index=True)
    settled_cost_in_base: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(36, 18))
    )
    origin_pnl_id: Optional[int] = Field(default=None, index=True)
    
    created_at: datetime = Field(default_factory=utc_now)
    
    # Relationships
    asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLot.asset_id]"},
    )
    # consumed_slices owned by this lot with cascade
    consumed_slices: List["ConsumedLotSlice"] = Relationship(
        back_populates="cost_lot",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
    # outgoing_settlements: settlements where this lot is the settling lot (cascade)
    outgoing_settlements: List["LotSettlement"] = Relationship(
        back_populates="settling_lot",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[LotSettlement.settling_lot_id]"
        }
    )
    # events: audit trail of all state changes to this lot (cascade)
    events: List["CostLotEvent"] = Relationship(
        back_populates="lot",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[CostLotEvent.lot_id]"
        }
    )
    account: Optional[Account] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLot.account_id]"},
    )
    origin_transaction: Optional["NormalizedTransaction"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLot.origin_transaction_id]"},
    )
    # Owner relationship: CostLot belongs to CalculationUnit
    unit: Optional["CalculationUnit"] = Relationship(
        back_populates="cost_lots",
        sa_relationship_kwargs={"foreign_keys": "[CostLot.unit_id]"},
    )
    
    def __init__(self, **data):
        """Initialize CostLot with automatic cost computation.
        
        If total_cost_in_base is provided but unit_cost_in_base is not (or is 0),
        compute unit_cost_in_base from total_cost_in_base / qty.
        """
        # Extract total_cost_in_base if provided (it's not a DB field)
        total_cost = data.pop("total_cost_in_base", None)
        
        super().__init__(**data)
        
        # If total_cost was provided, compute it
        if self.total_cost_in_base is None :
            self.total_cost_in_base = total_cost


    
    @property
    def total_cost_in_base(self) -> Decimal:
        """Total cost basis for the original quantity (alias for total_cost)."""
        return self.qty * self.unit_cost_in_base
    
    @total_cost_in_base.setter
    def total_cost_in_base(self, value: Decimal) -> None:
        """Set total cost and compute unit cost from qty."""
        if self.qty and self.qty != Decimal("0"):
            self.unit_cost_in_base = Decimal(str(value)) / self.qty
        else:
            self.unit_cost_in_base = Decimal("0")

    # Convenience aliases for shorter access
    @property
    def total_cost(self) -> Decimal:
        """Alias for total_cost_in_base."""
        return self.total_cost_in_base
    
    @property
    def unit_cost(self) -> Decimal:
        """Alias for unit_cost_in_base."""
        return self.unit_cost_in_base

    @property
    def remaining_cost_in_base(self) -> Decimal:
        """Remaining cost basis for unconsumed quantity."""
        return self.qty_remaining * self.unit_cost_in_base
    
    # Alias for backward compatibility
    @property
    def cost_remaining_in_base(self) -> Decimal:
        """Alias for remaining_cost_in_base."""
        return self.remaining_cost_in_base

    def consume(self, qty: Decimal) -> "ConsumedLotSlice":
        """Consume a quantity from this lot, returning a slice record.
        
        Sets the cost_lot relationship on the slice at creation time.
        The slice is automatically persisted via the cascade relationship.
        """
        if qty > self.qty_remaining:
            raise ValueError(
                f"Cannot consume {qty} from lot with {self.qty_remaining} remaining"
            )

        self.qty_remaining -= qty

        slice_record = ConsumedLotSlice(
            quantity=qty,
            unit_cost_in_base=self.unit_cost_in_base,
            total_cost_in_base=qty * self.unit_cost_in_base,
            cost_lot=self,  # Set cost_lot relationship - cascade handles persistence
        )
        return slice_record


class ConsumedLotSlice(SQLModel, table=True):
    """
    Detailed tracking of cost lot consumption.
    Each slice represents a portion of a cost lot consumed in a disposal.
    
    Used both for persistence (SQLModel table) and runtime P&L calculation.
    Runtime fields (consumed_at, etc.) are populated during calculation.
    
    Ownership: Owned by CostLot via cost_lot_id (cascade delete).
    """

    __tablename__ = "consumed_lot_slices"

    slice_id: Optional[int] = Field(default=None, primary_key=True)
    # version_id removed - version accessed via cost_lot.unit.version
    pnl_id: Optional[int] = Field(default=None, foreign_key="realized_pnl.pnl_id")
    cost_lot_id: Optional[int] = Field(
        default=None, foreign_key="cost_lots.cost_lot_id"
    )
    consumed_by_leg_id: Optional[int] = Field(
        default=None, foreign_key="calculation_unit_legs.id", index=True
    )
    quantity: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    unit_cost_in_base: Decimal = Field(
        sa_column=Column(Numeric(36, 18), nullable=False)
    )
    total_cost_in_base: Decimal = Field(
        sa_column=Column(Numeric(36, 18), nullable=False)
    )
    created_at: datetime = Field(default_factory=utc_now)
    
    # Runtime-only fields (used during P&L calculation, derived from cost_lot)
    consumed_at: Optional[datetime] = Field(default=None, exclude=True)

    # Relationships - cost_lot is the owner
    pnl: Optional["RealizedPnl"] = Relationship(
        back_populates="slices",
        sa_relationship_kwargs={"foreign_keys": "[ConsumedLotSlice.pnl_id]"}
    )
    cost_lot: Optional[CostLot] = Relationship(back_populates="consumed_slices")
    consumed_by_leg: Optional["CalculationUnitLeg"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[ConsumedLotSlice.consumed_by_leg_id]"}
    )
    
    # Convenience property to access version via cost_lot
    @property
    def version(self) -> Optional["CalculationVersion"]:
        """Access version through the owning cost_lot's unit."""
        if self.cost_lot and self.cost_lot.unit:
            return self.cost_lot.unit.version
        return None
    
    @property
    def holding_period_days(self) -> Optional[int]:
        """
        Number of days this slice was held before consumption.
        Computed from consumed_at - cost_lot.acquired_at.
        Returns None if either date is not set.
        
        Both datetimes are now guaranteed to be timezone-aware UTC.
        """
        if self.consumed_at is None or not self.cost_lot or not self.cost_lot.acquired_at:
            return None
        
        delta = ensure_utc(self.consumed_at) - ensure_utc(self.cost_lot.acquired_at)
        return max(0, delta.days)


class RealizedPnl(SQLModel, table=True):
    """
    Realized profit/loss record for tax reporting.
    Records each disposal and the lots consumed.
    
    Used both for persistence (SQLModel table) and runtime P&L calculation.
    Runtime fields (is_fee, is_provisional, etc.) are used during calculation.
    
    Ownership: Owned by CalculationUnit via origin_unit_id (cascade delete).
    """

    __tablename__ = "realized_pnl"

    pnl_id: Optional[int] = Field(default=None, primary_key=True)
    asset_id: int = Field(foreign_key="assets.asset_id", nullable=False, index=True)
    qty: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    proceeds_in_base: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    cost_basis_in_base: Decimal = Field(
        sa_column=Column(Numeric(36, 18), nullable=False)
    )
    pnl_in_base: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    disposal_taxable: bool = Field(default=False)  # Whether this disposal is a taxable event
    transaction_id: Optional[int] = Field(
        default=None, foreign_key="normalized_transactions.id", index=True
    )
    origin_unit_id: Optional[int] = Field(
        default=None, foreign_key="calculation_units.id", index=True
    )

    # version_id removed - version accessed via origin_unit.version
    realized_at: Optional[datetime] = Field(default=None, index=True)
    holding_period_days: Optional[int] = Field(default=None)
    notes: Optional[str] = Field(default=None, sa_column=Column(Text))
    
    # Proceeds tracking - how FMV was determined
    proceeds_source: Optional[str] = Field(default="fmv_lookup")  # 'fmv_lookup', 'base_currency', 'transfer'
    proceeds_price: Optional[Decimal] = Field(default=None, sa_column=Column(Numeric(36, 18)))  # Price used for FMV
    proceeds_price_source: Optional[str] = Field(default=None)  # 'coingecko', 'manual', 'fallback', etc.
    proceeds_price_timestamp: Optional[datetime] = Field(default=None)  # When price was fetched
    

    # Relationships
    # slices is viewonly - ConsumedLotSlice is owned by CostLot
    slices: List[ConsumedLotSlice] = Relationship(
        back_populates="pnl",
        sa_relationship_kwargs={
            "viewonly": True,
            "foreign_keys": "[ConsumedLotSlice.pnl_id]"
        }
    )
    asset: Optional[Asset] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[RealizedPnl.asset_id]"},
    )
    # Owner relationship: RealizedPnl belongs to CalculationUnit
    origin_unit: Optional["CalculationUnit"] = Relationship(
        back_populates="realized_pnl_records",
        sa_relationship_kwargs={"foreign_keys": "[RealizedPnl.origin_unit_id]"},
    )
    transaction: Optional["NormalizedTransaction"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[RealizedPnl.transaction_id]"},
    ) 


class FeeEntry(SQLModel, table=True):
    """
    Fee index table linking fee legs to their RealizedPnl entries.
    
    This is a minimal join table that:
    - Links fee_leg_id to realized_pnl_id for efficient fee queries
    - All fee data (FMV, cost basis, quantity) lives in RealizedPnl
    - All fees create RealizedPnl entries (disposal_taxable flag determines tax treatment)
    
    Ownership: Owned by CalculationUnit via unit_id (cascade delete).
    """

    __tablename__ = "fee_entries"

    id: Optional[int] = Field(default=None, primary_key=True)
    
    # Core FKs - minimal index
    fee_leg_id: int = Field(foreign_key="calculation_unit_legs.id", nullable=False, index=True)
    realized_pnl_id: Optional[int] = Field(default=None, foreign_key="realized_pnl.pnl_id", nullable=True, index=True)
    unit_id: int = Field(foreign_key="calculation_units.id", nullable=False, index=True)
    version_id: int = Field(foreign_key="calculation_versions.version_id", nullable=False, index=True)
    
    # Related asset - the primary asset this fee relates to (non-base-currency side of trade)
    # Used for aggregating fees by asset in balance view
    related_asset_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id", index=True)
    
    # Fee value in base currency - stored directly for base currency fees (no RealizedPnl)
    fee_value_in_base: Decimal = Field(default=Decimal(0), max_digits=28, decimal_places=18)
    
    # Timestamps
    created_at: datetime = Field(default_factory=utc_now)
    
    # Relationships
    fee_leg: Optional["CalculationUnitLeg"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[FeeEntry.fee_leg_id]"},
    )
    realized_pnl: Optional["RealizedPnl"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[FeeEntry.realized_pnl_id]"},
    )
    unit: Optional["CalculationUnit"] = Relationship(
        back_populates="fee_entries",
        sa_relationship_kwargs={"foreign_keys": "[FeeEntry.unit_id]"},
    )
    version: Optional["CalculationVersion"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[FeeEntry.version_id]"},
    )


class CalculationUnitLeg(SQLModel, table=True):
    """
    Unified leg interface for both persistence and runtime.
    
    This model serves as:
    1. Database persistence layer (minimal fields stored)
    2. Runtime interface (computed properties access transaction data via relationships)
    
    Replaces the dual ExpandedLeg/CalculationUnitLeg pattern with a single interface.
    All transaction details are accessible through relationships and computed properties.
    
    Fields stored in DB:
    - transaction_id, asset_id, leg_type, quantity (essential identifiers)
    
    Computed via relationships:
    - All transaction fields (date_time, price, account, etc.) via transaction FK
    - Asset details via asset FK
    - Unit metadata via unit FK
    
    Usage:
    - In P&L engine: Create with relationships set (transaction, asset)
    - In queries: Eager load relationships with selectinload()
    - In processing: Access properties directly (e.g., leg.date_time, leg.account_id)
    """

    __tablename__ = "calculation_unit_legs"

    id: Optional[int] = Field(default=None, primary_key=True)
    unit_id: int = Field(foreign_key="calculation_units.id", nullable=False, index=True)
    transaction_id: int = Field(foreign_key="normalized_transactions.id", nullable=False, index=True)
    asset_id: int = Field(foreign_key="assets.asset_id", nullable=False, index=True)
    leg_type: str = Field(nullable=False, index=True)  # "inflow", "outflow", "fee"
    quantity: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships
    unit: Optional["CalculationUnit"] = Relationship(
        back_populates="legs",
        sa_relationship_kwargs={"foreign_keys": "[CalculationUnitLeg.unit_id]"}
    )
    transaction: Optional["NormalizedTransaction"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CalculationUnitLeg.transaction_id]"}
    )
    asset: Optional["Asset"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CalculationUnitLeg.asset_id]"}
    )
    
    # Computed properties for ExpandedLeg compatibility
    @property
    def asset_symbol(self) -> str:
        """Get asset symbol from loaded relationship or fallback to ID."""
        return self.asset.symbol if self.asset else f"#{self.asset_id}"
    
    @property
    def date_time(self) -> Optional[datetime]:
        """Get transaction datetime."""
        return self.transaction.date_time if self.transaction else None
    
    @property
    def origin_transaction_id(self) -> int:
        """Alias for transaction_id."""
        return self.transaction_id
    
    @property
    def origin_transaction(self) -> Optional["NormalizedTransaction"]:
        """Alias for transaction relationship."""
        return self.transaction
    
    @property
    def account_id(self) -> Optional[int]:
        """Get account ID from transaction."""
        return self.transaction.account_id if self.transaction else None
    
    @property
    def account(self) -> Optional[Account]:
        """Get account from transaction."""
        return self.transaction.account_rel if self.transaction else None
    
    @property
    def direction(self) -> str:
        """Map leg_type to direction for ExpandedLeg compatibility."""
        return self.leg_type if self.leg_type in ("inflow", "outflow") else "outflow"
    
    @property
    def is_fee(self) -> bool:
        """Check if this is a fee leg."""
        return self.leg_type == "fee"
    
    @property
    def tx_disposal_taxable(self) -> bool:
        """Get disposal_taxable override flag from transaction (user input)."""
        return self.transaction.disposal_taxable if self.transaction else False
    
    # Persisted taxability (computed by TaxabilityCalculator during P&L processing)
    disposal_taxable: bool = Field(default=False)


class CalculationUnit(SQLModel, table=True):
    """
    Unified calculation unit for P&L processing and audit trail.
    
    Merges RuntimeCalculationUnit (runtime) and ProcessedUnit (persistence) into one.
    Each unit represents a logical grouping of transactions processed together.
    
    Origin tracking:
    - unit_origin="bundle:{id}" for user-defined bundles (UserCalculationBundle)
    - unit_origin="tx:{id}" for single transactions
    
    Persisted fields are minimal - computed fields are derived from relationships
    at API/service level:
    - transaction_ids → from members at runtime
    - lots_created_count → count(cost_lots where unit_id=self.id)
    - realized_pnl_in_base → sum(realized_pnl_records.pnl_in_base)
    """

    __tablename__ = "calculation_units"

    id: Optional[int] = Field(default=None, primary_key=True)
    version_id: int = Field(
        foreign_key="calculation_versions.version_id", nullable=False, index=True
    )
    
    # Origin tracking: "bundle:{id}" or "tx:{id}"
    unit_origin: str = Field(nullable=False, index=True)
    
    # Unit metadata
    unit_label: Optional[str] = Field(default=None)  # Human-readable label
    pattern: Optional[str] = Field(default=None)  # User-confirmed pattern: transfer, swap, split, unknown
    timestamp: datetime = Field(default_factory=utc_now, index=True)

    # Relationships - all children use cascade for automatic persistence
    version: Optional["CalculationVersion"] = Relationship(back_populates="calculation_units")
    
    # Children owned by this unit - cascade enables automatic persistence/deletion
    cost_lots: List["CostLot"] = Relationship(
        back_populates="unit",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[CostLot.unit_id]"
        }
    )
    realized_pnl_records: List["RealizedPnl"] = Relationship(
        back_populates="origin_unit",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[RealizedPnl.origin_unit_id]"
        }
    )
    fee_entries: List["FeeEntry"] = Relationship(
        back_populates="unit",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[FeeEntry.unit_id]"
        }
    )
    warnings: List["PnlWarning"] = Relationship(
        back_populates="unit",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[PnlWarning.unit_id]"
        }
    )
    legs: List["CalculationUnitLeg"] = Relationship(
        back_populates="unit",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[CalculationUnitLeg.unit_id]"
        }
    )
    
    # Model configuration to allow extra attributes for runtime data
    model_config = {"extra": "allow", "arbitrary_types_allowed": True}
    
    def __init__(self, **data):
        """Initialize with runtime-only attributes and auto-compute pattern if needed."""
        import logging
        logger = logging.getLogger("backend")
        
        _label = data.pop('_label', None)
        bundle_taxability_override = data.pop('bundle_taxability_override', None)
        bundle_pattern = data.pop('bundle_pattern', None)
        
        super().__init__(**data)
        
        # Runtime-only attributes (not persisted)
        object.__setattr__(self, 'bundle_taxability_override', bundle_taxability_override)
        object.__setattr__(self, 'residual_pct', None)
        
        if _label and not self.unit_label:
            self.unit_label = _label
        
        # Pattern precedence: explicit > bundle > computed > unknown
        if self.pattern is None:
            if bundle_pattern:
                self.pattern = bundle_pattern
                logger.debug(f"Unit {self.id}: Pattern set from bundle: {bundle_pattern}")
            else:
                try:
                    computed_pattern, reason = self._compute_pattern_from_legs()
                    self.pattern = computed_pattern
                    logger.debug(f"Unit {self.id}: Pattern auto-computed: {computed_pattern} ({reason})")
                except Exception as e:
                    self.pattern = UnitPattern.UNKNOWN.value
                    logger.warning(f"Unit {self.id}: Pattern computation failed: {e}, defaulting to unknown")
    
    # Computed properties from persisted relationships
    @property
    def lots_created_count(self) -> int:
        return len(self.cost_lots) if self.cost_lots else 0
    
    @property
    def realized_entry_count(self) -> int:
        return len(self.realized_pnl_records) if self.realized_pnl_records else 0
    
    @property
    def total_realized_pnl_in_base(self) -> Decimal:
        if not self.realized_pnl_records:
            return Decimal("0")
        return sum(r.pnl_in_base for r in self.realized_pnl_records if r.pnl_in_base)
    
    # Persisted leg accessors (for API/queries)
    @property
    def outflow_legs(self) -> List["CalculationUnitLeg"]:
        return [leg for leg in (self.legs or []) if leg.leg_type == "outflow"]
    
    @property
    def inflow_legs(self) -> List["CalculationUnitLeg"]:
        return [leg for leg in (self.legs or []) if leg.leg_type == "inflow"]
    
    @property
    def fee_legs(self) -> List["CalculationUnitLeg"]:
        return [leg for leg in (self.legs or []) if leg.leg_type == "fee"]
    
    @property
    def transaction_ids(self) -> List[int]:
        return list({leg.transaction_id for leg in (self.legs or [])})
    
    # Computed properties from legs
    @property
    def _outflow_asset_ids(self) -> set:
        """Set of asset IDs being disposed (excluding fees)."""
        return {leg.asset_id for leg in self.outflow_legs if leg.asset_id}
    
    @property
    def _inflow_asset_ids(self) -> set:
        """Set of asset IDs being acquired."""
        return {leg.asset_id for leg in self.inflow_legs if leg.asset_id}
    
    @property
    def total_outflow_qty(self) -> Decimal:
        return sum(leg.quantity for leg in self.outflow_legs if leg.quantity)
    
    @property
    def total_inflow_qty(self) -> Decimal:
        return sum(leg.quantity for leg in self.inflow_legs if leg.quantity)
    
    def _generate_label(self) -> str:
        """Generate a human-readable label from legs with quantities.
        
        Returns:
            Label like '0.5 BTC → 10 ETH' for swaps, '1.5 BTC out' for spends,
            '1 BTC: Binance → Ledger' for transfers, etc.
        """
        if not self.legs:
            return ""
        
        def format_qty(qty) -> str:
            """Format quantity, stripping trailing zeros."""
            if qty is None:
                return "?"
            # Convert to float for cleaner display, then strip trailing zeros
            formatted = f"{float(qty):g}"
            return formatted
        
        def get_account_name(leg) -> str:
            """Get account name from leg if available."""
            if leg.account:
                return leg.account.name
            return ""
        
        # For transfers: show "{qty} {asset}: {from_account} → {to_account}"
        if self.pattern == UnitPattern.TRANSFER.value:
            outflow_legs = self.outflow_legs
            inflow_legs = self.inflow_legs
            
            if outflow_legs and inflow_legs:
                # Get the asset (same for both sides in transfer)
                asset_symbol = outflow_legs[0].asset_symbol if outflow_legs else "?"
                qty = sum(leg.quantity or Decimal(0) for leg in outflow_legs)
                
                # Get account names
                from_accounts = list({get_account_name(leg) for leg in outflow_legs if get_account_name(leg)})
                to_accounts = list({get_account_name(leg) for leg in inflow_legs if get_account_name(leg)})
                
                from_str = ", ".join(from_accounts[:2]) if from_accounts else "?"
                to_str = ", ".join(to_accounts[:2]) if to_accounts else "?"
                
                if from_accounts and to_accounts:
                    return f"{format_qty(qty)} {asset_symbol}: {from_str} → {to_str}"
        
        # Aggregate quantities by symbol for outflows
        outflow_by_symbol: dict[str, Decimal] = {}
        for leg in self.outflow_legs:
            if leg.asset_symbol:
                outflow_by_symbol[leg.asset_symbol] = outflow_by_symbol.get(leg.asset_symbol, Decimal(0)) + (leg.quantity or Decimal(0))
        
        # Aggregate quantities by symbol for inflows
        inflow_by_symbol: dict[str, Decimal] = {}
        for leg in self.inflow_legs:
            if leg.asset_symbol:
                inflow_by_symbol[leg.asset_symbol] = inflow_by_symbol.get(leg.asset_symbol, Decimal(0)) + (leg.quantity or Decimal(0))
        
        # Format as "qty SYMBOL" pairs
        outflow_parts = [f"{format_qty(qty)} {sym}" for sym, qty in sorted(outflow_by_symbol.items())[:2]]
        inflow_parts = [f"{format_qty(qty)} {sym}" for sym, qty in sorted(inflow_by_symbol.items())[:2]]
        
        # For swaps: OUT → IN
        if outflow_parts and inflow_parts:
            return f"{', '.join(outflow_parts)} → {', '.join(inflow_parts)}"
        
        # For outflow only (e.g., spend)
        if outflow_parts:
            return f"{', '.join(outflow_parts)} out"
        
        # For inflow only (e.g., income)
        if inflow_parts:
            return f"{', '.join(inflow_parts)} in"
        
        return ""
    
    def _compute_pattern_from_legs(self) -> tuple[str, str]:
        """Compute pattern from legs analysis.
        
        Returns:
            Tuple of (pattern, reason) for logging.
            
        Pattern detection priority:
        1. Same single asset in/out = transfer (complete)
        2. Different assets with both in/out = swap
        3. Single-leg transfer (outflow-only or inflow-only with transfer tx_type) = pending_transfer
        4. Unknown
        """
        if not self.legs:
            return (UnitPattern.UNKNOWN.value, "no legs")
        
        outflow_assets = self._outflow_asset_ids
        inflow_assets = self._inflow_asset_ids
        
        # Same single asset in/out = transfer (complete)
        if outflow_assets == inflow_assets and len(outflow_assets) == 1:
            asset_id = next(iter(outflow_assets))
            return (UnitPattern.TRANSFER.value, f"same asset #{asset_id} in/out")
        
        # Different assets = swap
        if outflow_assets and inflow_assets:
            return (UnitPattern.SWAP.value, "different assets")
        
        # Check for incomplete transfer: single-leg with transfer transaction_type
        # This detects withdrawal/deposit without matching counterpart
        if self._is_incomplete_transfer():
            if outflow_assets:
                return (UnitPattern.PENDING_TRANSFER.value, "outflow-only transfer awaiting inflow")
            else:
                return (UnitPattern.PENDING_TRANSFER.value, "inflow-only transfer awaiting outflow")
        
        # Default to unknown
        return (UnitPattern.UNKNOWN.value, "unable to determine pattern")
    
    def _is_incomplete_transfer(self) -> bool:
        """Check if this unit is an incomplete transfer (single leg with transfer tx_type).
        
        Returns:
            True if legs indicate a transfer but missing counterpart (inflow or outflow).
        """
        # Must be single-direction (outflow-only or inflow-only)
        if not (self.is_outflow_only or self.is_inflow_only):
            return False
        
        # Check if any leg's source transaction has transfer-related type
        transfer_types = {"transfer", "withdrawal", "deposit", "internal_transfer"}
        
        for leg in self.legs:
            if leg.transaction and leg.transaction.transaction_type:
                tx_type = leg.transaction.transaction_type.lower()
                if tx_type in transfer_types:
                    return True
        
        return False
    
    @property
    def is_cost_basis_transfer(self) -> bool:
        """True if cost basis transfers (user pattern or same asset in/out)."""
        # If pattern is explicitly set, use it
        if self.pattern is not None:
            if self.pattern in (UnitPattern.TRANSFER.value, UnitPattern.SPLIT.value):
                return True
            if self.pattern == UnitPattern.SWAP.value:
                return False
        # Fallback to intrinsic detection (same single asset in/out)
        return self._outflow_asset_ids == self._inflow_asset_ids and len(self._outflow_asset_ids) == 1
    
    @property
    def is_inflow_only(self) -> bool:
        return bool(self.inflow_legs) and not self.outflow_legs
    
    @property
    def is_outflow_only(self) -> bool:
        return bool(self.outflow_legs) and not self.inflow_legs
    
    @property
    def label(self) -> str:
        """Generate a descriptive label for logging/debugging."""
        if self.unit_label:
            return self.unit_label
        if not self.legs:
            return "Empty"
        
        def fmt(legs) -> str:
            if not legs:
                return "-"
            parts = []
            for leg in legs:
                sym = leg.asset.symbol if leg.asset else f"#{leg.asset_id}"
                qty = float(leg.quantity) if leg.quantity else 0
                qty_str = f"{qty:.4g}" if qty != int(qty) else str(int(qty))
                parts.append(f"{sym} {qty_str}")
            return ", ".join(parts)
        
        pattern_label = (self.pattern or "unknown").upper()
        return f"{pattern_label} out: {fmt(self.outflow_legs)} in: {fmt(self.inflow_legs)} fees: {fmt(self.fee_legs)}"


class LotSettlement(SQLModel, table=True):
    """
    Settlement record linking negative lots to their settling positive lots.
    
    When a negative lot (debt) is settled by one or more inflows, each settlement
    creates a record to maintain full audit trail.
    
    Ownership: Owned by settling_lot (the positive lot that provides funds).
    Version accessed via settling_lot.unit.version.
    
    Example:
        Day 1: BUY 3 BTC with 100€ → Creates negative lot (NEG1) for EUR
        Day 2: SELL AAPL → 50€ → Creates positive lot (POS1), settles 50€ of NEG1
        Day 3: SELL ETH → 30€ → Creates positive lot (POS2), settles 30€ of NEG1
    """

    __tablename__ = "lot_settlements"

    settlement_id: Optional[int] = Field(default=None, primary_key=True)
    
    # The negative lot (debt) being settled
    negative_lot_id: Optional[int] = Field(
        default=None, foreign_key="cost_lots.cost_lot_id", index=True
    )
    
    # The positive lot providing funds (owner of this settlement)
    settling_lot_id: Optional[int] = Field(
        default=None, foreign_key="cost_lots.cost_lot_id", index=True
    )
    
    # Transaction that triggered the settlement (the inflow)
    settling_transaction_id: Optional[int] = Field(
        default=None, foreign_key="normalized_transactions.id", index=True
    )
    
    # Settlement amount
    qty_settled: Decimal = Field(sa_column=Column(Numeric(36, 18), nullable=False))
    
    # For non-base currency: cost basis applied
    cost_basis_applied: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(36, 18))
    )
    
    settled_at: datetime = Field(default_factory=utc_now, index=True)
    created_at: datetime = Field(default_factory=utc_now)
    
    # Relationships
    # settling_lot is the owner - back_populates to CostLot.outgoing_settlements
    settling_lot: Optional["CostLot"] = Relationship(
        back_populates="outgoing_settlements",
        sa_relationship_kwargs={"foreign_keys": "[LotSettlement.settling_lot_id]"},
    )
    negative_lot: Optional["CostLot"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[LotSettlement.negative_lot_id]"},
    )
    settling_transaction: Optional["NormalizedTransaction"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[LotSettlement.settling_transaction_id]"},
    )
    
    # Convenience property to access version via settling_lot
    @property
    def version(self) -> Optional["CalculationVersion"]:
        """Access version through the owning settling_lot's unit."""
        if self.settling_lot and self.settling_lot.unit:
            return self.settling_lot.unit.version
        return None


class PnlWarning(SQLModel, table=True):
    """
    Warning record from P&L calculation.
    
    Ownership: Owned by CalculationUnit via unit_id (cascade delete).
    Version accessed via unit.version.
    """

    __tablename__ = "pnl_warnings"

    id: Optional[int] = Field(default=None, primary_key=True)
    # version_id removed - version accessed via unit.version
    warning_type: str = Field(index=True)  # insufficient_lots, negative_balance, missing_price, etc.
    message: str = Field(sa_column=Column(Text))
    transaction_id: Optional[int] = Field(
        default=None, foreign_key="normalized_transactions.id", index=True
    )
    # unit_id is now the owner FK
    unit_id: Optional[int] = Field(
        default=None, foreign_key="calculation_units.id", index=True
    )
    asset_id: Optional[int] = Field(default=None, foreign_key="assets.asset_id")
    details: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utc_now)

    # Relationships - unit is the owner
    unit: Optional["CalculationUnit"] = Relationship(
        back_populates="warnings",
        sa_relationship_kwargs={"foreign_keys": "[PnlWarning.unit_id]"}
    )
    
    # Convenience property to access version via unit
    @property
    def version(self) -> Optional["CalculationVersion"]:
        """Access version through the owning unit."""
        return self.unit.version if self.unit else None


class CostLotEvent(SQLModel, table=True):
    """
    Event-sourced audit trail for cost lot lifecycle.
    
    Tracks every state change to cost lots for complete traceability:
    - Creation from acquisitions
    - Consumption from disposals
    - Settlements of negative lots
    - Transfers between accounts
    - Manual adjustments
    
    This provides a chronological history that can reconstruct lot state
    at any point in time, supporting tax audit requirements.
    
    Ownership: Part of version via lot → unit → version chain.
    """

    __tablename__ = "cost_lot_events"

    event_id: Optional[int] = Field(default=None, primary_key=True)
    
    # Event type (LotEventType value)
    event_type: str = Field(index=True)
    
    # Primary lot affected
    lot_id: Optional[int] = Field(
        default=None, foreign_key="cost_lots.cost_lot_id", index=True
    )
    
    # Related lot (for settlements/transfers)
    related_lot_id: Optional[int] = Field(
        default=None, foreign_key="cost_lots.cost_lot_id", index=True
    )
    
    # Quantity change (positive = increase, negative = decrease)
    quantity_delta: Decimal = Field(
        sa_column=Column(Numeric(36, 18), nullable=False)
    )
    
    # Cost basis change (for adjustments and settlements)
    cost_basis_delta: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(36, 18))
    )
    
    # New balances after event (snapshot for quick queries)
    qty_remaining_after: Decimal = Field(
        sa_column=Column(Numeric(36, 18), nullable=False)
    )
    cost_basis_remaining_after: Optional[Decimal] = Field(
        default=None, sa_column=Column(Numeric(36, 18))
    )
    
    # Triggering context
    triggered_by_transaction_id: Optional[int] = Field(
        default=None, foreign_key="normalized_transactions.id", index=True
    )
    triggered_by_unit_id: Optional[int] = Field(
        default=None, foreign_key="calculation_units.id", index=True
    )
    
    # Timestamp and sequencing
    timestamp: datetime = Field(default_factory=utc_now, index=True)
    sequence_num: int = Field(default=0)  # For ordering events at same timestamp
    
    # Extensible metadata (e.g., adjustment reason, transfer source/dest accounts)
    event_metadata: Optional[dict] = Field(default=None, sa_column=Column(JSON))
    
    created_at: datetime = Field(default_factory=utc_now)
    
    # Relationships
    lot: Optional["CostLot"] = Relationship(
        back_populates="events",
        sa_relationship_kwargs={"foreign_keys": "[CostLotEvent.lot_id]"}
    )
    related_lot: Optional["CostLot"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLotEvent.related_lot_id]"}
    )
    triggered_by_transaction: Optional["NormalizedTransaction"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLotEvent.triggered_by_transaction_id]"}
    )
    triggered_by_unit: Optional["CalculationUnit"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[CostLotEvent.triggered_by_unit_id]"}
    )
    
    # Convenience properties
    @property
    def version(self) -> Optional["CalculationVersion"]:
        """Access version through the lot's unit."""
        if self.lot and self.lot.unit:
            return self.lot.unit.version
        return None
    
    @property
    def asset(self) -> Optional["Asset"]:
        """Access asset through the lot."""
        return self.lot.asset if self.lot else None
