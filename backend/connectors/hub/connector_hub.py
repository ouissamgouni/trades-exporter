"""
ConnectorHub: First-level connector that orchestrates all second-level connectors.
Provides a unified interface to fetch trades from all exchange and Web3 connectors.
"""

from typing import Dict, Any, List, Type

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging, load_settings

log = configure_logging("connector_hub")


class ConnectorHub(BaseHubConnector):
    """
    ConnectorHub orchestrates all second-level connectors.

    This first-level connector provides a unified interface to:
    - All exchange connectors (MEXC, Binance, Binance Deposits, Binance Withdrawals, OKX, OKXConvert, Coinbase)
    - All Web3 connectors (via Web3AggregatorConnector)
    - Unified error handling and logging
    - Parallel processing of all connectors
    """

    @classmethod
    def get_connector_map(cls) -> Dict[str, Type]:
        """Get connector map from registry."""
        return get_connector_registry().get_connector_map()

    # Keep CONNECTOR_MAP as property for backwards compatibility
    @property
    def CONNECTOR_MAP(self) -> Dict[str, Type]:
        return self.get_connector_map()

    @property
    def connector_name(self) -> str:
        return "connector_hub"

    def __init__(
        self,
        enabled_connectors: List[str] = None,
        parent_output_path: str = None,
    ):
        """
        Initialize the master trades connector.

        Args:
            enabled_connectors: List of connector names to enable. If None, all are enabled.
            parent_output_path: Parent output path for connector logs and raw data
        """
        # Load settings for configuration
        settings = load_settings()
        self.settings = settings

        # Get connector map from registry
        connector_map = self.get_connector_map()

        # Configure which connectors to run
        if enabled_connectors is None:
            self.enabled_connectors = list(connector_map.keys())
        else:
            # Validate enabled connectors
            invalid_connectors = set(enabled_connectors) - set(connector_map.keys())
            if invalid_connectors:
                raise ValueError(
                    f"Invalid connectors: {invalid_connectors}. Available: {list(connector_map.keys())}"
                )
            self.enabled_connectors = enabled_connectors

        self.connector_instances = {}
        
        # Build config with parent_output_path for BaseHubConnector
        hub_config = {"parent_output_path": parent_output_path} if parent_output_path else {}


        log.info("enabled_connectors", connectors=self.enabled_connectors)
        
        # Initialize as BaseHubConnector first to get self.output_path
        child_connectors_list = []  # Will populate after creating instances
        super().__init__(
            child_connectors=child_connectors_list,
            parallel_strategy="queue",  # Better for many connectors
            config=hub_config,
        )

        # Initialize all enabled connector instances with propagated path
        for connector_name in self.enabled_connectors:
            try:
                connector_class = connector_map[connector_name]

                # Pass hub's output_path as parent for children
                child_config = {"parent_output_path": self.output_path}
                self.connector_instances[connector_name] = connector_class(config=child_config)

                log.info("connector_initialized", connector=connector_name.upper())
            except Exception as e:
                log.error("connector_init_failed", connector=connector_name, error=str(e))
                # Don't add to instances if initialization failed
                continue

        log.info(
            "connector_hub_ready",
            initialized=len(self.connector_instances),
            total=len(self.enabled_connectors),
        )

        # Update child connectors list after instantiation
        self.child_connectors = list(self.connector_instances.items())

        log.info("parallel_processing_enabled", strategy="queue")

    def get_connector_stats(self) -> Dict[str, Dict[str, Any]]:
        """
        Get statistics about all connectors.

        Returns:
            Dictionary with connector stats
        """
        connector_map = self.get_connector_map()
        stats = {}

        for connector_name in self.enabled_connectors:
            stats[connector_name] = {
                "enabled": connector_name in self.connector_instances,
                "initialized": connector_name in self.connector_instances,
                "connector_class": connector_map[connector_name].__name__,
            }

            # Add connector-specific info if available
            if connector_name in self.connector_instances:
                connector = self.connector_instances[connector_name]
                stats[connector_name]["exchange_name"] = getattr(
                    connector, "exchange_name", connector_name
                )

        return stats

    def get_enabled_connectors(self) -> List[str]:
        """Get list of enabled connector names."""
        return self.enabled_connectors.copy()

    def get_available_connectors(self) -> List[str]:
        """Get list of all available connector names."""
        return list(self.CONNECTOR_MAP.keys())

    def enable_connector(self, connector_name: str):
        """
        Enable a specific connector.

        Args:
            connector_name: Name of the connector to enable
        """
        if connector_name not in self.CONNECTOR_MAP:
            raise ValueError(
                f"Unknown connector: {connector_name}. Available: {list(self.CONNECTOR_MAP.keys())}"
            )

        if connector_name not in self.enabled_connectors:
            self.enabled_connectors.append(connector_name)
            log.info("connector_enabled", connector=connector_name)
        else:
            log.info("connector_already_enabled", connector=connector_name)

    def disable_connector(self, connector_name: str):
        """
        Disable a specific connector.

        Args:
            connector_name: Name of the connector to disable
        """
        if connector_name in self.enabled_connectors:
            self.enabled_connectors.remove(connector_name)
            # Remove from instances if it exists
            if connector_name in self.connector_instances:
                del self.connector_instances[connector_name]
            log.info("connector_disabled", connector=connector_name)
        else:
            log.info("connector_not_enabled", connector=connector_name)

    def __str__(self):
        return f"ConnectorHub(enabled={len(self.enabled_connectors)})"

    def __repr__(self):
        return f"ConnectorHub(enabled_connectors={self.enabled_connectors})"
