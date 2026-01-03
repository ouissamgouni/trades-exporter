"""Unit tests for Blockscout Base Normal Transactions connector."""

from unittest.mock import patch

from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)


class TestBlockscoutBaseNormalTxConnector:
    """Unit tests for Blockscout Base normal transactions connector with mocked API responses."""

    def test_normal_tx_inflow_mapping(self):
        """Test mapping of inflow normal transaction from mocked Blockscout API response."""
        connector = ConnectorBlockscoutNormalTx(
            wallet_address="0xTEST_WALLET",
            chain_name="Base",
        )

        # Mock Blockscout API v2 response for normal transaction
        mock_api_response = {
            "items": [
                {
                    "priority_fee": "21000000000",
                    "raw_input": "0x",
                    "result": "success",
                    "hash": "0xd308f78be7a3ba7e8fb20a5509389f7c2d02ee52d98bb2109f410152d994ec85",
                    "max_fee_per_gas": "2611706",
                    "transaction_burnt_fee": "26841864000",
                    "position": 40,
                    "max_priority_fee_per_gas": "1000000",
                    "value": "100000000000000",
                    "from": {
                        "hash": "0xSENDER_ADDRESS",
                    },
                    "gas_used": "21000",
                    "status": "ok",
                    "to": {
                        "hash": "0xTEST_WALLET",
                    },
                    "fee": {"type": "actual", "value": "48226753932"},
                    "actions": [],
                    "gas_limit": "21000",
                    "gas_price": "2278184",
                    "base_fee_per_gas": "1278184",
                    "timestamp": "2025-11-27T14:09:55.000000Z",
                    "nonce": 11,
                    "historic_exchange_rate": "3035.23",
                    "transaction_types": ["coin_transfer"],
                }
            ]
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result from yield_normalized
            results = list(connector.yield_normalized())

            normalized_trxs = [res[1] for res in results]

            assert len(normalized_trxs) == 1
            normalized_tx = normalized_trxs[0]

            # Validate normalized structure
            assert normalized_tx.source == "blockscout_base_normal_tx"
            assert normalized_tx.direction == "inflow"
            assert normalized_tx.quantity == 0.0001  # 1 ETH
            assert normalized_tx.source_transaction_type == "normal-tx"
            assert normalized_tx.transaction_type is None  # To be classified later
            assert normalized_tx.source_asset_symbol == "ETH"
            assert normalized_tx.fee == 4.7841864e-08  # 0
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is False
            assert normalized_tx.source_from_account == "0xSENDER_ADDRESS"
            assert normalized_tx.source_to_account == "0xTEST_WALLET"

    def test_normal_tx_outflow_mapping(self):
        """Test mapping of outflow normal transaction from mocked Blockscout API response."""
        connector = ConnectorBlockscoutNormalTx(
            wallet_address="0xTEST_WALLET",
            chain_name="Base",
        )

        # Mock Blockscout API v2 response for outflow transaction
        mock_api_response = {
            "items": [
                {
                    "hash": "0xdef456",
                    "from": {"hash": "0xtest_wallet"},  # Outflow from our wallet
                    "to": {"hash": "0xRECEIVER_ADDRESS"},
                    "value": "500000000000000000",  # 0.5 ETH in wei
                    "gas_used": "21000",
                    "gas_price": "30000000000",  # 30 gwei
                    "timestamp": "2023-01-16T14:20:00.000000Z",
                }
            ]
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result
            results = list(connector.yield_normalized())

            normalized_txs = [res[1] for res in results]

            assert len(normalized_txs) == 1
            normalized_tx = normalized_txs[0]

            # Validate normalized structure
            assert normalized_tx.source == "blockscout_base_normal_tx"
            assert normalized_tx.direction == "outflow"
            assert normalized_tx.source_transaction_type == "normal-tx"
            assert normalized_tx.source_asset_symbol == "ETH"
            assert normalized_tx.source_from_account == "0xtest_wallet"
            assert normalized_tx.source_to_account == "0xRECEIVER_ADDRESS"
            assert normalized_tx.quantity == 0.5  # 0.5 ETH
            assert normalized_tx.transaction_type is None  # To be classified later
            assert normalized_tx.fee == 0.00063  # 0.00063 ETH
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is True
