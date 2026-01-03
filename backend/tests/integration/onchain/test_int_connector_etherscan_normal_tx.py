"""
Integration test for Etherscan normal transactions connector.
Tests that the connector can fetch and map normal transaction data successfully.
"""

import pytest
import logging

from backend.connectors.onchain.etherscan.connector_etherscan_normal_tx import (
    ConnectorEtherscanNormalTx,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_etherscan_normal_tx_connector_yield_normalized():
    """Test Etherscan normal transactions connector yield_normalized method."""
    # Skip if no API key configured
    try:
        from backend.config.loader import load_settings

        settings = load_settings()
        api_key = settings.get("web3_wallets", {}).get("etherscan_api_key", "")
        if not api_key:
            pytest.skip("Etherscan API key not configured")
    except Exception:
        pytest.skip("Could not load settings")

    # Test with a known address that has transactions
    connector = ConnectorEtherscanNormalTx(
        wallet_address="0x1111111111111111111111111111111111111111",
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
        f"📊 Etherscan Normal TX test complete: {len(results)} transactions, {len(errors)} errors"
    )
