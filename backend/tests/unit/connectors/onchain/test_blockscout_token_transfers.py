"""Unit tests for Blockscout Token Transfers connector."""

from unittest.mock import patch
from datetime import datetime, timezone
from decimal import Decimal

from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)


class TestBlockscoutTokenTransfersConnector:
    """Unit tests for Blockscout token transfers connector with mocked API responses."""

    def test_erc20_token_transfer_inflow(self):
        """Test mapping of ERC-20 token transfer inflow (fee=0)."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        # Mock token-transfers endpoint response
        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xtoken_abc123",
                    "timestamp": "2025-10-14T20:40:51.000000Z",
                    "from": {"hash": "0xSENDER_ADDRESS"},
                    "to": {"hash": "0xTEST_WALLET"},
                    "total": {"value": "1000000", "decimals": 6},
                    "token": {
                        "address": "0xUSDC_CONTRACT",
                        "symbol": "USDC",
                        "type": "ERC-20",
                        "decimals": 6,
                    },
                    "block_number": "12345678",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is None
            assert normalized is not None
            assert normalized.direction == "inflow"
            assert normalized.transaction_type == "transfer"

    def test_erc20_token_transfer_outflow(self):
        """Test mapping of ERC-20 token transfer outflow (fee=0)."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xtoken_def456",
                    "timestamp": "2025-10-14T21:00:00.000000Z",
                    "from": {"hash": "0xTEST_WALLET"},
                    "to": {"hash": "0xRECEIVER_ADDRESS"},
                    "total": {"value": "5000000000000000000", "decimals": 18},
                    "token": {
                        "address": "0xDAI_CONTRACT",
                        "symbol": "DAI",
                        "type": "ERC-20",
                        "decimals": 18,
                    },
                    "block_number": "12345679",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is None
            assert normalized is not None
            assert normalized.direction == "outflow"
            assert normalized.transaction_type == "transfer"

    def test_erc721_nft_transfer(self):
        """Test mapping of ERC-721 NFT transfer (amount=1)."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xnft_123",
                    "timestamp": "2025-10-14T22:00:00.000000Z",
                    "from": {"hash": "0xSENDER_ADDRESS"},
                    "to": {"hash": "0xTEST_WALLET"},
                    "token_id": "42",
                    "token": {
                        "address": "0xNFT_CONTRACT",
                        "symbol": "BAYC",
                        "type": "ERC-721",
                        "decimals": 0,
                    },
                    "block_number": "12345680",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is None
            assert normalized is not None
            assert normalized.direction == "inflow"
            assert normalized.transaction_type == "transfer"

    def test_erc1155_token_transfer(self):
        """Test mapping of ERC-1155 token transfer."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="polygon",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xerc1155_abc",
                    "timestamp": "2025-10-14T23:00:00.000000Z",
                    "from": {"hash": "0xTEST_WALLET"},
                    "to": {"hash": "0xRECEIVER"},
                    "token_id": "100",
                    "token": {
                        "address": "0xERC1155_CONTRACT",
                        "symbol": "GAME",
                        "type": "ERC-1155",
                        "decimals": 0,
                    },
                    "block_number": "50123456",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is None
            assert normalized is not None
            assert normalized.direction == "outflow"
            assert normalized.transaction_type == "transfer"

    def test_multiple_token_transfers_in_page(self):
        """Test multiple token transfers from single page."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xmulti_1",
                    "timestamp": "2025-10-14T20:00:00.000000Z",
                    "from": {"hash": "0xSENDER1"},
                    "to": {"hash": "0xTEST_WALLET"},
                    "total": {"value": "100000000", "decimals": 6},
                    "token": {
                        "address": "0xUSDC",
                        "symbol": "USDC",
                        "type": "ERC-20",
                        "decimals": 6,
                    },
                    "block_number": "12345681",
                },
                {
                    "tx_hash": "0xmulti_2",
                    "timestamp": "2025-10-14T21:00:00.000000Z",
                    "from": {"hash": "0xTEST_WALLET"},
                    "to": {"hash": "0xRECEIVER"},
                    "total": {"value": "50000000", "decimals": 6},
                    "token": {
                        "address": "0xUSDT",
                        "symbol": "USDT",
                        "type": "ERC-20",
                        "decimals": 6,
                    },
                    "block_number": "12345682",
                },
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 2
            
            # First transfer (inflow)
            assert results[0][1] is not None
            assert results[0][1].direction == "inflow"
            assert results[0][1].transaction_type == "transfer"
            
            # Second transfer (outflow)
            assert results[1][1] is not None
            assert results[1][1].direction == "outflow"
            assert results[1][1].transaction_type == "transfer"

    def test_pagination_support(self):
        """Test pagination with next_page_params."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        # First page response
        page1_response = {
            "items": [
                {
                    "tx_hash": "0xpage1_token",
                    "timestamp": "2025-10-14T20:40:51.000000Z",
                    "from": {"hash": "0xSENDER"},
                    "to": {"hash": "0xTEST_WALLET"},
                    "total": {"value": "1000000", "decimals": 6},
                    "token": {
                        "address": "0xUSDC",
                        "symbol": "USDC",
                        "type": "ERC-20",
                        "decimals": 6,
                    },
                    "block_number": "12345683",
                }
            ],
            "next_page_params": {"block_number": 12345682, "index": 25},
        }

        # Second page response
        page2_response = {
            "items": [
                {
                    "tx_hash": "0xpage2_token",
                    "timestamp": "2025-10-13T20:40:51.000000Z",
                    "from": {"hash": "0xTEST_WALLET"},
                    "to": {"hash": "0xRECEIVER"},
                    "total": {"value": "2000000", "decimals": 6},
                    "token": {
                        "address": "0xDAI",
                        "symbol": "DAI",
                        "type": "ERC-20",
                        "decimals": 18,
                    },
                    "block_number": "12345681",
                }
            ],
            "next_page_params": None,
        }

        # Mock safe_request to return different responses for consecutive calls
        with patch.object(
            connector, "safe_request", side_effect=[page1_response, page2_response]
        ):
            results = list(connector.yield_normalized())

            assert len(results) == 2
            # Verify both transfers were processed
            assert results[0][1] is not None
            assert results[1][1] is not None

    def test_missing_token_info_raises_error(self):
        """Test that missing token info raises ValueError."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="base",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xbad_transfer",
                    "timestamp": "2025-10-14T20:40:51.000000Z",
                    "from": {"hash": "0xSENDER"},
                    "to": {"hash": "0xTEST_WALLET"},
                    "total": {"value": "1000000", "decimals": 6},
                    "token": None,  # Missing token info
                    "block_number": "12345684",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is not None
            assert "Missing token info" in str(error)

    def test_ethereum_chain(self):
        """Test token transfers connector works with Ethereum chain."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="ethereum",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xeth_token",
                    "timestamp": "2025-10-14T20:40:51.000000Z",
                    "from": {"hash": "0xTEST_WALLET"},
                    "to": {"hash": "0xRECEIVER"},
                    "total": {"value": "10000000000000000000", "decimals": 18},
                    "token": {
                        "address": "0xWETH",
                        "symbol": "WETH",
                        "type": "ERC-20",
                        "decimals": 18,
                    },
                    "block_number": "18000000",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]
            
            assert error is None
            assert normalized is not None
            assert normalized.direction == "outflow"
            assert normalized.transaction_type == "transfer"

    def test_hyperevm_chain(self):
        """Test token transfers connector works with HyperEVM chain."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0x347681ec529f767dafB3703486570Bc3Da136993",
            chain_name="hyperevm",
        )

        mock_api_response = {
            "items": [
                {
                    "tx_hash": "0xhype_token_transfer",
                    "timestamp": "2025-12-01T10:30:00.000000Z",
                    "from": {"hash": "0xSENDER"},
                    "to": {"hash": "0x347681ec529f767dafB3703486570Bc3Da136993"},
                    "total": {"value": "5000000000000000000", "decimals": 18},
                    "token": {
                        "address": "0xHYPE_TOKEN",
                        "address_hash": "0xHYPE_TOKEN",
                        "symbol": "USDC",
                        "type": "ERC-20",
                        "decimals": 18,
                    },
                    "block_number": "100000",
                }
            ],
            "next_page_params": None,
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            results = list(connector.yield_normalized())

            assert len(results) == 1
            raw, normalized, error = results[0]

            assert error is None
            assert normalized is not None
            assert normalized.direction == "inflow"
            assert normalized.transaction_type == "transfer"
            assert normalized.network == "hyperevm"
            assert normalized.source_asset_symbol == "USDC"
