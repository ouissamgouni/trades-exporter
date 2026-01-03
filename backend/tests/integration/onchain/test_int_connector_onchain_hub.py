"""
Integration test for Onchain Hub connector.
Tests that the connector can fetch and aggregate transactions from multiple
wallet configurations and blockchain scanners.
"""

import pytest
import logging
from unittest.mock import patch

from backend.connectors.onchain.connector_onchain_hub import (
    ConnectorOnchainHub,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_onchain_hub_connector_yield_normalized():
    """Test Onchain Hub connector yield_normalized method with real wallet configs."""

    # Mock wallet configurations for testing
    mock_wallet_configs = [
        {
            "wallet_address": "0x347681ec529f767dafB3703486570Bc3Da136993",
            "chain_id": 1,
            "chain_name": "ethereum",
            "scanner": "etherscan-api",
            "scanner_chain_id": 1,
            "native_token": "ETH",
        },
        {
            "wallet_address": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
            "chain_id": 8453,
            "chain_name": "Base",
            "scanner": "blockscout",
            "scanner_chain_id": 8453,
            "native_token": "ETH",
        },
    ]

    # Mock load_settings to return test configuration
    with patch(
        "backend.connectors.onchain.connector_onchain_hub.load_settings"
    ) as mock_settings:
        mock_settings.return_value = {
            "web3_wallets": {
                "addresses": mock_wallet_configs,
                "etherscan_api_key": "test_key",
            }
        }

        connector = ConnectorOnchainHub()

        results = []
        errors = []

        # Fetch and validate results - limit iterations since this fetches from multiple sources
        for idx, (raw_item, mapped_item, error) in enumerate(
            connector.yield_normalized()
        ):
            if idx >= 10:  # Limit test iterations for blockchain operations
                break

            if error:
                errors.append(error)
                log.warning(f"❌ Mapping error: {error}")
            else:
                results.append(mapped_item)
                chain = mapped_item.network
                tx_type = mapped_item.source_transaction_id
                log.info(f"✅ Mapped transaction from {chain}: {tx_type}")

        # Assertions
        assert len(results) > 0, (
            "Should yield at least some results from configured wallets"
        )

        log.info(
            f"📊 Onchain Hub test complete: {len(results)} transactions, {len(errors)} errors"
        )
