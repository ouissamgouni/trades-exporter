"""
CoinGecko Price Getter.

Uses CoinGecko API to get current and historical cryptocurrency prices.
Requires asset_id to be configured in database (AssetPriceGetter.params.asset_id).

The asset_id should be the CoinGecko coin ID (e.g., "bitcoin", "ethereum", "solana").
"""

import requests
import time
from datetime import datetime
from typing import Optional, List, Dict

from backend.config.loader import (
    load_settings,
    configure_logging,
)
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

log = configure_logging("coingecko_price_getter")


class CoinGeckoPriceGetter(BasePriceGetter):
    """
    Price getter implementation for CoinGecko API.

    Ticker Resolution:
    - Uses config.asset_id from database (AssetPriceGetter.params.asset_id)
    - Falls back to asset.symbol (lowercase) as the CoinGecko coin ID

    The asset_id must be a valid CoinGecko coin ID (e.g., "bitcoin", "ethereum").
    Configure via UI: Assets > [asset] > Price Getters > Add CoinGecko > Asset ID.

    Features:
    - API key rotation on rate limits
    - Configurable retry logic with exponential backoff
    """

    name = "coingecko"
    max_retries = 5
    initial_delay = 2.0

    def __init__(self):
        """Initialize CoinGecko price getter."""
        super().__init__()
        settings = load_settings()
        self.api_keys: List[str] = settings.get("coingecko_api_keys", [])
        self.api_key_index = 0

    def get_ticker_symbol(self, asset: Asset) -> str:
        """
        Get the CoinGecko coin ID for an asset.

        Default implementation uses lowercase symbol as coin ID.
        For proper CoinGecko resolution, configure asset_id in the database.

        Args:
            asset: Asset object.

        Returns:
            str: CoinGecko coin ID (lowercase).

        Raises:
            ValueError: If no symbol available.
        """
        if not asset.symbol:
            raise ValueError(
                "Asset has no symbol. Configure asset_id in price getter params."
            )
        # CoinGecko uses lowercase IDs
        return asset.symbol.lower()

    def _is_rate_limit_error(self, response: requests.Response) -> bool:
        """Check if error response indicates rate limiting."""
        if response.status_code == 429:
            return True

        if response.status_code >= 400:
            try:
                data = response.json()
                if "status" in data and "error_code" in data["status"]:
                    error_code = data["status"]["error_code"]
                    # CoinGecko rate limit error codes
                    if error_code in [1002, 1003, 1004]:
                        return True
            except Exception:
                pass

        return False

    def _rotate_api_key(self) -> None:
        """Rotate to the next API key."""
        if len(self.api_keys) > 1:
            self.api_key_index = (self.api_key_index + 1) % len(self.api_keys)
            log.info(
                f"Rotating to API key {self.api_key_index + 1}/{len(self.api_keys)}"
            )

    def _get_headers(self) -> Dict[str, str]:
        """Get request headers with current API key."""
        headers = {"accept": "application/json"}

        if self.api_keys:
            headers["x-cg-demo-api-key"] = self.api_keys[self.api_key_index]

        return headers

    def _fetch_from_api(
        self,
        url: str,
        params: dict,
        operation_desc: str,
        asset: Optional[Asset] = None,
        ticker: Optional[str] = None,
    ) -> dict:
        """
        Fetch data from CoinGecko API with retry and key rotation.

        Args:
            url: API endpoint URL.
            params: Query parameters.
            operation_desc: Description for logging.
            asset: Asset being fetched (for error context).
            ticker: Ticker symbol used (for error context).

        Returns:
            dict: Parsed JSON response.

        Raises:
            PriceGetterError: If unable to fetch after retries.
        """
        delay = self.initial_delay
        last_error: Optional[Exception] = None
        error_reason = PriceErrorReason.UNKNOWN

        log.info(f"[coingecko] Starting: {operation_desc}")

        for attempt in range(1, self.max_retries + 1):
            try:
                # Rotate API key on retry
                if attempt > 1 and len(self.api_keys) > 1:
                    self._rotate_api_key()

                log.debug(
                    f"[coingecko] Attempt {attempt}/{self.max_retries}: {operation_desc}"
                )

                response = requests.get(
                    url=url,
                    headers=self._get_headers(),
                    params=params,
                    timeout=15,
                )

                # Handle rate limiting
                if self._is_rate_limit_error(response):
                    error_reason = PriceErrorReason.API_RATE_LIMITED
                    log.warning(
                        f"[coingecko] Rate limit hit (attempt {attempt}), "
                        f"rotating API key..."
                    )
                    if attempt < self.max_retries and len(self.api_keys) > 1:
                        time.sleep(delay)
                        delay *= self.backoff_multiplier
                        continue
                    else:
                        response.raise_for_status()

                response.raise_for_status()
                log.info(f"[coingecko] ✓ Success on attempt {attempt}: {operation_desc}")
                return response.json()

            except Exception as e:
                last_error = e
                error_reason = self._classify_coingecko_error(e, response if 'response' in locals() else None)
                
                log.warning(
                    f"[coingecko] Attempt {attempt} failed ({error_reason.value}): {e}"
                )

                if attempt < self.max_retries:
                    log.debug(f"[coingecko] Retrying in {delay:.1f}s...")
                    time.sleep(delay)
                    delay *= self.backoff_multiplier

        # All attempts failed
        asset_symbol = asset.symbol if asset else None
        
        log.error(
            f"[coingecko] ✗ Failed after {self.max_retries} attempts: {operation_desc} | "
            f"Reason: {error_reason.value} | Error: {last_error}"
        )
        
        raise PriceGetterError(
            message=f"Failed to {operation_desc.lower()} after {self.max_retries} attempts",
            getter_name=self.name,
            reason=error_reason,
            asset_symbol=asset_symbol,
            ticker_used=ticker,
            details=str(last_error) if last_error else None,
            original_error=last_error,
        )

    def _classify_coingecko_error(
        self, error: Exception, response: Optional[requests.Response] = None
    ) -> PriceErrorReason:
        """Classify CoinGecko-specific errors."""
        error_str = str(error).lower()
        
        if response is not None:
            if response.status_code == 429:
                return PriceErrorReason.API_RATE_LIMITED
            elif response.status_code == 404:
                return PriceErrorReason.TICKER_NOT_FOUND
            elif response.status_code == 401:
                return PriceErrorReason.MISSING_API_KEY
        
        if "rate limit" in error_str or "429" in error_str:
            return PriceErrorReason.API_RATE_LIMITED
        elif "not found" in error_str or "404" in error_str:
            return PriceErrorReason.TICKER_NOT_FOUND
        elif "timeout" in error_str:
            return PriceErrorReason.TIMEOUT
        elif "connection" in error_str:
            return PriceErrorReason.NETWORK_ERROR
            
        return PriceErrorReason.API_ERROR

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch current asset price from CoinGecko.

        CoinGecko returns prices in the configured native_quote_currency.
        Defaults to USD if not specified.

        Args:
            asset: Asset object with CoinGecko configuration.
            config: Optional price getter configuration with coin_id override.

        Returns:
            PriceResult: Current price and the currency it's denominated in.
        """
        # Get native quote from config, default to USD
        native_quote = "USD"
        if config and config.extra.get("native_quote_currency"):
            native_quote = config.extra["native_quote_currency"].upper()

        quote = native_quote.lower()
        coin_id = self.resolve_ticker(asset, config)

        log.info(
            f"[coingecko] Fetching current price: asset={asset.symbol}, "
            f"coin_id={coin_id}, quote={native_quote}"
        )

        url = "https://api.coingecko.com/api/v3/simple/price"
        params = {
            "ids": coin_id,
            "vs_currencies": quote,
            "include_market_cap": "false",
            "include_24hr_vol": "false",
            "include_24hr_change": "false",
        }

        data = self._fetch_from_api(
            url,
            params,
            f"Fetch current price for {asset.symbol}",
            asset=asset,
            ticker=coin_id,
        )

        if not data or coin_id not in data:
            raise PriceGetterError(
                message=f"CoinGecko returned no data for coin_id='{coin_id}'",
                getter_name=self.name,
                reason=PriceErrorReason.TICKER_NOT_FOUND,
                asset_symbol=asset.symbol,
                ticker_used=coin_id,
                details=f"Response: {data}",
            )

        price = data[coin_id].get(quote)
        if price is None:
            raise PriceGetterError(
                message=f"No price in {native_quote} available for {asset.symbol}",
                getter_name=self.name,
                reason=PriceErrorReason.UNSUPPORTED_QUOTE_CURRENCY,
                asset_symbol=asset.symbol,
                ticker_used=coin_id,
                details=f"Requested quote: {native_quote}, available: {list(data[coin_id].keys())}",
            )

        log.info(f"[coingecko] ✓ Current price for {asset.symbol}: {price} {native_quote}")

        return PriceResult(
            price=float(price),
            quote_currency=native_quote,
            source="coingecko",
            timestamp=datetime.utcnow(),
            ticker_used=coin_id,
        )

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch historical asset price from CoinGecko.

        CoinGecko returns prices in the configured native_quote_currency.
        Defaults to USD if not specified.

        Args:
            asset: Asset object with CoinGecko configuration.
            dt: Datetime for price lookup.
            config: Optional price getter configuration with coin_id override.

        Returns:
            PriceResult: Price at specified datetime and the currency it's denominated in.
        """
        # Get native quote from config, default to USD
        native_quote = "USD"
        if config and config.extra.get("native_quote_currency"):
            native_quote = config.extra["native_quote_currency"].upper()

        quote = native_quote.lower()
        coin_id = self.resolve_ticker(asset, config)
        timestamp = int(dt.timestamp())

        log.info(
            f"[coingecko] Fetching historical price: asset={asset.symbol}, "
            f"date={dt.date()}, coin_id={coin_id}, quote={native_quote}"
        )

        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart/range"
        params = {
            "vs_currency": quote,
            "from": timestamp,
            "to": timestamp + 3600,
        }

        data = self._fetch_from_api(
            url,
            params,
            f"Fetch historical price for {asset.symbol} at {dt.date()}",
            asset=asset,
            ticker=coin_id,
        )

        prices = data.get("prices", [])
        if not prices:
            raise PriceGetterError(
                message=f"No historical data for {asset.symbol} at {dt.date()}",
                getter_name=self.name,
                reason=PriceErrorReason.NO_DATA_FOR_DATE,
                asset_symbol=asset.symbol,
                ticker_used=coin_id,
                details=f"Date requested: {dt.date()}, quote: {native_quote}",
            )

        # Find closest price to target timestamp
        price = min(prices, key=lambda x: abs(x[0] / 1000 - timestamp))[1]

        log.info(
            f"[coingecko] ✓ Historical price for {asset.symbol} at {dt.date()}: "
            f"{price} {native_quote}"
        )

        return PriceResult(
            price=float(price),
            quote_currency=native_quote,
            source="coingecko",
            timestamp=dt,
            ticker_used=coin_id,
        )
