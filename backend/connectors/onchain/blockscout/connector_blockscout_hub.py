"""  
Blockscout Hub connector: Aggregates normal transactions and token transfers for a single wallet address.
Uses Blockscout API v2. Supports multiple networks (Base, Ethereum, Arbitrum, etc.).
Object-oriented design implementing BaseConnector interface.
"""

from typing import Optional, Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging

log = configure_logging(__name__)


class ConnectorBlockscoutHub(BaseHubConnector):
    """Blockscout Hub connector that aggregates normal transactions and token transfers."""

    @property
    def connector_name(self) -> str:
        return f"blockscout_hub_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "base",
        account_id: int = None,
        connector_id: int = None,
        config: Optional[Dict[str, Any]] = None,
        **kwargs,
    ):
        """
        Initialize Blockscout Hub connector that aggregates both transaction types.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "base", "ethereum", "arbitrum")
            config: Configuration dict (may include parent_output_path)
        """
        self.wallet_address = wallet_address
        self.chain_name = chain_name

        # Import specialized connectors
        from .connector_blockscout_normal_tx import ConnectorBlockscoutNormalTx
        from .connector_blockscout_token_transfers import (
            ConnectorBlockscoutTokenTransfers,
        )

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate chain is supported
        registry = get_connector_registry()
        chain_config = registry.get_chain_config("blockscout", self.chain_name)
        if not chain_config:
            all_chains = list(registry.get_chain_configs("blockscout").keys())
            raise ValueError(
                f"Unknown chain '{chain_name}'. Available: {all_chains}"
            )

        # Get test/renormalize mode from config
        test_mode = (config or {}).get("test_mode", False)
        renormalize_mode = (config or {}).get("renormalize_mode", False)
        
        if not test_mode and not renormalize_mode:
            # Live mode: validate API-related configuration
            if not chain_config.base_url:
                raise ValueError(
                    f"Blockscout API not available for chain '{chain_name}'"
                )
        
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
        
        normal_tx_connector = ConnectorBlockscoutNormalTx(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        token_transfers_connector = ConnectorBlockscoutTokenTransfers(
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


# Tests available at:
# pytest tests/unit/connectors/onchain/test_blockscout_connector.py -v
