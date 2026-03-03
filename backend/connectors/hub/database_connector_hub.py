"""
DatabaseConnectorHub: Loads and orchestrates connectors from the database.

This hub uses AccountConnector configurations stored in the database
instead of hardcoded settings, enabling dynamic connector management via API.
"""

from datetime import datetime
from typing import Dict, Any, List, Optional, Generator, Tuple

from sqlmodel import Session

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.db.models import AccountConnector
from backend.services.connector_loader_service import ConnectorLoaderService
from backend.db.models import NormalizedTransaction

log = configure_logging("database_connector_hub")


class DatabaseConnectorHub(BaseHubConnector):
    """
    DatabaseConnectorHub loads connectors from the database.

    This hub provides:
    - Dynamic connector loading from AccountConnector table
    - Per-account connector configuration
    - Sync status tracking per connector
    - Credential resolution from env/vault
    - Incremental sync support via since_datetime
    """

    @property
    def connector_name(self) -> str:
        return "database_connector_hub"

    def __init__(
        self,
        session: Session,
        parent_output_path: str = None,
        connector_since_map: Optional[Dict[int, Optional[datetime]]] = None,
        connector_overrides: Optional[List[Any]] = None,
        progress_callback: Optional[callable] = None,
        renormalize_mode: bool = False,
    ):
        """
        Initialize the database connector hub.

        Args:
            session: Database session for loading connectors
            parent_output_path: Parent output path for connector logs and raw data
            connector_since_map: Optional dict mapping connector_id to since_datetime.
                - If datetime is provided, connector will sync from that datetime
                - If None, connector will perform full sync
                - If connector_id not in map, connector will perform full sync
            connector_overrides: Optional list of ConnectorOverride objects for
                enable/disable and test_mode overrides per connector.
            progress_callback: Optional callback for reporting connector progress.
                Signature: (connector_id, operation, current, total, log_message)
            renormalize_mode: If True, connectors will read from raw_transactions DB
                instead of external APIs.
        """
        self.session = session
        self.loader_service = ConnectorLoaderService(session)
        self.connector_instances: Dict[str, Any] = {}  # Keep for backward compatibility
        self.connector_configs: Dict[str, Dict[str, Any]] = {}  # Store configs for lazy init
        self._account_connector_map: Dict[str, AccountConnector] = {}
        self._parent_output_path = parent_output_path
        self._connector_since_map = connector_since_map or {}
        self._progress_callback = progress_callback
        self._renormalize_mode = renormalize_mode
        
        # Build override lookup maps
        self._override_enabled: Dict[int, bool] = {}
        self._override_test_mode: Dict[int, bool] = {}
        self._override_test_file: Dict[int, str] = {}
        self._override_symbols: Dict[int, List[str]] = {}
        self._override_currencies: Dict[int, List[str]] = {}
        
        if connector_overrides:
            for o in connector_overrides:
                if o.enabled is not None:
                    self._override_enabled[o.connector_id] = o.enabled
                if o.test_mode is not None:
                    self._override_test_mode[o.connector_id] = o.test_mode
                if o.test_file_path is not None:
                    self._override_test_file[o.connector_id] = o.test_file_path
                if o.symbols is not None:
                    self._override_symbols[o.connector_id] = o.symbols
                if o.currencies is not None:
                    self._override_currencies[o.connector_id] = o.currencies


        log.info(f"🔄 Initializing DatabaseConnectorHub ...")
        
        # Build config with parent_output_path for BaseHubConnector
        hub_config = {"parent_output_path": parent_output_path} if parent_output_path else {}
        if renormalize_mode:
            hub_config["renormalize_mode"] = True

        # Initialize as BaseHubConnector first to get self.output_path
        # IMPORTANT: Pass progress_callback to super().__init__() so it's not overwritten
        child_connectors_list = []  # Will populate after loading
        super().__init__(
            child_connectors=child_connectors_list,
            parallel_strategy="queue",
            config=hub_config,
            progress_callback=progress_callback,
        )

        # Load and initialize connectors from database
        self._load_connectors()

        # child_connectors will be built lazily during yield_raws
        # Keep this empty to avoid eager initialization
        self.child_connectors = []

        log.info("⚡ Parallel processing: (queue strategy with lazy initialization)")

    def _load_connectors(self):
        """Load and initialize all connectors from the database."""
        # Use get_all_connectors_with_accounts to allow runtime overrides to enable disabled connectors
        # The enabled check is done per-connector below, respecting _override_enabled
        all_connectors = self.loader_service.get_all_connectors_with_accounts()
        log.info(f"📋 Found {len(all_connectors)} connectors in database")

        # Get registry instance
        registry = get_connector_registry()
        onchain_configs = []

        for account_connector, account in all_connectors:
            connector_type = account_connector.connector_type
            connector_key = f"{account.name}_{connector_type}_{account_connector.id}"
            connector_id = account_connector.id

            enabled = self._override_enabled.get(connector_id, account_connector.enabled)
            log.info(f"⏭️ Connector {connector_id} ({account_connector.connector_type}) enabled status ={enabled} {'(overridden)' if connector_id in self._override_enabled else ''} ")
                
            if not enabled: 
                continue
        
            try:
                # Build config for all connectors with parent output path
                config = self.loader_service.build_connector_config(
                    account_connector, account
                )
                # Add parent output path from this hub
                config["parent_output_path"] = self.output_path
                
                # Apply test_mode override if specified
                if connector_id in self._override_test_mode:
                    config["test_mode"] = self._override_test_mode[connector_id]
                    log.info(f"🧪 Connector {connector_key} test_mode override: {config['test_mode']}")
                
                # Apply test_file_path override if specified
                if connector_id in self._override_test_file:
                    config["test_file_path"] = self._override_test_file[connector_id]
                    log.info(f"📂 Connector {connector_key} test_file override: {config['test_file_path']}")
                
                # Add since_datetime if provided for this connector
                if connector_id in self._connector_since_map:
                    since_dt = self._connector_since_map[connector_id]
                    if since_dt:
                        config["since_datetime"] = since_dt
                        log.info(f"📅 Connector {connector_key} will sync since: {since_dt}")
                    else:
                        # since_dt is None → full sync (no since_datetime filter)
                        log.info(f"📅 Connector {connector_key} performing full sync (no since_datetime)")
                
                # Apply symbols override if specified (for trade connectors)
                if connector_id in self._override_symbols:
                    config["symbols"] = self._override_symbols[connector_id]
                    log.info(f"📊 Connector {connector_key} symbols override: {config['symbols']}")
                
                # Apply currencies override if specified (for deposit/withdrawal connectors)
                if connector_id in self._override_currencies:
                    config["currencies"] = self._override_currencies[connector_id]
                    log.info(f"💰 Connector {connector_key} currencies override: {config['currencies']}")
                
                # Apply renormalize mode if set on hub
                if self._renormalize_mode:
                    config["renormalize_mode"] = True
                    config["disable_file_output"] = True  # No need to dump raw JSON when renormalizing
                    log.info(f"🔄 Connector {connector_key} renormalize mode enabled")
                
                if registry.is_onchain(connector_type):
                    # Store config with account context for lazy initialization
                    config["_connector_key"] = connector_key
                    config["_connector_id"] = account_connector.id  # Extract ID to avoid lazy loading
                    config["_account_id"] = account_connector.account_id  # Extract account_id
                    config["_connector_type"] = connector_type
                    config["_registry_type"] = "onchain"
                    self.connector_configs[connector_key] = config
                    self._account_connector_map[connector_key] = account_connector
                    log.info(f"✅ Queued on-chain connector config: {connector_key}")
                else:
                    # CEX connectors: store config for lazy initialization
                    sync_mode = config.get("sync_mode", "api")
                    
                    # Determine which connector class to use
                    actual_connector_type = connector_type
                    if connector_type == "mexc-transactions" and sync_mode == "file":
                        file_path = config.get("file_path")
                        if not file_path:
                            _error_msg = "No file uploaded — upload a file before syncing"
                            log.warning(f"⚠️ Connector {connector_key} is in file mode but no file_path configured")
                            self.loader_service.update_sync_status(connector_id, "failed", _error_msg)
                            if self._progress_callback:
                                self._progress_callback(
                                    connector_id=connector_id,
                                    operation="Initialization failed",
                                    current=0,
                                    total=1,
                                    log_message=f"ERROR_DETAIL:{_error_msg}",
                                )
                            continue
                        actual_connector_type = "mexc-transactions-file"
                    elif connector_type == "mexc-deposits" and sync_mode == "file":
                        file_path = config.get("file_path")
                        if not file_path:
                            _error_msg = "No file uploaded — upload a file before syncing"
                            log.warning(f"⚠️ Connector {connector_key} is in file mode but no file_path configured")
                            self.loader_service.update_sync_status(connector_id, "failed", _error_msg)
                            if self._progress_callback:
                                self._progress_callback(
                                    connector_id=connector_id,
                                    operation="Initialization failed",
                                    current=0,
                                    total=1,
                                    log_message=f"ERROR_DETAIL:{_error_msg}",
                                )
                            continue
                        actual_connector_type = "mexc-deposits-file"
                    
                    config["_connector_key"] = connector_key
                    config["_connector_id"] = account_connector.id  # Extract ID to avoid lazy loading
                    config["_account_id"] = account_connector.account_id  # Extract account_id
                    config["_connector_type"] = actual_connector_type
                    config["_registry_type"] = "cex"
                    self.connector_configs[connector_key] = config
                    self._account_connector_map[connector_key] = account_connector
                    log.info(f"✅ Queued connector config: {connector_key}")

            except Exception as e:
                log.error(f"❌ Failed to prepare config for {connector_key}: {e}")
                # Update status to failed
                self.loader_service.update_sync_status(
                    account_connector.id, "failed", str(e)
                )
                continue

        log.info(
            f"✅ {len(self.connector_configs)} connector configs prepared (lazy initialization enabled)"
        )

    def get_enabled_connectors(self) -> List[str]:
        """Get list of enabled connector keys."""
        return list(self.connector_configs.keys())
    
    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch raw data from all child connectors with lazy initialization.
        
        Overrides parent method to instantiate connectors in worker threads
        instead of during hub initialization.
        """
        from queue import Queue, Empty
        from threading import Thread
        
        if not self.connector_configs:
            log.warning(f"⚠️ [{self.connector_name}] No connector configs available")
            return

        log.info(
            f"🚀 [{self.connector_name}] Starting to fetch from {len(self.connector_configs)} connector(s) "
            f"using lazy initialization strategy"
        )
        
        registry = get_connector_registry()
        queue = Queue()

        def fetch_and_queue_with_lazy_init(connector_key: str, config: Dict[str, Any]):
            """Fetch from connector with lazy instantiation in thread."""
            connector = None
            # Extract IDs from config (pre-loaded to avoid lazy loading in thread)
            connector_id = config.get("_connector_id")
            account_id = config.get("_account_id")
            
            try:
                # Instantiate connector in this thread
                connector_type = config.get("_connector_type")
                registry_type = config.get("_registry_type")
                
                log.info(f"   🔗 [{connector_key}] Initializing connector in thread...")
                
                # Notify that initialization is starting via progress callback
                # The main thread will handle status persistence to avoid session conflicts
                if connector_id and self._progress_callback:
                    self._progress_callback(
                        connector_id=connector_id,
                        operation="Initializing connector",
                        current=0,
                        total=1,
                        log_message=f"Starting initialization of {connector_key}",
                    )
                
                # Get connector class
                connector_class = registry.get_class(connector_type)
                if not connector_class:
                    raise RuntimeError(f"Unknown connector type: {connector_type}")
                
                # Build kwargs based on connector type
                if registry_type == "onchain":
                    connector = connector_class(
                        wallet_address=config.get("address", ""),
                        chain_name=config.get("chain", ""),
                        api_key=config.get("api_key"),
                        account_id=account_id,
                        connector_id=connector_id,
                        config=config,
                        progress_callback=self._progress_callback,
                    )
                else:  # CEX
                    connector = connector_class(
                        account_id=account_id,
                        connector_id=connector_id,
                        symbols=config.get("symbols"),
                        config=config,
                        progress_callback=self._progress_callback,
                    )
                
                log.info(f"   ✅ [{connector_key}] Connector initialized successfully")
                
                # Notify successful initialization via progress callback
                if connector_id and self._progress_callback:
                    self._progress_callback(
                        connector_id=connector_id,
                        operation="Connector initialized",
                        current=1,
                        total=1,
                        log_message=f"✅ {connector_key} initialized successfully",
                    )
                
                log.info(f"   🔗 [{connector_key}] Started fetching")
                
                item_count = 0
                # Fetch data from connector
                for raw_item, normalized_item, error in connector.yield_normalized():
                    wrapped_raw = {
                        "connector_name": connector.connector_name,
                        "_connector_id": connector.connector_id,
                        "_master_source": connector.connector_name,
                        "raw_item": raw_item,
                        "normalized_item": normalized_item,
                        "error": error,
                    }
                    queue.put(wrapped_raw)
                    item_count += 1
                
                log.info(
                    f"   ✅ [{connector_key}] Completed fetching ({item_count} items)"
                )
                
            except Exception as e:
                import traceback
                
                # Capture full traceback for detailed error reporting
                error_traceback = traceback.format_exc()
                error_message = f"{type(e).__name__}: {str(e)}"
                
                log.error(f"   ❌ [{connector_key}] Initialization or fetch error: {error_message}")
                log.error(f"   ❌ [{connector_key}] Traceback:\n{error_traceback}")
                
                # Create detailed error message with traceback (first 1000 chars to avoid DB overflow)
                detailed_error = f"{error_message}\n\nTraceback:\n{error_traceback[:1000]}"
                
                # Notify via progress callback with detailed error
                # The main thread will handle status persistence to avoid session conflicts
                # Pass detailed error via log_message so it can be extracted and persisted
                if connector_id and self._progress_callback:
                    self._progress_callback(
                        connector_id=connector_id,
                        operation="Initialization failed",
                        current=0,
                        total=1,
                        log_message=f"ERROR_DETAIL:{detailed_error}",
                    )
                
                # Put error item in queue
                queue.put({
                    "connector_name": connector_key,
                    "_connector_id": connector_id,
                    "_master_source": connector_key,
                    "raw_item": {"error_type": "connector_failure"},
                    "normalized_item": None,
                    "error": detailed_error,
                })
            finally:
                queue.put(None)  # Signal this connector is done

        # Start all connector threads with lazy initialization
        threads = []
        for connector_key, config in self.connector_configs.items():
            thread = Thread(
                target=fetch_and_queue_with_lazy_init,
                args=(connector_key, config),
                daemon=True,
            )
            threads.append(thread)
            thread.start()

        # Yield items as they arrive from any connector
        completed_connectors = 0
        total_connectors = len(threads)

        while completed_connectors < total_connectors:
            try:
                # Use timeout to detect potential hangs
                item = queue.get(timeout=900)
                if item is None:
                    completed_connectors += 1
                    log.info(
                        f"   📊 Progress: {completed_connectors}/{total_connectors} connectors completed"
                    )
                else:
                    yield item
            except Empty:
                # Timeout - check thread status
                alive_threads = [t for t in threads if t.is_alive()]
                if alive_threads:
                    log.warning(
                        f"   ⚠️ Timeout waiting for data. {len(alive_threads)} connectors still running"
                    )
                    continue
                else:
                    log.warning("   ⚠️ All threads completed but didn't receive all poison pills")
                    break

        log.info(f"   ✅ All {total_connectors} connectors completed")

    def yield_normalized(
        self,
    ) -> Generator[
        Tuple[Dict[str, Any], Optional[NormalizedTransaction], Optional[str]],
        None,
        None,
    ]:
        """
        Yield normalized transactions from all database-configured connectors.

        Note: Status persistence is handled by SyncJobService via progress_callback.
        This method focuses solely on data generation.

        Yields:
            Tuple of (raw_item, normalized_transaction, error)
        """
        # Use parent's yield_normalized implementation
        for raw_item, normalized_item, error in super().yield_normalized():
            yield raw_item, normalized_item, error

    def get_connector_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics about all database connectors."""
        stats = {}

        for key, config in self.connector_configs.items():
            account_connector = self._account_connector_map.get(key)
            stats[key] = {
                "enabled": True,
                "initialized": False,  # Lazy initialization - not instantiated yet
                "connector_type": config.get("_connector_type"),
                "last_sync_status": account_connector.last_sync_status
                if account_connector
                else None,
                "last_sync_at": account_connector.last_sync_at.isoformat()
                if account_connector and account_connector.last_sync_at
                else None,
            }

        return stats

    def close(self):
        """Close the loader service and release resources."""
        if hasattr(self, "loader_service"):
            self.loader_service.close()

    def __str__(self):
        return f"DatabaseConnectorHub(enabled={len(self.connector_configs)})"

    def __repr__(self):
        return (
            f"DatabaseConnectorHub(connectors={list(self.connector_configs.keys())})"
        )
