"""
Base connector class for all exchange connectors.
Defines the interface and common functionality for exchange-specific implementations.
"""

import json
import os
import logging
from abc import ABC, abstractmethod
from datetime import datetime
from logging.handlers import RotatingFileHandler
from typing import Generator, Dict, List, Any, Optional

from backend.config.loader import configure_logging, is_test_mode, get_connectors_output_path

from backend.db.models import NormalizedTransaction

log = configure_logging("base_connector")


class BaseConnector(ABC):
    """
    Abstract base class for exchange connectors.
    All exchange-specific connectors should inherit from this class.

    Subclasses must define:
    - exchange_name: Abstract property returning the exchange/source name
    - get_raws(): Abstract method to fetch raw data from the exchange/blockchain
    - raw_to_normalized(): Abstract method to convert raw data to NormalizedTransaction
    """
    
    # Flag to identify hub connectors (overridden in BaseHubConnector)
    is_hub_connector = False

    def __init__(
        self,
        account_id: Optional[int] = None,
        connector_id: Optional[int] = None,
        config: Optional[Dict[str, Any]] = None,
    ):
        """
        Initialize the connector.

        Args:
            account_id: The Account ID this connector belongs to (from accounts table)
            connector_id: The AccountConnector ID for this specific connector instance
            config: Connector configuration dict (may include test_mode, test_file_path, 
                   parent_output_path, since_datetime)

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
        
        # Per-connector test mode takes priority over global setting
        self._test_mode = self.config.get("test_mode", None)
        
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
                encoding="utf-8"
            )
            
            # Set format
            formatter = logging.Formatter(
                "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S"
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
        
        Priority:
            1. Per-connector config["test_mode"] (if explicitly set)
            2. Global TEST_MODE from environment/settings
        """
        if self._test_mode is not None:
            return self._test_mode
        return is_test_mode()

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

        log.info(
            f"💾 [{self.connector_name}] Raw data logged to {raw_file}"
        )
        
        # Also log to file logger if available
        if self.file_logger:
            self.file_logger.info(f"Saved {len(trades)} raw items to {raw_file}")
        
        return raw_file
