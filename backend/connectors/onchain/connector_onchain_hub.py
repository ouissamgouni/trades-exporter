"""
Onchain Hub connector: Aggregates all onchain blockchain data from multiple chains and scanners.
Combines Blockscout and Etherscan connectors for comprehensive blockchain transaction tracking.
Object-oriented design implementing BaseConnector interface.
"""

from typing import Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.config.loader import configure_logging, load_settings

log = configure_logging(__name__)


# ===== Onchain Hub Connector Class =====


class ConnectorOnchainHub(BaseHubConnector):
    """
    Onchain Hub connector that aggregates blockchain data from multiple chains.
    Automatically reads wallet configuration from settings and creates appropriate
    scanner connectors (Etherscan, Blockscout) for each wallet.
    """

    @property
    def connector_name(self) -> str:
        return "onchain_hub"

    def __init__(self):
        """
        Initialize Onchain Hub connector.
        Reads wallet addresses and scanner configuration from settings.yaml.
        In test mode, creates child connectors so they return test data.
        """
        # Load wallet configuration from settings (used in both test and live mode)
        settings = load_settings()
        web3_config = settings.get("web3_wallets", {})
        self.wallet_configs = web3_config.get("addresses", [])

        if not self.wallet_configs:
            raise ValueError("No wallet addresses configured")

        child_connectors = []

        for idx, wallet_config in enumerate(self.wallet_configs, 1):
            connector_name = (
                f"{wallet_config.get('chain_name', '')}_"
                f"{wallet_config.get('wallet_address', '')[:10]}_"
                f"{wallet_config.get('scanner', '')}"
            )

            try:
                scanner_connector = self._create_scanner_connector(wallet_config)
                child_connectors.append((connector_name, scanner_connector))
            except Exception as e:
                log.error(f"Failed to create connector for {connector_name}: {e}")
                continue

        log.info(
            f"🔄 Created {len(child_connectors)} connector(s) from {len(self.wallet_configs)} wallet(s)"
        )
        # Initialize as BaseHubConnector with queue strategy (streaming for multiple wallets)
        super().__init__(
            child_connectors=child_connectors,
            parallel_strategy="queue",
        )

        if not self.wallet_configs:
            log.warning("⚠️ No wallet addresses configured in settings.yaml")
        else:
            log.info(
                f"✅ Onchain Hub Connector initialized with {len(self.wallet_configs)} wallet(s)"
            )
            for idx, config in enumerate(self.wallet_configs, 1):
                log.info(
                    f"   [{idx}] {config.get('wallet_address', 'N/A')[:10]}... on {config.get('chain_name', 'Unknown')} ({config.get('scanner', 'Unknown')})"
                )

    def _create_scanner_connector(self, wallet_config: Dict) -> Any:
        """
        Create appropriate scanner connector based on wallet configuration.

        Args:
            wallet_config: Wallet configuration from settings.yaml

        Returns:
            Scanner connector instance (Etherscan or Blockscout hub)
        """
        scanner_type = wallet_config.get("scanner", "").lower()
        wallet_address = wallet_config.get("wallet_address")
        chain_name = wallet_config.get("chain_name")

        if "etherscan" in scanner_type:
            # Use Etherscan Hub connector
            from .etherscan.connector_etherscan_hub import ConnectorEtherscanHub

            return ConnectorEtherscanHub(
                wallet_address=wallet_address,
                chain_name=chain_name,
            )
        elif "blockscout" in scanner_type:
            # Use Blockscout Hub connector
            from .blockscout.connector_blockscout_hub import ConnectorBlockscoutHub

            return ConnectorBlockscoutHub(
                wallet_address=wallet_address,
                chain_name=chain_name,
            )
        else:
            raise ValueError(
                f"Unknown scanner type: {scanner_type}. Supported: etherscan-api, blockscout"
            )


# Tests available at:
# pytest tests/unit/connectors/onchain/test_onchain_hub.py -v
