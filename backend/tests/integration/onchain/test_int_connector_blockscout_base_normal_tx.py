"""
Integration test for Blockscout Base normal transactions connector.
Tests that the connector can fetch and map normal transaction data successfully.
"""

import pytest
import logging

from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_blockscout_base_normal_tx_connector_yield_normalized():
    """Test Blockscout Base normal transactions connector yield_normalized method."""
    # Test with a known address that has transactions on Base
    connector = ConnectorBlockscoutNormalTx(
        wallet_address="0x1111111111111111111111111111111111111111",
        chain_name="Base",
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
        f"📊 Blockscout Base Normal TX test complete: {len(results)} transactions, {len(errors)} errors"
    )
