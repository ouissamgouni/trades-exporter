"""
Pandas DataReader Price Getter.

Uses pandas_datareader to fetch prices from various data sources.
Supports stocks, ETFs, and other securities available via FRED, Stooq, etc.

The asset_id should be the ticker symbol appropriate for the data source:
- Stocks: "AAPL", "MSFT", "GOOGL"
- ETFs: "SPY", "QQQ"

This getter uses Stooq as the default source (free, no API key required).

Quote Currency Handling:
- Prices are returned in the asset's native currency (typically USD for US stocks)
- Configure native_quote_currency in AssetPriceGetter.params if different
"""

from datetime import datetime, timedelta
from typing import Optional, Tuple

import pandas_datareader.data as web

from backend.config.loader import configure_logging
from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

log = configure_logging("datareader_price_getter")


class DataReaderPriceGetter(BasePriceGetter):
    """
    Price getter implementation using pandas_datareader.

    Ticker Resolution:
    - Uses config.asset_id from database (AssetPriceGetter.params.asset_id)
    - Falls back to asset.symbol

    Data Sources:
    - Default: "stooq" (free, no API key)
    - Can be overridden via config.extra["source"]

    Supported sources:
    - stooq: Free stock/ETF data (default)
    - fred: Federal Reserve Economic Data
    - tiingo: Requires API key in config.extra["api_key"]
    - alphavantage: Requires API key

    Configure via UI: Assets > [asset] > Price Getters > Add DataReader > Asset ID.

    Quote Currency Config:
    - Set `native_quote_currency` in config.extra to specify what currency the ticker returns
    - Defaults to "USD" if not specified
    - PriceService handles conversion to requested quote currency
    """

    name = "datareader"

    # Default settings
    DEFAULT_SOURCE = "stooq"
    DEFAULT_NATIVE_QUOTE = "USD"

    def __init__(self):
        """Initialize pandas_datareader price getter."""
        super().__init__()

    def _resolve_ticker_with_quote(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig],
    ) -> Tuple[str, str, str]:
        """
        Resolve ticker symbol, data source, and native quote currency.

        Args:
            asset: Asset object
            config: Price getter config with potential overrides

        Returns:
            Tuple of (ticker_symbol, data_source, native_quote_currency)
        """
        # Determine ticker
        if config and config.asset_id:
            ticker = config.asset_id
        else:
            ticker = asset.symbol.upper()

        # Determine data source
        source = self.DEFAULT_SOURCE
        if config and config.extra:
            source = config.extra.get("source", self.DEFAULT_SOURCE)

        # Determine native quote currency
        native_quote = self.DEFAULT_NATIVE_QUOTE
        if config and config.extra:
            native_quote = config.extra.get(
                "native_quote_currency", self.DEFAULT_NATIVE_QUOTE
            )

        return ticker, source, native_quote.upper()

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch current asset price using pandas_datareader.

        Gets the most recent available price (yesterday or last trading day).

        Args:
            asset: Asset object.
            config: Optional price getter configuration with ticker override.

        Returns:
            PriceResult: Current price in the ticker's native quote currency.
        """
        ticker_symbol, source, native_quote = self._resolve_ticker_with_quote(
            asset, config
        )
        
        log.info(
            f"[datareader] Fetching current price: asset={asset.symbol}, "
            f"ticker={ticker_symbol}, source={source}"
        )

        def fetch() -> Optional[float]:
            # Fetch last 5 days to ensure we get data (markets may be closed)
            end_date = datetime.now()
            start_date = end_date - timedelta(days=5)

            try:
                df = web.DataReader(
                    ticker_symbol, source, start=start_date, end=end_date
                )

                if df.empty:
                    log.warning(
                        f"[datareader] No data returned for {ticker_symbol} from {source}"
                    )
                    return None

                # Get the most recent close price
                if "Close" in df.columns:
                    return float(df["Close"].iloc[-1])
                elif "close" in df.columns:
                    return float(df["close"].iloc[-1])
                else:
                    # Some sources use different column names
                    log.warning(
                        f"[datareader] Unexpected columns for {ticker_symbol}: {df.columns.tolist()}"
                    )
                    return None

            except Exception as e:
                log.warning(f"[datareader] API error for {ticker_symbol}: {e}")
                raise

        price = self._fetch_with_retry(
            f"Fetch current price for {asset.symbol} ({ticker_symbol} via {source})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.debug(
            f"Current price for {asset.symbol}: {price} {native_quote} ({ticker_symbol} via {source})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source=f"datareader:{source}",
            timestamp=datetime.now(),
            ticker_used=ticker_symbol,
        )

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        """
        Fetch historical asset price using pandas_datareader.

        Args:
            asset: Asset object.
            dt: Datetime for price lookup.
            config: Optional price getter configuration with ticker override.

        Returns:
            PriceResult: Price at specified datetime in the ticker's native quote currency.
        """
        ticker_symbol, source, native_quote = self._resolve_ticker_with_quote(
            asset, config
        )
        
        log.info(
            f"[datareader] Fetching historical price: asset={asset.symbol}, "
            f"date={dt.date()}, ticker={ticker_symbol}, source={source}"
        )

        def fetch() -> Optional[float]:
            # Fetch a range around target date
            start_date = dt - timedelta(days=7)
            end_date = dt + timedelta(days=2)

            try:
                df = web.DataReader(
                    ticker_symbol, source, start=start_date, end=end_date
                )

                if df.empty:
                    log.warning(
                        f"[datareader] No data for {ticker_symbol} around {dt.date()}"
                    )
                    return None

                # Determine the close column name
                close_col = None
                if "Close" in df.columns:
                    close_col = "Close"
                elif "close" in df.columns:
                    close_col = "close"
                else:
                    log.warning(
                        f"[datareader] Unexpected columns for {ticker_symbol}: {df.columns.tolist()}"
                    )
                    return None

                target_date = dt.date()

                # Find exact match or closest previous date
                df_dates = df.index.date

                exact_match = None
                closest_before = None

                for idx, row_date in enumerate(df_dates):
                    if row_date == target_date:
                        exact_match = idx
                        break
                    elif row_date < target_date:
                        closest_before = idx

                if exact_match is not None:
                    return float(df[close_col].iloc[exact_match])
                elif closest_before is not None:
                    return float(df[close_col].iloc[closest_before])
                else:
                    # Use first available if all dates are after target
                    return float(df[close_col].iloc[0])

            except Exception as e:
                log.warning(
                    f"[datareader] API error for {ticker_symbol} at {dt.date()}: {e}"
                )
                raise

        price = self._fetch_with_retry(
            f"Fetch historical price for {asset.symbol} at {dt.date()} ({ticker_symbol} via {source})",
            fetch,
            asset=asset,
            ticker=ticker_symbol,
        )

        log.debug(
            f"Historical price for {asset.symbol} at {dt}: {price} {native_quote} ({ticker_symbol} via {source})"
        )

        return PriceResult(
            price=price,
            quote_currency=native_quote,
            source=f"datareader:{source}",
            timestamp=dt,
            ticker_used=ticker_symbol,
        )
