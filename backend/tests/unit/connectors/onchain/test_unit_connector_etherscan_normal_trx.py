"""Unit tests for Etherscan Normal Transactions connector."""

from unittest.mock import patch
from datetime import datetime, timezone

from backend.connectors.onchain.etherscan.connector_etherscan_normal_tx import (
    ConnectorEtherscanNormalTx,
)


class TestEtherscanNormalTxConnector:
    """Unit tests for Etherscan normal transactions connector with mocked API responses."""

    def test_normal_tx_inflow_mapping(self):
        """Test mapping of inflow normal transaction from mocked Etherscan API response."""
        connector = ConnectorEtherscanNormalTx(
            wallet_address="0xTEST_WALLET",
            chain_name="ethereum",
        )

        # Mock Etherscan API response for normal transaction (list format)
        mock_api_response = [
            {
                "hash": "0xeth123",
                "transactionIndex": "10",
                "from": "0xSENDER_ADDRESS",
                "to": "0xtest_wallet",  # Inflow to our wallet
                "value": "2000000000000000000",  # 2 ETH in wei
                "gasUsed": "21000",
                "gasPrice": "100000000000",  # 100 gwei
                "timeStamp": "1673780400",  # Unix timestamp
                "methodId": "0x",
            }
        ]

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result from yield_normalized
            results = list(connector.yield_normalized())
            normalized_txs = [res[1] for res in results]
            assert len(normalized_txs) == 1
            normalized_tx = normalized_txs[0]

            # Validate normalized structure
            assert normalized_tx.source == "etherscan_normal_tx_ethereum"
            assert normalized_tx.date_time == datetime.fromtimestamp(
                1673780400, tz=timezone.utc
            )
            assert normalized_tx.source_asset_symbol == "ETH"
            assert normalized_tx.direction == "inflow"
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.quantity == 2.0  # 2 ETH
            assert normalized_tx.fee == 0.0021  # 0.0021 ETH
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is False
            assert normalized_tx.source_from_account == "0xSENDER_ADDRESS"
            assert normalized_tx.source_to_account == "0xtest_wallet"

    def test_normal_tx_outflow_mapping(self):
        """Test mapping of outflow normal transaction from mocked Etherscan API response."""
        connector = ConnectorEtherscanNormalTx(
            wallet_address="0xTEST_WALLET",
            chain_name="ethereum",
        )

        # Mock Etherscan API response for outflow transaction
        mock_api_response = [
            {
                "hash": "0xeth456",
                "transactionIndex": "25",
                "from": "0xtest_wallet",  # Outflow from our wallet
                "to": "0xRECEIVER_ADDRESS",
                "value": "1500000000000000000",  # 1.5 ETH in wei
                "gasUsed": "21000",
                "gasPrice": "80000000000",  # 80 gwei
                "timeStamp": "1673866800",  # Unix timestamp
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
            assert normalized_tx.source == "etherscan_normal_tx_ethereum"
            assert normalized_tx.date_time == datetime.fromtimestamp(
                1673866800, tz=timezone.utc
            )
            assert normalized_tx.direction == "outflow"
            assert normalized_tx.quantity == 1.5  # 1.5 ETH
            assert normalized_tx.source_transaction_type == "normal-tx"
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.fee == 0.00168
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is True
            assert normalized_tx.source_from_account == "0xtest_wallet"
            assert normalized_tx.source_to_account == "0xRECEIVER_ADDRESS"
