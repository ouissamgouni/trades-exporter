"""
OKX (OKCoin) Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List


from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials
from backend.db.models import NormalizedTransaction

log = configure_logging("okx")


# ===== OKX Connector Class =====


class OKXConnectorTrx(BaseConnector):
    """OKX exchange connector using CCXT library with OKX-specific pagination pattern."""

    @property
    def connector_name(self) -> str:
        return "okx_trx"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        account_id: int = None,
        connector_id: int = None,
        symbols: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize OKX connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store symbols filter - from parameter or config (for override support)
        # Note: OKX API fetches all trades globally, so this filters results post-fetch
        self._symbols_filter = symbols or (config.get("symbols") if config else None)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None or api_passphrase is None:
            creds = load_credentials("okx")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")
            api_passphrase = creds.get("api_passphrase")

        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

        # Validate configuration
        if not self.api_key or not self.api_secret or not self.api_passphrase:
            raise ValueError("Missing API credentials for OKX")

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.myokx(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "password": self.api_passphrase,
                    "enableRateLimit": True,
                }
            )
            self.exchange.load_markets()
            log.info("✅ OKX exchange initialized successfully")
        except Exception as e:
            log.error(f"❌ Failed to initialize OKX exchange: {e}")
            raise

    def get_all_trades(self) -> List[Dict[str, Any]]:
        """
        Fetch all private trades from OKX across all symbols using CCXT.
        Handles pagination with 'after' parameter to get complete trade history.
        If since_datetime is set, filters out trades before that datetime.

        Returns:
            list: List of all trade objects from CCXT
        """
        try:
            all_trades = {}
            after = None
            since_ms = self.since_timestamp_ms

            while True:
                # Check for abort at start of each pagination iteration
                if self.is_abort_requested():
                    log.info("⚠️ Abort requested, stopping OKX trade fetching")
                    break
                    
                log.info("Fetching trades batch...")
                params = {}
                if after:
                    params["after"] = after

                # Fetch trades for all symbols (symbol=None means all)
                trades = self.exchange.fetch_my_trades(None, limit=100, params=params)

                # Handle None or empty result
                if not trades:
                    log.info("No more trades to fetch. Done.")
                    break

                first_trade = trades[0]
                last_trade = trades[-1]
                after = first_trade.get("info", {}).get("billId")
                log.info(
                    f"✅ Fetched {len(trades)} trades from {first_trade.get('datetime', 'unknown')} to {last_trade.get('datetime', 'unknown')}"
                )

                # Track new trades, filtering by since_datetime if set
                fetched_new_trades = False
                for trade in trades:
                    trade_id = trade.get("id")
                    trade_timestamp = trade.get("timestamp")
                    
                    # Skip trades before since_datetime if incremental sync
                    if since_ms and trade_timestamp and trade_timestamp < since_ms:
                        continue
                    
                    if trade_id and trade_id not in all_trades:
                        fetched_new_trades = True
                        all_trades[trade_id] = trade

                # If all trades in batch are before since_datetime, we can stop
                if since_ms and last_trade.get("timestamp", 0) < since_ms:
                    log.info(f"Reached trades before since datetime, stopping pagination")
                    break

                if not fetched_new_trades:
                    log.info("No new trades found. Done.")
                    break

            # Sort by timestamp
            sorted_trades = list(all_trades.values())
            if sorted_trades:
                sorted_trades = self.exchange.sort_by(sorted_trades, "timestamp")
                if sorted_trades is None:
                    sorted_trades = list(
                        all_trades.values()
                    )  # Fallback if sort_by returns None

            # Apply symbols filter if configured (post-fetch filtering since OKX doesn't support per-symbol API)
            if self._symbols_filter and sorted_trades:
                original_count = len(sorted_trades)
                sorted_trades = [trade for trade in sorted_trades if trade.get("symbol") in self._symbols_filter]
                if original_count != len(sorted_trades):
                    log.info(f"📊 Filtered trades from {original_count} to {len(sorted_trades)} based on symbols filter")

            log.info(f"✅ Total trades fetched: {len(sorted_trades)}")
            return sorted_trades

        except Exception as e:
            error_str = str(e).lower()
            
            # Legitimate empty result
            if "no data" in error_str or "empty" in error_str or "no trades" in error_str:
                log.debug("ℹ️ No trades found (legitimate empty result)")
                return []
            
            # Authentication errors
            if "401" in error_str or "unauthorized" in error_str:
                log.error(f"❌ Authentication failed for OKX trades: {e}")
                raise ConnectorAPIError(
                    message="Authentication failed - check API credentials",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
                    reason=ErrorReason.AUTHENTICATION_FAILED,
                    http_status_code=401,
                    retryable=False,
                    original_error=e,
                )
            
            if "403" in error_str or "forbidden" in error_str:
                log.error(f"❌ Permission denied for OKX trades: {e}")
                raise ConnectorAPIError(
                    message="Permission denied - insufficient API key permissions",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
                    reason=ErrorReason.PERMISSION_DENIED,
                    http_status_code=403,
                    retryable=False,
                    original_error=e,
                )
            
            # Rate limiting
            if "429" in error_str or "rate limit" in error_str:
                log.error(f"❌ Rate limited on OKX trades: {e}")
                raise ConnectorAPIError(
                    message="Rate limited by OKX API",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
                    reason=ErrorReason.RATE_LIMITED,
                    http_status_code=429,
                    retryable=True,
                    original_error=e,
                )
            
            # Network/timeout errors
            if "timeout" in error_str or "timed out" in error_str:
                log.error(f"❌ Timeout fetching OKX trades: {e}")
                raise ConnectorAPIError(
                    message="Request timeout",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
                    reason=ErrorReason.TIMEOUT,
                    retryable=True,
                    original_error=e,
                )
            
            if "connection" in error_str or "network" in error_str:
                log.error(f"❌ Network error fetching OKX trades: {e}")
                raise ConnectorAPIError(
                    message="Network connection error",
                    connector_name=self.connector_name,
                    operation="fetch_trades",
                    reason=ErrorReason.NETWORK_ERROR,
                    retryable=True,
                    original_error=e,
                )
            
            # Generic API error
            log.error(f"❌ API error fetching OKX trades: {e}")
            raise ConnectorAPIError(
                message="API request failed",
                connector_name=self.connector_name,
                operation="fetch_trades",
                reason=ErrorReason.API_ERROR,
                retryable=False,
                original_error=e,
                details=str(e),
            )

    def raw_to_normalized(self, ccxt_trade: dict) -> "NormalizedTransaction":
        """
        Map a CCXT trade response from OKX to NormalizedTransaction dataclass.

        CCXT trade format:
        {
            'id': str,
            'timestamp': int (milliseconds),
            'datetime': str (ISO 8601),
            'symbol': str (e.g., 'BTC/USDT'),
            'type': str ('limit' or 'market'),
            'side': str ('buy' or 'sell'),
            'price': float,
            'amount': float (quantity),
            'cost': float (total in quote currency),
            'fee': {'currency': str, 'cost': float, 'rate': float},
            'info': dict (raw exchange response)
        }
        """
        from backend.db.models import NormalizedTransaction

        try:
            trade_id = str(ccxt_trade.get("id", ""))
            symbol = str(ccxt_trade.get("symbol", "")).upper()
            base, quote = symbol.split("/")
            if not base or not quote:
                raise ValueError(
                    f"Cannot determine base or quote from symbol '{symbol}'"
                )
            price = float(ccxt_trade.get("price", 0))
            qty = float(ccxt_trade.get("amount", 0))
            total = float(ccxt_trade.get("cost"))
            source_transaction_type = str(ccxt_trade.get("side")).lower()
            if source_transaction_type not in ["buy", "sell"]:
                raise ValueError(
                    f"Unexpected source_transaction_type '{source_transaction_type}'"
                )

            fee_info = ccxt_trade.get("fee", {})
            fee = float(fee_info.get("cost", 0)) if fee_info else 0
            fee_quote = str(fee_info.get("currency", "")).upper() if fee_info else quote
            timestamp_ms = int(ccxt_trade.get("timestamp", 0))
            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            return NormalizedTransaction(
                source="okx-transactions",
                account_id=self.account_id,
                source_account=self.connector_name,  # Raw account identifier for mapping
                source_transaction_id=trade_id,
                date_time=dt,
                direction="inflow" if source_transaction_type == "buy" else "outflow",
                transaction_type="trade",
                source_transaction_type=source_transaction_type,
                source_asset_symbol=base,
                quantity=qty,
                price=price,
                source_price_quote_asset_symbol=quote,
                total=total,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
            )
        except Exception as e:
            error_msg = f"Failed to map OKX trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch trades from OKX using CCXT and yield them.
        
        Yields:
            Dict[str, Any]: Trade objects as they are fetched
        """
        from typing import Generator
        
        log.info("🔄 Fetching trades from OKX API using CCXT...")
        
        self.update_progress(
            operation="Fetching trades",
            current=0,
            total=1,
            log_message="Fetching trades from OKX API...",
            fetched_count=0,
        )
        
        all_trades = self.get_all_trades()
        if not all_trades:
            log.warning("⚠️ No trades fetched from OKX")
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message="ℹ️ No trades found on OKX",
                fetched_count=0,
            )
            return
        
        for trade in all_trades:
            yield trade
        
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Fetched {len(all_trades)} trades from OKX",
            fetched_count=len(all_trades),
        )

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_okx_connector -v
