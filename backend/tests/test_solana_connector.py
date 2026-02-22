"""
Unit tests for Solana Helius connector.
Tests transaction normalization using fixtures.
"""

import pytest
from decimal import Decimal
from backend.connectors.onchain.connector_solana_helius import ConnectorSolanaHelius


class TestSolanaConnector:
    """Test suite for Solana Helius connector."""

    @pytest.fixture
    def connector(self):
        """Create a test connector instance."""
        return ConnectorSolanaHelius(
            wallet_address="6VUr67Aux76vH32vpZaKbjU9wq4ubcqsTxuUnqDzhyz8",
            account_id=1,
            connector_id=1,
            config={"test_mode": True}
        )

    def test_connector_initialization(self, connector):
        """Test connector initializes correctly."""
        assert connector.connector_name == "solana_helius"
        assert connector.wallet_address == "6VUr67Aux76vH32vpZaKbjU9wq4ubcqsTxuUnqDzhyz8"
        assert connector.test_mode is True

    def test_yield_raws_from_fixture(self, connector):
        """Test that yield_raws loads transactions from fixture file."""
        transactions = list(connector.yield_raws())
        
        # Should load 5 transactions from fixture
        assert len(transactions) == 5
        
        # Verify structure of first transaction
        first_tx = transactions[0]
        assert "signature" in first_tx
        assert "timestamp" in first_tx
        assert "type" in first_tx
        assert "fee" in first_tx
        assert "feePayer" in first_tx

    def test_normalization_native_transfer_outflow(self, connector):
        """Test normalization of native SOL transfer (outflow)."""
        # First transaction: native outflow with fee
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[0]))
        
        # Should yield 1 native transfer + 1 fee transaction
        assert len(normalized) == 2
        
        # Check native transfer
        transfer = normalized[0]
        assert transfer.source_transaction_id == f"{raw_txs[0]['signature']}_native_0"
        assert transfer.network_transaction_id == raw_txs[0]['signature']
        assert transfer.direction == "outflow"
        assert transfer.source_asset_symbol == "SOL"
        assert transfer.quantity == Decimal("1.5")  # 1.5 SOL (1500000000 lamports)
        assert transfer.fee == Decimal(0)
        assert transfer.include_fee is False
        assert transfer.network == "solana"
        assert transfer.transaction_type == "transfer"
        assert transfer.source_transaction_type == "TRANSFER"
        
        # Check fee transaction
        fee_tx = normalized[1]
        assert fee_tx.source_transaction_id == f"{raw_txs[0]['signature']}_fee"
        assert fee_tx.direction == "outflow"
        assert fee_tx.transaction_type == "technical"
        assert fee_tx.quantity == Decimal(0)
        assert fee_tx.fee == Decimal("0.000005")  # 5000 lamports
        assert fee_tx.include_fee is True
        assert fee_tx.source_asset_symbol == "SOL"

    def test_normalization_token_transfers_swap(self, connector):
        """Test normalization of token swap with multiple transfers."""
        # Second transaction: USDC -> USDT swap
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[1]))
        
        # Should yield 2 token transfers + 1 fee transaction
        assert len(normalized) == 3
        
        # Check outgoing USDC
        usdc_transfer = normalized[0]
        assert usdc_transfer.source_transaction_id == f"{raw_txs[1]['signature']}_token_0"
        assert usdc_transfer.direction == "outflow"
        assert usdc_transfer.source_asset_symbol == "USDC"
        assert usdc_transfer.quantity == Decimal("100")  # 100 USDC (6 decimals)
        assert usdc_transfer.token_contract_address == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        
        # Check incoming USDT
        usdt_transfer = normalized[1]
        assert usdt_transfer.source_transaction_id == f"{raw_txs[1]['signature']}_token_1"
        assert usdt_transfer.direction == "inflow"
        assert usdt_transfer.source_asset_symbol == "USDT"
        assert usdt_transfer.quantity == Decimal("95")  # 95 USDT (6 decimals)
        assert usdt_transfer.token_contract_address == "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
        
        # Check fee transaction
        fee_tx = normalized[2]
        assert fee_tx.source_transaction_id == f"{raw_txs[1]['signature']}_fee"
        assert fee_tx.transaction_type == "technical"

    def test_normalization_native_transfer_inflow(self, connector):
        """Test normalization of native SOL transfer (inflow)."""
        # Third transaction: native inflow, fee paid by other wallet
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[2]))
        
        # Should yield 1 native transfer only (no fee transaction since feePayer is different)
        assert len(normalized) == 1
        
        transfer = normalized[0]
        assert transfer.direction == "inflow"
        assert transfer.source_asset_symbol == "SOL"
        assert transfer.quantity == Decimal("0.5")  # 0.5 SOL (500000000 lamports)
        assert transfer.fee == Decimal(0)

    def test_normalization_filters_ineligible_transfers(self, connector):
        """Test that transfers not involving the wallet are filtered out."""
        # Fourth transaction: transfers between other wallets
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[3]))
        
        # Should yield nothing (no eligible transfers)
        assert len(normalized) == 0

    def test_normalization_token_transfer_inflow(self, connector):
        """Test normalization of token transfer (inflow)."""
        # Fifth transaction: mSOL inflow with fee paid by wallet
        raw_txs = list(connector.yield_raws())
        normalized = list(connector.raw_to_normalized(raw_txs[4]))
        
        # Should yield 1 token transfer + 1 fee transaction
        assert len(normalized) == 2
        
        # Check token transfer
        transfer = normalized[0]
        assert transfer.source_transaction_id == f"{raw_txs[4]['signature']}_token_0"
        assert transfer.direction == "inflow"
        assert transfer.source_asset_symbol == "mSOL"
        assert transfer.quantity == Decimal("50")  # 50 mSOL (9 decimals)
        assert transfer.token_contract_address == "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"

    def test_token_metadata_caching(self, connector):
        """Test that token metadata is cached after first lookup."""
        mint_address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        
        # First call should load from fixture
        metadata1 = connector._get_token_metadata(mint_address)
        assert metadata1["symbol"] == "USDC"
        assert metadata1["decimals"] == 6
        
        # Second call should return cached value
        metadata2 = connector._get_token_metadata(mint_address)
        assert metadata2 == metadata1
        assert mint_address in connector._token_cache

    def test_token_metadata_fallback(self, connector):
        """Test fallback when token metadata is not found."""
        unknown_mint = "UnknownMint1111111111111111111111111111111"
        
        metadata = connector._get_token_metadata(unknown_mint)
        
        # Should fallback to mint address as symbol and default decimals
        assert metadata["symbol"] == unknown_mint
        assert metadata["decimals"] == 8

    def test_direction_determination(self, connector):
        """Test direction determination logic."""
        wallet = connector.wallet_address
        other = "OtherAddress123456789012345678901234567890"
        
        # Outflow
        assert connector._determine_direction(wallet, other) == "outflow"
        
        # Inflow
        assert connector._determine_direction(other, wallet) == "inflow"
        
        # Self-transfer
        assert connector._determine_direction(wallet, wallet) == "neutral"
        
        # Neither (edge case)
        assert connector._determine_direction(other, other) == "neutral"

    def test_sol_decimal_conversion(self, connector):
        """Test SOL lamports to SOL conversion."""
        # 1 SOL = 1,000,000,000 lamports
        assert Decimal(1_000_000_000) / connector.SOL_DIVISOR == Decimal("1")
        assert Decimal(500_000_000) / connector.SOL_DIVISOR == Decimal("0.5")
        assert Decimal(5000) / connector.SOL_DIVISOR == Decimal("0.000005")

    def test_source_transaction_id_uniqueness(self, connector):
        """Test that source_transaction_id is unique for each transfer."""
        raw_txs = list(connector.yield_raws())
        
        # Get all normalized transactions
        all_normalized = []
        for raw_tx in raw_txs:
            all_normalized.extend(list(connector.raw_to_normalized(raw_tx)))
        
        # Collect all source_transaction_ids
        tx_ids = [tx.source_transaction_id for tx in all_normalized]
        
        # All IDs should be unique
        assert len(tx_ids) == len(set(tx_ids))
        
        # Verify format
        for tx_id in tx_ids:
            # Should match pattern: [SIGNATURE]_[native|token|fee]_[INDEX]
            parts = tx_id.split("_")
            assert len(parts) >= 2
            assert parts[1] in ["native", "token", "fee"]

    def test_network_transaction_id_grouping(self, connector):
        """Test that all transfers from same transaction share network_transaction_id."""
        raw_txs = list(connector.yield_raws())
        
        # Second transaction has multiple transfers
        swap_tx = raw_txs[1]
        normalized = list(connector.raw_to_normalized(swap_tx))
        
        # All should have same network_transaction_id
        network_ids = [tx.network_transaction_id for tx in normalized]
        assert len(set(network_ids)) == 1
        assert network_ids[0] == swap_tx["signature"]

    def test_token_amount_not_double_divided(self, connector):
        """Regression test: tokenAmount from Helius is already human-readable.
        
        Ensures the connector does NOT divide tokenAmount by 10^decimals again.
        See: Helius tokenTransfers[].tokenAmount is pre-divided, unlike
        rawTokenAmount in accountData which is in base units.
        """
        raw_tx = {
            "signature": "41po6Wst73PKC1tD5qzKP33GMTwCntXm1RFB9JTVNaJ83oX8KtW8Paqi5gs69QmPmehKf5F18MmqvMq6DyrYCDzj",
            "timestamp": 1762040831,
            "type": "TRANSFER",
            "fee": 69886,
            "feePayer": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
            "nativeTransfers": [],
            "tokenTransfers": [
                {
                    "fromUserAccount": "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
                    "toUserAccount": "6VUr67Aux76vH32vpZaKbjU9wq4ubcqsTxuUnqDzhyz8",
                    "mint": "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn",
                    "tokenAmount": 78517.27,
                    "tokenStandard": "Fungible"
                }
            ]
        }

        normalized = list(connector.raw_to_normalized(raw_tx))

        # Should yield 1 token inflow (no fee — feePayer is not our wallet)
        token_transfers = [tx for tx in normalized if tx.transaction_type == "transfer"]
        assert len(token_transfers) == 1

        transfer = token_transfers[0]
        assert transfer.direction == "inflow"
        assert transfer.quantity == Decimal("78517.27"), (
            f"Expected 78517.27 but got {transfer.quantity} — "
            "tokenAmount is already human-readable, do not divide by 10^decimals"
        )
        assert transfer.network == "solana"
        assert transfer.token_contract_address == "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
