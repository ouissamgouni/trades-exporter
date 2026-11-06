"""
Centralized Connector Registry - Single source of truth for connector configuration.

This module provides the authoritative mapping between:
- Connector type names (used in database and API)
- Connector classes (Python implementation)
- Connector metadata (display names, categories, config requirements)
- Chain configurations (for on-chain connectors)
"""

import os
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Type, Any

from backend.config.loader import configure_logging
from backend.core.network_normalizer import get_network_display_name, normalize_network

log = configure_logging("connector_registry")

# Raw source name -> provider leaf class that produced it, so stored raws stay
# readable after a connector switches provider.
_RAW_SOURCE_ORIGINS: List[Tuple["re.Pattern[str]", str, str]] = [
    (re.compile(r"^ankr_(?P<chain>\w+)$"), "backend.connectors.onchain.connector_ankr", "ConnectorAnkr"),
    (
        re.compile(r"^moralis_wallet_history_(?P<chain>\w+)$"),
        "backend.connectors.onchain.connector_moralis_wallet_history",
        "ConnectorMoralisWalletHistory",
    ),
    (
        re.compile(r"^blockscout_(?P<chain>\w+?)_normal_tx$"),
        "backend.connectors.onchain.blockscout.connector_blockscout_normal_tx",
        "ConnectorBlockscoutNormalTx",
    ),
    (
        re.compile(r"^blockscout_token_transfers_(?P<chain>\w+)$"),
        "backend.connectors.onchain.blockscout.connector_blockscout_token_transfers",
        "ConnectorBlockscoutTokenTransfers",
    ),
    (
        re.compile(r"^etherscan_normal_tx_(?P<chain>\w+)$"),
        "backend.connectors.onchain.etherscan.connector_etherscan_normal_tx",
        "ConnectorEtherscanNormalTx",
    ),
    (
        re.compile(r"^etherscan_token_transfers_(?P<chain>\w+)$"),
        "backend.connectors.onchain.etherscan.connector_etherscan_token_transfers",
        "ConnectorEtherscanTokenTransfers",
    ),
]


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

    # Incremental sync support - True for CEX connectors that support "since" parameter
    supports_incremental_sync: bool = False

    # File connector support - groups related API and file connectors in UI
    connector_family: Optional[str] = (
        None  # e.g., "mexc-transactions" for both API and file variants
    )
    is_file_connector: bool = False  # True for file-based import connectors

    # Balance support - True for connectors that can fetch live balances
    supports_balance: bool = False

    # Derivative support - exchange name for derivative position tracking
    # Only set for connectors that produce derivative positions (perps, futures)
    derivative_exchange: Optional[str] = None

    # Provider picker metadata
    status: str = "active"  # "active" | "legacy" | "degraded"
    status_note: Optional[str] = None
    degraded_chains: List[str] = field(default_factory=list)  # canonical names
    recommended_for: List[str] = field(default_factory=list)  # canonical names
    # Start used by the connector itself when no since/start_datetime is given
    default_start: Optional[str] = None
    required_env: List[str] = field(default_factory=list)
    # UI grouping: "exchange" | "evm" | "chain" | "app" | "file"; derived when empty
    group: str = ""

    def __post_init__(self):
        if not self.group:
            if self.is_file_connector:
                self.group = "file"
            elif self.category != "onchain":
                self.group = "exchange"
            else:
                self.group = "chain"

    def chain_options(self) -> List[Dict[str, str]]:
        """Supported chains as stored value + canonical name + display label."""
        options = []
        for value in self.supported_chains or []:
            canonical = normalize_network(value) or value
            options.append(
                {
                    "value": value,
                    "canonical": canonical,
                    "label": get_network_display_name(canonical),
                }
            )
        return options

    def chain_value_for(self, chain: Optional[str]) -> Optional[str]:
        """Map any chain alias (e.g. "eth") to this connector's stored value."""
        canonical = normalize_network(chain)
        for option in self.chain_options():
            if option["canonical"] == canonical:
                return option["value"]
        return None

    def to_api_dict(self) -> Dict[str, Any]:
        """Convert to API-friendly dictionary."""
        return {
            "type": self.type,
            "category": self.category,
            "display_name": self.display_name,
            "supported_chains": self.supported_chains,
            "required_config": self.required_config,
            "optional_config": self.optional_config,
            "supports_incremental_sync": self.supports_incremental_sync,
            "connector_family": self.connector_family,
            "is_file_connector": self.is_file_connector,
            "supports_balance": self.supports_balance,
            "group": self.group,
            "chains": self.chain_options(),
            "status": self.status,
            "status_note": self.status_note,
            "degraded_chains": self.degraded_chains,
            "recommended_for": self.recommended_for,
            "default_start": self.default_start,
            "required_env": self.required_env,
            # Only names are exposed, never values
            "missing_env": [v for v in self.required_env if not os.getenv(v)],
        }


@dataclass
class ChainConfig:
    """Configuration for a specific blockchain/explorer combination."""

    explorer_type: str
    base_url: str
    chain_id: Optional[int] = None
    native_currency: Optional[str] = None
    native_token_decimals: Optional[int] = None


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
                optional_config=["symbols", "start_datetime"],
                supports_incremental_sync=True,
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="binance-deposits",
                category="cex",
                display_name="Binance Deposits",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="binance-withdrawals",
                category="cex",
                display_name="Binance Withdrawals",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-transactions",
                category="cex",
                display_name="MEXC Transactions (API)",
                required_config=[],
                optional_config=["symbols", "start_datetime"],
                supports_incremental_sync=True,
                connector_family="mexc-transactions",
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-transactions-file",
                category="cex",
                display_name="MEXC Transactions (File)",
                required_config=[],
                optional_config=["file_path"],
                supports_incremental_sync=False,
                connector_family="mexc-transactions",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-deposits",
                category="cex",
                display_name="MEXC Deposits",
                required_config=[],
                optional_config=["currencies", "start_datetime"],
                supports_incremental_sync=True,
                connector_family="mexc-deposits",
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-deposits-file",
                category="cex",
                display_name="MEXC Deposits (File)",
                required_config=[],
                optional_config=["file_path"],
                supports_incremental_sync=False,
                connector_family="mexc-deposits",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-withdrawals",
                category="cex",
                display_name="MEXC Withdrawals",
                required_config=[],
                optional_config=["currencies", "start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="mexc-withdrawals-file",
                category="cex",
                display_name="MEXC Withdrawals (File)",
                required_config=[],
                optional_config=["file_path"],
                supports_incremental_sync=False,
                connector_family="mexc-withdrawals",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-transactions",
                category="cex",
                display_name="OKX Transactions",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-convert",
                category="cex",
                display_name="OKX Convert",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-deposits",
                category="cex",
                display_name="OKX Deposits",
                required_config=[],
                optional_config=["currencies", "start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-withdrawals",
                category="cex",
                display_name="OKX Withdrawals",
                required_config=[],
                optional_config=["currencies", "start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="okx-file",
                category="cex",
                display_name="OKX Trading History (File)",
                required_config=[],
                optional_config=["file_path", "source_timezone"],
                supports_incremental_sync=False,
                connector_family="okx",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="degiro-file",
                category="cex",
                display_name="DeGiro Transactions (File)",
                required_config=[],
                optional_config=["file_path"],
                supports_incremental_sync=False,
                connector_family="degiro",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="degiro-account-file",
                category="cex",
                display_name="DeGiro Account (File)",
                required_config=[],
                optional_config=["file_path"],
                supports_incremental_sync=False,
                connector_family="degiro",
                is_file_connector=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="coinbase-transactions",
                category="cex",
                display_name="Coinbase Transactions",
                required_config=[],
                optional_config=["symbols", "start_datetime"],
                supports_incremental_sync=True,
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="coinbase-deposits",
                category="cex",
                display_name="Coinbase Deposits",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="coinbase-withdrawals",
                category="cex",
                display_name="Coinbase Withdrawals",
                required_config=[],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
            )
        )

        # ==================== DEX Connectors ====================

        self._register(
            ConnectorInfo(
                type="hyperliquid-perps",
                category="cex",
                display_name="Hyperliquid Perps",
                required_config=[],
                optional_config=["wallet_address", "start_datetime"],
                supports_incremental_sync=True,
                connector_family="hyperliquid",
                default_start="2025-10-01T00:00:00+00:00",
                supports_balance=True,
                derivative_exchange="hyperliquid",
            )
        )

        self._register(
            ConnectorInfo(
                type="hyperliquid-funding",
                category="cex",
                display_name="Hyperliquid Funding",
                required_config=[],
                optional_config=["wallet_address", "start_datetime"],
                supports_incremental_sync=True,
                connector_family="hyperliquid",
                default_start="2025-10-01T00:00:00+00:00",
            )
        )

        self._register(
            ConnectorInfo(
                type="hyperliquid-transfers",
                category="cex",
                display_name="Hyperliquid Transfers",
                required_config=[],
                optional_config=["wallet_address", "start_datetime"],
                supports_incremental_sync=True,
                connector_family="hyperliquid",
                default_start="2025-10-01T00:00:00+00:00",
            )
        )

        # ==================== On-Chain Connectors ====================

        self._register(
            ConnectorInfo(
                type="blockscout",
                category="onchain",
                display_name="EVM · Blockscout",
                hub_key="on-chain",
                group="evm",
                status="degraded",
                status_note=(
                    "Cloudflare blocks API requests on Base, Polygon and Arbitrum; "
                    "HyperEVM explorer (hyperscan.com) was retired"
                ),
                degraded_chains=["base", "polygon", "arbitrum", "hyperevm"],
                supported_chains=[
                    "base",
                    "ethereum",
                    "polygon",
                    "arbitrum",
                    "optimism",
                    "hyperevm",
                ],
                required_config=["chain", "address"],
                optional_config=[
                    "start_datetime",
                    "include_internal_txs",
                    "include_token_transfers",
                ],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="etherscan",
                category="onchain",
                display_name="EVM · Etherscan",
                hub_key="on-chain",
                group="evm",
                recommended_for=["ethereum", "hyperevm"],
                required_env=["ETHERSCAN_API_KEY"],
                supported_chains=["ethereum", "hyperevm"],
                required_config=["address"],
                optional_config=[
                    "start_datetime",
                    "include_internal_txs",
                    "include_token_transfers",
                ],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="moralis",
                category="onchain",
                display_name="EVM · Moralis (legacy)",
                hub_key="on-chain",
                group="evm",
                status="legacy",
                status_note="Superseded by Ankr; kept for existing connectors",
                required_env=["MORALIS_API_KEY"],
                supported_chains=[
                    "eth",
                    "bsc",
                    "base",
                    "polygon",
                    "arbitrum",
                    "avalanche",
                    "optimism",
                    "sei",
                ],
                required_config=["chain", "address"],
                optional_config=[],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="ankr",
                category="onchain",
                display_name="EVM · Ankr",
                hub_key="on-chain",
                group="evm",
                recommended_for=["bsc", "arbitrum", "polygon", "base", "optimism", "avalanche"],
                required_env=["ANKR_API_KEY"],
                supported_chains=[
                    "bsc",
                    "arbitrum",
                    "ethereum",
                    "polygon",
                    "base",
                    "optimism",
                    "avalanche",
                ],
                required_config=["chain", "address"],
                optional_config=["start_datetime"],
                supports_incremental_sync=True,
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="solana",
                category="onchain",
                display_name="Solana (Helius)",
                hub_key="on-chain",
                recommended_for=["solana"],
                required_env=["HELIUS_API_KEY"],
                supported_chains=["solana"],
                required_config=["address"],
                optional_config=["api_key"],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="xrp",
                category="onchain",
                display_name="XRP Ledger (XRPScan)",
                hub_key="on-chain",
                recommended_for=["xrp"],
                supported_chains=["xrp"],
                required_config=["address"],
                optional_config=[],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="cardano_scan",
                category="onchain",
                display_name="Cardano (Cardanoscan)",
                hub_key="on-chain",
                recommended_for=["cardano"],
                supported_chains=["cardano"],
                required_config=["address"],
                optional_config=["api_key"],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="sui",
                category="onchain",
                display_name="Sui (GraphQL)",
                hub_key="on-chain",
                recommended_for=["sui"],
                supported_chains=["sui"],
                required_config=["address"],
                optional_config=[],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="bitcoin_esplora",
                category="onchain",
                display_name="Bitcoin (Esplora)",
                hub_key="on-chain",
                recommended_for=["bitcoin"],
                supported_chains=["bitcoin"],
                required_config=["address"],
                optional_config=[],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="near",
                category="onchain",
                display_name="NEAR (NearBlocks)",
                hub_key="on-chain",
                recommended_for=["near"],
                required_env=["NEARBLOCKS_API_KEY"],
                supported_chains=["near"],
                required_config=["address"],
                optional_config=["api_key"],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="bittensor",
                category="onchain",
                display_name="Bittensor (Taostats)",
                hub_key="on-chain",
                recommended_for=["bittensor"],
                supported_chains=["bittensor"],
                required_config=["address"],
                optional_config=["api_key"],
                supports_balance=True,
            )
        )

        self._register(
            ConnectorInfo(
                type="polymarket",
                category="onchain",
                display_name="Polymarket",
                hub_key="on-chain",
                group="app",
                required_env=["ANKR_API_KEY"],
                supported_chains=["polygon"],
                required_config=["address"],
                optional_config=[],
                supports_incremental_sync=True,
                supports_balance=True,
            )
        )

    def _register_chain_configs(self):
        """Register chain configurations for on-chain connectors."""

        # Blockscout chains
        self._chain_configs["blockscout"] = {
            "base": ChainConfig(
                explorer_type="blockscout",
                base_url="https://base.blockscout.com/api/v2",
                chain_id=8453,
                native_currency="ETH",
                native_token_decimals=18,
            ),
            "ethereum": ChainConfig(
                explorer_type="blockscout",
                base_url="https://eth.blockscout.com/api/v2",
                chain_id=1,
                native_currency="ETH",
                native_token_decimals=18,
            ),
            "polygon": ChainConfig(
                explorer_type="blockscout",
                base_url="https://polygon.blockscout.com/api/v2",
                chain_id=137,
                native_currency="MATIC",
                native_token_decimals=18,
            ),
            "arbitrum": ChainConfig(
                explorer_type="blockscout",
                base_url="https://arbitrum.blockscout.com/api/v2",
                chain_id=42161,
                native_currency="ETH",
                native_token_decimals=18,
            ),
            "optimism": ChainConfig(
                explorer_type="blockscout",
                base_url="https://optimism.blockscout.com/api/v2",
                chain_id=10,
                native_currency="ETH",
                native_token_decimals=18,
            ),
            "hyperevm": ChainConfig(
                explorer_type="blockscout",
                base_url="https://www.hyperscan.com/api/v2",
                chain_id=998,
                native_currency="HYPE",
                native_token_decimals=18,
            ),
        }

        # Etherscan
        self._chain_configs["etherscan"] = {
            "ethereum": ChainConfig(
                explorer_type="etherscan",
                base_url="https://api.etherscan.io/api",
                chain_id=1,
                native_currency="ETH",
                native_token_decimals=18,
            ),
            "hyperevm": ChainConfig(
                explorer_type="etherscan",
                base_url="https://api.etherscan.io/v2/api",
                chain_id=999,
                native_currency="HYPE",
                native_token_decimals=18,
            ),
        }

        # Cardano
        self._chain_configs["cardano_scan"] = {
            "cardano": ChainConfig(
                explorer_type="cardanoscan",
                base_url="https://api.cardanoscan.io/api/v1",
                chain_id=None,
                native_currency="ADA",
                native_token_decimals=6,
            ),
        }

        # XRP Ledger
        self._chain_configs["xrp"] = {
            "xrp": ChainConfig(
                explorer_type="xrpscan",
                base_url="https://api.xrpscan.com/api/v1",
                chain_id=None,
                native_currency="XRP",
                native_token_decimals=6,
            ),
        }

        # Solana
        self._chain_configs["solana"] = {
            "solana": ChainConfig(
                explorer_type="helius",
                base_url="https://api.helius.xyz/v0",
                chain_id=None,
                native_currency="SOL",
                native_token_decimals=9,
            ),
        }

        # SUI
        self._chain_configs["sui"] = {
            "sui": ChainConfig(
                explorer_type="sui_graphql",
                base_url="https://graphql.mainnet.sui.io/graphql",
                chain_id=None,
                native_currency="SUI",
                native_token_decimals=9,
            ),
        }

        # Bitcoin
        self._chain_configs["bitcoin_esplora"] = {
            "bitcoin": ChainConfig(
                explorer_type="bitcoin_esplora",
                base_url="https://blockstream.info/api",
                chain_id=None,
                native_currency="BTC",
                native_token_decimals=8,
            ),
        }

        # NEAR Protocol
        self._chain_configs["near"] = {
            "near": ChainConfig(
                explorer_type="nearblocks",
                base_url="https://api.nearblocks.io/v1",
                chain_id=None,
                native_currency="NEAR",
                native_token_decimals=24,
            ),
        }

        # Bittensor (TAO)
        self._chain_configs["bittensor"] = {
            "bittensor": ChainConfig(
                explorer_type="taostats",
                base_url="https://api.taostats.io",
                chain_id=None,
                native_currency="TAO",
                native_token_decimals=9,
            ),
        }

        # Polymarket (Polygon-based prediction market)
        self._chain_configs["polymarket"] = {
            "polygon": ChainConfig(
                explorer_type="polymarket",
                base_url="https://data-api.polymarket.com/v2",
                chain_id=137,
                native_currency="USDC",
                native_token_decimals=6,
            ),
        }

    def _register(self, info: ConnectorInfo):
        """Register a connector type."""
        self._connectors[info.type] = info

    def _load_connector_classes(self) -> Dict[str, Type]:
        """Lazy-load connector classes to avoid circular imports."""
        if self._connector_classes is not None:
            return self._connector_classes

        # Import connector classes here to avoid circular imports
        from backend.connectors.cex.connector_mexc_trx import MEXCConnectorTrx
        from backend.connectors.cex.connector_mexc_trx_file import MEXCTrxFileConnector
        from backend.connectors.cex.connector_mexc_deposits import MEXCDepositsConnector
        from backend.connectors.cex.connector_mexc_deposits_file import (
            MEXCDepositsFileConnector,
        )
        from backend.connectors.cex.connector_mexc_withdrawals import (
            MEXCWithdrawalsConnector,
        )
        from backend.connectors.cex.connector_mexc_withdrawals_file import (
            MEXCWithdrawalsFileConnector,
        )
        from backend.connectors.cex.connector_binance_trx import BinanceTrxConnector
        from backend.connectors.cex.connector_okx_trx import OKXConnectorTrx
        from backend.connectors.cex.connector_okx_convert import OKXConvertConnector
        from backend.connectors.cex.connector_okx_deposits import OKXDepositsConnector
        from backend.connectors.cex.connector_okx_withdrawals import (
            OKXWithdrawalsConnector,
        )
        from backend.connectors.cex.connector_okx_file import OKXFileConnector
        from backend.connectors.cex.connector_degiro_file import DeGiroFileConnector
        from backend.connectors.cex.connector_degiro_account_file import (
            DeGiroAccountFileConnector,
        )
        from backend.connectors.cex.connector_coinbase_trx import ConnectorCoinbaseTrx
        from backend.connectors.cex.connector_coinbase_deposits import (
            ConnectorCoinbaseDeposits,
        )
        from backend.connectors.cex.connector_coinbase_withdrawals import (
            ConnectorCoinbaseWithdrawals,
        )
        from backend.connectors.cex.connector_binance_deposits import (
            ConnectorBinanceDeposits,
        )
        from backend.connectors.cex.connector_binance_withdrawals import (
            BinanceWithdrawalsConnector,
        )
        from backend.connectors.cex.connector_hyperliquid_perps import (
            HyperliquidPerpsConnector,
        )
        from backend.connectors.cex.connector_hyperliquid_funding import (
            HyperliquidFundingConnector,
        )
        from backend.connectors.cex.connector_hyperliquid_transfers import (
            HyperliquidTransfersConnector,
        )
        from backend.connectors.onchain.blockscout.connector_blockscout_hub import (
            ConnectorBlockscoutHub,
        )
        from backend.connectors.onchain.etherscan.connector_etherscan_hub import (
            ConnectorEtherscanHub,
        )
        from backend.connectors.onchain.connector_moralis_wallet_history import (
            ConnectorMoralisWalletHistory,
        )
        from backend.connectors.onchain.connector_ankr import ConnectorAnkr
        from backend.connectors.onchain.connector_xrp_ledger import (
            ConnectorXRPLedger,
        )
        from backend.connectors.onchain.connector_solana_helius import (
            ConnectorSolanaHelius,
        )
        from backend.connectors.onchain.connector_cardano_scan import (
            ConnectorCardanoScan,
        )
        from backend.connectors.onchain.connector_sui import (
            ConnectorSui,
        )
        from backend.connectors.onchain.connector_bitcoin_esplora import (
            ConnectorBitcoinEsplora,
        )
        from backend.connectors.onchain.near.connector_near_hub import (
            ConnectorNearHub,
        )
        from backend.connectors.onchain.connector_bittensor import (
            ConnectorBittensor,
        )
        from backend.connectors.onchain.connector_polymarket import (
            ConnectorPolymarket,
        )
        from backend.connectors.onchain.connector_polymarket_hub import (
            ConnectorPolymarketHub,
        )

        self._connector_classes = {
            "binance-transactions": BinanceTrxConnector,
            "binance-deposits": ConnectorBinanceDeposits,
            "binance-withdrawals": BinanceWithdrawalsConnector,
            "mexc-transactions": MEXCConnectorTrx,
            "mexc-transactions-file": MEXCTrxFileConnector,
            "mexc-deposits": MEXCDepositsConnector,
            "mexc-deposits-file": MEXCDepositsFileConnector,
            "mexc-withdrawals": MEXCWithdrawalsConnector,
            "mexc-withdrawals-file": MEXCWithdrawalsFileConnector,
            "okx-transactions": OKXConnectorTrx,
            "okx-convert": OKXConvertConnector,
            "okx-deposits": OKXDepositsConnector,
            "okx-withdrawals": OKXWithdrawalsConnector,
            "okx-file": OKXFileConnector,
            "degiro-file": DeGiroFileConnector,
            "degiro-account-file": DeGiroAccountFileConnector,
            "coinbase-transactions": ConnectorCoinbaseTrx,
            "coinbase-deposits": ConnectorCoinbaseDeposits,
            "coinbase-withdrawals": ConnectorCoinbaseWithdrawals,
            # Hyperliquid DEX connectors
            "hyperliquid-perps": HyperliquidPerpsConnector,
            "hyperliquid-funding": HyperliquidFundingConnector,
            "hyperliquid-transfers": HyperliquidTransfersConnector,
            # On-chain connectors mapped directly to their hub classes
            "solana": ConnectorSolanaHelius,
            "blockscout": ConnectorBlockscoutHub,
            "etherscan": ConnectorEtherscanHub,
            "moralis": ConnectorMoralisWalletHistory,
            "ankr": ConnectorAnkr,
            "xrp": ConnectorXRPLedger,
            "cardano_scan": ConnectorCardanoScan,
            "sui": ConnectorSui,
            "bitcoin_esplora": ConnectorBitcoinEsplora,
            "near": ConnectorNearHub,
            "bittensor": ConnectorBittensor,
            "polymarket": ConnectorPolymarketHub,
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

    def resolve_raw_origin(self, raw_source: str) -> Optional[Tuple[Type, str]]:
        """(leaf connector class, chain) that produced raws stored under raw_source."""
        import importlib

        for pattern, module_name, class_name in _RAW_SOURCE_ORIGINS:
            match = pattern.match(raw_source or "")
            if match:
                module = importlib.import_module(module_name)
                return getattr(module, class_name), match.group("chain")
        return None

    def validate_connector_type(self, connector_type: str) -> bool:
        """Check if a connector type is valid."""
        return connector_type in self._connectors

    def validate_chain(self, connector_type: str, chain: str) -> bool:
        """Check if a chain is valid for a connector type."""
        info = self.get(connector_type)
        if info and info.supported_chains:
            return chain in info.supported_chains
        return True  # Non-chain connectors accept any chain (ignored)

    def get_native_token(self, connector_type: str, chain: str) -> Optional[str]:
        """Get native token symbol for a chain.

        Args:
            connector_type: Connector type (e.g., 'blockscout', 'cardano_scan')
            chain: Chain name (e.g., 'ethereum', 'cardano')

        Returns:
            Native token symbol (e.g., 'ETH', 'ADA') or None if not found
        """
        config = self.get_chain_config(connector_type, chain)
        return config.native_currency if config else None

    def get_native_token_decimals(
        self, connector_type: str, chain: str
    ) -> Optional[int]:
        """Get native token decimals for a chain.

        Args:
            connector_type: Connector type (e.g., 'blockscout', 'cardano_scan')
            chain: Chain name (e.g., 'ethereum', 'cardano')

        Returns:
            Native token decimals (e.g., 18, 6) or None if not found
        """
        config = self.get_chain_config(connector_type, chain)
        return config.native_token_decimals if config else None

    def get_chain_id(self, connector_type: str, chain: str) -> Optional[int]:
        """Get chain ID for a chain.

        Args:
            connector_type: Connector type (e.g., 'blockscout', 'etherscan')
            chain: Chain name (e.g., 'ethereum', 'base')

        Returns:
            Chain ID (e.g., 1 for Ethereum) or None if not applicable
        """
        config = self.get_chain_config(connector_type, chain)
        return config.chain_id if config else None


# Convenience function
def get_connector_registry() -> ConnectorRegistry:
    """Get the connector registry singleton."""
    return ConnectorRegistry.instance()
