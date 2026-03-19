"""
Unit tests for ConnectorRegistry.

Tests the centralized connector configuration registry.
"""


class TestConnectorRegistry:
    """Tests for ConnectorRegistry singleton and configuration."""

    def test_singleton_pattern(self):
        """Test that ConnectorRegistry follows singleton pattern."""
        from backend.connectors.connector_registry import (
            ConnectorRegistry,
            get_connector_registry,
        )

        instance1 = ConnectorRegistry.instance()
        instance2 = ConnectorRegistry.instance()
        instance3 = get_connector_registry()

        assert instance1 is instance2
        assert instance2 is instance3

    def test_list_types_returns_all_connectors(self):
        """Test that list_types returns all registered connector types."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        types = registry.list_types()

        # CEX connectors
        assert "binance-transactions" in types
        assert "binance-deposits" in types
        assert "binance-withdrawals" in types
        assert "mexc-transactions" in types
        assert "okx-transactions" in types
        assert "okx-convert" in types
        assert "coinbase-transactions" in types

        # On-chain connectors
        assert "blockscout" in types
        assert "etherscan" in types

    def test_get_returns_connector_info(self):
        """Test that get returns ConnectorInfo for valid types."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("binance-transactions")

        assert info is not None
        assert info.type == "binance-transactions"
        assert info.category == "cex"
        assert info.display_name == "Binance Transactions"
        assert "symbols" in info.optional_config

    def test_get_returns_none_for_invalid_type(self):
        """Test that get returns None for invalid connector types."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("invalid_connector")

        assert info is None

    def test_is_onchain_correctly_identifies_onchain_connectors(self):
        """Test that is_onchain correctly identifies on-chain connectors."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        # On-chain connectors
        assert registry.is_onchain("blockscout") is True
        assert registry.is_onchain("etherscan") is True

        # CEX connectors
        assert registry.is_onchain("binance-transactions") is False
        assert registry.is_onchain("mexc-transactions") is False
        assert registry.is_onchain("coinbase-transactions") is False

    def test_get_hub_key_returns_correct_keys(self):
        """Test that get_hub_key returns correct hub keys."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        # CEX connectors have hub_key defaulting to type
        assert registry.get_hub_key("binance-transactions") == "binance-transactions"
        assert registry.get_hub_key("mexc-transactions") == "mexc-transactions"
        assert registry.get_hub_key("coinbase-transactions") == "coinbase-transactions"

        # On-chain connectors all map to "on-chain"
        assert registry.get_hub_key("blockscout") == "on-chain"
        assert registry.get_hub_key("etherscan") == "on-chain"

    def test_get_chain_config_returns_config(self):
        """Test that get_chain_config returns valid chain configurations."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        # Blockscout base chain
        config = registry.get_chain_config("blockscout", "base")
        assert config is not None
        assert config.explorer_type == "blockscout"
        assert "base.blockscout.com" in config.base_url

        # Etherscan ethereum
        config = registry.get_chain_config("etherscan", "ethereum")
        assert config is not None
        assert config.explorer_type == "etherscan"
        assert "etherscan.io" in config.base_url

    def test_get_chain_config_returns_none_for_invalid(self):
        """Test that get_chain_config returns None for invalid combinations."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        # Invalid connector type
        assert registry.get_chain_config("invalid", "ethereum") is None

        # Invalid chain
        assert registry.get_chain_config("etherscan", "invalid_chain") is None

    def test_get_chain_configs_returns_all_chains(self):
        """Test that get_chain_configs returns all chain configurations."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        blockscout_chains = registry.get_chain_configs("blockscout")
        assert "base" in blockscout_chains
        assert "ethereum" in blockscout_chains
        assert "polygon" in blockscout_chains
        assert "arbitrum" in blockscout_chains
        assert "optimism" in blockscout_chains

    def test_list_cex_connectors(self):
        """Test that list_cex_connectors returns only CEX connectors."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        cex_connectors = registry.list_cex_connectors()

        cex_types = [c.type for c in cex_connectors]
        assert "binance-transactions" in cex_types
        assert "mexc-transactions" in cex_types
        assert "coinbase-transactions" in cex_types

        # No on-chain connectors
        assert "blockscout" not in cex_types
        assert "etherscan" not in cex_types

    def test_list_onchain_connectors(self):
        """Test that list_onchain_connectors returns only on-chain connectors."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        onchain_connectors = registry.list_onchain_connectors()

        onchain_types = [c.type for c in onchain_connectors]
        assert "blockscout" in onchain_types
        assert "etherscan" in onchain_types

        # No CEX connectors
        assert "binance-transactions" not in onchain_types
        assert "mexc-transactions" not in onchain_types

    def test_validate_connector_type(self):
        """Test that validate_connector_type works correctly."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        assert registry.validate_connector_type("binance-transactions") is True
        assert registry.validate_connector_type("blockscout") is True
        assert registry.validate_connector_type("invalid") is False

    def test_validate_chain(self):
        """Test that validate_chain works correctly."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()

        # Valid chain for blockscout
        assert registry.validate_chain("blockscout", "base") is True
        assert registry.validate_chain("blockscout", "ethereum") is True

        # Invalid chain for blockscout
        assert registry.validate_chain("blockscout", "invalid_chain") is False

        # CEX connectors accept any chain (no chain restriction)
        assert registry.validate_chain("binance-transactions", "anything") is True

    def test_get_connector_map_returns_classes(self):
        """Test that get_connector_map returns connector classes."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        connector_map = registry.get_connector_map()

        # Should have CEX connector classes
        assert "binance-transactions" in connector_map
        assert "mexc-transactions" in connector_map
        assert "coinbase-transactions" in connector_map

        # Should have on-chain hub connectors (blockscout, etherscan)
        assert "blockscout" in connector_map
        assert "etherscan" in connector_map

        # All values should be classes
        for key, cls in connector_map.items():
            assert callable(cls), f"{key} should be a class"

    def test_get_api_connectors_returns_api_format(self):
        """Test that get_api_connectors returns API-friendly format."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        api_connectors = registry.get_api_connectors()

        # Should have all connector types
        assert "binance-transactions" in api_connectors
        assert "blockscout" in api_connectors

        # Each should have expected fields
        binance = api_connectors["binance-transactions"]
        assert binance["type"] == "binance-transactions"
        assert binance["category"] == "cex"
        assert binance["display_name"] == "Binance Transactions"
        assert "required_config" in binance
        assert "optional_config" in binance

    def test_connector_info_to_api_dict(self):
        """Test that ConnectorInfo.to_api_dict works correctly."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("blockscout")
        api_dict = info.to_api_dict()

        assert api_dict["type"] == "blockscout"
        assert api_dict["category"] == "onchain"
        assert api_dict["display_name"] == "Blockscout"
        assert api_dict["supported_chains"] is not None
        assert "base" in api_dict["supported_chains"]
        assert "chain" in api_dict["required_config"]
        assert "address" in api_dict["required_config"]
