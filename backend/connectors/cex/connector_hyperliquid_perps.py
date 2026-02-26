"""
Hyperliquid Perps connector: Fetch perpetual futures fill history.
Uses hyperliquid-python-sdk (public Info API — no API key required).
Models perp fills as spot-equivalent trades for the P&L engine.
Stores closedPnl from the API in transaction tags for validation.
"""

import time
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector, BalanceEntry
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("hyperliquid_perps")

# Hyperliquid returns max 2000 fills per request
PAGE_SIZE = 2000


class HyperliquidPerpsConnector(BaseConnector):
    """
    Hyperliquid perpetual futures connector.

    Fetches fill history via the public Info API and aggregates partial
    fills by order ID (oid) before mapping to NormalizedTransaction.

    A single order can match against multiple counterparties, producing
    multiple fills with unique trade IDs but the same oid. We aggregate
    them into one NormalizedTransaction per order using:
    - Summed quantity, fees, and closedPnl
    - Volume-weighted average price (VWAP)

    The P&L engine treats these as spot-equivalent trades:
    - BUY 1 ETH @ 3000 → inflow ETH, outflow USDC (via leg expansion)
    - SELL 1 ETH @ 3500 → outflow ETH, inflow USDC
    - Short positions produce negative lots, resolved on cover

    closedPnl from the API is stored in tags for P&L validation.
    """

    @property
    def connector_name(self) -> str:
        return "hyperliquid_perps"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Optional[Dict[str, Any]] = None,
        progress_callback=None,
        **kwargs,
    ):
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        self._info = None
        self._wallet_address: str = ""

        if self.test_mode or self.renormalize_mode:
            return

        # Wallet address comes from the account's address_or_identifier
        self._wallet_address = (config or {}).get(
            "_account_address_or_identifier", ""
        )
        if not self._wallet_address:
            raise ValueError(
                "Missing wallet address — set address_or_identifier on the account"
            )

        try:
            from hyperliquid.info import Info

            self._info = Info(
                base_url="https://api.hyperliquid.xyz", skip_ws=True
            )
            log.info(
                f"✅ Hyperliquid Info API initialized for {self._wallet_address}"
            )
        except Exception as e:
            log.error(f"❌ Failed to initialize Hyperliquid SDK: {e}")
            raise

    # ------------------------------------------------------------------
    # Raw data fetching
    # ------------------------------------------------------------------

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch perp fills with cursor-based pagination.
        The API returns fills sorted ascending by time.
        We paginate by using the last fill's time as the next start_time.
        """
        if self.test_mode:
            for item in self._load_test_data():
                yield item
            return

        start_ms = self.since_timestamp_ms or 0
        all_fills: list[dict] = []

        self.update_progress(
            operation="Fetching fills",
            current=0,
            total=0,
            log_message="Starting Hyperliquid perps fill fetch",
            fetched_count=0,
        )

        while True:
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping fill fetch")
                break

            try:
                fills = self._info.user_fills_by_time(
                    self._wallet_address, start_ms
                )
            except Exception as e:
                log.error(f"❌ API error fetching fills: {e}")
                raise ConnectorAPIError(
                    message=f"Failed to fetch fills: {e}",
                    connector_name=self.connector_name,
                    operation="user_fills_by_time",
                    reason=ErrorReason.API_ERROR,
                    retryable=True,
                    original_error=e,
                )

            if not fills:
                break

            all_fills.extend(fills)

            self.update_progress(
                operation="Fetching fills",
                current=len(all_fills),
                total=0,
                log_message=f"Fetched {len(fills)} fills (total: {len(all_fills)})",
                fetched_count=len(all_fills),
            )

            # Paginate: if we got a full page, advance start_time past the last fill
            if len(fills) >= PAGE_SIZE:
                last_time = fills[-1].get("time", 0)
                start_ms = last_time + 1
            else:
                break

        # Aggregate partial fills by order ID
        aggregated = self._aggregate_fills_by_oid(all_fills)

        for agg_fill in aggregated:
            yield agg_fill

        self.update_progress(
            operation="Completed",
            current=len(aggregated),
            total=len(aggregated),
            log_message=f"✅ Total fills fetched: {len(all_fills)}, aggregated to {len(aggregated)} orders",
            fetched_count=len(aggregated),
        )
        log.info(
            f"✅ Total fills fetched: {len(all_fills)}, aggregated to {len(aggregated)} orders"
        )

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Fill aggregation
    # ------------------------------------------------------------------

    @staticmethod
    def _aggregate_fills_by_oid(
        fills: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Aggregate partial fills that share the same order ID (oid).

        A single Hyperliquid order can match against multiple counterparties,
        producing N fills with unique trade IDs but the same oid.
        We merge them into one aggregated dict per order:
        - quantity = sum of sizes
        - total = sum(px_i * sz_i)  →  price = total / quantity  (VWAP)
        - fee = sum of fees
        - closedPnl = sum of closedPnl values
        - startPosition = first fill's startPosition
        - dir = first fill's dir (consistent within an oid)
        - hash = shared hash from the order
        - time = shared timestamp
        """
        if not fills:
            return []

        groups: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for fill in fills:
            groups[fill["oid"]].append(fill)

        aggregated: List[Dict[str, Any]] = []

        for oid, group in groups.items():
            if len(group) == 1:
                # Single fill — no aggregation needed
                aggregated.append(group[0])
                continue

            # Sort by startPosition descending to get the first fill's start
            # (startPosition decrements as each fill reduces the position)
            group.sort(
                key=lambda f: abs(Decimal(f.get("startPosition", "0"))),
                reverse=True,
            )

            first = group[0]
            total_qty = sum(Decimal(f["sz"]) for f in group)
            total_notional = sum(
                Decimal(f["px"]) * Decimal(f["sz"]) for f in group
            )
            total_fee = sum(Decimal(f.get("fee", "0")) for f in group)
            total_closed_pnl = sum(
                Decimal(f.get("closedPnl", "0")) for f in group
            )

            # VWAP = total_notional / total_qty
            vwap = total_notional / total_qty if total_qty else Decimal("0")

            aggregated.append(
                {
                    "coin": first["coin"],
                    "px": str(vwap),
                    "sz": str(total_qty),
                    "side": first["side"],
                    "time": first["time"],
                    "startPosition": first.get("startPosition", "0.0"),
                    "dir": first.get("dir", ""),
                    "closedPnl": str(total_closed_pnl),
                    "hash": first.get("hash", ""),
                    "oid": oid,
                    "crossed": first.get("crossed", False),
                    "fee": str(total_fee),
                    "tid": first["tid"],  # Use first fill's tid
                    "feeToken": first.get("feeToken", "USDC"),
                    "twapId": first.get("twapId"),
                    # Aggregation metadata
                    "_aggregated_fills": len(group),
                    "_fill_tids": [f["tid"] for f in group],
                }
            )

        # Sort by time to maintain chronological order
        aggregated.sort(key=lambda f: f["time"])
        return aggregated

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    def raw_to_normalized(self, fill: dict) -> NormalizedTransaction:
        """
        Map a Hyperliquid fill (or aggregated order) to NormalizedTransaction.

        Fill shape (single or aggregated):
        {
            "coin": "ETH", "px": "3000.5", "sz": "0.1", "side": "B",
            "time": 1763646444076, "startPosition": "0.0",
            "dir": "Open Long", "closedPnl": "0.0",
            "hash": "0x...", "oid": 123, "crossed": true,
            "fee": "0.135", "tid": 651079843976815, "feeToken": "USDC",
            "_aggregated_fills": 3  (optional, only for aggregated)
        }
        """
        try:
            coin = fill["coin"]
            side = fill["side"]  # "B" = buy, "A" = sell (ask)
            px = fill["px"]
            sz = fill["sz"]
            fee_str = fill.get("fee", "0")
            fee_token = fill.get("feeToken", "USDC")
            timestamp_ms = int(fill["time"])
            oid = str(fill["oid"])
            tx_hash = fill.get("hash", "")
            closed_pnl = fill.get("closedPnl", "0.0")
            direction_label = fill.get("dir", "")
            start_position = fill.get("startPosition", "0.0")
            aggregated_fills = fill.get("_aggregated_fills", 1)

            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            # side "B" = buy (inflow of the coin), "A" = sell (outflow of the coin)
            direction = "inflow" if side == "B" else "outflow"
            source_trx_type = "buy" if side == "B" else "sell"

            # Use oid as source_transaction_id (one txn per order)
            tag_data = {
                "closed_pnl": closed_pnl,
                "dir": direction_label,
                "start_position": start_position,
            }
            if aggregated_fills > 1:
                tag_data["aggregated_fills"] = aggregated_fills

            return NormalizedTransaction(
                source="hyperliquid-perps",
                account_id=self.account_id,
                source_account=self.connector_name,
                source_transaction_id=oid,
                date_time=dt,
                direction=direction,
                transaction_type="trade",
                source_transaction_type=source_trx_type,
                source_asset_symbol=coin,
                quantity=float(sz),
                price=float(px),
                source_price_quote_asset_symbol="USDC",
                total=float(Decimal(px) * Decimal(sz)),
                fee=abs(float(fee_str)),
                source_fee_quote_asset_symbol=fee_token,
                network_transaction_id=tx_hash,
                tags=[tag_data],
            )
        except Exception as e:
            error_msg = f"Failed to map Hyperliquid fill: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    # ------------------------------------------------------------------
    # Balance
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return not self.test_mode and self._info is not None

    def get_balance(self) -> List[BalanceEntry]:
        """Fetch USDC margin balance and open position values."""
        state = self._info.user_state(self._wallet_address)
        entries = []

        # USDC margin balance
        margin = state.get("marginSummary", {})
        account_value = Decimal(margin.get("accountValue", "0"))
        withdrawable = Decimal(state.get("withdrawable", "0"))
        margin_used = Decimal(margin.get("totalMarginUsed", "0"))

        if account_value > 0:
            entries.append(
                BalanceEntry(
                    asset_symbol="USDC",
                    total=account_value,
                    available=withdrawable,
                    locked=margin_used,
                    raw=margin,
                )
            )

        # Open positions as individual entries
        for pos in state.get("assetPositions", []):
            p = pos.get("position", {})
            coin = p.get("coin", "")
            size = Decimal(p.get("szi", "0"))
            if coin and size != 0:
                entries.append(
                    BalanceEntry(
                        asset_symbol=coin,
                        total=size,
                        available=size,
                        locked=Decimal(0),
                        raw=p,
                    )
                )

        return entries
