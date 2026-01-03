"""
Forex Price Getter.

Specialized price getter for fiat currency pairs using free forex APIs.
Used for currency conversion when the primary getter returns prices in a different currency.
"""

from datetime import datetime, timedelta
from typing import Optional

import requests

from backend.config.loader import configure_logging
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

log = configure_logging("forex_price_getter")


class ForexPriceGetter(BasePriceGetter):
    """
    Price getter for fiat currency forex rates.
    
    Uses free APIs:
    - exchangerate-api.com (primary)
    - Fallback: calculates inverse rate if direct rate not available
    
    This getter should ONLY be used for fiat-to-fiat conversion.
    For crypto/stock prices, use yahoo, coingecko, or datareader.
    """

    name = "forex"

    # Free forex API (no key required for basic usage)
    FOREX_API_URL = "https://api.exchangerate-api.com/v4/latest"

    def __init__(self):
        """Initialize forex price getter."""
        super().__init__()
        self._rate_cache: dict = {}  # Simple in-memory cache

    def _fetch_rate(self, from_currency: str, to_currency: str) -> Optional[float]:
        """
        Fetch exchange rate from API.
        
        Args:
            from_currency: Source currency (e.g., "USD")
            to_currency: Target currency (e.g., "EUR")
            
        Returns:
            Exchange rate or None if not found
        """
        from_upper = from_currency.upper()
        to_upper = to_currency.upper()
        
        # Check cache first (5 minute TTL)
        cache_key = f"{from_upper}_{to_upper}"
        if cache_key in self._rate_cache:
            rate, cached_at = self._rate_cache[cache_key]
            if datetime.now() - cached_at < timedelta(minutes=5):
                log.debug(f"[forex] Using cached rate for {cache_key}: {rate}")
                return rate
        
        try:
            # Try direct rate: from_currency -> to_currency
            log.debug(f"[forex] Fetching rate from API: {from_upper} -> {to_upper}")
            response = requests.get(
                f"{self.FOREX_API_URL}/{from_upper}",
                timeout=10
            )
            if response.ok:
                data = response.json()
                rates = data.get("rates", {})
                if to_upper in rates:
                    rate = rates[to_upper]
                    self._rate_cache[cache_key] = (rate, datetime.now())
                    log.debug(f"[forex] Got direct rate: {rate}")
                    return rate
            
            # Try inverse rate: to_currency -> from_currency, then invert
            log.debug(f"[forex] Trying inverse rate: {to_upper} -> {from_upper}")
            response = requests.get(
                f"{self.FOREX_API_URL}/{to_upper}",
                timeout=10
            )
            if response.ok:
                data = response.json()
                rates = data.get("rates", {})
                if from_upper in rates:
                    inverse_rate = rates[from_upper]
                    if inverse_rate > 0:
                        rate = 1.0 / inverse_rate
                        self._rate_cache[cache_key] = (rate, datetime.now())
                        log.debug(f"[forex] Got inverse rate: {rate}")
                        return rate
                        
        except Exception as e:
            log.warning(f"[forex] API error for {from_upper}/{to_upper}: {e}")
            
        return None

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Get current forex rate.
        
        The asset should be a fiat currency (USD, EUR, etc.).
        The config.extra["to_currency"] specifies the target currency.
        
        Args:
            asset: Fiat asset (source currency)
            config: Config with to_currency in extra
            
        Returns:
            PriceResult with exchange rate
        """
        from_currency = asset.symbol.upper()
        
        # Get target currency from config or use USD as default
        to_currency = "USD"
        if config and config.extra:
            to_currency = config.extra.get("to_currency", "USD").upper()
        
        ticker = f"{from_currency}/{to_currency}"
        log.info(f"[forex] Fetching current rate: {ticker}")
        
        def fetch() -> Optional[float]:
            return self._fetch_rate(from_currency, to_currency)
        
        rate = self._fetch_with_retry(
            f"Fetch forex rate {ticker}",
            fetch,
            asset=asset,
            ticker=ticker,
        )
        
        log.info(f"[forex] ✓ Rate: 1 {from_currency} = {rate} {to_currency}")
        
        return PriceResult(
            price=rate,
            quote_currency=to_currency,
            source="forex",
            timestamp=datetime.now(),
            ticker_used=ticker,
        )

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Get historical forex rate.
        
        Note: Free API doesn't support historical rates.
        Falls back to current rate with a warning.
        
        Args:
            asset: Fiat asset (source currency)
            dt: Target datetime (ignored, uses current rate)
            config: Config with to_currency in extra
            
        Returns:
            PriceResult with current exchange rate
        """
        log.warning(
            f"Historical forex rates not available via free API. "
            f"Using current rate for {asset.symbol} at {dt}"
        )
        return self.get_current_price(asset, config)
