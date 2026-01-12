"""Unit tests for Blockscout Base Token Transfers connector."""

from unittest.mock import patch

from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)


class TestBlockscoutBaseTokenTransfersConnector:
    """Unit tests for Blockscout Base token transfers connector with mocked API responses."""

    def test_token_transfer_inflow_mapping(self):
        """Test mapping of inflow token transfer from mocked Blockscout API response."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="Base",
        )

        # Mock Blockscout API v2 response for token transfer
        mock_api_response = {
            "items": [
                {
                    "hash": "0xtoken123",
                    "from": {"hash": "0xSENDER_ADDRESS"},
                    "to": {"hash": "0xtest_wallet"},  # Inflow to our wallet
                    "token": {
                        "symbol": "USDC",
                        "name": "USD Coin",
                        "address_hash": "0xUSDC_CONTRACT",
                        "decimals": 6,
                    },
                    "total": {"value": "1000000000"},  # 1000 USDC
                    "gas_used": "65000",
                    "gas_price": "20000000000",  # 20 gwei
                    "timestamp": "2023-02-10T08:15:00.000000Z",
                }
            ]
        }

        with patch.object(connector, "safe_request", return_value=mock_api_response):
            # Get mapped result from yield_normalized
            results = list(connector.yield_normalized())
            normalized_txs = [res[1] for res in results]
            assert len(normalized_txs) == 1
            normalized_tx = normalized_txs[0]

            # Validate normalized structure
            assert normalized_tx.source == "blockscout_token_transfers_base"
            assert normalized_tx.source_transaction_type == "token-transfer"
            assert normalized_tx.source_asset_symbol == "USDC_0xUSDC_CONTRACT"
            assert normalized_tx.source_from_account == "0xSENDER_ADDRESS"
            assert normalized_tx.source_to_account == "0xtest_wallet"
            assert normalized_tx.direction == "inflow"
            assert normalized_tx.quantity == 1000.0  # 1000 USDC
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.fee == 0.0013  # 0.0013 ETH
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is False
            assert normalized_tx.token_contract_address == "0xUSDC_CONTRACT"

    def test_token_transfer_outflow_mapping(self):
        """Test mapping of outflow token transfer from mocked Blockscout API response."""
        connector = ConnectorBlockscoutTokenTransfers(
            wallet_address="0xTEST_WALLET",
            chain_name="Base",
        )

        # Mock Blockscout API v2 response for outflow token transfer
        mock_api_response = {
            "items": [
                {
                    "hash": "0xtoken456",
                    "from": {"hash": "0xtest_wallet"},  # Outflow from our wallet
                    "to": {"hash": "0xRECEIVER_ADDRESS"},
                    "token": {
                        "symbol": "DAI",
                        "name": "Dai Stablecoin",
                        "address_hash": "0xDAI_CONTRACT",
                        "decimals": 18,
                    },
                    "total": {"value": "500000000000000000000"},  # 500 DAI
                    "gas_used": "70000",
                    "gas_price": "25000000000",  # 25 gwei
                    "timestamp": "2023-02-11T16:45:00.000000Z",
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
            assert normalized_tx.source == "blockscout_token_transfers_base"
            assert normalized_tx.source_transaction_type == "token-transfer"
            assert normalized_tx.source_asset_symbol == "DAI_0xDAI_CONTRACT"
            assert normalized_tx.source_from_account == "0xtest_wallet"
            assert normalized_tx.source_to_account == "0xRECEIVER_ADDRESS"
            assert normalized_tx.direction == "outflow"
            assert normalized_tx.quantity == 500.0  # 500 DAI
            assert normalized_tx.transaction_type == "transfer"  # Onchain transactions are transfers
            assert normalized_tx.fee == 0.00175  # 0.00175 ETH
            assert normalized_tx.source_fee_quote_asset_symbol == "ETH"
            assert normalized_tx.include_fee is True
            assert normalized_tx.token_contract_address == "0xDAI_CONTRACT"
