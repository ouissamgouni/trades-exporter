"""
Integration tests for Blockscout connectors (normal tx + token transfers).
Consolidated from 6 separate per-chain files into a single parametrized test.
Tests that connectors can fetch and normalize data from real Blockscout APIs.
"""

import pytest
import logging

from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)
from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)

log = logging.getLogger(__name__)

TEST_WALLET = "0x347681ec529f767dafB3703486570Bc3Da136993"
MAX_RESULTS = 3


@pytest.mark.integration
@pytest.mark.timeout(60)
@pytest.mark.parametrize("chain_name", ["Base", "ethereum", "hyperevm"])
class TestBlockscoutNormalTx:
    """Integration tests for Blockscout normal transactions across chains."""

    def test_yield_normalized(self, chain_name):
        connector = ConnectorBlockscoutNormalTx(
            wallet_address=TEST_WALLET,
            chain_name=chain_name,
        )

        results = []
        errors = []

        for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
            if idx >= MAX_RESULTS:
                break
            if error:
                errors.append(error)
            if mapped_item:
                results.append(mapped_item)

        assert len(results) > 0, f"Should yield results for {chain_name}"
        log.info(f"Blockscout {chain_name} normal tx: {len(results)} results, {len(errors)} errors")


@pytest.mark.integration
@pytest.mark.timeout(60)
@pytest.mark.parametrize("chain_name", ["Base", "ethereum", "hyperevm"])
class TestBlockscoutTokenTransfers:
    """Integration tests for Blockscout token transfers across chains."""

    def test_yield_normalized(self, chain_name):
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address=TEST_WALLET,
            chain_name=chain_name,
        )

        results = []
        errors = []

        for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
            if idx >= MAX_RESULTS:
                break
            if error:
                errors.append(error)
            if mapped_item:
                results.append(mapped_item)

        # Token transfers may not exist on all chains — just verify no crash
        log.info(f"Blockscout {chain_name} token transfers: {len(results)} results, {len(errors)} errors")
