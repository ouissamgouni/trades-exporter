"""
Polymarket connector: Fetch prediction market trades and redemptions.
Uses the public Data API v2 (https://data-api.polymarket.com/v2) for trades and
redemptions, and the public CLOB /markets endpoint for market resolution.
No API key or private key is required — only the proxy wallet address.

Stock model: outcome shares are treated as tradeable assets (like stocks).
BUY = inflow of shares (creates cost lot), SELL/REDEEM = outflow (disposes cost lot).
Asset symbol format: PM:{slug}-{outcome} (e.g. PM:rain-friday-Yes).
"""

import json
import os
import re
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List, Optional

from backend.connectors.base.base_connector import BaseConnector, BalanceEntry
from backend.config.loader import configure_logging, load_settings
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("polymarket")

CLOB_BASE_URL = "https://clob.polymarket.com"
GAMMA_BASE_URL = "https://gamma-api.polymarket.com"
DATA_API_BASE_URL = "https://data-api.polymarket.com/v2"
PAGE_SIZE = 500
GAMMA_BATCH = 20


def _parse_closed_time(value: Any) -> Optional[int]:
    """Gamma closedTime ("2025-11-08 00:51:23+00" or ISO) → unix seconds."""
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    if re.search(r"[+-]\d{2}$", text):
        text += ":00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


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

        # Gamma market cache: conditionId → market data (built during sync)
        self._gamma_cache: Dict[str, Dict] = {}
        # Token ID → (slug, outcome) mapping (built from Gamma data)
        self._token_outcome_map: Dict[str, tuple] = {}

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _data_api_request(self, path: str, params: Dict) -> Any:
        """Public Data API v2 GET with retry and backoff (honours Retry-After on 429)."""
        delay = self.request_delay
        url = f"{DATA_API_BASE_URL}{path}"

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, timeout=30)

                if response.status_code == 429:
                    retry_after = response.headers.get("Retry-After")
                    delay = float(retry_after) if retry_after else delay * 2
                    log.warning(f"⚠️ Data API rate limited (attempt {attempt})")
                    continue
                if response.status_code >= 500:
                    log.error(
                        f"⚠️ Data API HTTP {response.status_code} (attempt {attempt}): {response.text[:200]}"
                    )
                    delay *= 2
                    continue
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Data API HTTP {response.status_code}: {response.text[:200]}"
                    )
                return response.json()

            except requests.exceptions.RequestException as e:
                log.error(f"⚠️ Data API network error (attempt {attempt}): {e}")
                delay *= 2

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - Data API request failed"
        )

    def _gamma_request(self, path: str, params: Dict = None) -> Any:
        """
        Perform public Gamma API request with retry and backoff.

        Args:
            path: API path (e.g. "/markets")
            params: Optional query parameters

        Returns:
            JSON response data
        """
        delay = self.request_delay
        url = f"{GAMMA_BASE_URL}{path}"
        if params is None:
            params = {}

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, timeout=15)

                if response.status_code == 429:
                    log.warning(f"⚠️ Gamma rate limited (attempt {attempt}): HTTP 429")
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    log.error(
                        f"⚠️ Gamma HTTP {response.status_code} (attempt {attempt}): {response.text[:200]}"
                    )
                    delay *= 2
                    continue

                return response.json()

            except requests.exceptions.RequestException as e:
                log.error(f"⚠️ Gamma network error (attempt {attempt}): {e}")
                delay *= 2
                continue
            except Exception as e:
                log.error(f"⚠️ Gamma API error (attempt {attempt}): {e}")
                delay *= 2
                continue

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - Gamma API request failed"
        )

    # ------------------------------------------------------------------
    # Core connector interface
    # ------------------------------------------------------------------

    def _yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Override base _yield_raws() to always go through yield_raws().

        Polymarket's yield_raws() builds _condition_outcome_map during iteration,
        which raw_to_normalized() needs to resolve REDEEM outcomes. The base class
        test mode path bypasses yield_raws(), so the map would never get built.
        """
        if self._renormalize_mode:
            yield from super()._yield_raws()
            return

        collected_raws = []
        for raw_item in self.yield_raws():
            collected_raws.append(raw_item)
            yield raw_item
        if not self.test_mode:
            self.dump_trades_to_json(collected_raws)

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch and yield raw Polymarket trades, then generate synthetic closes
        for resolved positions.

        In test mode, loads from fixture file.

        Flow (live mode):
        1. Fetch Data API v2 /activity (TRADE + REDEEM, cursor-paginated, public)
        2. Collect unique conditionIds from trades
        3. Query Gamma /markets for resolution data and slug/outcome mapping
        4. Enrich raw items with slug/outcome from Gamma data
        5. Yield trade items (inserting resolution synthetics before REDEEMs)
        6. Yield synthetic closes for resolved positions (from Gamma)
        """
        # ------ Test mode: load from fixture file ------
        if self.test_mode:
            test_file = self.get_test_data_path()
            log.info(f"🧪 [TEST MODE] Loading Polymarket test data from {test_file}")

            if not test_file or not os.path.exists(test_file):
                log.warning(f"Test file not found: {test_file}")
                return

            with open(test_file, "r") as f:
                data = json.load(f)

            # Initialize tracking maps
            self._condition_outcome_map = {}
            self._redeemed_conditions = set()
            self._condition_latest_timestamp = {}

            # First pass: build condition→outcome map from BUY items
            for item in data:
                activity_type = item.get("type", "").upper()
                condition_id = item.get("conditionId", "")
                outcome = item.get("outcome", "")
                ts = item.get("timestamp")
                if activity_type == "TRADE" and outcome and condition_id:
                    self._condition_outcome_map[condition_id] = outcome
                elif activity_type == "REDEEM" and condition_id and float(item.get("usdcSize") or 0) > 0:
                    self._redeemed_conditions.add(condition_id)
                # Track latest trade timestamp per conditionId (for synthetic close timing)
                if condition_id and ts and activity_type == "TRADE":
                    prev = self._condition_latest_timestamp.get(condition_id, 0)
                    if ts > prev:
                        self._condition_latest_timestamp[condition_id] = ts

            log.info(
                f"🧪 [TEST MODE] Loaded {len(data)} items, "
                f"{len(self._condition_outcome_map)} condition mappings"
            )

            # Second pass: yield items, inserting resolution synthetics before REDEEMs
            for item in data:
                activity_type = item.get("type", "").upper()
                if activity_type == "REDEEM":
                    # Generate a resolution synthetic BEFORE the REDEEM
                    synthetic = self._synthetic_from_redeem(item)
                    if synthetic:
                        yield synthetic
                yield item
            return

        # ------ Live mode: fetch from Data API + CLOB markets ------
        try:
            self.update_progress(
                operation="Fetching Polymarket trades",
                current=0,
                total=1,
                log_message=f"Fetching Polymarket activity for {self.wallet_address[:10]}...",
            )

            # Phase A: Fetch all trades + redemptions from the Data API
            raw_trades = self._fetch_activity()
            log.info(f"   Fetched {len(raw_trades)} activities from Data API")

            # Phase B: Collect unique conditionIds and fetch Gamma market data
            condition_ids = set()
            for trade in raw_trades:
                cid = trade.get("conditionId", "")
                if cid:
                    condition_ids.add(cid)

            if condition_ids:
                self._fetch_gamma_markets(condition_ids)
                log.info(f"   Fetched Gamma data for {len(self._gamma_cache)} markets")

            # Phase C: Enrich trades with Gamma data (slug, outcome) and build maps
            self._condition_outcome_map: Dict[str, str] = {}
            self._redeemed_conditions: set = set()
            self._condition_latest_timestamp: Dict[str, int] = {}
            self._condition_net_shares: Dict[
                str, float
            ] = {}  # Net shares per conditionId

            for item in raw_trades:
                self._enrich_with_gamma(item)

                activity_type = item.get("type", "").upper()
                condition_id = item.get("conditionId", "")
                outcome = item.get("outcome", "")
                ts = item.get("timestamp")
                side = item.get("side", "").upper()
                size = float(item.get("size", 0))

                if activity_type == "TRADE" and outcome and condition_id:
                    self._condition_outcome_map[condition_id] = outcome
                elif activity_type == "REDEEM" and condition_id and float(item.get("usdcSize") or 0) > 0:
                    self._redeemed_conditions.add(condition_id)

                if condition_id and activity_type == "TRADE":
                    if side == "BUY":
                        self._condition_net_shares[condition_id] = (
                            self._condition_net_shares.get(condition_id, 0) + size
                        )
                    elif side == "SELL":
                        self._condition_net_shares[condition_id] = (
                            self._condition_net_shares.get(condition_id, 0) - size
                        )

                if condition_id and ts and activity_type == "TRADE":
                    prev = self._condition_latest_timestamp.get(condition_id, 0)
                    if ts > prev:
                        self._condition_latest_timestamp[condition_id] = ts

            total_items = 0
            for item in raw_trades:
                activity_type = item.get("type", "").upper()

                # Generate resolution synthetic BEFORE yielding REDEEMs
                if activity_type == "REDEEM":
                    synthetic = self._synthetic_from_redeem(item)
                    if synthetic:
                        total_items += 1
                        yield synthetic

                total_items += 1
                yield item

            log.info(f"   ✅ Found {total_items} Polymarket trades")

            # Phase D: Generate synthetic closes from Gamma resolution data
            synthetic_count = 0
            for synthetic in self._generate_synthetic_closes():
                total_items += 1
                synthetic_count += 1
                yield synthetic

            if synthetic_count:
                log.info(
                    f"   ✅ Generated {synthetic_count} synthetic closes for resolved positions"
                )

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} Polymarket trades (incl. {synthetic_count} synthetic)",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching Polymarket trades: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    # ------------------------------------------------------------------
    # Data API activity fetching
    # ------------------------------------------------------------------

    def _fetch_activity(self) -> List[Dict[str, Any]]:
        """
        Fetch the wallet's TRADE and REDEEM history from Data API v2 /activity.

        Always fetches the full history (ignores since_datetime): synthetic closes
        need every trade of a condition to compute net shares and the held outcome.
        Rows are upserted by source_transaction_id, so re-fetching is idempotent.
        """
        items: List[Dict[str, Any]] = []
        skipped: Dict[str, int] = {}
        cursor = None

        while True:
            if self.is_abort_requested():
                log.info("🛑 Abort requested, stopping Data API fetch")
                break

            params: Dict[str, Any] = {"user": self.wallet_address, "limit": PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor
            result = self._data_api_request("/activity", params) or {}

            for activity in result.get("data") or []:
                activity_type = (activity.get("type") or "").upper()
                if activity_type in ("TRADE", "REDEEM"):
                    items.append(self._activity_to_raw(activity))
                else:
                    skipped[activity_type] = skipped.get(activity_type, 0) + 1

            cursor = (result.get("pagination") or {}).get("next_cursor")
            if not cursor:
                break

        if skipped:
            log.warning(f"⚠️ Unsupported Polymarket activity types skipped: {skipped}")
        items.sort(key=lambda item: item.get("timestamp") or 0)
        return items

    @staticmethod
    def _activity_to_raw(activity: Dict[str, Any]) -> Dict[str, Any]:
        """Map a Data API v2 activity row to the connector's raw item format (v1 field names)."""
        timestamp = activity.get("timestamp")
        return {
            "type": (activity.get("type") or "").upper(),
            "side": (activity.get("side") or "").upper(),
            "size": float(activity.get("size") or 0),
            "price": float(activity.get("price") or 0),
            "usdcSize": float(activity.get("usdc_size") or 0),
            "transactionHash": activity.get("transaction_hash") or "",
            "conditionId": activity.get("condition_id") or "",
            "timestamp": int(timestamp) if timestamp else None,
            "title": activity.get("title") or "",
            "outcome": activity.get("outcome") or "",
            "outcomeIndex": activity.get("outcome_index"),
            "slug": activity.get("slug") or "",
            "eventSlug": activity.get("event_slug") or "",
            "asset": str(activity.get("token_id") or ""),
        }

    # ------------------------------------------------------------------
    # Gamma API: market metadata + resolution
    # ------------------------------------------------------------------

    def _fetch_gamma_markets(self, condition_ids: set) -> None:
        """
        Fetch market metadata from CLOB /markets/{condition_id} for each conditionId.

        Populates self._gamma_cache and self._token_outcome_map.
        Uses the unauthenticated CLOB markets endpoint (not Gamma API, which
        does not support filtering by condition_id).
        """
        for cid in condition_ids:
            try:
                url = f"{CLOB_BASE_URL}/markets/{cid}"
                resp = requests.get(url, timeout=15)
                if resp.status_code != 200:
                    log.debug(
                        f"CLOB market fetch {cid[:16]}... → HTTP {resp.status_code}"
                    )
                    continue
                market = resp.json()
            except Exception as e:
                log.warning(f"CLOB market fetch failed for {cid[:16]}...: {e}")
                continue

            if not isinstance(market, dict) or not market.get("condition_id"):
                continue

            # Convert CLOB market format to the cache format expected downstream
            slug = market.get("market_slug", "")
            question = market.get("question", "")
            tokens = market.get("tokens", [])
            closed = market.get("closed", False)

            # Build outcome_prices string and outcomes from token data
            outcomes_list = [t.get("outcome", "") for t in tokens]
            outcome_prices = [str(t.get("price", 0)) for t in tokens]

            self._gamma_cache[cid] = {
                "closed": closed,
                "outcomePrices": json.dumps(outcome_prices),
                "outcomes": json.dumps(outcomes_list),
                "slug": slug,
                "question": question,
                "condition_id": cid,
            }

            # Build token_id → (slug, outcome) mapping
            for token in tokens:
                tid = str(token.get("token_id", ""))
                outcome = token.get("outcome", "")
                if tid and outcome:
                    self._token_outcome_map[tid] = (slug, outcome)

            time.sleep(0.1)  # rate-limit courtesy

        self._fetch_resolution_times(
            [cid for cid, market in self._gamma_cache.items() if market.get("closed")]
        )

    def _fetch_resolution_times(self, condition_ids: List[str]) -> None:
        """Add Gamma closedTime (actual resolution time) to closed markets; CLOB lacks it."""
        for start in range(0, len(condition_ids), GAMMA_BATCH):
            batch = condition_ids[start : start + GAMMA_BATCH]
            try:
                markets = self._gamma_request(
                    "/markets",
                    {"condition_ids": batch, "closed": "true", "limit": len(batch)},
                )
            except RuntimeError as e:
                log.warning(f"Gamma resolution time fetch failed: {e}")
                continue
            for market in markets if isinstance(markets, list) else []:
                cid = market.get("conditionId")
                if cid in self._gamma_cache and market.get("closedTime"):
                    self._gamma_cache[cid]["closedTime"] = market["closedTime"]

    def _build_token_map(self, market: Dict) -> None:
        """
        Build token_id → (slug, outcome) mapping from a Gamma market response.

        Gamma provides:
            clobTokenIds: ["token_yes_id", "token_no_id"]  (JSON string or list)
            outcomes: ["Yes", "No"]  (JSON string or list)
            slug: "rain-friday"
        """
        slug = market.get("slug", "")
        clob_token_ids = market.get("clobTokenIds", "")
        outcomes = market.get("outcomes", "")

        # Parse JSON strings if needed
        if isinstance(clob_token_ids, str):
            try:
                clob_token_ids = json.loads(clob_token_ids)
            except (json.JSONDecodeError, TypeError):
                return
        if isinstance(outcomes, str):
            try:
                outcomes = json.loads(outcomes)
            except (json.JSONDecodeError, TypeError):
                return

        if not clob_token_ids or not outcomes:
            return

        for token_id, outcome in zip(clob_token_ids, outcomes):
            if token_id:
                self._token_outcome_map[str(token_id)] = (slug, outcome)

    def _enrich_with_gamma(self, item: Dict[str, Any]) -> None:
        """
        Enrich a raw trade item with Gamma market data (slug, outcome, title).

        Uses token_id → (slug, outcome) mapping built from Gamma.
        Falls back to conditionId-based Gamma cache for title/eventSlug.
        """
        asset_token_id = item.get("asset", "")
        condition_id = item.get("conditionId", "")

        # Resolve slug + outcome from token_id
        if asset_token_id and asset_token_id in self._token_outcome_map:
            slug, outcome = self._token_outcome_map[asset_token_id]
            item["slug"] = slug
            item["outcome"] = outcome

        # Enrich with title and eventSlug from Gamma cache
        if condition_id and condition_id in self._gamma_cache:
            gm = self._gamma_cache[condition_id]
            if not item.get("title"):
                item["title"] = gm.get("question", "") or gm.get("title", "")
            if not item.get("eventSlug"):
                item["eventSlug"] = gm.get("event_slug", "") or gm.get("slug", "")

    def _synthetic_from_redeem(
        self, redeem_item: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """
        Generate a SYNTHETIC_CLOSE from a paid REDEEM (winning shares → USDC).

        The close is dated 1s before the REDEEM: that is when the shares are
        exchanged for USDC, so realized P&L and the wallet's USDC balance agree.
        The REDEEM itself stays a memo with no PnL.

        Returns None for losing (0 USDC) redeems — those positions are closed
        at market resolution by _generate_synthetic_closes().
        """
        condition_id = redeem_item.get("conditionId", "")
        usdc_size = Decimal(str(redeem_item.get("usdcSize", 0)))
        shares = Decimal(str(redeem_item.get("size", 0)))

        if not condition_id or shares <= 0 or usdc_size <= 0:
            return None

        # Resolution price: usdcSize / shares (typically 1.0 for winners)
        price = float(usdc_size / shares)

        # Resolve outcome from condition map (REDEEM has outcome="" in API)
        outcome = self._condition_outcome_map.get(condition_id, "")

        redeem_ts = redeem_item.get("timestamp")
        latest_ts = self._condition_latest_timestamp.get(condition_id)
        if redeem_ts:
            timestamp = redeem_ts - 1
        elif latest_ts:
            timestamp = latest_ts + 1
        else:
            timestamp = int(datetime.now(timezone.utc).timestamp())

        return {
            "type": "SYNTHETIC_CLOSE",
            "side": "CLOSE",
            "usdcSize": float(usdc_size),
            "size": float(shares),
            "price": price,
            "transactionHash": f"synthetic_{condition_id}",
            "conditionId": condition_id,
            "timestamp": timestamp,
            "title": redeem_item.get("title", ""),
            "outcome": outcome,
            "outcomeIndex": redeem_item.get("outcomeIndex", 0),
            "slug": redeem_item.get("slug", ""),
            "eventSlug": redeem_item.get("eventSlug", ""),
            "asset": "",
            "_synthetic": True,
        }

    def _generate_synthetic_closes(self) -> Generator[Dict[str, Any], None, None]:
        """
        Close losing positions at $0 on the market's resolution time (Gamma closedTime).

        Winning (or partially paid) outcomes are not closed here: they stay open
        until redeemed, and the paid REDEEM closes them (_synthetic_from_redeem).
        This keeps each close date fixed once written.
        """
        for condition_id, market in self._gamma_cache.items():
            if not market.get("closed", False):
                continue

            # Skip if already redeemed
            if condition_id in self._redeemed_conditions:
                continue

            # Skip if no trades for this condition
            if condition_id not in self._condition_outcome_map:
                continue

            # Parse outcomePrices to determine winner
            outcome_prices = market.get("outcomePrices", "")
            if isinstance(outcome_prices, str):
                try:
                    outcome_prices = json.loads(outcome_prices)
                except (json.JSONDecodeError, TypeError):
                    continue

            outcomes = market.get("outcomes", "")
            if isinstance(outcomes, str):
                try:
                    outcomes = json.loads(outcomes)
                except (json.JSONDecodeError, TypeError):
                    continue

            if not outcome_prices or not outcomes:
                continue

            # Determine the user's outcome for this condition
            user_outcome = self._condition_outcome_map.get(condition_id, "")
            if not user_outcome:
                continue

            # Check if user's outcome is the winner
            try:
                user_idx = outcomes.index(user_outcome)
            except ValueError:
                continue

            try:
                user_price = float(outcome_prices[user_idx])
            except (IndexError, TypeError, ValueError):
                continue
            if user_price > 0:
                continue  # paying outcome: stays open until its REDEEM

            timestamp = _parse_closed_time(market.get("closedTime"))
            latest_ts = self._condition_latest_timestamp.get(condition_id)
            if timestamp is not None and latest_ts and timestamp <= latest_ts:
                # A close dated before the last trade would dispose shares not yet bought
                timestamp = latest_ts + 1
            if timestamp is None:
                timestamp = (
                    latest_ts + 1
                    if latest_ts
                    else int(datetime.now(timezone.utc).timestamp())
                )
                log.warning(
                    f"No resolution time for {condition_id[:16]}..., closing after last trade"
                )

            slug = market.get("slug", "")
            title = market.get("question", "") or market.get("title", "")
            close_price = 0
            # Use tracked net shares from Data API trades
            close_size = max(0, self._condition_net_shares.get(condition_id, 0))

            yield {
                "type": "SYNTHETIC_CLOSE",
                "side": "CLOSE",
                "usdcSize": close_size * close_price,
                "size": close_size,
                "price": close_price,
                "transactionHash": f"synthetic_{condition_id}",
                "conditionId": condition_id,
                "timestamp": timestamp,
                "title": title,
                "outcome": user_outcome,
                "outcomeIndex": user_idx,
                "slug": slug,
                "eventSlug": market.get("event_slug", "") or slug,
                "asset": "",
                "_synthetic": True,
            }

    def raw_to_normalized(self, item: Dict) -> NormalizedTransaction:
        """
        Map raw Polymarket activity item to NormalizedTransaction (stock model).

        Outcome shares are the traded asset (like stocks):
            TRADE BUY       -> inflow of shares (creates cost lot)
            TRADE SELL      -> outflow of shares (disposes cost lot)
            SYNTHETIC_CLOSE -> outflow at resolution price (disposes remaining lots)
            REDEEM          -> memo (audit-only, no PnL — cash settlement)

        Asset symbol format: PM:{slug}-{outcome} (e.g. PM:rain-friday-Yes)
        Quote asset: USDC (price is per-share in USDC)
        """
        try:
            activity_type = item.get("type", "").upper()
            side = item.get("side", "").upper()
            tx_hash = item.get("transactionHash", "")
            condition_id = item.get("conditionId", "")
            timestamp = item.get("timestamp")
            usdc_size = Decimal(str(item.get("usdcSize", 0)))
            shares = Decimal(str(item.get("size", 0)))
            raw_price = item.get("price", 0)
            title = item.get("title", "")
            outcome = item.get("outcome", "")
            outcome_index = item.get("outcomeIndex")
            slug = item.get("slug", "")
            event_slug = item.get("eventSlug", "")
            asset_token_id = item.get("asset", "")

            # Resolve outcome for REDEEMs (API returns outcome="" for redemptions)
            if not outcome and hasattr(self, "_condition_outcome_map"):
                outcome = self._condition_outcome_map.get(condition_id, "")

            # Build per-market asset symbol: PM:{slug}-{outcome}
            if slug and outcome:
                asset_symbol = f"PM:{slug}-{outcome}"
            elif slug:
                asset_symbol = f"PM:{slug}-{condition_id[:8]}"
            else:
                asset_symbol = (
                    f"PM:{condition_id[:16]}" if condition_id else "PM:unknown"
                )

            # Unique ID: tx_hash + condition_id (same tx can have multiple redemptions)
            source_transaction_id = (
                f"{tx_hash}_{condition_id}" if condition_id else tx_hash
            )

            # Parse timestamp
            dt = None
            if timestamp:
                dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)

            # All activities are trades: shares ↔ USDC
            transaction_type = "trade"

            if activity_type == "TRADE":
                if side == "BUY":
                    direction = "inflow"  # shares arriving in portfolio
                    source_transaction_type = "buy"
                elif side == "SELL":
                    direction = "outflow"  # shares leaving portfolio
                    source_transaction_type = "sell"
                else:
                    direction = "neutral"
                    source_transaction_type = "trade"
            elif activity_type == "SYNTHETIC_CLOSE":
                direction = "outflow"  # synthetic close for losing position
                source_transaction_type = "synthetic-close"
            elif activity_type == "REDEEM":
                direction = (
                    "neutral"  # audit-only (PnL handled by resolution synthetic)
                )
                transaction_type = "memo"
                source_transaction_type = "redeem"
            else:
                direction = "neutral"
                transaction_type = "cost"
                source_transaction_type = (
                    activity_type.lower() if activity_type else "unknown"
                )

            # Price per share in USDC
            if activity_type == "REDEEM" and shares > 0:
                # REDEEM price = usdcSize / shares (1.0 for winners)
                price_per_share = float(Decimal(str(usdc_size)) / Decimal(str(shares)))
            elif raw_price:
                price_per_share = float(raw_price)
            else:
                price_per_share = 0.0

            # Build tags with market context
            tags = {
                "polymarket_type": activity_type,
                "market_title": title,
                "outcome": outcome,
                "outcome_index": outcome_index,
                "shares": float(shares),
                "price_per_share": price_per_share,
                "usdc_size": float(usdc_size),
                "event_slug": event_slug,
                "slug": slug,
                "condition_id": condition_id,
                "asset_token_id": asset_token_id,
            }
            if side:
                tags["side"] = side
            if item.get("_synthetic"):
                tags["synthetic"] = True

            # PM trades don't need from/to accounts — the Polygon child connector
            # handles USDC transfers with proper from/to, and the PnL engine
            # ignores from/to on trades anyway.
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
                source_asset_symbol=asset_symbol,
                source_price_quote_asset_symbol="USDC",
                quantity=float(shares),
                price=price_per_share,
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
        return False

    def get_balance(self) -> List[BalanceEntry]:
        """
        Position balances are not reported here; USDC cash comes from the
        Polygon child, and open positions from the PnL engine's lot state.
        """
        return []
