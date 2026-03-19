"""
Hyperliquid Funding connector: Fetch funding rate payment history.
Funding payments are periodic (≈8h) transfers of USDC between long/short holders.
Modeled as transfer transactions (USDC inflow/outflow).
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Any, List, Generator, Optional
import time as _time

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("hyperliquid_funding")

# Hyperliquid recommends querying funding in time windows
# We use 30-day windows to avoid overly large responses
WINDOW_DAYS = 30
MS_PER_DAY = 86_400_000

# Rate-limit / retry settings
MAX_RETRIES = 5
INITIAL_BACKOFF = 2.0   # seconds, doubles each retry
REQUEST_DELAY = 0.3     # polite delay between every request

# Default start date when no since_datetime is configured.
# Prevents walking from Unix epoch (1970) to now in 30-day windows (~681 empty API calls).
# Oct 1, 2025 00:00 UTC — aligns with accounts.yaml default start_datetime.
DEFAULT_START_MS = 1_727_740_800_000  # 2025-10-01T00:00:00Z


class HyperliquidFundingConnector(BaseConnector):
    """
    Hyperliquid funding rate payment connector.

    Fetches funding history and maps each payment to a NormalizedTransaction
    with transaction_type="transfer" and direction based on payment sign.

    Positive usdc = received funding (inflow).
    Negative usdc = paid funding (outflow).
    """

    @property
    def connector_name(self) -> str:
        return "hyperliquid_funding"

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

        self._wallet_address = (config or {}).get(
            "wallet_address",
            (config or {}).get("_account_address_or_identifier", ""),
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
                f"✅ Hyperliquid Info API initialized for funding: {self._wallet_address}"
            )
        except Exception as e:
            log.error(f"❌ Failed to initialize Hyperliquid SDK: {e}")
            raise

    # ------------------------------------------------------------------
    # Retry helper
    # ------------------------------------------------------------------

    def _call_with_retry(self, operation: str, func, *args, **kwargs):
        """Call *func* with exponential back-off on HTTP 429."""
        backoff = INITIAL_BACKOFF
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                if "429" in str(e):
                    if attempt < MAX_RETRIES:
                        log.warning(
                            f"⚠️ Rate limited (429) on {operation}, "
                            f"retrying in {backoff:.0f}s "
                            f"(attempt {attempt}/{MAX_RETRIES})"
                        )
                        _time.sleep(backoff)
                        backoff *= 2
                        continue
                    else:
                        log.error(
                            f"❌ Rate limited on {operation} "
                            f"after {MAX_RETRIES} retries"
                        )
                raise

    # ------------------------------------------------------------------
    # Raw data fetching
    # ------------------------------------------------------------------

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch funding history with time-windowed pagination.
        The API accepts startTime/endTime so we walk forward in WINDOW_DAYS chunks.
        """
        if self.test_mode:
            for item in self._load_test_data():
                yield item
            return

        start_ms = self.since_timestamp_ms or DEFAULT_START_MS
        now_ms = int(_time.time() * 1000)
        total_yielded = 0

        self.update_progress(
            operation="Fetching funding",
            current=0,
            total=0,
            log_message="Starting Hyperliquid funding fetch",
            fetched_count=0,
        )

        window_start = start_ms
        while window_start < now_ms:
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping funding fetch")
                break

            window_end = min(window_start + WINDOW_DAYS * MS_PER_DAY, now_ms)

            try:
                _time.sleep(REQUEST_DELAY)
                entries = self._call_with_retry(
                    "user_funding_history",
                    self._info.user_funding_history,
                    self._wallet_address,
                    window_start,
                    window_end,
                )
            except Exception as e:
                log.error(f"❌ API error fetching funding: {e}")
                raise ConnectorAPIError(
                    message=f"Failed to fetch funding: {e}",
                    connector_name=self.connector_name,
                    operation="user_funding_history",
                    reason=ErrorReason.API_ERROR,
                    retryable=True,
                    original_error=e,
                )

            if entries:
                for entry in entries:
                    total_yielded += 1
                    yield entry

                self.update_progress(
                    operation="Fetching funding",
                    current=total_yielded,
                    total=0,
                    log_message=f"Fetched {len(entries)} funding entries (total: {total_yielded})",
                    fetched_count=total_yielded,
                )

            window_start = window_end

        self.update_progress(
            operation="Completed",
            current=total_yielded,
            total=total_yielded,
            log_message=f"✅ Total funding entries: {total_yielded}",
            fetched_count=total_yielded,
        )
        log.info(f"✅ Total funding entries: {total_yielded}")

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    def raw_to_normalized(self, entry: dict) -> NormalizedTransaction:
        """
        Map a Hyperliquid funding entry to NormalizedTransaction.

        Entry shape:
        {
            "time": 1763596800000,
            "hash": "0x000...000",
            "delta": {
                "type": "funding",
                "coin": "BTC",
                "usdc": "0.018261",    # positive = received, negative = paid
                "szi": "-0.003412",
                "fundingRate": "0.0000125",
                "nSamples": 5
            }
        }
        """
        try:
            delta = entry["delta"]
            coin = delta["coin"]
            usdc_amount = Decimal(delta["usdc"])
            funding_rate = delta.get("fundingRate", "0")
            position_size = delta.get("szi", "0")
            timestamp_ms = int(entry["time"])
            tx_hash = entry.get("hash", "")

            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            # Positive USDC = we received funding (inflow)
            # Negative USDC = we paid funding (outflow)
            direction = "inflow" if usdc_amount >= 0 else "outflow"
            quantity = abs(float(usdc_amount))

            # Compound source_transaction_id for uniqueness
            source_id = f"funding_{coin}_{timestamp_ms}"

            return NormalizedTransaction(
                source="hyperliquid-funding",
                account_id=self.account_id,
                source_account=self.connector_name,
                source_transaction_id=source_id,
                date_time=dt,
                direction=direction,
                transaction_type="margin",
                source_transaction_type="funding",
                source_asset_symbol="USDC",
                quantity=quantity,
                network_transaction_id=tx_hash,
                taxability_status="non_taxable",
                tags=[
                    {
                        "funding_rate": str(funding_rate),
                        "coin": coin,
                        "position_size": str(position_size),
                    }
                ],
            )
        except Exception as e:
            error_msg = f"Failed to map Hyperliquid funding entry: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e
