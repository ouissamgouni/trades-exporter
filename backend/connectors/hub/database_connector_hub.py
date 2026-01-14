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
from backend.config.loader import configure_logging, is_test_mode
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
        """
        self.session = session
        self.loader_service = ConnectorLoaderService(session)
        self.connector_instances: Dict[str, Any] = {}
        self._account_connector_map: Dict[str, AccountConnector] = {}
        self._parent_output_path = parent_output_path
        self._connector_since_map = connector_since_map or {}
        
        # Build override lookup maps
        self._override_enabled: Dict[int, bool] = {}
        self._override_test_mode: Dict[int, bool] = {}
        self._override_test_file: Dict[int, str] = {}
        
        if connector_overrides:
            for o in connector_overrides:
                if o.enabled is not None:
                    self._override_enabled[o.connector_id] = o.enabled
                if o.test_mode is not None:
                    self._override_test_mode[o.connector_id] = o.test_mode
                if o.test_file_path is not None:
                    self._override_test_file[o.connector_id] = o.test_file_path

        test_mode = is_test_mode()
        mode_str = "TEST MODE" if test_mode else "LIVE MODE"
        log.info(f"🔄 Initializing DatabaseConnectorHub [{mode_str}]...")
        
        # Build config with parent_output_path for BaseHubConnector
        hub_config = {"parent_output_path": parent_output_path} if parent_output_path else {}

        # Initialize as BaseHubConnector first to get self.output_path
        child_connectors_list = []  # Will populate after loading
        super().__init__(
            child_connectors=child_connectors_list,
            parallel_strategy="futures",
            config=hub_config,
        )

        # Load and initialize connectors from database
        self._load_connectors()

        # Update child connectors list after loading
        self.child_connectors = list(self.connector_instances.items())

        log.info("⚡ Parallel processing: enabled (futures strategy)")

    def _load_connectors(self):
        """Load and initialize all enabled connectors from the database."""
        enabled_connectors = self.loader_service.get_enabled_connectors()
        log.info(f"📋 Found {len(enabled_connectors)} enabled connectors in database")

        # Get registry instance
        registry = get_connector_registry()
        onchain_configs = []

        for account_connector, account in enabled_connectors:
            connector_type = account_connector.connector_type
            connector_key = f"{account.name}_{connector_type}_{account_connector.id}"
            connector_id = account_connector.id
            
            # Check if connector is disabled by override
            if connector_id in self._override_enabled and not self._override_enabled[connector_id]:
                log.info(f"⏭️ Connector {connector_key} disabled by override, skipping")
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
                
                if registry.is_onchain(connector_type):
                    # Store config with account context for batch initialization
                    config["_connector_key"] = connector_key
                    config["_account_connector"] = account_connector
                    onchain_configs.append(config)
                    log.info(f"✅ Queued on-chain connector: {connector_key}")
                else:
                    # CEX connectors: manually instantiate with updated config
                    connector_class = registry.get_class(connector_type)
                    if connector_class:
                        instance = connector_class(
                            account_id=account.id,
                            connector_id=account_connector.id,
                            config=config,
                        )
                        self.connector_instances[connector_key] = instance
                        self._account_connector_map[connector_key] = account_connector
                        log.info(f"✅ Initialized connector: {connector_key}")
                    else:
                        log.warning(f"⚠️ Unknown connector type: {connector_type}")

            except Exception as e:
                log.error(f"❌ Failed to initialize {connector_key}: {e}")
                # Update status to failed
                self.loader_service.update_sync_status(
                    account_connector.id, "failed", str(e)
                )
                continue

        # Initialize on-chain connectors individually (not via hub)
        if onchain_configs:
            for config in onchain_configs:
                connector_key = config.pop("_connector_key")
                account_connector = config.pop("_account_connector")
                try:
                    connector_type = account_connector.connector_type
                    connector_class = registry.get_class(connector_type)
                    if connector_class:
                        instance = connector_class(
                            wallet_address=config.get("address", ""),
                            chain_name=config.get("chain", ""),
                            api_key=config.get("api_key"),
                            account_id=config.get("_account_id"),
                            connector_id=config.get("_connector_id"),
                            config=config,
                        )
                        self.connector_instances[connector_key] = instance
                        self._account_connector_map[connector_key] = account_connector
                        log.info(f"✅ Initialized on-chain connector: {connector_key}")
                except Exception as e:
                    log.error(f"❌ Failed to initialize on-chain {connector_key}: {e}")
                    self.loader_service.update_sync_status(
                        account_connector.id, "failed", str(e)
                    )

        log.info(
            f"✅ {len(self.connector_instances)} connectors initialized from database"
        )

    def get_enabled_connectors(self) -> List[str]:
        """Get list of enabled connector keys."""
        return list(self.connector_instances.keys())

    def yield_normalized(
        self,
    ) -> Generator[
        Tuple[Dict[str, Any], Optional[NormalizedTransaction], Optional[str]],
        None,
        None,
    ]:
        """
        Yield normalized transactions from all database-configured connectors.

        Updates sync status for each connector as it processes.

        Yields:
            Tuple of (raw_item, normalized_transaction, error)
        """
        # Mark all connectors as running
        for key, account_connector in self._account_connector_map.items():
            self.loader_service.update_sync_status(account_connector.id, "running")

        try:
            # Use parent's yield_normalized implementation
            for raw_item, normalized_item, error in super().yield_normalized():
                yield raw_item, normalized_item, error

            # Mark all as success when done
            for key, account_connector in self._account_connector_map.items():
                self.loader_service.update_sync_status(account_connector.id, "success")

        except Exception as e:
            # Mark all as failed on error
            for key, account_connector in self._account_connector_map.items():
                self.loader_service.update_sync_status(
                    account_connector.id, "failed", str(e)
                )
            raise

    def get_connector_stats(self) -> Dict[str, Dict[str, Any]]:
        """Get statistics about all database connectors."""
        stats = {}

        for key, instance in self.connector_instances.items():
            account_connector = self._account_connector_map.get(key)
            stats[key] = {
                "enabled": True,
                "initialized": True,
                "connector_class": type(instance).__name__,
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
        return f"DatabaseConnectorHub(enabled={len(self.connector_instances)})"

    def __repr__(self):
        return (
            f"DatabaseConnectorHub(connectors={list(self.connector_instances.keys())})"
        )
