"""
P&L Configuration - Enums and configuration dataclass.
"""

from dataclasses import dataclass
from decimal import Decimal
from enum import Enum


class CostMethod(str, Enum):
    """Cost basis calculation method."""

    FIFO = "FIFO"  # First In, First Out
    LIFO = "LIFO"  # Last In, First Out
    HIFO = "HIFO"  # Highest In, First Out


class LotMode(str, Enum):
    """Lot tracking mode."""

    LOT_TRAVEL = "LOT_TRAVEL"  # Track lots per account (transfers preserve cost basis)
    MEGA_WALLET = "MEGA_WALLET"  # Aggregate lots across all accounts


class WarningType(str, Enum):
    """Types of warnings generated during P&L calculation."""

    INSUFFICIENT_LOTS = "insufficient_lots"
    NEGATIVE_BALANCE = "negative_balance"
    MISSING_PRICE = "missing_price"
    STALE_PRICE = "stale_price"  # Price used is outside staleness window (fallback)
    RESIDUAL_MISMATCH = "residual_mismatch"
    ZERO_COST_LOT = "zero_cost_lot"
    FEE_CONSUMPTION_FAILED = "fee_consumption_failed"
    UNMATCHED_GROUP = "unmatched_group"
    FMV_FETCH_FAILED = "fmv_fetch_failed"
    UNMATCHED_INTERNAL_TRANSFER = "unmatched_internal_transfer"  # Internal transfer with missing counterpart leg


@dataclass
class PnLConfig:
    """Configuration for P&L calculation."""

    # Core settings
    lot_method: CostMethod = CostMethod.FIFO
    lot_mode: LotMode = LotMode.LOT_TRAVEL
    base_currency_id: int = 1  # Asset ID of base currency (e.g., EUR)
    base_currency_symbol: str = "EUR"

    # Tolerance settings
    residual_tolerance_pct: Decimal = Decimal("0.05")  # 5% tolerance
    allow_negative_balances: bool = False

    # Taxability settings
    crypto_swap_taxable_by_default: bool = False  # Whether crypto-to-crypto swaps are taxable (False in most EU jurisdictions)
    fee_taxable_by_default: bool = (
        False  # Fees reduce proceeds/cost, not taxable by default
    )

    # FMV/Residual settings
    compute_residuals: bool = True  # Whether to compute residual warnings
    fmv_timeout_seconds: float = 5.0  # Timeout for FMV fetches
    skip_fmv_on_error: bool = False  # Skip FMV computation if price fetch fails

    # Price fallback settings
    use_price_fallback: bool = True  # Whether to fallback to latest known price when fetch fails
    price_staleness_window_days: int = 7  # Default staleness window in days
    # Per-asset-type staleness windows (days). If not specified, uses price_staleness_window_days
    price_staleness_by_type: dict = None  # e.g., {"crypto": 1, "stock": 7, "fiat": 30}

    def get_staleness_window_days(self, price_type: str) -> int:
        """Get staleness window for a specific asset/price type."""
        if self.price_staleness_by_type and price_type in self.price_staleness_by_type:
            return self.price_staleness_by_type[price_type]
        return self.price_staleness_window_days

    def __post_init__(self):
        if isinstance(self.lot_method, str):
            self.lot_method = CostMethod(self.lot_method)
        if isinstance(self.lot_mode, str):
            self.lot_mode = LotMode(self.lot_mode)
        if not isinstance(self.residual_tolerance_pct, Decimal):
            self.residual_tolerance_pct = Decimal(str(self.residual_tolerance_pct))
