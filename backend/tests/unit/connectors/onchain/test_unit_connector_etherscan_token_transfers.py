"""Unit tests for Etherscan Token Transfers connector."""

from unittest.mock import patch

from backend.connectors.onchain.etherscan.connector_etherscan_token_transfers import (
    ConnectorEtherscanTokenTransfers,
)


class TestEtherscanTokenTransfersConnector:
    """Unit tests for Etherscan token transfers connector with mocked API responses."""

    def test_token_transfer_inflow_mapping(self):
        """Test mapping of inflow token transfer from mocked Etherscan API response."""
        connector = ConnectorEtherscanTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="ethereum",
        )

        # Mock Etherscan API response for token transfer (list format)
        mock_api_response = [
            {
                "hash": "0xtoken_eth123",
                "transactionIndex": "15",
                "from": "0xSENDER_ADDRESS",
                "to": "0xtest_wallet",  # Inflow to our wallet
                "tokenSymbol": "USDT",
                "tokenName": "Tether USD",
                "contractAddress": "0xUSDT_CONTRACT",
                "value": "5000000000",  # 5000 USDT (6 decimals)
                "tokenDecimal": "6",
                "gasUsed": "80000",
                "gasPrice": "120000000000",  # 120 gwei
                "timeStamp": "1673953200",  # Unix timestamp
                "methodId": "0xa9059cbb",
            }
        ]

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result from yield_normalized
            results = list(connector.yield_normalized())
            normalized_txs = [res[1] for res in results]

            assert len(normalized_txs) == 1
            normalized_tx = normalized_txs[0]

            # Validate normalized structure
            assert normalized_tx.source == "etherscan_token_transfers_ethereum"
            assert normalized_tx.direction == "inflow"
            assert normalized_tx.source_transaction_type == "token-transfer"
            assert normalized_tx.source_asset_symbol == "USDT"
            assert normalized_tx.quantity == 5000.0  # 5000 USDT
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.fee == 0.0096
            assert normalized_tx.include_fee is False
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.token_contract_address == "0xUSDT_CONTRACT"

    def test_token_transfer_outflow_mapping(self):
        """Test mapping of outflow token transfer from mocked Etherscan API response."""
        connector = ConnectorEtherscanTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="ethereum",
        )

        # Mock Etherscan API response for outflow token transfer
        mock_api_response = [
            {
                "hash": "0xtoken_eth456",
                "transactionIndex": "22",
                "from": "0xtest_wallet",  # Outflow from our wallet
                "to": "0xRECEIVER_ADDRESS",
                "tokenSymbol": "LINK",
                "tokenName": "ChainLink Token",
                "contractAddress": "0xLINK_CONTRACT",
                "value": "100000000000000000000",  # 100 LINK (18 decimals)
                "tokenDecimal": "18",
                "gasUsed": "90000",
                "gasPrice": "150000000000",  # 150 gwei
                "timeStamp": "1674039600",  # Unix timestamp
                "methodId": "0xa9059cbb",
            }
        ]

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result
            results = list(connector.yield_normalized())
            normalized_txs = [res[1] for res in results]
            assert len(normalized_txs) == 1
            normalized_tx = normalized_txs[0]

            # Validate normalized structure
            assert normalized_tx.source == "etherscan_token_transfers_ethereum"
            assert normalized_tx.direction == "outflow"
            assert normalized_tx.quantity == 100.0  # 100 LINK
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.fee == 0.0135
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is True
            assert normalized_tx.source_transaction_type == "token-transfer"
            assert normalized_tx.token_contract_address == "0xLINK_CONTRACT"
            assert normalized_tx.source_from_account == "0xtest_wallet"
            assert normalized_tx.source_to_account == "0xRECEIVER_ADDRESS"
            assert normalized_tx.source_asset_symbol == "LINK"
