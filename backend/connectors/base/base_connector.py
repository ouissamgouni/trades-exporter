"""
Base connector class for all exchange connectors.
Defines the interface and common functionality for exchange-specific implementations.
"""

import json
import os
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Generator, Dict, List, Any, Optional, Callable

from backend.config.loader import configure_logging

from backend.db.models import NormalizedTransaction

log = configure_logging("base_connector")

# Type alias for progress callback
ProgressCallback = Callable[[int, str, int, int, Optional[str]], None]


class BaseConnector(ABC):
    """
    Abstract base class for exchange connectors.
    All exchange-specific connectors should inherit from this class.

    Subclasses must define:
    - exchange_name: Abstract property returning the exchange/source name
    - get_raws(): Abstract method to fetch raw data from the exchange/blockchain
    - raw_to_normalized(): Abstract method to convert raw data to NormalizedTransaction
    """

    def __init__(
        self,
        account_id: Optional[int] = None,
        connector_id: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ):
        """
        Initialize the connector.

        Args:
            account_id: The Account ID this connector belongs to (from accounts table)
            connector_id: The AccountConnector ID for this specific connector instance
            config: Connector configuration dict (may include test_mode, test_file_path)
            progress_callback: Optional callback to report progress updates.
                              Signature: (connector_id, operation, current, total, log_message)

        Note: Test mode priority:
            1. Per-connector config["test_mode"] (if set)
            2. Global TEST_MODE environment variable / settings.yaml
        """
        self.account_id = account_id
        self.connector_id = connector_id
        self.config = config or {}
        self.exchange = None
        self._progress_callback = progress_callback
        
        # Per-connector test mode takes priority over global setting
        self._test_mode = self.config.get("test_mode", None)

        mode_str = "TEST MODE" if self.test_mode else "LIVE MODE"
        account_info = f" (account_id={account_id})" if account_id else ""
        log.info(
            f"Initialized {self.__class__.__name__} for {self.connector_name}{account_info} [{mode_str}]"
        )

    def update_progress(
        self,
        operation: str,
        current: int,
        total: int,
        log_message: Optional[str] = None,
    ):
        """
        Report progress update via callback if available.
        
        Args:
            operation: Description of current operation (e.g., "Fetching BTC/USDT")
            current: Current progress count
            total: Total items to process
            log_message: Optional log message to record
        """
        if self._progress_callback and self.connector_id:
            self._progress_callback(
                self.connector_id,
                operation,
                current,
                total,
                log_message,
            )

    @property
    @abstractmethod
    def connector_name(self) -> str:
        """
        Return the name of the exchange/source (e.g., 'binance', 'mexc', 'blockscout_base').
        Must be implemented by subclasses.
        """

    @abstractmethod
    def get_raws(self) -> List[Dict[str, Any]]:
        """
        Fetch raw data from the exchange/blockchain.
        Must be implemented by each connector.

        Returns:
            List[Dict[str, Any]]: List of raw transaction/trade/event dictionaries

        Example:
            For CEX: return self.exchange.fetch_my_trades(symbol)
            For blockchain: return self.fetch_transactions(address)
        """

    @abstractmethod
    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        """
        Convert raw API response to NormalizedTransaction dataclass.
        Must be implemented by subclasses.

        Args:
            raw_item: Raw data from exchange/source API

        Returns:
            NormalizedTransaction: Typed dataclass with all transaction fields
        """

    @property
    def test_mode(self) -> bool:
        """
        Check if connector is in test mode.
        
        Test mode is determined by per-connector config["test_mode"].
        Defaults to False (live mode) if not explicitly set.
        """
        return self._test_mode if self._test_mode is not None else False

    def _get_raws(self) -> List[Dict[str, Any]]:
        """
        Get raw data, checking test mode first.

        In test mode, loads data from test fixtures.
        In live mode, calls get_raws() to fetch from API.

        Returns:
            List[Dict[str, Any]]: List of raw data items
        """
        if self.test_mode:
            test_data = self._load_test_data()
            # If None is returned, hub connector - call get_raws() to delegate to children
            if test_data is None:
                return self.get_raws()
            return test_data
        else:
            raw_data = self.get_raws()
            self.dump_trades_to_json(raw_data)
            return raw_data

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
            workspace_root, "backend", "tests", "e2e", "fixtures", f"{self.connector_name}.json"
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
        Fetch raw data and yield normalized items with error handling.
        This method is implemented in the base class and should not be overridden.

        The method:
        1. Calls _get_raws() to fetch all raw data (handles test mode automatically)
        2. Applies raw_to_normalized() to each item
        3. Handles errors gracefully by yielding error string

        Yields:
            tuple: (raw_item, normalized_item, None) for successful mapping
            tuple: (raw_item, None, error_string) for mapping failures

        Example:
            for raw_item, normalized, error in connector.yield_normalized():
                if error:
                    handle_error(error)
                else:
                    process(normalized)
        """
        log.info(f"🔄 [{self.connector_name}] Fetching data...")

        # Use _get_raws() which handles test mode automatically
        all_raws = self._get_raws()

        if not all_raws:
            log.warning(f"⚠️ [{self.connector_name}] No data fetched")
            return

        for raw_item in all_raws:
            try:
                # Map to normalized format
                normalized = self.raw_to_normalized(raw_item)
                yield (raw_item, normalized, None)
            except Exception as e:
                # Yield error tuple to maintain streaming behavior
                error_msg = str(e)
                yield (raw_item, None, error_msg)
                log.warning(
                    f"⚠️ [{self.connector_name}] Failed to map item {raw_item.get('id', 'unknown')}: {e}"
                )

    def dump_trades_to_json(self, trades: List[Dict]) -> str:
        if not trades:
            return ""

        # Get or create the output directory using connector_name
        output_dir = f"data/output/raw/{self.connector_name}"
        os.makedirs(output_dir, exist_ok=True)

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        combined_trades_file = f"{output_dir}/{timestamp}.json"

        # Write back to file
        with open(combined_trades_file, "w") as f:
            json.dump(trades, f, indent=2, default=str)

        log.info(
            f"💾 [{self.connector_name}] Raw data logged to {combined_trades_file}"
        )
        return combined_trades_file
