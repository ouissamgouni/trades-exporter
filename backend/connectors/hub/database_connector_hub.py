"""
DatabaseConnectorHub: Loads and orchestrates connectors from the database.

This hub uses AccountConnector configurations stored in the database
instead of hardcoded settings, enabling dynamic connector management via API.
"""

from typing import Dict, Any, List, Optional, Generator, Tuple, Callable
from threading import Event

from sqlmodel import Session

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.db.models import AccountConnector
from backend.services.connector_loader_service import ConnectorLoaderService
from backend.db.models import NormalizedTransaction

log = configure_logging("database_connector_hub")

# Type alias for progress callback
ProgressCallback = Callable[[int, str, int, int, Optional[str]], None]


class DatabaseConnectorHub(BaseHubConnector):
    """
    DatabaseConnectorHub loads connectors from the database.

    This hub provides:
    - Dynamic connector loading from AccountConnector table
    - Per-account connector configuration
    - Sync status tracking per connector
    - Credential resolution from env/vault
    """

    @property
    def connector_name(self) -> str:
        return "database_connector_hub"

    def __init__(
        self,
        session: Session,
        connector_overrides: Optional[Dict[int, Any]] = None,
        progress_callback: Optional[ProgressCallback] = None,
        abort_event: Optional[Event] = None,
    ):
        """
        Initialize the database connector hub.

        Args:
            session: Database session for loading connectors
            connector_overrides: Optional dict of connector_id -> override settings
                                 (enabled, test_mode, test_file_path)
            progress_callback: Optional callback for reporting connector progress
            abort_event: Optional threading.Event to signal abort request
        """
        self.session = session
        self.loader_service = ConnectorLoaderService(session)
        self.connector_instances: Dict[str, Any] = {}
        self._account_connector_map: Dict[str, AccountConnector] = {}
        self._connector_overrides = connector_overrides or {}
        self._progress_callback = progress_callback
        self._abort_event = abort_event

        log.info("🔄 Initializing DatabaseConnectorHub...")
        if self._connector_overrides:
            log.info(f"📋 {len(self._connector_overrides)} connector overrides provided")

        # Load and initialize connectors from database
        self._load_connectors()

        # Initialize as BaseHubConnector
        child_connectors_list = list(self.connector_instances.items())
        super().__init__(
            child_connectors=child_connectors_list,
            parallel_strategy="futures",
            abort_event=abort_event,
        )

        log.info("⚡ Parallel processing: enabled (futures strategy)")

    def _load_connectors(self):
        """Load and initialize all enabled connectors from the database."""
        enabled_connectors = self.loader_service.get_enabled_connectors()
        log.info(f"📋 Found {len(enabled_connectors)} enabled connectors in database")

        # Get registry instance
        registry = get_connector_registry()
        onchain_configs = []

        for account_connector, account in enabled_connectors:
            connector_id = account_connector.id
            connector_type = account_connector.connector_type
            connector_key = f"{account.name}_{connector_type}_{connector_id}"

            # Check for overrides
            override = self._connector_overrides.get(connector_id)
            if override:
                # Skip if explicitly disabled via override
                if hasattr(override, 'enabled') and override.enabled is False:
                    log.info(f"⏭️ Skipping {connector_key} (disabled via override)")
                    continue
                # Handle dict-style override
                elif isinstance(override, dict) and override.get('enabled') is False:
                    log.info(f"⏭️ Skipping {connector_key} (disabled via override)")
                    continue

            try:
                if registry.is_onchain(connector_type):
                    # Build config for on-chain connector
                    config = self.loader_service.build_connector_config(
                        account_connector, account
                    )
                    # Apply test_mode override if specified
                    if override:
                        test_mode = getattr(override, 'test_mode', None) if hasattr(override, 'test_mode') else override.get('test_mode')
                        test_file_path = getattr(override, 'test_file_path', None) if hasattr(override, 'test_file_path') else override.get('test_file_path')
                        if test_mode is not None:
                            config['test_mode'] = test_mode
                        if test_file_path:
                            config['test_file_path'] = test_file_path
                    
                    # Store config with account context for batch initialization
                    config["_connector_key"] = connector_key
                    config["_account_connector"] = account_connector
                    config["_progress_callback"] = self._progress_callback
                    onchain_configs.append(config)
                    log.info(f"✅ Queued on-chain connector: {connector_key}")
                else:
                    # Use instantiate_connector for CEX connectors
                    # This properly passes account_id, connector_id, and config
                    instance = self.loader_service.instantiate_connector(
                        account_connector, account,
                        override=override,
                        progress_callback=self._progress_callback
                    )
                    if instance:
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
                progress_callback = config.pop("_progress_callback", None)
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
                            progress_callback=progress_callback,
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
