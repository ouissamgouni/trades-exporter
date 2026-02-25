"""
Integration test for Blockscout HyperEVM normal transactions connector.
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
def test_blockscout_hyperevm_normal_tx_connector_yield_normalized():
    """Test Blockscout HyperEVM normal transactions connector yield_normalized method."""
    connector = ConnectorBlockscoutNormalTx(
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
            log.info(f"✅ Mapped transaction: {mapped_item.source_transaction_id}")

    assert len(results) > 0, "Should yield at least some results"

    # Verify HyperEVM-specific assertions
    for r in results:
        assert r.network == "hyperevm"
        assert r.source.startswith("blockscout_normal_tx")

    log.info(
        f"📊 Blockscout HyperEVM Normal TX test complete: {len(results)} transactions, {len(errors)} errors"
    )
