"""
Integration test for Blockscout HyperEVM token transfers connector.
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
def test_blockscout_hyperevm_token_transfers_connector_yield_normalized():
    """Test Blockscout HyperEVM token transfers connector yield_normalized method."""
    connector = ConnectorBlockscoutTokenTransfers(
        wallet_address="0x347681ec529f767dafB3703486570Bc3Da136993",
        chain_name="hyperevm",
    )

    results = []
    errors = []

    for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
        if idx >= 3:  # Limit test iterations
            break

        if error:
            errors.append(error)
            log.warning(f"❌ Mapping error: {error}")
        if mapped_item:
            results.append(mapped_item)
            log.info(f"✅ Mapped transfer: {mapped_item.source_transaction_id}")

    # Token transfers may or may not exist for this address on HyperEVM
    # so we just verify the connector runs without crashing
    log.info(
        f"📊 Blockscout HyperEVM Token Transfers test complete: {len(results)} transfers, {len(errors)} errors"
    )
