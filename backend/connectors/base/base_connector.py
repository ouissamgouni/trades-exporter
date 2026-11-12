"""
Base connector class for all exchange connectors.
Defines the interface and common functionality for exchange-specific implementations.
"""

import json
import os
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from logging.handlers import RotatingFileHandler
from typing import Generator, Dict, List, Any, Optional

from backend.config.loader import configure_logging, get_connectors_output_path
from backend.core.utils import is_test_mode

from backend.db.models import NormalizedTransaction, ensure_utc

log = configure_logging("base_connector")

class _FetchComplete:
    """Hub marker yielded as normalized item once a child connector yielded its last item."""

    def __repr__(self):
        return "FETCH_COMPLETE"

    def __bool__(self):
        # Falsy so consumers guarding with `if normalized_item:` never process it
        return False


FETCH_COMPLETE = _FetchComplete()

# yield_raws() may yield {FETCH_ERROR_KEY: message} for a partial fetch failure (e.g. one currency/window):
# it is reported as an item error (connector ends in WARNING) instead of being swallowed.
FETCH_ERROR_KEY = "_fetch_error"

# CCXT unified transfer statuses for which no funds moved
TERMINAL_FAILED_TRANSFER_STATUSES = frozenset({"canceled", "cancelled", "failed", "rejected"})


@dataclass
class BalanceEntry:
    """A single asset balance as reported by the connector's API."""

    asset_symbol: str  # e.g. "BTC", "ETH", "USDT"
    total: Decimal  # Total balance (available + locked/staked)
    available: Decimal = Decimal(0)  # Available for trading/transfer
    locked: Decimal = Decimal(0)  # In open orders, staking, etc.
    chain: Optional[str] = None  # Network/chain (for on-chain connectors)
    contract_address: Optional[str] = (
        None  # Token contract (None for native coins / CEX)
    )
    # Set by BalanceService
    asset_id: Optional[int] = None
    match_symbol: Optional[str] = (
        None  # Distinct key when the contract is not the ticker's real asset
    )
    spam_reason: Optional[str] = None  # "spam_rule" | "rejected_transactions"
    raw: Dict[str, Any] = field(default_factory=dict)  # Original response data


class BaseConnector(ABC):
    """
    Abstract base class for exchange connectors.
    All exchange-specific connectors should inherit from this class.

    Subclasses must define:
    - connector_name: Abstract property returning the exchange/source name
    - yield_raws(): Generator method to fetch and yield raw data from the exchange/blockchain
    - raw_to_normalized(): Abstract method to convert raw data to NormalizedTransaction

    Streaming architecture:
    - yield_raws() yields raw items as they are fetched (enables immediate processing)
    - yield_normalized() consumes yield_raws() and applies normalization per item
    - This allows processing (normalize, enrich, persist) to happen incrementally
    """

    # Flag to identify hub connectors (overridden in BaseHubConnector)
    is_hub_connector = False

    def __init__(
        self,
        account_id: Optional[int] = None,
        connector_id: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[Any] = None,
        abort_event: Optional[Any] = None,
    ):
        """
        Initialize the connector.

        Args:
            account_id: The Account ID this connector belongs to (from accounts table)
            connector_id: The AccountConnector ID for this specific connector instance
            config: Connector configuration dict (may include test_mode, test_file_path,
                   parent_output_path, since_datetime)
            progress_callback: Optional callback function for progress reporting
            abort_event: Optional threading.Event for abort signaling

        Note: Test mode priority:
            1. Per-connector config["test_mode"] (if set)
            2. Global TEST_MODE environment variable / settings.yaml

        Note: since_datetime in config:
            If provided, the connector should only fetch transactions since this datetime.
            This enables incremental sync for connectors that support it.
        """
        self.account_id = account_id
        self.connector_id = connector_id
        self.config = config or {}
        self.exchange = None
        self._progress_callback = progress_callback
        self._abort_event = abort_event

        # Per-connector test mode takes priority over global setting
        self._test_mode = self.config.get("test_mode", None)

        # Renormalize mode: read from raw_transactions DB instead of external APIs
        self._renormalize_mode = self.config.get("renormalize_mode", False)

        # Since datetime for incremental sync (if supported by connector)
        self._since_datetime: Optional[datetime] = self.config.get("since_datetime")

        # Build output path: {parent_output_path}/{connector_name}/{timestamp}/
        parent_path = self.config.get("parent_output_path")
        if parent_path is None:
            parent_path = get_connectors_output_path()

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.output_path = os.path.join(parent_path, self.connector_name, timestamp)

        # Setup file logging if not disabled
        self.file_logger = None
        if not self.config.get("disable_file_output", False):
            self._setup_file_logger()

        mode_str = "TEST MODE" if self.test_mode else "LIVE MODE"
        account_info = f" (account_id={account_id})" if account_id else ""
        since_info = f" since={self._since_datetime}" if self._since_datetime else ""
        log.info(
            f"Initialized {self.__class__.__name__} for {self.connector_name}{account_info} [{mode_str}]{since_info}"
        )
        log.info(f"Output path: {self.output_path}")

    @property
    def since_datetime(self) -> Optional[datetime]:
        """Get the since datetime for incremental sync, or None for full sync."""
        return self._since_datetime

    @property
    def since_timestamp_ms(self) -> Optional[int]:
        """Get the since datetime as milliseconds timestamp (for CCXT APIs)."""
        if self._since_datetime:
            return int(self._since_datetime.timestamp() * 1000)
        return None

    def _setup_file_logger(self):
        """
        Setup rotating file logger for this connector.
        Logs are written to {output_path}/log/connector.log with 10MB max size and 3 backups.
        """
        try:
            log_dir = os.path.join(self.output_path, "log")
            os.makedirs(log_dir, exist_ok=True)

            log_file = os.path.join(log_dir, "connector.log")

            # Create rotating file handler (10MB max, 3 backups)
            handler = RotatingFileHandler(
                log_file,
                maxBytes=10 * 1024 * 1024,  # 10MB
                backupCount=3,
                encoding="utf-8",
            )

            # Set format
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            handler.setFormatter(formatter)

            # Get the structlog logger's underlying logger and add handler
            self.file_logger = logging.getLogger(f"connector.{self.connector_name}")
            self.file_logger.addHandler(handler)
            self.file_logger.setLevel(logging.INFO)
            self.file_logger.propagate = False  # Prevent duplicate logs

            log.info(f"📝 [{self.connector_name}] File logging enabled: {log_file}")
        except Exception as e:
            log.error(f"❌ [{self.connector_name}] Failed to setup file logger: {e}")
            self.file_logger = None

    def _get_account_identifier(self) -> str:
        """Get the account identifier for use in source_from_account/source_to_account fields.

        Returns the account's address_or_identifier if available, otherwise falls back
        to the account name. This provides a stable, human-readable identifier that can
        be used for account mapping and display.

        Returns:
            str: Account identifier (address_or_identifier or account name)
        """
        identifier = self.config.get("_account_address_or_identifier")
        if identifier:
            return str(identifier)
        # Fallback to account name
        account_name = self.config.get("_account_name")
        if account_name:
            return str(account_name)
        # Last resort: use account ID
        return str(self.account_id) if self.account_id else "unknown"

    def cleanup(self):
        """
        Cleanup resources, particularly file handlers.
        Call this when the connector is done to prevent file handle leaks.
        """
        if self.file_logger:
            # Close and remove all handlers
            for handler in self.file_logger.handlers[:]:
                handler.close()
                self.file_logger.removeHandler(handler)
            self.file_logger = None

    @property
    @abstractmethod
    def connector_name(self) -> str:
        """
        Return the name of the exchange/source (e.g., 'binance', 'mexc', 'blockscout_base').
        Must be implemented by subclasses.
        """

    @abstractmethod
    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch and yield raw data from the exchange/blockchain.
        Must be implemented by each connector as a generator.

        This method should yield items as they are fetched, enabling
        incremental processing without waiting for all data to be collected.

        For parallel fetching (e.g., multiple symbols), use a queue-based
        pattern where worker threads put items into a queue and the main
        thread yields from the queue.

        Yields:
            Dict[str, Any]: Raw transaction/trade/event dictionaries

        Example:
            For CEX with streaming:
                for symbol in self.get_symbols():
                    for trade in self.fetch_trades(symbol):
                        yield trade

            For parallel fetching with queue:
                queue = Queue()
                # Start worker threads that put items into queue
                while not done:
                    item = queue.get()
                    yield item
        """

    @abstractmethod
    def raw_to_normalized(self, raw_item: dict):
        """
        Convert raw API response to NormalizedTransaction dataclass.
        Must be implemented by subclasses.

        Can return either:
        - A single NormalizedTransaction object
        - A generator yielding multiple NormalizedTransaction objects (for multi-yield support)

        Args:
            raw_item: Raw data from exchange/source API

        Returns:
            NormalizedTransaction | Generator[NormalizedTransaction, None, None]:
                Single transaction or generator yielding multiple transactions
        """

    def is_settled_transfer(self, raw_item: dict, kind: str) -> bool:
        """True for 'ok'; False for terminal non-success (canceled/failed: nothing moved); raises otherwise."""
        status = str(raw_item.get("status", "")).lower()
        if status == "ok":
            return True
        if status in TERMINAL_FAILED_TRANSFER_STATUSES:
            log.info(
                f"⏭️ [{self.connector_name}] Ignoring {status} {kind.lower()} {raw_item.get('id', 'unknown')}"
            )
            return False
        raise ValueError(f"{kind} status is not 'ok': {status}")

    # ------------------------------------------------------------------
    # Balance API (opt-in)
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        """Whether this connector can fetch live balances.

        Override and return ``True`` in subclasses that implement
        ``get_balance()``.
        """
        return False

    def get_balance(self) -> List[BalanceEntry]:
        """Fetch current balances from the connector's API.

        Subclasses that set ``supports_balance = True`` must override this.

        Returns:
            List of BalanceEntry objects, one per asset with non-zero balance.
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} does not implement get_balance()"
        )

    @property
    def test_mode(self) -> bool:
        """
        Check if connector is in test mode.

        Priority:
            1. Per-connector config["test_mode"] (if explicitly set)
            2. Global TEST_MODE from environment/settings
        """
        return self._test_mode if self._test_mode is not None else is_test_mode()

    @property
    def renormalize_mode(self) -> bool:
        """Check if connector is in renormalize mode (reading from raw_transactions DB)."""
        return self._renormalize_mode

    def _yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw data, checking renormalize and test modes first.

        In renormalize mode, reads from raw_transactions DB.
        In test mode, loads data from test fixtures and yields items.
        In live mode, yields from yield_raws() and collects items for JSON dump.

        Yields:
            Dict[str, Any]: Raw data items
        """
        if self._renormalize_mode and not getattr(self, "is_hub_connector", False):
            # Hub connectors skip this — they delegate to child connectors via yield_raws()
            # Only leaf connectors read directly from raw_transactions DB
            from backend.db.database import get_session
            from backend.db.repositories.raw_transaction_repository import (
                RawTransactionRepository,
            )

            log.info(
                f"🔄 [{self.connector_name}] Renormalize mode: reading from raw_transactions DB (connector_id={self.connector_id})"
            )

            # Get total count for progress tracking
            total_count = 0
            with get_session() as count_session:
                count_repo = RawTransactionRepository(count_session)
                total_count = count_repo.count_by_connector_id(self.connector_id)

            self.update_progress(
                "Renormalizing",
                0,
                total_count,
                f"Loading {total_count} raw transactions from DB",
                fetched_count=0,
            )

            item_count = 0
            with get_session() as session:
                repo = RawTransactionRepository(session)
                for batch in repo.iter_by_connector_id(self.connector_id):
                    for raw_tx in batch:
                        item_count += 1
                        if item_count % 50 == 0 or item_count == total_count:
                            self.update_progress(
                                "Renormalizing",
                                item_count,
                                total_count,
                                fetched_count=item_count,
                            )
                        self._raw_origin_source = raw_tx.source
                        yield raw_tx.raw_data
            self._raw_origin_source = None

            self.update_progress(
                "Renormalize complete",
                item_count,
                item_count,
                f"Yielded {item_count} raw items from DB",
                fetched_count=item_count,
            )
            log.info(
                f"📦 [{self.connector_name}] Renormalize: yielded {item_count} raw items from DB"
            )
            return

        if self.test_mode:
            test_data = self._load_test_data()
            # If None is returned, hub connector - delegate to yield_raws()
            if test_data is None:
                yield from self.yield_raws()
            else:
                for item in test_data:
                    yield item
        else:
            # Collect items for JSON dump while yielding
            collected_raws = []
            for raw_item in self.yield_raws():
                if not (isinstance(raw_item, dict) and FETCH_ERROR_KEY in raw_item):
                    collected_raws.append(raw_item)
                yield raw_item
            # Dump all collected raws to JSON after streaming completes
            self.dump_trades_to_json(collected_raws)

    def get_test_data_path(self) -> str:
        """
        Get the path to test data file for this connector.

        Priority:
            1. Per-connector config["test_file_path"] (uploaded fixture)
            2. Default path: tests/e2e/fixtures/{connector_name}.json

        Uses the connector's connector_name property for the default filename.
        For example:
            - connector_name="binance_trx" -> binance_trx.json
            - connector_name="blockscout_normal_tx_base" -> blockscout_normal_tx_base.json

        Override this method only if you need a custom path (e.g., for hub connectors
        that aggregate other connectors and have no data of their own).

        Returns:
            str: Path to the test data JSON file, or None for hub connectors
        """
        # Get workspace root (go up from backend/connectors/base to workspace)
        import os

        base_connector_dir = os.path.dirname(
            os.path.abspath(__file__)
        )  # backend/connectors/base
        connectors_dir = os.path.dirname(base_connector_dir)  # backend/connectors
        backend_dir = os.path.dirname(connectors_dir)  # backend
        workspace_root = os.path.dirname(backend_dir)  # workspace root

        # Priority 1: Per-connector uploaded fixture from config
        if self.config.get("test_file_path"):
            return os.path.join(backend_dir, self.config["test_file_path"])

        # Priority 2: Default path based on connector_name
        # Path: workspace_root/backend/tests/e2e/fixtures/{connector_name}.json
        return os.path.join(
            workspace_root,
            "backend",
            "tests",
            "e2e",
            "fixtures",
            f"{self.connector_name}.json",
        )

    def _load_test_data(self) -> List[Dict[str, Any]]:
        """
        Load test data from JSON file using connector's get_test_data_path().

        Returns:
            List[Dict[str, Any]]: List of test data items
        """
        test_data_file = self.get_test_data_path()

        if not test_data_file:
            # Hub connectors return None - they don't have their own test data
            # They will delegate to child connectors via get_raws()
            log.debug(f"[{self.connector_name}] No test data path (hub connector)")
            return None  # Signal that we should call get_raws() instead

        try:
            with open(test_data_file, "r") as f:
                data = json.load(f)
                log.info(
                    f"📁 [{self.connector_name}] Loaded {len(data)} test items from {test_data_file}"
                )
                return data
        except FileNotFoundError:
            log.error(
                f"[{self.connector_name}] Test data file not found: {test_data_file}"
            )
            return []
        except json.JSONDecodeError as e:
            log.error(
                f"[{self.connector_name}] Invalid JSON in test data file {test_data_file}: {e}"
            )
            return []

    def yield_normalized(
        self,
    ) -> Generator[
        tuple[Dict[str, Any], NormalizedTransaction | None, str | None], None, None
    ]:
        """
        Stream raw data and yield normalized items with error handling.
        This method is implemented in the base class and should not be overridden.

        The method:
        1. Iterates over _yield_raws() generator (handles test mode automatically)
        2. Applies raw_to_normalized() to each item as it arrives
        3. Handles generators from raw_to_normalized() (multi-yield support)
        4. Handles errors gracefully by yielding error string

        This enables incremental processing - each item can be normalized,
        enriched, and persisted as soon as it's fetched, without waiting
        for all data to be collected.

        Yields:
            tuple: (raw_item, normalized_item, None) for successful mapping
            tuple: (raw_item, None, error_string) for mapping failures

        Example:
            for raw_item, normalized, error in connector.yield_normalized():
                if error:
                    handle_error(error)
                else:
                    process(normalized)  # Process immediately as items stream in
        """
        import types

        log.info(f"🔄 [{self.connector_name}] Starting data stream...")

        history_cutoff = None if self._renormalize_mode else self._history_cutoff()
        skipped_before_cutoff = 0
        ignored_count = 0

        item_count = 0
        # Use _yield_raws() generator which handles test mode automatically
        for raw_item in self._yield_raws():
            if isinstance(raw_item, dict) and FETCH_ERROR_KEY in raw_item:
                log.warning(f"⚠️ [{self.connector_name}] Partial fetch failure: {raw_item[FETCH_ERROR_KEY]}")
                yield (raw_item, None, f"Fetch failed: {raw_item[FETCH_ERROR_KEY]}")
                continue
            item_count += 1
            try:
                # Map to normalized format immediately
                result = self._mapper_for_raw_origin().raw_to_normalized(raw_item)

                # Check if result is a generator (multi-yield support)
                results = (
                    result if isinstance(result, types.GeneratorType) else [result]
                )
                for normalized in results:
                    if normalized is FETCH_COMPLETE:
                        yield (raw_item, normalized, None)
                        continue
                    if normalized is None:
                        ignored_count += 1
                        continue
                    if (
                        history_cutoff
                        and normalized is not None
                        and normalized.date_time
                        and ensure_utc(normalized.date_time) <= history_cutoff
                    ):
                        skipped_before_cutoff += 1
                        continue
                    yield (raw_item, normalized, None)
            except Exception as e:
                # Yield error tuple to maintain streaming behavior
                error_msg = str(e)
                yield (raw_item, None, error_msg)
                log.warning(
                    f"⚠️ [{self.connector_name}] Failed to map item {raw_item.get('id', 'unknown')}: {e}"
                )

        if item_count == 0:
            log.warning(f"⚠️ [{self.connector_name}] No data fetched")
        if ignored_count:
            log.info(
                f"⏭️ [{self.connector_name}] Ignored {ignored_count} raw item(s) with nothing to record "
                f"(e.g. canceled/failed transfers)"
            )
        if skipped_before_cutoff:
            log.info(
                f"⏭️ [{self.connector_name}] Skipped {skipped_before_cutoff} items at or before "
                f"history_cutoff {history_cutoff.isoformat()} (owned by the previous provider)"
            )

    def _history_cutoff(self) -> Optional[datetime]:
        """Set when a connector switches provider: older history belongs to the previous provider."""
        raw = (self.config or {}).get("history_cutoff")
        if not raw:
            return None
        try:
            return ensure_utc(datetime.fromisoformat(str(raw)))
        except (TypeError, ValueError):
            log.warning(
                f"[{self.connector_name}] Ignoring invalid history_cutoff {raw!r}"
            )
            return None

    def _mapper_for_raw_origin(self) -> "BaseConnector":
        """Connector able to read the current raw: the provider that stored it (renormalize)."""
        source = getattr(self, "_raw_origin_source", None)
        if not source:
            return self
        cache = self.__dict__.setdefault("_origin_mappers", {})
        if source not in cache:
            from backend.connectors.connector_registry import get_connector_registry

            mapper = self
            origin = get_connector_registry().resolve_raw_origin(source)
            if origin and not isinstance(self, origin[0]):
                cls, chain = origin
                try:
                    mapper = cls(
                        wallet_address=getattr(self, "wallet_address", ""),
                        chain_name=chain,
                        account_id=self.account_id,
                        connector_id=self.connector_id,
                        config={"renormalize_mode": True, "disable_file_output": True},
                    )
                except Exception as e:
                    log.warning(
                        f"[{self.connector_name}] No mapper for raw source {source!r}: {e}"
                    )
            cache[source] = mapper
        return cache[source]

    def dump_trades_to_json(self, trades: List[Dict]) -> str:
        """Save raw trades data to JSON file in connector's output directory."""
        # Skip if file output is disabled
        if self.config.get("disable_file_output", False):
            return ""

        # Skip for hub connectors (they don't produce raw data)
        if self.is_hub_connector:
            log.debug(f"[{self.connector_name}] Skipping raw data dump (hub connector)")
            return ""

        if not trades:
            return ""

        # Save to {output_path}/raw.json
        os.makedirs(self.output_path, exist_ok=True)
        raw_file = os.path.join(self.output_path, "raw.json")

        # Write to file
        with open(raw_file, "w") as f:
            json.dump(trades, f, indent=2, default=str)

        log.info(f"💾 [{self.connector_name}] Raw data logged to {raw_file}")

        # Also log to file logger if available
        if self.file_logger:
            self.file_logger.info(f"Saved {len(trades)} raw items to {raw_file}")

        return raw_file

    def update_progress(
        self,
        operation: str,
        current: int,
        total: int,
        log_message: Optional[str] = None,
        fetched_count: Optional[int] = None,
    ):
        """
        Update progress via callback if configured.

        Args:
            operation: Description of current operation (e.g., "Fetching BTC/USDT")
            current: Current progress count
            total: Total items to process
            log_message: Optional log message to display
            fetched_count: Optional count of items fetched from API so far
        """
        if self._progress_callback and self.connector_id:
            self._progress_callback(
                self.connector_id,
                operation,
                current,
                total,
                log_message,
                fetched_count=fetched_count,
            )

    def is_abort_requested(self) -> bool:
        """
        Check if abort has been requested.

        Returns:
            True if abort event is set, False otherwise
        """
        if self._abort_event:
            return self._abort_event.is_set()
        return False
