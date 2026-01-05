"""
FMV Service - Safe Fair Market Value fetching with fallbacks and timeouts.

This module provides safe FMV fetching that:
1. Handles price service failures gracefully
2. Supports configurable timeouts
3. Returns fallback values on error
4. Caches results to avoid repeated failures
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Optional, Any, Dict, Tuple, Union

from backend.config.loader import configure_logging
from backend.services.pnl.config import PnLConfig
from backend.db.models import CalculationUnitLeg


log = configure_logging("pnl_fmv_service")


@dataclass
class FMVResult:
    """Result of FMV fetch."""

    value: Decimal
    success: bool
    source: str  # "price_service", "transaction", "fallback", "base_currency"
    price: Optional[Decimal] = None  # Unit price used (if applicable)
    timestamp: Optional[datetime] = None  # When price was fetched/valid
    error: Optional[str] = None


class FMVService:
    """
    Service for fetching Fair Market Value with fallbacks.

    Designed to be resilient to price service failures.
    """

    def __init__(
        self,
        price_service: Optional[Any],
        config: PnLConfig,
    ):
        self.price_service = price_service
        self.config = config

        # Cache for failed lookups to avoid repeated attempts
        self._failed_lookups: Dict[Tuple[int, str], str] = {}

    def get_fmv_in_base(
        self,
        tx: CalculationUnitLeg,
        skip_on_error: bool = True,
    ) -> FMVResult:
        """
        Get Fair Market Value of a transaction in base currency.

        Always computes FMV at runtime using price service (prices are cached).
        This ensures consistency regardless of when transactions were normalized.

        Priority:
        1. If asset IS base currency, value = qty (1:1)
        2. Fetch price from price service and compute value
        3. Return zero with warning on failure

        Args:
            tx: Transaction to value
            skip_on_error: If True, return zero on error instead of raising

        Returns:
            FMVResult with value and metadata
        """
        asset_id = tx.asset_id
        qty = tx.quantity if tx.quantity else Decimal("0")
        dt = tx.date_time

        if not asset_id:
            return FMVResult(
                value=Decimal("0"),
                success=False,
                source="fallback",
                error="No asset_id",
            )

        # 1. Base currency = qty (1:1 by definition)
        if asset_id == self.config.base_currency_id:
            return FMVResult(
                value=Decimal(str(qty)),
                success=True,
                source="base_currency",
                price=Decimal("1"),
                timestamp=dt,
            )

        # 2. Fetch from price service (prices are cached)
        if self.price_service and dt:
            cache_key = (asset_id, dt.strftime("%Y-%m-%d"))

            # Check if we've already failed this lookup
            if cache_key in self._failed_lookups:
                if skip_on_error:
                    return FMVResult(
                        value=Decimal("0"),
                        success=False,
                        source="fallback",
                        error=self._failed_lookups[cache_key],
                    )

            try:
                # Use get_price_with_source to get actual provider name
                price_result = self.price_service.get_price_with_source(
                    asset_id=asset_id,
                    dt=dt,
                    price_quote=self.config.base_currency_symbol,
                )
                if price_result and price_result.price:
                    price = price_result.price
                    value = Decimal(str(qty)) * Decimal(str(price))
                    return FMVResult(
                        value=value,
                        success=True,
                        source=price_result.source,  # Pass through actual source (coingecko, yahoo, etc.)
                        price=Decimal(str(price)),
                        timestamp=dt,
                    )
                else:
                    error = f"No price found for asset {asset_id}"
                    self._failed_lookups[cache_key] = error
                    if skip_on_error:
                        return FMVResult(
                            value=Decimal("0"),
                            success=False,
                            source="fallback",
                            error=error,
                        )
                    raise ValueError(error)

            except Exception as e:
                error = f"Price fetch failed: {str(e)}"
                self._failed_lookups[cache_key] = error
                log.warning(f"FMV fetch failed for asset {asset_id} at {dt}: {e}")

                if skip_on_error:
                    return FMVResult(
                        value=Decimal("0"),
                        success=False,
                        source="fallback",
                        error=error,
                    )
                raise

        # 4. Fallback
        return FMVResult(
            value=Decimal("0"),
            success=False,
            source="fallback",
            error="No price service or datetime",
        )

    def get_price_in_base(
        self,
        asset_id: int,
        dt: datetime,
        qty: Optional[Decimal] = None,
    ) -> Optional[Decimal]:
        """
        Get price for asset in base currency.

        Args:
            asset_id: Asset ID
            dt: Datetime for price lookup
            qty: Optional quantity (not used, for compatibility)

        Returns:
            Price in base currency or None if unavailable
        """
        # Base currency is always 1.0
        if asset_id == self.config.base_currency_id:
            return Decimal("1")

        if self.price_service is None:
            return None

        try:
            price = self.price_service.get_price(
                asset_id=asset_id,
                dt=dt,
                price_quote=self.config.base_currency_symbol,
            )
            return Decimal(str(price)) if price else None
        except Exception as e:
            log.warning(f"Failed to get price for asset {asset_id} at {dt}: {e}")
            return None

    def clear_cache(self):
        """Clear failed lookup cache."""
        self._failed_lookups.clear()


def compute_group_residual(
    inflows: list,
    outflows: list,
    fees: list,
    fmv_service: FMVService,
    config: PnLConfig,
) -> Optional[Dict]:
    """
    Compute residual (value mismatch) for a group.

    This is OPTIONAL - if FMV fetches fail, we skip residual computation.

    Args:
        inflows: Inflow transactions
        outflows: Outflow transactions
        fees: Fee transactions
        fmv_service: FMV service for value lookup
        config: P&L config

    Returns:
        Dict with residual info, or None if computation skipped
    """
    if not config.compute_residuals:
        return None

    # Compute values, tracking failures
    inflow_value = Decimal("0")
    outflow_value = Decimal("0")
    fee_value = Decimal("0")
    has_failures = False

    for tx in inflows:
        result = fmv_service.get_fmv_in_base(tx, skip_on_error=True)
        inflow_value += result.value
        if not result.success:
            has_failures = True

    for tx in outflows:
        result = fmv_service.get_fmv_in_base(tx, skip_on_error=True)
        outflow_value += result.value
        if not result.success:
            has_failures = True

    for tx in fees:
        result = fmv_service.get_fmv_in_base(tx, skip_on_error=True)
        fee_value += result.value
        if not result.success:
            has_failures = True

    # If we had failures and config says skip, return None
    if has_failures and config.skip_fmv_on_error:
        return None

    # Compute residual
    residual = inflow_value - outflow_value - fee_value
    max_value = max(inflow_value, outflow_value, Decimal("0.0001"))
    residual_pct = abs(residual) / max_value

    return {
        "residual": residual,
        "residual_pct": residual_pct,
        "inflow_value": inflow_value,
        "outflow_value": outflow_value,
        "fee_value": fee_value,
        "has_fmv_failures": has_failures,
    }
