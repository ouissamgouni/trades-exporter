"""
Integration test for Solana Helius connector.
Tests real API calls with a live Solana address.

Note: Requires HELIUS_API_KEY environment variable to be set.
"""

import os
import pytest
from decimal import Decimal
from backend.connectors.onchain.connector_solana_helius import ConnectorSolanaHelius


@pytest.mark.skipif(
    not os.getenv("HELIUS_API_KEY"),
    reason="HELIUS_API_KEY environment variable not set"
)
class TestSolanaIntegration:
    """Integration tests using real Helius API."""

    WALLET_ADDRESS = "6VUr67Aux76vH32vpZaKbjU9wq4ubcqsTxuUnqDzhyz8"

    @pytest.fixture
    def connector(self):
        """Create a live connector instance."""
        return ConnectorSolanaHelius(
            wallet_address=self.WALLET_ADDRESS,
            account_id=1,
            connector_id=1,
            config={"test_mode": False}
        )

    def test_real_api_fetch_transactions(self, connector):
        """Test fetching real transactions from Helius API."""
        # Fetch limited transactions (first page only)
        transactions = []
        count = 0
        max_transactions = 5
        
        for tx in connector.yield_raws():
            transactions.append(tx)
            count += 1
            if count >= max_transactions:
                break
        
        print(f"\n✅ Fetched {len(transactions)} transactions from Helius API")
        
        # Verify we got some transactions
        assert len(transactions) > 0, "Should fetch at least one transaction"
        
        # Verify transaction structure
        for tx in transactions:
            assert "signature" in tx, "Transaction should have signature"
            assert "timestamp" in tx, "Transaction should have timestamp"
            assert "type" in tx, "Transaction should have type"
            assert "fee" in tx, "Transaction should have fee"
            assert "feePayer" in tx, "Transaction should have feePayer"
            
            print(f"  - TX: {tx['signature'][:20]}... Type: {tx['type']}, Fee: {tx['fee']} lamports")

    def test_real_api_normalization(self, connector):
        """Test normalization of real transactions."""
        # Fetch one transaction and normalize it
        raw_tx = None
        for tx in connector.yield_raws():
            raw_tx = tx
            break
        
        assert raw_tx is not None, "Should fetch at least one transaction"
        
        # Normalize the transaction
        normalized = list(connector.raw_to_normalized(raw_tx))
        
        print(f"\n✅ Normalized transaction {raw_tx['signature'][:20]}...")
        print(f"   Generated {len(normalized)} normalized transactions")
        
        # Verify we got normalized transactions
        assert len(normalized) > 0, "Should generate at least one normalized transaction"
        
        # Verify each normalized transaction
        for norm_tx in normalized:
            print(f"  - {norm_tx.source_transaction_id}: {norm_tx.direction} {norm_tx.quantity} {norm_tx.source_asset_symbol}")
            
            # Basic validations
            assert norm_tx.source == "solana_helius"
            assert norm_tx.network == "solana"
            assert norm_tx.network_transaction_id == raw_tx["signature"]
            assert norm_tx.source_transaction_id.startswith(raw_tx["signature"])
            assert norm_tx.direction in ["inflow", "outflow", "neutral"]
            assert norm_tx.source_asset_symbol is not None
            assert isinstance(norm_tx.quantity, Decimal)
            assert isinstance(norm_tx.fee, Decimal)
            
            # Verify source_transaction_id format
            parts = norm_tx.source_transaction_id.split("_")
            assert len(parts) >= 2
            assert parts[1] in ["native", "token", "fee"]

    def test_real_api_token_metadata_resolution(self, connector):
        """Test token metadata resolution with real API."""
        # Fetch transactions until we find one with token transfers
        token_tx = None
        for tx in connector.yield_raws():
            if tx.get("tokenTransfers") and len(tx["tokenTransfers"]) > 0:
                token_tx = tx
                break
        
        if token_tx is None:
            pytest.skip("No token transfers found in recent transactions")
        
        print(f"\n✅ Found transaction with {len(token_tx['tokenTransfers'])} token transfers")
        
        # Normalize to trigger metadata resolution
        normalized = list(connector.raw_to_normalized(token_tx))
        
        # Find token transfers (not fee transactions)
        token_transfers = [tx for tx in normalized if tx.token_contract_address]
        
        assert len(token_transfers) > 0, "Should have token transfers"
        
        for transfer in token_transfers:
            print(f"  - Token: {transfer.source_asset_symbol} (Mint: {transfer.token_contract_address[:20]}...)")
            print(f"    Amount: {transfer.quantity}")
            
            # Verify token metadata was resolved
            assert transfer.source_asset_symbol is not None
            assert transfer.token_contract_address is not None
            
            # Verify the token is in cache
            assert transfer.token_contract_address in connector._token_cache

    def test_real_api_sol_decimal_conversion(self, connector):
        """Test SOL lamports conversion with real data."""
        # Fetch transactions until we find one with ELIGIBLE native transfers
        # (where wallet is fromUserAccount or toUserAccount)
        native_tx = None
        wallet_lower = connector.wallet_address.lower()
        
        for tx in connector.yield_raws():
            if not tx.get("nativeTransfers"):
                continue
            
            # Check if any native transfer involves our wallet
            has_eligible_transfer = False
            for nt in tx["nativeTransfers"]:
                from_addr = nt.get("fromUserAccount", "").lower()
                to_addr = nt.get("toUserAccount", "").lower()
                if from_addr == wallet_lower or to_addr == wallet_lower:
                    has_eligible_transfer = True
                    break
            
            if has_eligible_transfer:
                native_tx = tx
                break
        
        if native_tx is None:
            pytest.skip("No eligible native SOL transfers found in recent transactions")
        
        print(f"\n✅ Found transaction with eligible native transfers")
        
        # Normalize
        normalized = list(connector.raw_to_normalized(native_tx))
        
        # Find SOL transfers
        sol_transfers = [tx for tx in normalized if tx.source_asset_symbol == "SOL" and tx.quantity > 0]
        
        assert len(sol_transfers) > 0, "Should have SOL transfers with quantity > 0"
        
        for transfer in sol_transfers:
            print(f"  - SOL Transfer: {transfer.direction} {transfer.quantity} SOL")
            
            # Verify amount is properly converted
            assert isinstance(transfer.quantity, Decimal)
            assert transfer.quantity > 0

    def test_real_api_fee_handling(self, connector):
        """Test fee transaction handling with real data."""
        # Fetch one transaction where wallet is fee payer
        fee_tx = None
        for tx in connector.yield_raws():
            if tx.get("feePayer", "").lower() == self.WALLET_ADDRESS.lower():
                fee_tx = tx
                break
        
        if fee_tx is None:
            pytest.skip("No transactions where wallet is fee payer found")
        
        print(f"\n✅ Found transaction where wallet pays fee: {fee_tx['fee']} lamports")
        
        # Normalize
        normalized = list(connector.raw_to_normalized(fee_tx))
        
        # Should have at least one fee transaction
        fee_transactions = [tx for tx in normalized if tx.transaction_type == "technical" and tx.include_fee]
        
        assert len(fee_transactions) == 1, "Should have exactly one fee transaction"
        
        fee_tx_norm = fee_transactions[0]
        print(f"  - Fee Transaction: {fee_tx_norm.fee} SOL")
        
        # Verify fee transaction structure
        assert fee_tx_norm.direction == "outflow"
        assert fee_tx_norm.quantity == Decimal(0)
        assert fee_tx_norm.fee > 0
        assert fee_tx_norm.source_asset_symbol == "SOL"
        assert fee_tx_norm.source_fee_quote_asset_symbol == "SOL"


if __name__ == "__main__":
    # Run only if HELIUS_API_KEY is set
    if os.getenv("HELIUS_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("⚠️  HELIUS_API_KEY not set. Skipping integration tests.")
        print("   Set HELIUS_API_KEY environment variable to run integration tests.")
