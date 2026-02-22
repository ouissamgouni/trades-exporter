"""
Service to load and manage connectors from the database.

This service bridges the database-stored connector configurations with the
actual connector instances used for syncing.
"""

import os
from typing import List, Dict, Any, Optional, Tuple, Callable

from sqlmodel import Session

from backend.db.models import Account, AccountConnector
from backend.db.repositories import AccountConnectorRepository
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging, load_settings

log = configure_logging("connector_loader")

# Type alias for progress callback
ProgressCallback = Callable[[int, str, int, int, Optional[str]], None]


class ConnectorLoaderService:
    """
    Service to load connector configurations from database and instantiate connectors.

    This provides the bridge between:
    - Database-stored AccountConnector configurations
    - Runtime connector instances
    """

    def __init__(self, session: Optional[Session] = None):
        """
        Initialize the connector loader service.

        Args:
            session: Optional database session. If not provided, creates one.
        """
        self._session = session
        self._owns_session = session is None
        self._repo: Optional[AccountConnectorRepository] = None
        self.settings = load_settings()
        self._registry = get_connector_registry()

    @property
    def session(self) -> Session:
        """Get or create the database session."""
        if self._session is None:
            from backend.db.database import get_engine

            engine = get_engine()
            self._session = Session(engine)
            self._owns_session = True
        return self._session

    @property
    def repo(self) -> AccountConnectorRepository:
        """Get the account connector repository."""
        if self._repo is None:
            self._repo = AccountConnectorRepository(self.session)
        return self._repo

    def close(self):
        """Close the session if we own it."""
        if self._owns_session and self._session:
            self._session.close()
            self._session = None
            self._repo = None

    def get_enabled_connectors(self) -> List[Tuple[AccountConnector, Account]]:
        """
        Get all enabled connectors from the database.

        Returns:
            List of (AccountConnector, Account) tuples ordered by sync_priority
        """
        return self.repo.get_enabled()

    def get_all_connectors_with_accounts(self) -> List[Tuple[AccountConnector, Account]]:
        """
        Get ALL connectors from the database (enabled and disabled).

        Use this when you need to apply runtime overrides that may enable
        disabled connectors.

        Returns:
            List of (AccountConnector, Account) tuples ordered by sync_priority
        """
        return self.repo.get_all()

    def get_connectors_for_account(self, account_id: int) -> List[AccountConnector]:
        """
        Get all connectors for a specific account.

        Args:
            account_id: The account ID

        Returns:
            List of AccountConnector records
        """
        return self.repo.get_by_account(account_id)

    def load_connector_by_id(
        self,
        connector_id: int,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> Optional[Any]:
        """
        Load and instantiate a connector by its ID.

        Args:
            connector_id: The AccountConnector ID
            progress_callback: Optional callback for reporting progress

        Returns:
            Instantiated connector or None if not found
        """
        result = self.repo.get_with_account(connector_id)
        if not result:
            log.warning(f"Connector {connector_id} not found")
            return None

        account_connector, account = result

        return self.instantiate_connector(
            account_connector,
            account,
            progress_callback=progress_callback,
        )

    def resolve_credentials(self, credentials_ref: Optional[str]) -> Optional[str]:
        """
        Resolve credentials reference to actual value.

        Supports:
        - env:VAR_NAME - Read from environment variable
        - vault:path/to/secret - Read from HashiCorp Vault (future)
        - None - No credentials needed

        Args:
            credentials_ref: The credentials reference string

        Returns:
            The resolved credentials value or None
        """
        if not credentials_ref:
            return None

        if credentials_ref.startswith("env:"):
            env_var = credentials_ref[4:]
            value = os.getenv(env_var)
            if not value:
                log.warning(f"Environment variable {env_var} not set")
            return value

        if credentials_ref.startswith("vault:"):
            # Future: implement vault integration
            log.warning("Vault credentials not yet implemented")
            return None

        # Direct value (not recommended, but supported)
        return credentials_ref

    def build_connector_config(
        self,
        account_connector: AccountConnector,
        account: Account,
    ) -> Dict[str, Any]:
        """
        Build the full configuration for a connector by merging:
        1. Static defaults from settings
        2. Database-stored config
        3. Resolved credentials

        Args:
            account_connector: The AccountConnector record
            account: The parent Account record

        Returns:
            Complete connector configuration dict
        """
        connector_type = account_connector.connector_type
        db_config = account_connector.config or {}

        # Start with database config
        config = db_config.copy()

        # Add account context
        config["_account_id"] = account.id
        config["_account_name"] = account.name
        config["_account_address_or_identifier"] = account.address_or_identifier
        config["_connector_id"] = account_connector.id

        # Resolve credentials
        api_key = self.resolve_credentials(account_connector.credentials_ref)
        if api_key:
            config["api_key"] = api_key

        # For on-chain connectors, add chain-specific config
        if self._registry.is_onchain(connector_type):
            # Inherit address from account if not explicitly set in config
            if "address" not in config or not config.get("address"):
                if account.address_or_identifier:
                    config["address"] = account.address_or_identifier
                    log.debug(
                        f"Inherited address '{account.address_or_identifier}' from account '{account.name}' "
                        f"for connector '{connector_type}'"
                    )
            
            chain = db_config.get("chain")
            chain_config_obj = self._registry.get_chain_config(connector_type, chain)
            if chain_config_obj:
                config["explorer_type"] = chain_config_obj.explorer_type
                config["base_url"] = chain_config_obj.base_url

        return config

    def instantiate_connector(
        self,
        account_connector: AccountConnector,
        account: Account,
        override: Optional[Any] = None,
        progress_callback: Optional[ProgressCallback] = None,
    ) -> Optional[Any]:
        """
        Instantiate a connector with full account context.

        This creates the actual connector instance with:
        - account_id: The Account ID for transaction attribution
        - connector_id: The AccountConnector ID for sync tracking
        - All necessary configuration and credentials

        Args:
            account_connector: The AccountConnector record
            account: The parent Account record
            override: Optional override settings (enabled, test_mode, test_file_path)
            progress_callback: Optional callback for reporting connector progress

        Returns:
            Instantiated connector or None if connector type not found
        """
        connector_type = account_connector.connector_type
        config = self.build_connector_config(account_connector, account)

        # Apply overrides to config
        if override:
            test_mode = getattr(override, 'test_mode', None) if hasattr(override, 'test_mode') else override.get('test_mode') if isinstance(override, dict) else None
            test_file_path = getattr(override, 'test_file_path', None) if hasattr(override, 'test_file_path') else override.get('test_file_path') if isinstance(override, dict) else None
            if test_mode is not None:
                config['test_mode'] = test_mode
            if test_file_path:
                config['test_file_path'] = test_file_path

        # Get connector class from registry
        connector_class = self._registry.get_class(connector_type)
        if not connector_class:
            log.warning(f"⚠️ Unknown connector type: {connector_type}")
            return None

        try:
            # Extract account context
            account_id = account.id
            connector_id = account_connector.id

            # Build connector-specific kwargs
            kwargs = {
                "account_id": account_id,
                "connector_id": connector_id,
                "config": config,  # Pass full config for test_mode, test_file_path, etc.
                "progress_callback": progress_callback,  # Pass progress callback for reporting
            }

            # Add connector-specific config based on type
            if self._registry.is_onchain(connector_type):
                # On-chain connectors need wallet_address and chain_name
                kwargs["wallet_address"] = config.get("address", "")
                kwargs["chain_name"] = config.get("chain", "")
                if config.get("api_key"):
                    kwargs["api_key"] = config["api_key"]
            else:
                # CEX connectors may need api_key and api_secret
                if config.get("api_key"):
                    kwargs["api_key"] = config["api_key"]
                if config.get("api_secret"):
                    kwargs["api_secret"] = config["api_secret"]
                # Pass additional config like symbols, start_date
                if config.get("symbols"):
                    kwargs["symbols"] = config["symbols"]

            log.debug(
                f"Instantiating {connector_type} for account {account.name} (id={account_id})"
            )
            return connector_class(**kwargs)

        except Exception as e:
            log.error(f"❌ Failed to instantiate {connector_type}: {e}")
            return None

    def get_onchain_addresses(self) -> List[Dict[str, Any]]:
        """
        Get all enabled on-chain connector addresses grouped by chain.

        This is used by ConnectorOnchainHub to know which addresses to sync.

        Returns:
            List of address configs with chain, address, and options
        """
        addresses = []

        for account_connector, account in self.get_enabled_connectors():
            connector_type = account_connector.connector_type

            # Only process on-chain connectors
            if not self._registry.is_onchain(connector_type):
                continue

            config = self.build_connector_config(account_connector, account)

            address_config = {
                "connector_type": connector_type,
                "chain": config.get("chain"),
                "address": config.get("address"),
                "api_key": config.get("api_key"),
                "start_block": config.get("start_block"),
                "include_internal_txs": config.get("include_internal_txs", True),
                "include_token_transfers": config.get("include_token_transfers", True),
                "account_id": account.id,
                "account_name": account.name,
                "connector_id": account_connector.id,
            }

            # Add chain-specific base URL from registry
            chain = config.get("chain")
            chain_config = self._registry.get_chain_config(connector_type, chain)
            if chain_config:
                address_config["explorer_type"] = chain_config.explorer_type
                address_config["base_url"] = chain_config.base_url

            addresses.append(address_config)

        return addresses

    def get_cex_configs(self) -> Dict[str, List[Dict[str, Any]]]:
        """
        Get all enabled CEX connector configurations grouped by connector type.

        Returns:
            Dict mapping connector_type to list of configs
        """
        cex_configs: Dict[str, List[Dict[str, Any]]] = {}

        for account_connector, account in self.get_enabled_connectors():
            connector_type = account_connector.connector_type

            # Only process CEX connectors (skip on-chain connectors)
            if connector_type in ["blockscout", "etherscan"]:
                continue

            config = self.build_connector_config(account_connector, account)

            if connector_type not in cex_configs:
                cex_configs[connector_type] = []

            cex_configs[connector_type].append(config)

        return cex_configs

    def update_sync_status(
        self,
        connector_id: int,
        status: str,
        error: Optional[str] = None,
    ):
        """
        Update the sync status of a connector.

        Args:
            connector_id: The AccountConnector ID
            status: New status ('pending', 'running', 'success', 'failed')
            error: Optional error message if status is 'failed'
        """
        self.repo.update_sync_status(connector_id, status, error)

    def mark_all_running(self, connector_ids: List[int]):
        """
        Mark multiple connectors as running.

        Args:
            connector_ids: List of connector IDs to mark as running
        """
        for connector_id in connector_ids:
            self.update_sync_status(connector_id, "running")

    def get_connector_summary(self) -> Dict[str, Any]:
        """
        Get a summary of all configured connectors.

        Returns:
            Summary dict with counts and status breakdown
        """
        all_connectors = self.repo.list_all()

        summary = {
            "total": len(all_connectors),
            "enabled": sum(1 for c in all_connectors if c.enabled),
            "disabled": sum(1 for c in all_connectors if not c.enabled),
            "by_type": {},
            "by_status": {
                "pending": 0,
                "running": 0,
                "success": 0,
                "failed": 0,
            },
        }

        for connector in all_connectors:
            # Count by type
            ctype = connector.connector_type
            if ctype not in summary["by_type"]:
                summary["by_type"][ctype] = {"enabled": 0, "disabled": 0}

            if connector.enabled:
                summary["by_type"][ctype]["enabled"] += 1
            else:
                summary["by_type"][ctype]["disabled"] += 1

            # Count by status
            status = connector.last_sync_status or "pending"
            if status in summary["by_status"]:
                summary["by_status"][status] += 1

        return summary
