"""
Blockscout Hub connector: Aggregates normal transactions and token transfers for a single wallet address.
Uses Blockscout API v2. Supports multiple networks (Base, Ethereum, Arbitrum, etc.).
Object-oriented design implementing BaseConnector interface.
"""

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.onchain.chain_config import (
    get_chain_config,
    get_blockscout_api_url,
    CHAIN_CONFIG,
)
from backend.config.loader import configure_logging, is_test_mode

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
        **kwargs,
    ):
        """
        Initialize Blockscout Hub connector that aggregates both transaction types.
        In test mode, creates child connectors so they return test data.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "base", "ethereum", "arbitrum")
        """
        self.wallet_address = wallet_address
        self.chain_name = chain_name
        test_mode = is_test_mode()

        # Import specialized connectors (needed for both test and live mode)
        from .connector_blockscout_normal_tx import ConnectorBlockscoutNormalTx
        from .connector_blockscout_token_transfers import (
            ConnectorBlockscoutTokenTransfers,
        )

        # Validate wallet configuration (required in both test and live mode)
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate chain is supported (required in both test and live mode)
        chain_config = get_chain_config(self.chain_name)
        if not chain_config:
            raise ValueError(
                f"Unknown chain '{chain_name}'. Available: {list(CHAIN_CONFIG.keys())}"
            )

        if not test_mode:
            # Live mode: validate API-related configuration
            blockscout_url = get_blockscout_api_url(self.chain_name)
            if not blockscout_url:
                raise ValueError(
                    f"Blockscout API not available for chain '{chain_name}'"
                )

        # Create specialized connectors (they get native_token from chain_config)
        # In test mode, each child connector will return its own test data
        normal_tx_connector = ConnectorBlockscoutNormalTx(
            wallet_address=self.wallet_address,
            chain_name=self.chain_name,
        )

        token_transfers_connector = ConnectorBlockscoutTokenTransfers(
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
# pytest tests/unit/connectors/onchain/test_blockscout_connector.py -v
