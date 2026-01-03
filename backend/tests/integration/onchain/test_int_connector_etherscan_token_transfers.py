"""
Integration test for Etherscan token transfers connector.
Tests that the connector can fetch and map token transfer data successfully.
"""

import pytest
import logging

from backend.connectors.onchain.etherscan.connector_etherscan_token_transfers import (
    ConnectorEtherscanTokenTransfers,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_etherscan_token_transfers_connector_yield_normalized():
    """Test Etherscan token transfers connector yield_normalized method."""
    # Skip if no API key configured
    try:
        from backend.config.loader import load_settings

        settings = load_settings()
        api_key = settings.get("web3_wallets", {}).get("etherscan_api_key", "")
        if not api_key:
            pytest.skip("Etherscan API key not configured")
    except Exception:
        pytest.skip("Could not load settings")

    # Test with a known address that has token transfers
    connector = ConnectorEtherscanTokenTransfers(
        wallet_address="0x347681ec529f767dafB3703486570Bc3Da136993",
        chain_name="ethereum",
    )

    results = []
    errors = []

    # Fetch and validate results
    for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
        if idx >= 3:  # Limit test iterations for blockchain operations
            break

        if error:
            errors.append(error)
            log.warning(f"❌ Mapping error: {error}")
        if mapped_item:
            results.append(mapped_item)
            log.info(f"✅ Mapped transaction: {mapped_item.source_transaction_id}")
    # Assertions
    assert len(results) > 0, "Should yield at least some results"

    log.info(
        f"📊 Etherscan Token Transfers test complete: {len(results)} transfers, {len(errors)} errors"
    )
