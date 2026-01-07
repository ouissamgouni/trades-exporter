"""
OKX (OKCoin) Exchange connector: API access and trade mapping to trade_sync format.
Uses CCXT library for robust API handling.
Object-oriented design implementing BaseConnector interface.
"""

import ccxt
from datetime import datetime, timezone
from typing import Dict, Any, List


from backend.connectors.base.base_connector import BaseConnector
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
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        """Initialize OKX connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config)

        # In test mode, skip all API configuration
        if self.test_mode:
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

        Returns:
            list: List of all trade objects from CCXT
        """
        try:
            all_trades = {}
            after = None

            while True:
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

                # Track new trades
                fetched_new_trades = False
                for trade in trades:
                    trade_id = trade.get("id")
                    if trade_id and trade_id not in all_trades:
                        fetched_new_trades = True
                        all_trades[trade_id] = trade

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

            log.info(f"✅ Total trades fetched: {len(sorted_trades)}")
            return sorted_trades

        except Exception as e:
            log.warning(f"⚠️ Error fetching trades: {e}")
            return []

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

    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch all trades from OKX using CCXT.
        Returns:
            list: List of trade objects
        """
        log.info("🔄 Fetching trades from OKX API using CCXT...")
        all_trades = self.get_all_trades()
        if not all_trades:
            log.warning("⚠️ No trades fetched from OKX")
            return []
        return all_trades

    # Inherits yield_normalized from BaseConnector


# Integration tests available at:
# pytest tests/integration/exchanges/test_connector_integration.py::TestConnectorIntegration::test_okx_connector -v
