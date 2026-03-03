"""
Integration tests for Etherscan connectors (normal tx + token transfers).
Consolidated from 2 separate files into a single parametrized test.
Requires Etherscan API key configured in settings.yaml.
"""

import pytest
import logging

from backend.connectors.onchain.etherscan.connector_etherscan_normal_tx import (
    ConnectorEtherscanNormalTx,
)
from backend.connectors.onchain.etherscan.connector_etherscan_token_transfers import (
    ConnectorEtherscanTokenTransfers,
)

log = logging.getLogger(__name__)

TEST_WALLET = "0x347681ec529f767dafB3703486570Bc3Da136993"
MAX_RESULTS = 3


def _check_etherscan_api_key():
    """Skip if Etherscan API key is not configured."""
    try:
        from backend.config.loader import load_settings

        settings = load_settings()
        api_key = settings.get("web3_wallets", {}).get("etherscan_api_key", "")
        if not api_key:
            pytest.skip("Etherscan API key not configured")
    except Exception:
        pytest.skip("Could not load settings")


@pytest.mark.integration
@pytest.mark.timeout(60)
class TestEtherscanNormalTx:
    """Integration test for Etherscan normal transactions."""

    def test_yield_normalized(self):
        _check_etherscan_api_key()

        connector = ConnectorEtherscanNormalTx(
            wallet_address=TEST_WALLET,
            chain_name="ethereum",
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

        assert len(results) > 0, "Should yield at least some results"
        log.info(f"Etherscan normal tx: {len(results)} results, {len(errors)} errors")


@pytest.mark.integration
@pytest.mark.timeout(60)
class TestEtherscanTokenTransfers:
    """Integration test for Etherscan token transfers."""

    def test_yield_normalized(self):
        _check_etherscan_api_key()

        connector = ConnectorEtherscanTokenTransfers(
            wallet_address=TEST_WALLET,
            chain_name="ethereum",
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

        assert len(results) > 0, "Should yield at least some results"
        log.info(f"Etherscan token transfers: {len(results)} results, {len(errors)} errors")
