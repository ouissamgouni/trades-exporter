"""
Etherscan Hub connector: Aggregates normal transactions and token transfers for a single wallet address.
Supports EVM chains through Etherscan API v2.
Object-oriented design implementing BaseConnector interface.
"""

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.onchain.chain_config import get_chain_config, CHAIN_CONFIG
from backend.config.loader import configure_logging, load_settings, is_test_mode

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
        **kwargs,
    ):
        """
        Initialize Etherscan Hub connector that aggregates both transaction types.
        In test mode, creates child connectors so they return test data.

        Args:
            wallet_address: The wallet address to scan
            chain_name: The chain name (e.g., "Ethereum", "BSC")
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name
        self.wallet_address = wallet_address
        test_mode = is_test_mode()

        # Import specialized connectors (needed for both test and live mode)
        from .connector_etherscan_normal_tx import ConnectorEtherscanNormalTx
        from .connector_etherscan_token_transfers import (
            ConnectorEtherscanTokenTransfers,
        )

        # Validate wallet address (required in both test and live mode)
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate chain is supported (required in both test and live mode)
        chain_config = get_chain_config(self.chain_name)
        if not chain_config:
            raise ValueError(
                f"Unsupported chain: {self.chain_name}. Available: {list(CHAIN_CONFIG.keys())}"
            )

        if not test_mode:
            # Live mode: validate API key
            web3_config = load_settings().get("web3_wallets", {})
            api_key = web3_config.get("etherscan_api_key", "")
            if not api_key:
                raise ValueError("Missing API KEY")

        # Create specialized connectors (they get native_token from chain_config)
        # In test mode, each child connector will detect test mode and return test data
        normal_tx_connector = ConnectorEtherscanNormalTx(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
        )

        token_transfers_connector = ConnectorEtherscanTokenTransfers(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
        )

        child_connectors = [
            ("normal transactions", normal_tx_connector),
            ("token transfers", token_transfers_connector),
        ]
        # Initialize as BaseHubConnector with queue strategy (good for 2 children)
        super().__init__(
            child_connectors=child_connectors,
            parallel_strategy="queue",
        )


# Tests available at:
# pytest tests/unit/connectors/onchain/test_etherscan_connector.py -v
