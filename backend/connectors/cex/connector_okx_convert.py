"""
OKX Convert Exchange connector: API access to convert trades and mapping to trade_sync format.
Uses CCXT library for robust API handling.
Handles OKX convert operations (e.g., BTC -> EUR conversions).
Object-oriented design implementing BaseConnector interface.
"""

import logging
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

log = configure_logging("okx_convert")


# ===== OKX Convert Connector Class =====


class OKXConvertConnector(BaseConnector):
    """OKX convert connector using CCXT library for convert trade history."""

    @property
    def connector_name(self) -> str:
        return "okx_convert"

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize OKX convert connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

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
            log.info("✅ OKX Convert exchange initialized successfully")
        except Exception as e:
            log.error(f"❌ Failed to initialize OKX Convert exchange: {e}")
            raise

    def get_convert_trades(self) -> List[Dict[str, Any]]:
        """
        Fetch convert trade history from OKX using CCXT.
        If since_datetime is set, filters out trades before that timestamp.

        Returns:
            list: List of convert trade objects from CCXT
        """
        try:
            all_trades = {}
            since_ms = self.since_timestamp_ms

            # Fetch convert trade history
            log.info("Fetching convert trades...")
            trades = self.exchange.fetch_convert_trade_history()

            # Handle None or empty result
            if not trades:
                log.info("No convert trades found.")
                return []

            log.info(f"✅ Fetched {len(trades)} convert trades")

            # Track trades by ID to avoid duplicates, filtering by since_datetime if set
            for trade in trades:
                trade_id = trade.get("id")
                trade_timestamp = trade.get("timestamp")
                
                # Skip trades before since_datetime if incremental sync
                if since_ms and trade_timestamp and trade_timestamp < since_ms:
                    continue
                    
                if trade_id and trade_id not in all_trades:
                    all_trades[trade_id] = trade

            # Sort by timestamp
            sorted_trades = list(all_trades.values())
            if sorted_trades:
                sorted_trades = self.exchange.sort_by(sorted_trades, "timestamp")
                if sorted_trades is None:
                    sorted_trades = list(
                        all_trades.values()
                    )  # Fallback if sort_by returns None

            log.info(f"✅ Total unique convert trades: {len(sorted_trades)}")
            return sorted_trades

        except Exception as e:
            error_str = str(e).lower()
            
            # Legitimate empty result
            if "no data" in error_str or "empty" in error_str or "no" in error_str and "convert" in error_str:
                log.debug("ℹ️ No convert trades found (legitimate empty result)")
                return []
            
            # Authentication errors
            if "401" in error_str or "unauthorized" in error_str:
                log.error(f"❌ Authentication failed for OKX convert trades: {e}")
                raise ConnectorAPIError(
                    message="Authentication failed - check API credentials",
                    connector_name=self.connector_name,
                    operation="fetch_convert_trades",
                    reason=ErrorReason.AUTHENTICATION_FAILED,
                    http_status_code=401,
                    retryable=False,
                    original_error=e,
                )
            
            if "403" in error_str or "forbidden" in error_str:
                log.error(f"❌ Permission denied for OKX convert trades: {e}")
                raise ConnectorAPIError(
                    message="Permission denied - insufficient API key permissions",
                    connector_name=self.connector_name,
                    operation="fetch_convert_trades",
                    reason=ErrorReason.PERMISSION_DENIED,
                    http_status_code=403,
                    retryable=False,
                    original_error=e,
                )
            
            # Rate limiting
            if "429" in error_str or "rate limit" in error_str:
                log.error(f"❌ Rate limited on OKX convert trades: {e}")
                raise ConnectorAPIError(
                    message="Rate limited by OKX API",
                    connector_name=self.connector_name,
                    operation="fetch_convert_trades",
                    reason=ErrorReason.RATE_LIMITED,
                    http_status_code=429,
                    retryable=True,
                    original_error=e,
                )
            
            # Network/timeout errors
            if "timeout" in error_str or "timed out" in error_str:
                log.error(f"❌ Timeout fetching OKX convert trades: {e}")
                raise ConnectorAPIError(
                    message="Request timeout",
                    connector_name=self.connector_name,
                    operation="fetch_convert_trades",
                    reason=ErrorReason.TIMEOUT,
                    retryable=True,
                    original_error=e,
                )
            
            if "connection" in error_str or "network" in error_str:
                log.error(f"❌ Network error fetching OKX convert trades: {e}")
                raise ConnectorAPIError(
                    message="Network connection error",
                    connector_name=self.connector_name,
                    operation="fetch_convert_trades",
                    reason=ErrorReason.NETWORK_ERROR,
                    retryable=True,
                    original_error=e,
                )
            
            # Generic API error
            log.error(f"❌ API error fetching OKX convert trades: {e}")
            raise ConnectorAPIError(
                message="API request failed",
                connector_name=self.connector_name,
                operation="fetch_convert_trades",
                reason=ErrorReason.API_ERROR,
                retryable=False,
                original_error=e,
                details=str(e),
            )

    def raw_to_normalized(self, convert_trade: dict) -> NormalizedTransaction:
        """
        Map a CCXT convert trade response from OKX to trade_sync structure.
        Implements abstract method from BaseConnector.

        Convert trade format:
        {
            'info': dict (raw exchange response with clTReqId, instId, side, fillPx, baseCcy, quoteCcy, etc),
            'timestamp': int (milliseconds),
            'datetime': str (ISO 8601),
            'id': str,
            'fromCurrency': str (e.g., 'BTC'),
            'fromAmount': float,
            'toCurrency': str (e.g., 'EUR'),
            'toAmount': float,
            'price': float,
            'fee': float or None
        }
        """
        try:
            trade_id = str(convert_trade.get("id", ""))
            info = convert_trade.get("info", {})
            base = str(info.get("baseCcy", "")).upper()
            quote = str(info.get("quoteCcy", "")).upper()
            if not base or not quote:
                raise ValueError(f"Invalid currency pair: {base}/{quote}")
            qty = float(info.get("fillBaseSz", 0))
            to_amount = float(info.get("fillQuoteSz", 0))
            price = float(convert_trade.get("price", 0))
            fee = float(convert_trade.get("fee", 0)) if convert_trade.get("fee") else 0
            timestamp_ms = int(convert_trade.get("timestamp", 0))
            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)
            source_transaction_type = str(info.get("side")).lower()

            return NormalizedTransaction(
                source="okx-convert",
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
                total=to_amount,
                fee=fee,
                source_fee_quote_asset_symbol=quote,
                include_fee=True,
                tags=[{"type": "convert"}],
            )
        except Exception as e:
            error_msg = f"Failed to map OKX convert trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """
        Fetch convert trades from OKX using CCXT and yield them.
        
        Yields:
            Dict[str, Any]: Convert trade objects as they are fetched
        """
        from typing import Generator
        
        log.info("🔄 Fetching convert trades from OKX API using CCXT...")
        
        self.update_progress(
            operation="Fetching convert trades",
            current=0,
            total=1,
            log_message="Fetching convert trades from OKX API...",
            fetched_count=0,
        )
        
        all_trades = self.get_convert_trades()
        if not all_trades:
            log.warning("⚠️ No convert trades fetched from OKX")
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message="ℹ️ No convert trades found on OKX",
                fetched_count=0,
            )
            return
        
        for trade in all_trades:
            yield trade
        
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Fetched {len(all_trades)} convert trades from OKX",
            fetched_count=len(all_trades),
        )

    # Inherits yield_normalized from BaseConnector


# ===== Main =====


def main():
    """Test the OKX Convert connector."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    print("\n" + "=" * 60)
    print("OKX Convert Connector Test - Object-Oriented (CCXT)")
    print("=" * 60 + "\n")

    count_success = 0
    count_error = 0

    try:
        connector = OKXConvertConnector()
        for trade_or_error in connector.fetch_and_map_trades():
            if "_error" in trade_or_error:
                count_error += 1
                print(
                    f"❌ [{count_error}] Error: {trade_or_error.get('_error', 'Unknown error')}"
                )
            else:
                count_success += 1
                print(
                    f"✅ [{count_success}] {trade_or_error.get('asset_id', '?')} "
                    f"{trade_or_error.get('transaction_type', '').upper()} "
                    f"x{trade_or_error.get('quantity', '?')} @ {trade_or_error.get('price', '?')} "
                    f"(Fee: {trade_or_error.get('fee', '?')} {trade_or_error.get('source_fee_quote_asset_symbol', '?')})"
                )
    except Exception as e:
        print(f"\n❌ Test failed with exception: {e}")
        import traceback

        traceback.print_exc()
        return
    print("\n" + "=" * 60)
    print(f"Test Complete: {count_success} successful, {count_error} failed")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
