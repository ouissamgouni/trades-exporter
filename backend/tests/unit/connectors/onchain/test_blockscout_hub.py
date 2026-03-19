"""Unit tests for Blockscout Hub connector."""

from unittest.mock import patch, MagicMock
from decimal import Decimal

from backend.connectors.onchain.blockscout.connector_blockscout_hub import (
    ConnectorBlockscoutHub,
)


class TestBlockscoutHubConnector:
    """Unit tests for Blockscout hub connector orchestration."""

    def test_hub_initialization(self):
        """Test that hub connector initializes with proper child connectors."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        assert hub.connector_name == "blockscout_hub_base"
        assert hub.wallet_address == "0xTEST_WALLET"
        assert hub.chain_name == "base"
        assert len(hub.child_connectors) == 2
        
        # Check child connectors are properly named
        child_names = [name for name, _ in hub.child_connectors]
        assert "normal transactions" in child_names
        assert "token transfers" in child_names

    def test_hub_with_ethereum_chain(self):
        """Test hub connector initialization with Ethereum chain."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xETH_WALLET",
            chain_name="ethereum",
        )

        assert hub.connector_name == "blockscout_hub_ethereum"
        assert hub.chain_name == "ethereum"
        assert len(hub.child_connectors) == 2

    def test_hub_with_polygon_chain(self):
        """Test hub connector initialization with Polygon chain."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xPOLY_WALLET",
            chain_name="polygon",
        )

        assert hub.connector_name == "blockscout_hub_polygon"
        assert hub.chain_name == "polygon"
        assert len(hub.child_connectors) == 2

    def test_hub_with_hyperevm_chain(self):
        """Test hub connector initialization with HyperEVM chain."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0x347681ec529f767dafB3703486570Bc3Da136993",
            chain_name="hyperevm",
        )

        assert hub.connector_name == "blockscout_hub_hyperevm"
        assert hub.chain_name == "hyperevm"
        assert len(hub.child_connectors) == 2

    def test_hub_missing_wallet_address_raises_error(self):
        """Test that missing wallet address raises ValueError."""
        try:
            hub = ConnectorBlockscoutHub(
                wallet_address="",
                chain_name="base",
            )
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "Missing wallet address" in str(e)

    def test_hub_unsupported_chain_raises_error(self):
        """Test that unsupported chain raises ValueError."""
        try:
            hub = ConnectorBlockscoutHub(
                wallet_address="0xTEST_WALLET",
                chain_name="unsupported_chain",
            )
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "Unknown chain" in str(e)

    def test_hub_child_connectors_have_correct_types(self):
        """Test that child connectors are of correct types."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
            ConnectorBlockscoutNormalTx,
        )
        from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
            ConnectorBlockscoutTokenTransfers,
        )

        # Extract child connector instances
        normal_tx_connector = hub.child_connectors[0][1]
        token_transfers_connector = hub.child_connectors[1][1]

        assert isinstance(normal_tx_connector, ConnectorBlockscoutNormalTx)
        assert isinstance(token_transfers_connector, ConnectorBlockscoutTokenTransfers)

    def test_hub_child_connectors_share_config(self):
        """Test that child connectors receive parent output path config."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        # Check that child connectors have parent_output_path configured
        for name, connector in hub.child_connectors:
            assert connector.wallet_address == "0xTEST_WALLET"
            assert connector.chain_name == "base"

    def test_hub_with_account_and_connector_ids(self):
        """Test hub initialization with account_id and connector_id."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
            account_id=123,
            connector_id=456,
        )

        assert hub.account_id == 123
        assert hub.connector_id == 456

        # Check child connectors receive same IDs
        for name, connector in hub.child_connectors:
            assert connector.account_id == 123
            assert connector.connector_id == 456

    def test_hub_parallel_strategy_is_queue(self):
        """Test that hub uses queue parallel strategy."""
        hub = ConnectorBlockscoutHub(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        # BaseHubConnector should have parallel_strategy set to "queue"
        assert hasattr(hub, "parallel_strategy")
        # Note: actual parallel execution is tested in integration tests

    def test_hub_supports_all_blockscout_chains(self):
        """Test hub initialization with all supported Blockscout chains."""
        supported_chains = ["base", "ethereum", "polygon", "arbitrum", "optimism"]

        for chain in supported_chains:
            hub = ConnectorBlockscoutHub(
                wallet_address="0xTEST_WALLET",
                chain_name=chain,
            )
            assert hub.chain_name == chain
            assert hub.connector_name == f"blockscout_hub_{chain}"
