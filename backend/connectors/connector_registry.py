"""
Centralized Connector Registry - Single source of truth for connector configuration.

This module provides the authoritative mapping between:
- Connector type names (used in database and API)
- Connector classes (Python implementation)
- Connector metadata (display names, categories, config requirements)
- Chain configurations (for on-chain connectors)
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Type, Any

from backend.config.loader import configure_logging

log = configure_logging("connector_registry")


@dataclass
class ConnectorInfo:
    """Complete information about a connector type."""

    # Core identification
    type: str  # Unique identifier (e.g., "binance-transactions", "blockscout")
    category: str  # "cex", "onchain", "broker"
    display_name: str  # Human-readable name

    # Class mapping - hub_key is only needed when different from type
    # (e.g., on-chain connectors share hub_key="on-chain")
    connector_class: Optional[Type] = None  # The actual connector class
    hub_key: Optional[str] = None  # Key in ConnectorHub, defaults to type if None

    # Configuration requirements
    required_config: List[str] = field(default_factory=list)
    optional_config: List[str] = field(default_factory=list)

    # On-chain specific
    supported_chains: Optional[List[str]] = None

    def to_api_dict(self) -> Dict[str, Any]:
        """Convert to API-friendly dictionary."""
        return {
            "type": self.type,
            "category": self.category,
            "display_name": self.display_name,
            "supported_chains": self.supported_chains,
            "required_config": self.required_config,
            "optional_config": self.optional_config,
        }


@dataclass
class ChainConfig:
    """Configuration for a specific blockchain/explorer combination."""

    explorer_type: str
    base_url: str
    chain_id: Optional[int] = None
    native_currency: Optional[str] = None


class ConnectorRegistry:
    """
    Centralized registry for all connector types.

    This is the single source of truth for:
    - Available connector types
    - Connector class mappings
    - Configuration requirements
    - Chain configurations for on-chain connectors

    Usage:
        registry = ConnectorRegistry.instance()
        info = registry.get("binance")
        connector_class = registry.get_class("binance")
    """

    _instance: Optional["ConnectorRegistry"] = None

    # Lazy-loaded connector classes to avoid circular imports
    _connector_classes: Optional[Dict[str, Type]] = None

    def __new__(cls):
        """Singleton pattern."""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._initialized = True
        self._connectors: Dict[str, ConnectorInfo] = {}
        self._chain_configs: Dict[str, Dict[str, ChainConfig]] = {}

        self._register_all_connectors()
        self._register_chain_configs()

    @classmethod
    def instance(cls) -> "ConnectorRegistry":
        """Get the singleton instance."""
        return cls()

    def _register_all_connectors(self):
        """Register all known connector types."""

        # ==================== CEX Connectors ====================

        self._register(
            ConnectorInfo(
                type="binance-transactions",
                category="cex",
                display_name="Binance Transactions",
                required_config=[],
                optional_config=["symbols", "start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="binance-deposits",
                category="cex",
                display_name="Binance Deposits",
                required_config=[],
                optional_config=["start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="binance-withdrawals",
                category="cex",
                display_name="Binance Withdrawals",
                required_config=[],
                optional_config=["start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-transactions",
                category="cex",
                display_name="MEXC Transactions",
                required_config=[],
                optional_config=["symbols", "start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-transactions",
                category="cex",
                display_name="OKX Transactions",
                required_config=[],
                optional_config=["symbols", "start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-convert",
                category="cex",
                display_name="OKX Convert",
                required_config=[],
                optional_config=["start_date"],
            )
        )

        self._register(
            ConnectorInfo(
                type="coinbase-transactions",
                category="cex",
                display_name="Coinbase Transactions",
                required_config=[],
                optional_config=["start_date"],
            )
        )

        # ==================== On-Chain Connectors ====================

        self._register(
            ConnectorInfo(
                type="blockscout",
                category="onchain",
                display_name="Blockscout",
                hub_key="on-chain",
                supported_chains=[
                    "base",
                    "bnb",
                    "ethereum",
                    "polygon",
                    "arbitrum",
                    "optimism",
                ],
                required_config=["chain", "address"],
                optional_config=[
                    "start_block",
                    "include_internal_txs",
                    "include_token_transfers",
                ],
            )
        )

        self._register(
            ConnectorInfo(
                type="etherscan",
                category="onchain",
                display_name="Etherscan",
                hub_key="on-chain",
                supported_chains=["ethereum"],
                required_config=["address"],
                optional_config=[
                    "start_block",
                    "include_internal_txs",
                    "include_token_transfers",
                ],
            )
        )

        # Note: bscscan removed - use blockscout with chain="bnb" instead

    def _register_chain_configs(self):
        """Register chain configurations for on-chain connectors."""

        # Blockscout chains
        self._chain_configs["blockscout"] = {
            "base": ChainConfig(
                explorer_type="blockscout",
                base_url="https://base.blockscout.com/api",
                chain_id=8453,
                native_currency="ETH",
            ),
            "bnb": ChainConfig(
                explorer_type="blockscout",
                base_url="https://bscscan.com/api",
                chain_id=56,
                native_currency="BNB",
            ),
            "ethereum": ChainConfig(
                explorer_type="blockscout",
                base_url="https://eth.blockscout.com/api",
                chain_id=1,
                native_currency="ETH",
            ),
            "polygon": ChainConfig(
                explorer_type="blockscout",
                base_url="https://polygon.blockscout.com/api",
                chain_id=137,
                native_currency="MATIC",
            ),
            "arbitrum": ChainConfig(
                explorer_type="blockscout",
                base_url="https://arbitrum.blockscout.com/api",
                chain_id=42161,
                native_currency="ETH",
            ),
            "optimism": ChainConfig(
                explorer_type="blockscout",
                base_url="https://optimism.blockscout.com/api",
                chain_id=10,
                native_currency="ETH",
            ),
        }

        # Etherscan
        self._chain_configs["etherscan"] = {
            "ethereum": ChainConfig(
                explorer_type="etherscan",
                base_url="https://api.etherscan.io/api",
                chain_id=1,
                native_currency="ETH",
            ),
        }

        # Note: BscScan chain config removed - use blockscout with chain="bnb" instead

    def _register(self, info: ConnectorInfo):
        """Register a connector type."""
        self._connectors[info.type] = info

    def _load_connector_classes(self) -> Dict[str, Type]:
        """Lazy-load connector classes to avoid circular imports."""
        if self._connector_classes is not None:
            return self._connector_classes

        # Import connector classes here to avoid circular imports
        from backend.connectors.cex.connector_mexc_trx import MEXCConnectorTrx
        from backend.connectors.cex.connector_binance_trx import BinanceTrxConnector
        from backend.connectors.cex.connector_okx_trx import OKXConnectorTrx
        from backend.connectors.cex.connector_okx_convert import OKXConvertConnector
        from backend.connectors.cex.connector_coinbase_trx import ConnectorCoinbaseTrx
        from backend.connectors.cex.connector_binance_deposits import (
            ConnectorBinanceDeposits,
        )
        from backend.connectors.cex.connector_binance_withdrawals import (
            BinanceWithdrawalsConnector,
        )
        from backend.connectors.onchain.blockscout.connector_blockscout_hub import (
            ConnectorBlockscoutHub,
        )
        from backend.connectors.onchain.etherscan.connector_etherscan_hub import (
            ConnectorEtherscanHub,
        )

        self._connector_classes = {
            "binance-transactions": BinanceTrxConnector,
            "binance-deposits": ConnectorBinanceDeposits,
            "binance-withdrawals": BinanceWithdrawalsConnector,
            "mexc-transactions": MEXCConnectorTrx,
            "okx-transactions": OKXConnectorTrx,
            "okx-convert": OKXConvertConnector,
            "coinbase-transactions": ConnectorCoinbaseTrx,
            # On-chain connectors mapped directly to their hub classes
            "blockscout": ConnectorBlockscoutHub,
            "etherscan": ConnectorEtherscanHub,
        }

        return self._connector_classes

    # ==================== Public API ====================

    def get(self, connector_type: str) -> Optional[ConnectorInfo]:
        """Get connector info by type."""
        return self._connectors.get(connector_type)

    def get_class(self, connector_type: str) -> Optional[Type]:
        """Get connector class by type."""
        classes = self._load_connector_classes()

        # First try direct lookup by connector type
        if connector_type in classes:
            return classes.get(connector_type)

        # Fall back to hub_key lookup for backwards compatibility
        hub_key = self.get_hub_key(connector_type)
        if hub_key:
            return classes.get(hub_key)
        return None

    def get_hub_key(self, connector_type: str) -> Optional[str]:
        """Get the hub key for a connector type. Defaults to type if hub_key is None."""
        info = self.get(connector_type)
        if info:
            return info.hub_key if info.hub_key else info.type
        return None

    def get_chain_config(
        self, connector_type: str, chain: str
    ) -> Optional[ChainConfig]:
        """Get chain configuration for an on-chain connector."""
        type_configs = self._chain_configs.get(connector_type)
        if type_configs:
            return type_configs.get(chain)
        return None

    def get_chain_configs(self, connector_type: str) -> Dict[str, ChainConfig]:
        """Get all chain configurations for a connector type."""
        return self._chain_configs.get(connector_type, {})

    def list_types(self) -> List[str]:
        """List all registered connector types."""
        return list(self._connectors.keys())

    def list_by_category(self, category: str) -> List[ConnectorInfo]:
        """List connectors by category."""
        return [c for c in self._connectors.values() if c.category == category]

    def list_cex_connectors(self) -> List[ConnectorInfo]:
        """List all CEX connectors."""
        return self.list_by_category("cex")

    def list_onchain_connectors(self) -> List[ConnectorInfo]:
        """List all on-chain connectors."""
        return self.list_by_category("onchain")

    def is_onchain(self, connector_type: str) -> bool:
        """Check if a connector type is an on-chain connector."""
        info = self.get(connector_type)
        return info is not None and info.category == "onchain"

    def get_connector_map(self) -> Dict[str, Type]:
        """Get the full connector type to class mapping (for ConnectorHub).

        Returns a map where the key is the connector type (e.g., 'binance-transactions',
        'blockscout', 'etherscan') and the value is the connector class.
        """
        classes = self._load_connector_classes()
        result = {}
        for connector_type in self._connectors.keys():
            # Try direct lookup first
            if connector_type in classes:
                result[connector_type] = classes[connector_type]
        return result

    def get_api_connectors(self) -> Dict[str, Dict[str, Any]]:
        """Get connector info formatted for API responses."""
        return {ctype: info.to_api_dict() for ctype, info in self._connectors.items()}

    def validate_connector_type(self, connector_type: str) -> bool:
        """Check if a connector type is valid."""
        return connector_type in self._connectors

    def validate_chain(self, connector_type: str, chain: str) -> bool:
        """Check if a chain is valid for a connector type."""
        info = self.get(connector_type)
        if info and info.supported_chains:
            return chain in info.supported_chains
        return True  # Non-chain connectors accept any chain (ignored)


# Convenience function
def get_connector_registry() -> ConnectorRegistry:
    """Get the connector registry singleton."""
    return ConnectorRegistry.instance()
