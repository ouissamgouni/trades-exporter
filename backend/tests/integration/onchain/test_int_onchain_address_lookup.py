"""
Integration test for OnChainAddressLookupService.
Makes real calls to Moralis EVM API to verify address resolution.
Requires MORALIS_API_KEY environment variable.
"""

import os
import pytest
import logging

from backend.services.onchain_address_lookup import OnChainAddressLookupService

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# Known BSC transaction for testing
BSC_TX_HASH = "0xedbb2685265d90216c98849a0c85accc0724c5a5cd5f7dd5a5c9124ebba39737"
BSC_EXPECTED_FROM = "0xeb2d2f1b8c558a40207669291fda468e50c8a0bb"
BSC_EXPECTED_TO = "0x55d398326f99059ff775485246999027b3197955"  # USDT contract on BSC

# Known Arbitrum transaction for testing (real Binance withdrawal)
ARB_TX_HASH = "0x638207efe87d81303758a08a75a5e01e9743c714ce7b3eb93a50dc2838cbe4be"
ARB_EXPECTED_FROM = "0xb38e8c17e38363af6ebdcb3dae12e0243582891d"
ARB_EXPECTED_TO = "0xee7ae85f2fe2239e27d9c1e23fffe168d63b4055"

needs_api_key = pytest.mark.skipif(
    not os.getenv("MORALIS_API_KEY"),
    reason="MORALIS_API_KEY not set",
)


@pytest.mark.integration
@needs_api_key
class TestOnChainAddressLookupLive:
    """Live integration tests against Moralis EVM API."""

    @pytest.fixture(autouse=True)
    def _service(self):
        """Shared service instance with reduced delay for faster tests."""
        self.service = OnChainAddressLookupService(request_delay=0.1)

    def test_bsc_lookup_resolves_from_address(self):
        """Lookup inflow direction should return the sender (from) address."""
        result = self.service.lookup_address("bsc", BSC_TX_HASH, "inflow")

        log.info(f"Resolved from address: {result}")
        assert result is not None, "Expected a from address"
        assert result == BSC_EXPECTED_FROM

    def test_bsc_lookup_resolves_to_address(self):
        """Lookup outflow direction should return the recipient (to) address."""
        result = self.service.lookup_address("bsc", BSC_TX_HASH, "outflow")

        log.info(f"Resolved to address: {result}")
        assert result is not None, "Expected a to address"
        assert result == BSC_EXPECTED_TO

    def test_bsc_lookup_with_bep20_alias(self):
        """Network alias 'bep20' should also resolve correctly."""
        result = self.service.lookup_address("bep20", BSC_TX_HASH, "inflow")

        assert result == BSC_EXPECTED_FROM

    def test_nonexistent_tx_returns_none(self):
        """A fake tx hash should return None gracefully."""
        service = OnChainAddressLookupService(request_delay=0.1, max_retries=1)

        result = service.lookup_address(
            "bsc",
            "0x0000000000000000000000000000000000000000000000000000000000000000",
            "inflow",
        )

        assert result is None

    def test_cache_works_across_directions(self):
        """Second call with same tx hash should use cache (no extra API call)."""
        from_addr = self.service.lookup_address("bsc", BSC_TX_HASH, "inflow")
        to_addr = self.service.lookup_address("bsc", BSC_TX_HASH, "outflow")

        assert from_addr == BSC_EXPECTED_FROM
        assert to_addr == BSC_EXPECTED_TO
        # Verify cache was populated
        assert BSC_TX_HASH in self.service._cache


@pytest.mark.integration
@needs_api_key
class TestArbitrumLookupLive:
    """Live integration tests against Moralis EVM API for Arbitrum."""

    @pytest.fixture(autouse=True)
    def _service(self):
        """Shared service instance with reduced delay for faster tests."""
        self.service = OnChainAddressLookupService(request_delay=0.1)

    def test_arbitrum_lookup_resolves_from_address(self):
        """Lookup inflow direction should return the sender (from) address."""
        result = self.service.lookup_address("arbitrum", ARB_TX_HASH, "inflow")

        log.info(f"Arbitrum resolved from address: {result}")
        assert result is not None, "Expected a from address"
        assert result == ARB_EXPECTED_FROM

    def test_arbitrum_lookup_resolves_to_address(self):
        """Lookup outflow direction should return the recipient (to) address."""
        result = self.service.lookup_address("arbitrum", ARB_TX_HASH, "outflow")

        log.info(f"Arbitrum resolved to address: {result}")
        assert result is not None, "Expected a to address"
        assert result == ARB_EXPECTED_TO

    def test_arbitrum_lookup_with_uppercase_alias(self):
        """Network name 'ARBITRUM' (as from Binance raw data) should resolve."""
        result = self.service.lookup_address("ARBITRUM", ARB_TX_HASH, "inflow")

        assert result == ARB_EXPECTED_FROM
