"""
Unit tests for network normalization logic.
"""

import pytest
from backend.core.network_normalizer import normalize_network, get_network_display_name


class TestNormalizeNetwork:
    """Critical path tests for normalize_network()."""

    @pytest.mark.parametrize("raw,expected", [
        # None / empty -> None
        (None, None),
        ("", None),
        ("  ", None),
        # Known aliases
        ("ETH", "ethereum"),
        ("erc20", "ethereum"),
        ("BNB Smart Chain(BEP20)", "bsc"),
        ("bep20", "bsc"),
        ("SOL", "solana"),
        ("TRC20", "tron"),
        ("MATIC", "polygon"),
        # Already canonical (idempotent)
        ("ethereum", "ethereum"),
        ("bitcoin", "bitcoin"),
        ("solana", "solana"),
        # Unknown network falls back to lowercased value
        ("SomeNewChain", "somenewchain"),
        # Whitespace trimming
        ("  eth  ", "ethereum"),
        # MEXC raw values
        ("Ethereum(ERC20)", "ethereum"),
        ("Solana(SOL)", "solana"),
        ("HYPEREVM", "hyperevm"),
        ("SONIC", "sonic"),
        # OKX raw values
        ("ADA-Cardano", "cardano"),
        ("ETH-ERC20", "ethereum"),
        ("SUI-SUI", "sui"),
        ("USDC-SUI", "sui"),
        # HyperEVM aliases
        ("hyperliquid", "hyperevm"),
        ("hyperliquid evm", "hyperevm"),
        ("hyper evm", "hyperevm"),
        # Sonic aliases
        ("S", "sonic"),
    ])
    def test_normalize(self, raw, expected):
        assert normalize_network(raw) == expected


class TestGetNetworkDisplayName:
    """Critical path tests for display name lookup."""

    def test_known_network(self):
        assert get_network_display_name("ethereum") == "Ethereum"
        assert get_network_display_name("bsc") == "BNB Smart Chain"
        assert get_network_display_name("hyperevm") == "HyperEVM"
        assert get_network_display_name("sonic") == "Sonic"

    def test_unknown_falls_back_to_title(self):
        assert get_network_display_name("foochain") == "Foochain"
