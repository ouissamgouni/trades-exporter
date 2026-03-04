"""
Polymarket connector: Fetch prediction market trades and redemptions.
Uses Polymarket Data API (https://data-api.polymarket.com).
Supports trade (BUY/SELL) and redemption (REDEEM) activity tracking.
"""

import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List, Optional

from backend.connectors.base.base_connector import BaseConnector, BalanceEntry
from backend.config.loader import configure_logging, load_settings
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction, ensure_utc

log = configure_logging("polymarket")

BASE_URL = "https://data-api.polymarket.com"
PAGE_SIZE = 100


class ConnectorPolymarket(BaseConnector):
    """Polymarket connector for prediction market trades and redemptions."""

    @property
    def connector_name(self) -> str:
        return "polymarket"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize Polymarket connector.

        Args:
            wallet_address: The Polymarket proxy wallet address
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        self.wallet_address = wallet_address
        self.chain_name = "polygon"

        # Initialize base (sets self.test_mode and logs)
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Rate limiting configuration
        settings = load_settings()
        web3_config = settings.get("web3_wallets", {})
        self.request_delay = web3_config.get("request_delay", 1.0)
        self.max_retries = web3_config.get("max_retries", 7)

    # ------------------------------------------------------------------
    # HTTP helper
    # ------------------------------------------------------------------

    def _safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry and exponential backoff.

        Args:
            endpoint: API endpoint path (e.g., "/activity")
            params: Optional query parameters

        Returns:
            JSON response data

        Raises:
            RuntimeError: If all retries fail
        """
        delay = self.request_delay
        url = f"{BASE_URL}{endpoint}"
        if params is None:
            params = {}

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, timeout=15)

                if response.status_code == 429:
                    log.warning(f"⚠️ Rate limited (attempt {attempt}): HTTP 429")
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    raise RuntimeError(
                        f"HTTP {response.status_code}: {response.text[:200]}"
                    )

                return response.json()

            except requests.exceptions.RequestException as e:
                log.error(f"⚠️ Network error (attempt {attempt}): {e}")
                delay *= 2
                continue
            except Exception as e:
                log.error(f"⚠️ API error (attempt {attempt}): {e}")
                delay *= 2
                continue

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - Polymarket API request failed"
        )

    # ------------------------------------------------------------------
    # Core connector interface
    # ------------------------------------------------------------------

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw Polymarket activity with offset-based pagination."""
        try:
            self.update_progress(
                operation="Fetching Polymarket activity",
                current=0,
                total=1,
                log_message=f"Fetching activity for {self.wallet_address[:10]}...",
            )

            offset = 0
            total_items = 0
            page = 0

            while True:
                if self.is_abort_requested():
                    log.info("🛑 Abort requested, stopping fetch")
                    break

                page += 1
                params = {
                    "user": self.wallet_address,
                    "limit": PAGE_SIZE,
                    "offset": offset,
                }

                result = self._safe_request("/activity", params)

                if not isinstance(result, list):
                    log.warning(f"Unexpected response format: {type(result)}")
                    break

                # Apply since_datetime filter
                for item in result:
                    ts = item.get("timestamp")
                    if ts and self.since_datetime:
                        item_dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                        if item_dt < ensure_utc(self.since_datetime):
                            # Data API returns newest first; once we see an old item,
                            # all subsequent items will also be older.
                            log.info(
                                f"   Reached since_datetime cutoff at page {page}"
                            )
                            return
                    total_items += 1
                    yield item

                log.info(f"   Page {page}: yielded {len(result)} items (offset={offset})")

                # Stop if we got fewer items than requested (last page)
                if len(result) < PAGE_SIZE:
                    break

                offset += PAGE_SIZE

            log.info(f"   ✅ Found {total_items} Polymarket activities")

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} Polymarket activities",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching Polymarket activity: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    def raw_to_normalized(self, item: Dict) -> NormalizedTransaction:
        """
        Map raw Polymarket activity item to NormalizedTransaction.

        Activity types:
            TRADE (BUY)  -> outflow of USDC (buying outcome shares)
            TRADE (SELL) -> inflow of USDC (selling outcome shares)
            REDEEM       -> inflow of USDC (market resolved, payout)

        Args:
            item: Raw activity dict from Polymarket Data API

        Returns:
            NormalizedTransaction with USDC as the asset and market details in tags
        """
        try:
            activity_type = item.get("type", "").upper()
            side = item.get("side", "").upper()
            tx_hash = item.get("transactionHash", "")
            condition_id = item.get("conditionId", "")
            timestamp = item.get("timestamp")
            usdc_size = Decimal(str(item.get("usdcSize", 0)))
            shares = Decimal(str(item.get("size", 0)))
            price = item.get("price", 0)
            title = item.get("title", "")
            outcome = item.get("outcome", "")
            outcome_index = item.get("outcomeIndex")
            slug = item.get("slug", "")
            event_slug = item.get("eventSlug", "")
            asset_token_id = item.get("asset", "")

            # Unique ID: tx_hash + condition_id (same tx can have multiple redemptions)
            source_transaction_id = f"{tx_hash}_{condition_id}" if condition_id else tx_hash

            # Parse timestamp
            dt = None
            if timestamp:
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)

            # Trades and redemptions are 'trade' type — USDC ↔ outcome shares
            # (prediction shares aren't tracked assets, but the USDC exchange is a trade)
            transaction_type = "trade"

            if activity_type == "TRADE":
                if side == "BUY":
                    direction = "outflow"
                    source_transaction_type = "buy"
                elif side == "SELL":
                    direction = "inflow"
                    source_transaction_type = "sell"
                else:
                    direction = "neutral"
                    source_transaction_type = "trade"
            elif activity_type == "REDEEM":
                direction = "inflow"
                source_transaction_type = "redeem"
            else:
                direction = "neutral"
                transaction_type = "cost"
                source_transaction_type = activity_type.lower() if activity_type else "unknown"

            # Build tags with market context
            tags = {
                "polymarket_type": activity_type,
                "market_title": title,
                "outcome": outcome,
                "outcome_index": outcome_index,
                "shares": float(shares),
                "price_per_share": float(price) if price else 0,
                "event_slug": event_slug,
                "slug": slug,
                "condition_id": condition_id,
                "asset_token_id": asset_token_id,
            }
            if side:
                tags["side"] = side

            # from/to based on direction: outflow = wallet→polymarket, inflow = polymarket→wallet
            if direction == "outflow":
                from_account = self.wallet_address
                to_account = "polymarket"
            elif direction == "inflow":
                from_account = "polymarket"
                to_account = self.wallet_address
            else:
                from_account = None
                to_account = None

            normalized = NormalizedTransaction(
                source="polymarket",
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=source_transaction_id,
                network_transaction_id=tx_hash,
                date_time=dt,
                direction=direction,
                transaction_type=transaction_type,
                source_transaction_type=source_transaction_type,
                source_asset_symbol="USDC",
                quantity=float(usdc_size),
                fee=0,
                source_fee_quote_asset_symbol="POL",
                include_fee=False,
                source_from_account=from_account,
                source_to_account=to_account,
                network=normalize_network("polygon"),
                tags=[tags],
            )

            return normalized

        except Exception as e:
            log.error(f"   ⚠️ Error mapping Polymarket activity: {e}")
            raise

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self) -> List[BalanceEntry]:
        """
        Fetch current Polymarket portfolio value as a single USDC balance entry.

        Calls the /positions endpoint and sums currentValue across all open positions.
        Individual position details are stored in the raw field.

        Returns:
            List with a single BalanceEntry for USDC portfolio value.
        """
        try:
            result = self._safe_request("/positions", {"user": self.wallet_address})

            if not isinstance(result, list):
                log.warning(f"Unexpected positions response format: {type(result)}")
                return []

            # Aggregate positions
            total_value = Decimal(0)
            positions_detail = []

            for pos in result:
                size = Decimal(str(pos.get("size", 0)))
                if size <= 0:
                    continue

                current_value = Decimal(str(pos.get("currentValue", 0)))
                total_value += current_value

                positions_detail.append({
                    "title": pos.get("title", ""),
                    "outcome": pos.get("outcome", ""),
                    "shares": float(size),
                    "avg_price": float(pos.get("avgPrice", 0)),
                    "current_price": float(pos.get("curPrice", 0)),
                    "current_value": float(current_value),
                    "pnl": float(pos.get("cashPnl", 0)),
                    "pnl_percent": float(pos.get("percentPnl", 0)),
                    "redeemable": pos.get("redeemable", False),
                    "end_date": pos.get("endDate", ""),
                    "condition_id": pos.get("conditionId", ""),
                })

            if total_value == 0 and not positions_detail:
                return []

            return [
                BalanceEntry(
                    asset_symbol="USDC",
                    total=total_value,
                    available=total_value,
                    locked=Decimal(0),
                    chain="polygon",
                    raw={
                        "positions_count": len(positions_detail),
                        "positions": positions_detail,
                    },
                )
            ]

        except Exception as e:
            log.warning(f"Failed to fetch Polymarket balance: {e}")
            return []
