"""
Hyperliquid Transfers connector: Fetch deposit and withdrawal history on L1.
Uses the non-funding ledger updates endpoint.
Modeled as transfer transactions for bundling with on-chain EVM transactions.
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

log = configure_logging("hyperliquid_transfers")

# Time window for pagination (30 days)
WINDOW_DAYS = 30
MS_PER_DAY = 86_400_000

# Rate-limit / retry settings
MAX_RETRIES = 5
INITIAL_BACKOFF = 2.0   # seconds, doubles each retry
REQUEST_DELAY = 0.3     # polite delay between every request


class HyperliquidTransfersConnector(BaseConnector):
    """
    Hyperliquid L1 deposits/withdrawals connector.

    Fetches non-funding ledger updates and maps deposit/withdraw entries
    to NormalizedTransaction with transaction_type="transfer".

    These can be bundled with on-chain Arbitrum bridge transactions to
    create INTERNAL_TRANSFER units that preserve USDC cost basis.
    """

    @property
    def connector_name(self) -> str:
        return "hyperliquid_transfers"

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
                f"✅ Hyperliquid Info API initialized for transfers: {self._wallet_address}"
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
        Fetch non-funding ledger updates (deposits + withdrawals) with
        time-windowed pagination.
        """
        if self.test_mode:
            for item in self._load_test_data():
                yield item
            return

        start_ms = self.since_timestamp_ms or 0
        now_ms = int(_time.time() * 1000)
        total_yielded = 0

        self.update_progress(
            operation="Fetching transfers",
            current=0,
            total=0,
            log_message="Starting Hyperliquid transfers fetch",
            fetched_count=0,
        )

        window_start = start_ms
        while window_start < now_ms:
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping transfer fetch")
                break

            window_end = min(window_start + WINDOW_DAYS * MS_PER_DAY, now_ms)

            try:
                _time.sleep(REQUEST_DELAY)
                entries = self._call_with_retry(
                    "user_non_funding_ledger_updates",
                    self._info.user_non_funding_ledger_updates,
                    self._wallet_address,
                    window_start,
                    window_end,
                )
            except Exception as e:
                log.error(f"❌ API error fetching transfers: {e}")
                raise ConnectorAPIError(
                    message=f"Failed to fetch transfers: {e}",
                    connector_name=self.connector_name,
                    operation="user_non_funding_ledger_updates",
                    reason=ErrorReason.API_ERROR,
                    retryable=True,
                    original_error=e,
                )

            if entries:
                for entry in entries:
                    # Only yield deposit/withdraw entries, skip other types
                    delta = entry.get("delta", {})
                    entry_type = delta.get("type", "")
                    if entry_type in ("deposit", "withdraw"):
                        total_yielded += 1
                        yield entry

                self.update_progress(
                    operation="Fetching transfers",
                    current=total_yielded,
                    total=0,
                    log_message=f"Fetched batch (total transfers: {total_yielded})",
                    fetched_count=total_yielded,
                )

            window_start = window_end

        self.update_progress(
            operation="Completed",
            current=total_yielded,
            total=total_yielded,
            log_message=f"✅ Total transfers: {total_yielded}",
            fetched_count=total_yielded,
        )
        log.info(f"✅ Total transfers: {total_yielded}")

    # ------------------------------------------------------------------
    # Normalization
    # ------------------------------------------------------------------

    def raw_to_normalized(self, entry: dict) -> NormalizedTransaction:
        """
        Map a Hyperliquid ledger entry to NormalizedTransaction.

        Entry shape:
        {
            "time": 1763602992077,
            "hash": "0x61d4ba76...",
            "delta": {
                "type": "deposit",    # or "withdraw"
                "usdc": "57.85"
            }
        }
        """
        try:
            delta = entry["delta"]
            entry_type = delta["type"]  # "deposit" or "withdraw"
            usdc_amount = Decimal(delta["usdc"])
            timestamp_ms = int(entry["time"])
            tx_hash = entry.get("hash", "")

            dt = datetime.fromtimestamp(timestamp_ms / 1000.0, tz=timezone.utc)

            is_deposit = entry_type == "deposit"
            direction = "inflow" if is_deposit else "outflow"
            quantity = abs(float(usdc_amount))

            # Build the normalized transaction
            tx = NormalizedTransaction(
                source="hyperliquid-transfers",
                account_id=self.account_id,
                source_account=self.connector_name,
                source_transaction_id=f"{entry_type}_{tx_hash}_{timestamp_ms}",
                date_time=dt,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type=entry_type,
                source_asset_symbol="USDC",
                quantity=quantity,
                network_transaction_id=tx_hash,
                network="arbitrum",  # Hyperliquid L1 bridges via Arbitrum
            )

            # Set the known side of from/to with both account ID and address.
            # Pipeline enrichment (OnChainAddressEnrichmentStage →
            # AccountResolutionStage) will fill the other side from the
            # on-chain transaction.
            wallet = self._wallet_address or self._get_account_identifier()
            if is_deposit:
                # Deposit into HL: current account is the destination
                tx.to_account_id = self.account_id
                tx.source_to_account = wallet
            else:
                # Withdrawal from HL: current account is the source
                tx.from_account_id = self.account_id
                tx.source_from_account = wallet

            return tx
        except Exception as e:
            error_msg = f"Failed to map Hyperliquid transfer: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e
