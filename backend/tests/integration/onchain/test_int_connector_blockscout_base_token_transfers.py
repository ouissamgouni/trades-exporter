"""
Integration test for Blockscout Base token transfers connector.
Tests that the connector can fetch and map token transfer data successfully.
"""

import pytest
import logging

from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_blockscout_base_token_transfers_connector_yield_normalized():
    """Test Blockscout Base token transfers connector yield_normalized method."""
    # Test with a known address that has token transfers on Base
    connector = ConnectorBlockscoutTokenTransfers(
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
        f"📊 Blockscout Base Token Transfers test complete: {len(results)} transfers, {len(errors)} errors"
    )
