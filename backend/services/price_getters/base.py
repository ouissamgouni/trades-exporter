"""
Abstract Base Class for Price Getters.

Provides a consistent interface and shared functionality for all price getter implementations.
New price getters should inherit from BasePriceGetter and implement the required methods.
"""

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional, Callable, TypeVar, Dict, Any, List

from backend.config.loader import load_settings, configure_logging
from backend.db.models import Asset

log = configure_logging("price_getter_base")

T = TypeVar("T")


# ============================================================================
# Error Handling
# ============================================================================


class PriceErrorReason(str, Enum):
    """Detailed reasons for price fetch failures."""
    
    # Configuration errors
    TICKER_NOT_FOUND = "ticker_not_found"
    INVALID_CONFIG = "invalid_config"
    MISSING_API_KEY = "missing_api_key"
    UNSUPPORTED_QUOTE_CURRENCY = "unsupported_quote_currency"
    
    # API errors
    API_ERROR = "api_error"
    API_RATE_LIMITED = "api_rate_limited"
    API_UNAVAILABLE = "api_unavailable"
    
    # Data errors
    NO_DATA_RETURNED = "no_data_returned"
    NO_DATA_FOR_DATE = "no_data_for_date"
    INVALID_DATA_FORMAT = "invalid_data_format"
    DATE_OUT_OF_RANGE = "date_out_of_range"
    
    # Network errors
    NETWORK_ERROR = "network_error"
    TIMEOUT = "timeout"
    
    # General
    UNKNOWN = "unknown"


class PriceGetterError(Exception):
    """
    Detailed exception for price getter failures.
    
    Contains structured information about what went wrong to help
    users understand and fix the issue.
    """
    
    def __init__(
        self,
        message: str,
        getter_name: str,
        reason: PriceErrorReason = PriceErrorReason.UNKNOWN,
        asset_symbol: Optional[str] = None,
        ticker_used: Optional[str] = None,
        details: Optional[str] = None,
        original_error: Optional[Exception] = None,
    ):
        self.getter_name = getter_name
        self.reason = reason
        self.asset_symbol = asset_symbol
        self.ticker_used = ticker_used
        self.details = details
        self.original_error = original_error
        
        # Build user-friendly message
        full_message = self._build_message(message)
        super().__init__(full_message)
    
    def _build_message(self, message: str) -> str:
        """Build a detailed, user-friendly error message."""
        parts = [f"[{self.getter_name}] {message}"]
        
        if self.asset_symbol:
            parts.append(f"Asset: {self.asset_symbol}")
        
        if self.ticker_used and self.ticker_used != self.asset_symbol:
            parts.append(f"Ticker used: {self.ticker_used}")
        
        if self.details:
            parts.append(f"Details: {self.details}")
        
        # Add actionable hints based on reason
        hint = self._get_hint()
        if hint:
            parts.append(f"Hint: {hint}")
        
        return " | ".join(parts)
    
    @property
    def user_message(self) -> str:
        """Get a concise user-friendly message."""
        hint = self._get_hint()
        base = f"{self.reason.value}"
        if self.ticker_used:
            base = f"{self.reason.value} (ticker: {self.ticker_used})"
        if hint:
            return f"{base} - {hint}"
        return base
    
    def _get_hint(self) -> Optional[str]:
        """Get actionable hint based on error reason."""
        hints = {
            PriceErrorReason.TICKER_NOT_FOUND: 
                "Check if the ticker symbol is correct for this price getter, "
                "or configure a custom ticker in Assets > Price Getters",
            PriceErrorReason.MISSING_API_KEY:
                "This price getter requires an API key. Configure it in settings.yaml",
            PriceErrorReason.API_RATE_LIMITED:
                "Too many requests. Wait a moment and try again, or switch to a different price getter",
            PriceErrorReason.NO_DATA_RETURNED:
                "The price getter returned no data. The asset may not be supported, "
                "or try a different price getter",
            PriceErrorReason.NO_DATA_FOR_DATE:
                "No price data available for this specific date. The asset may not have been "
                "listed yet, or historical data is limited",
            PriceErrorReason.DATE_OUT_OF_RANGE:
                "Historical data not available for this date. Try a more recent date",
            PriceErrorReason.UNSUPPORTED_QUOTE_CURRENCY:
                "This price getter doesn't support the requested quote currency. "
                "Try configuring a different native_quote_currency in the price getter settings",
            PriceErrorReason.INVALID_CONFIG:
                "Check the price getter configuration in Assets > Price Getters",
            PriceErrorReason.NETWORK_ERROR:
                "Network connection failed. Check your internet connection",
            PriceErrorReason.TIMEOUT:
                "Request timed out. The API may be slow or unavailable. Try again later",
        }
        return hints.get(self.reason)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for API responses."""
        return {
            "getter_name": self.getter_name,
            "reason": self.reason.value,
            "asset_symbol": self.asset_symbol,
            "ticker_used": self.ticker_used,
            "details": self.details,
            "message": str(self),
        }


class PriceGetterAggregateError(Exception):
    """
    Exception when all price getters fail for an asset.
    
    Contains details from each failed attempt to help diagnose the issue.
    """
    
    def __init__(
        self,
        asset_symbol: str,
        errors: List[PriceGetterError],
    ):
        self.asset_symbol = asset_symbol
        self.errors = errors
        
        message = self._build_message()
        super().__init__(message)
    
    def _build_message(self) -> str:
        """Build summary message from all errors."""
        lines = [f"All price getters failed for {self.asset_symbol}:"]
        
        for i, err in enumerate(self.errors, 1):
            lines.append(f"  {i}. [{err.getter_name}] {err.reason.value}: {err.details or str(err.original_error or 'Unknown')}")
        
        # Find most actionable hint
        for err in self.errors:
            hint = err._get_hint()
            if hint:
                lines.append(f"Suggestion: {hint}")
                break
        
        return "\n".join(lines)

    @property
    def detailed_report(self) -> str:
        """Get a detailed multi-line report of all failures."""
        lines = [
            f"═══ Price Fetch Failed for {self.asset_symbol} ═══",
            f"Attempted {len(self.errors)} price getter(s):",
            "",
        ]
        
        for i, err in enumerate(self.errors, 1):
            lines.append(f"────────────────────────────────────────")
            lines.append(f"Getter {i}: {err.getter_name}")
            lines.append(f"  Reason: {err.reason.value}")
            if err.ticker_used:
                lines.append(f"  Ticker: {err.ticker_used}")
            if err.details:
                lines.append(f"  Details: {err.details}")
            if err.original_error:
                lines.append(f"  Error: {err.original_error}")
            hint = err._get_hint()
            if hint:
                lines.append(f"  💡 {hint}")
        
        lines.append("════════════════════════════════════════")
        return "\n".join(lines)
    
    @property
    def user_summary(self) -> str:
        """Get a concise user-friendly summary."""
        getter_names = [e.getter_name for e in self.errors]
        reasons = list(set(e.reason.value for e in self.errors))
        
        msg = f"Unable to fetch price for {self.asset_symbol}. "
        msg += f"Tried: {', '.join(getter_names)}. "
        msg += f"Errors: {', '.join(reasons)}."
        
        # Add first actionable hint
        for err in self.errors:
            hint = err._get_hint()
            if hint:
                msg += f" Suggestion: {hint}"
                break
        
        return msg


@dataclass
class PriceGetterConfig:
    """
    Configuration for a price getter call.

    Contains parameters that override default behavior for a specific asset.
    
    Fields:
    - external_id: The identifier used by the external price API
      (e.g., "BTC-USD" for Yahoo, "bitcoin" for CoinGecko). This is the
      primary override for ticker resolution. Stored in the external_id
      column of asset_price_getters table.
    - extra: Additional getter-specific parameters from the params JSON column
      (e.g., native_quote_currency, source, to_currency).
    """

    external_id: Optional[str] = None  # The identifier for this asset in the price getter's API
    extra: Dict[str, Any] = field(default_factory=dict)  # Additional getter-specific params

    @classmethod
    def from_db(cls, external_id: Optional[str], params: Optional[Dict[str, Any]]) -> "PriceGetterConfig":
        """
        Create PriceGetterConfig from database fields.

        Args:
            external_id: The external_id column value (API identifier).
            params: The params JSON column value (extra parameters).

        Returns:
            PriceGetterConfig instance.
        """
        return cls(
            external_id=external_id,
            extra=params or {},
        )


@dataclass
class PriceResult:
    """Result from a price fetch operation."""

    price: float
    quote_currency: str  # The currency this price is denominated in
    source: str = ""
    timestamp: Optional[datetime] = None
    ticker_used: Optional[str] = None
    # Staleness/fallback fields
    is_fallback: bool = False  # True if this price came from fallback lookup
    is_stale: bool = False  # True if fallback price is outside staleness window
    actual_price_date: Optional[datetime] = None  # The actual date of the price used
    staleness_days: Optional[int] = None  # Days between requested and actual price date
    fallback_error: Optional[str] = None  # Original error that triggered fallback


class BasePriceGetter(ABC):
    """
    Abstract base class for price getter implementations.

    To create a new price getter:
    1. Create a new file in price_getters/ (e.g., binance.py)
    2. Create a class that inherits from BasePriceGetter
    3. Set the class attribute `name` to a unique identifier
    4. Implement `get_current_price` and `get_historical_price`
    5. Optionally override `get_ticker_symbol` for custom ticker logic
    6. Register in __init__.py's PRICE_GETTER_REGISTRY

    Example:
        class BinancePriceGetter(BasePriceGetter):
            name = "binance"

            def get_current_price(self, asset: Asset, price_quote: Optional[str] = None) -> float:
                ...

            def get_historical_price(self, asset: Asset, dt: datetime, price_quote: Optional[str] = None) -> float:
                ...
    """

    # Unique identifier for this price getter (override in subclass)
    name: str = "base"

    # Default retry configuration (can be overridden)
    max_retries: int = 3
    initial_delay: float = 1.0
    backoff_multiplier: float = 2.0

    def __init__(self):
        """Initialize base price getter with common settings."""
        settings = load_settings()
        self.default_base_currency = settings.get("base_currency", "USD").upper()

    def get_ticker_symbol(self, asset: Asset) -> str:
        """
        Get the ticker symbol for an asset.

        Default implementation uses asset symbol.
        Override in subclass for custom ticker resolution logic.

        Args:
            asset: Asset object.

        Returns:
            str: Ticker symbol for this price getter's API.

        Raises:
            ValueError: If no ticker symbol can be determined.
        """
        ticker = asset.symbol

        if not ticker:
            raise ValueError(
                "No ticker symbol available for asset. "
                "Set ticker in config or ensure asset has a symbol."
            )

        return ticker

    def resolve_ticker(
        self, asset: Asset, config: Optional[PriceGetterConfig] = None
    ) -> str:
        """
        Resolve the ticker symbol for an asset using config overrides.

        Priority order:
        1. config.external_id (explicit override from AssetPriceGetter.external_id)
        2. get_ticker_symbol(asset) (subclass implementation using asset.symbol)

        Args:
            asset: Asset object.
            config: Optional price getter configuration with overrides.

        Returns:
            str: Resolved ticker symbol.
        """
        if config and config.external_id:
            return config.external_id

        return self.get_ticker_symbol(asset)

    @abstractmethod
    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch current asset price.

        Args:
            asset: Asset object.
            config: Optional price getter configuration with ticker overrides.

        Returns:
            PriceResult: Price and the currency it's denominated in.
                        The caller (PriceService) handles conversion if needed.

        Raises:
            RuntimeError: If unable to fetch price after retries.
            ValueError: If asset not supported by this price getter.
        """

    @abstractmethod
    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch historical asset price at a specific datetime.

        Args:
            asset: Asset object.
            dt: Datetime for price lookup.
            config: Optional price getter configuration with ticker overrides.

        Returns:
            PriceResult: Price and the currency it's denominated in.
                        The caller (PriceService) handles conversion if needed.

        Raises:
            RuntimeError: If unable to fetch price after retries.
            ValueError: If asset not supported or date out of range.
        """

    def _fetch_with_retry(
        self,
        operation_desc: str,
        fetch_func: Callable[[], Optional[T]],
        asset: Optional[Asset] = None,
        ticker: Optional[str] = None,
        max_attempts: Optional[int] = None,
        initial_delay: Optional[float] = None,
    ) -> T:
        """
        Execute a fetch operation with retry logic and exponential backoff.

        Args:
            operation_desc: Description of operation for logging.
            fetch_func: Function to execute that returns the result or None.
            asset: Asset being fetched (for error context).
            ticker: Ticker symbol used (for error context).
            max_attempts: Override default max retry attempts.
            initial_delay: Override default initial delay between retries.

        Returns:
            The result from fetch_func.

        Raises:
            PriceGetterError: If unable to fetch after all retries.
        """
        attempts = max_attempts or self.max_retries
        delay = initial_delay or self.initial_delay

        last_error: Optional[Exception] = None
        error_reason = PriceErrorReason.UNKNOWN

        log.info(f"[{self.name}] Starting: {operation_desc}")

        for attempt in range(1, attempts + 1):
            try:
                log.debug(
                    f"[{self.name}] Attempt {attempt}/{attempts}: {operation_desc}"
                )

                result = fetch_func()

                if result is not None:
                    log.info(
                        f"[{self.name}] ✓ Success on attempt {attempt}: {operation_desc}"
                    )
                    return result

                # No data returned
                log.warning(
                    f"[{self.name}] Attempt {attempt}: No data returned for {operation_desc}"
                )
                error_reason = PriceErrorReason.NO_DATA_RETURNED
                last_error = ValueError("No data returned from API")

            except Exception as e:
                last_error = e
                error_reason = self._classify_error(e)
                
                log.warning(
                    f"[{self.name}] Attempt {attempt} failed ({error_reason.value}): {e}"
                )

            if attempt < attempts:
                log.debug(f"[{self.name}] Retrying in {delay:.1f}s...")
                time.sleep(delay)
                delay *= self.backoff_multiplier

        # All attempts failed - create detailed error
        asset_symbol = asset.symbol if asset else None
        
        log.error(
            f"[{self.name}] ✗ Failed after {attempts} attempts: {operation_desc} | "
            f"Reason: {error_reason.value} | Error: {last_error}"
        )
        
        raise PriceGetterError(
            message=f"Failed to {operation_desc.lower()} after {attempts} attempts",
            getter_name=self.name,
            reason=error_reason,
            asset_symbol=asset_symbol,
            ticker_used=ticker,
            details=str(last_error) if last_error else None,
            original_error=last_error,
        )

    def _classify_error(self, error: Exception) -> PriceErrorReason:
        """
        Classify an exception into a PriceErrorReason.
        
        Override in subclasses for API-specific error classification.
        """
        error_str = str(error).lower()
        
        # Common error patterns
        if "rate limit" in error_str or "429" in error_str:
            return PriceErrorReason.API_RATE_LIMITED
        elif "not found" in error_str or "404" in error_str:
            return PriceErrorReason.TICKER_NOT_FOUND
        elif "timeout" in error_str:
            return PriceErrorReason.TIMEOUT
        elif "connection" in error_str or "network" in error_str:
            return PriceErrorReason.NETWORK_ERROR
        elif "api" in error_str or "unauthorized" in error_str or "401" in error_str:
            return PriceErrorReason.API_ERROR
        elif "key" in error_str:
            return PriceErrorReason.MISSING_API_KEY
        
        return PriceErrorReason.UNKNOWN

    def _resolve_quote(self, price_quote: Optional[str]) -> str:
        """
        Resolve the quote currency to use.

        Args:
            price_quote: Optional quote currency override.

        Returns:
            str: Quote currency in uppercase.
        """
        return (price_quote or self.default_base_currency).upper()

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} name='{self.name}'>"
