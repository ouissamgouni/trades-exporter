"""
Unit tests for ConnectorRegistry chain configuration methods.
Tests the new helper methods that replaced chain_config.py functionality.
"""

import pytest
from backend.connectors.connector_registry import get_connector_registry


class TestConnectorRegistryChainConfig:
    """Test chain configuration methods in ConnectorRegistry."""

    @pytest.fixture
    def registry(self):
        """Get the connector registry singleton."""
        return get_connector_registry()

    # ==================== get_native_token tests ====================

    def test_get_native_token_evm_chain(self, registry):
        """Test getting native token for EVM chain."""
        assert registry.get_native_token("blockscout", "ethereum") == "ETH"
        # Verify different chains have different tokens
        assert registry.get_native_token("blockscout", "polygon") == "MATIC"

    def test_get_native_token_non_evm_chains(self, registry):
        """Test getting native token for non-EVM chains."""
        assert registry.get_native_token("cardano_scan", "cardano") == "ADA"
        assert registry.get_native_token("xrp", "xrp") == "XRP"
        assert registry.get_native_token("solana", "solana") == "SOL"

    def test_get_native_token_unknown(self, registry):
        """Test getting native token for unknown chain/connector returns None."""
        assert registry.get_native_token("blockscout", "unknown_chain") is None
        assert registry.get_native_token("unknown_connector", "ethereum") is None

    # ==================== get_native_token_decimals tests ====================

    def test_get_native_token_decimals_evm_chain(self, registry):
        """Test getting decimals for EVM chain (18 decimals)."""
        assert registry.get_native_token_decimals("blockscout", "ethereum") == 18

    def test_get_native_token_decimals_non_evm_chains(self, registry):
        """Test getting decimals for non-EVM chains with different decimal values."""
        assert registry.get_native_token_decimals("cardano_scan", "cardano") == 6  # lovelaces
        assert registry.get_native_token_decimals("xrp", "xrp") == 6  # drops
        assert registry.get_native_token_decimals("solana", "solana") == 9  # lamports

    def test_get_native_token_decimals_unknown(self, registry):
        """Test getting decimals for unknown chain/connector returns None."""
        assert registry.get_native_token_decimals("blockscout", "unknown_chain") is None
        assert registry.get_native_token_decimals("unknown_connector", "ethereum") is None

    # ==================== get_chain_id tests ====================

    def test_get_chain_id_evm_chains(self, registry):
        """Test getting chain ID for EVM chains."""
        assert registry.get_chain_id("blockscout", "ethereum") == 1
        assert registry.get_chain_id("blockscout", "base") == 8453
        assert registry.get_chain_id("etherscan", "ethereum") == 1

    def test_get_chain_id_non_evm_chains(self, registry):
        """Test getting chain ID for non-EVM chains returns None."""
        assert registry.get_chain_id("cardano_scan", "cardano") is None
        assert registry.get_chain_id("xrp", "xrp") is None
        assert registry.get_chain_id("solana", "solana") is None

    def test_get_chain_id_unknown(self, registry):
        """Test getting chain ID for unknown chain/connector returns None."""
        assert registry.get_chain_id("blockscout", "unknown_chain") is None
        assert registry.get_chain_id("unknown_connector", "ethereum") is None

    # ==================== Integration tests ====================

    def test_get_chain_config_full_evm(self, registry):
        """Test getting complete chain config for EVM chain."""
        config = registry.get_chain_config("blockscout", "ethereum")
        assert config is not None
        assert config.explorer_type == "blockscout"
        assert config.base_url == "https://eth.blockscout.com/api"
        assert config.chain_id == 1
        assert config.native_currency == "ETH"
        assert config.native_token_decimals == 18

    def test_get_chain_config_full_non_evm(self, registry):
        """Test getting complete chain config for non-EVM chain."""
        config = registry.get_chain_config("cardano_scan", "cardano")
        assert config is not None
        assert config.explorer_type == "cardanoscan"
        assert config.base_url == "https://api.cardanoscan.io/api/v1"
        assert config.chain_id is None
        assert config.native_currency == "ADA"
        assert config.native_token_decimals == 6

    def test_get_chain_configs_returns_all_chains(self, registry):
        """Test getting all chain configs for a connector."""
        configs = registry.get_chain_configs("blockscout")
        assert "ethereum" in configs
        assert "base" in configs
        assert len(configs) >= 5  # At least the main chains

    def test_get_chain_configs_unknown_connector(self, registry):
        """Test getting chain configs for unknown connector returns empty dict."""
        assert registry.get_chain_configs("unknown_connector") == {}
