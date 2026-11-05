"""
Etherscan Hub connector: Aggregates normal transactions and token transfers for a single wallet address.
Supports EVM chains through Etherscan API v2.
Object-oriented design implementing BaseConnector interface.
"""

from typing import Optional, Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging, get_etherscan_api_key, load_settings

log = configure_logging(__name__)


# ===== Etherscan Hub Connector Class =====


class ConnectorEtherscanHub(BaseHubConnector):
    """Etherscan Hub connector that aggregates normal transactions and token transfers."""

    @property
    def connector_name(self) -> str:
        return f"etherscan_hub_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "ethereum",
        account_id: int = None,
        connector_id: int = None,
        config: Optional[Dict[str, Any]] = None,
        **kwargs,
    ):
        """
        Initialize Etherscan Hub connector that aggregates both transaction types.

        Args:
            wallet_address: The wallet address to scan
            chain_name: The chain name (e.g., "Ethereum", "BSC")
            config: Configuration dict (may include parent_output_path)
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name
        self.wallet_address = wallet_address

        # Import specialized connectors
        from .connector_etherscan_normal_tx import ConnectorEtherscanNormalTx
        from .connector_etherscan_token_transfers import (
            ConnectorEtherscanTokenTransfers,
        )

        # Validate wallet address
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate chain is supported
        registry = get_connector_registry()
        chain_config = registry.get_chain_config("etherscan", self.chain_name)
        if not chain_config:
            all_chains = list(registry.get_chain_configs("etherscan").keys())
            raise ValueError(
                f"Unsupported chain: {self.chain_name}. Available: {all_chains}"
            )

        # Get test/renormalize mode from config
        test_mode = (config or {}).get("test_mode", False)
        renormalize_mode = (config or {}).get("renormalize_mode", False)
        
        if not test_mode and not renormalize_mode:
            # Live mode: validate API key
            api_key = get_etherscan_api_key()
            if not api_key:
                raise ValueError("Missing API KEY")
        
        # Initialize parent first to get output_path
        super().__init__(
            child_connectors=[],  # Will populate after creating children
            parallel_strategy="queue",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

        # Create specialized connectors with parent output path
        # In test/renormalize mode, each child connector will skip API config
        child_config = {"parent_output_path": self.output_path}
        if test_mode:
            child_config["test_mode"] = True
        if renormalize_mode:
            child_config["renormalize_mode"] = True
        
        normal_tx_connector = ConnectorEtherscanNormalTx(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        token_transfers_connector = ConnectorEtherscanTokenTransfers(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        child_connectors = [
            ("normal transactions", normal_tx_connector),
            ("token transfers", token_transfers_connector),
        ]
        
        # Update child connectors after creation
        self.child_connectors = child_connectors

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        import requests
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        api_key = get_etherscan_api_key()
        registry = get_connector_registry()
        chain_config = registry.get_chain_config("etherscan", self.chain_name)
        chain_id = chain_config.chain_id if chain_config else 1
        entries = []

        # Native balance
        try:
            resp = requests.get(
                "https://api.etherscan.io/v2/api",
                params={
                    "module": "account",
                    "action": "balance",
                    "address": self.wallet_address,
                    "chainid": chain_id,
                    "apikey": api_key,
                },
                timeout=10,
            )
            resp.raise_for_status()
            data = resp.json()
            result = data.get("result", "0")
            if result and int(result) > 0:
                total = Decimal(result) / Decimal(10 ** 18)
                entries.append(BalanceEntry(
                    asset_symbol="ETH",
                    total=total,
                    available=total,
                    chain=self.chain_name,
                    raw=data,
                ))
        except Exception as e:
            log.warning(f"Failed to fetch native balance from Etherscan: {e}")

        return entries
