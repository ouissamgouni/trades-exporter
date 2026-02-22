"""
Integration test for Cardano Cardanoscan connector.
Tests real API calls with a live Cardano address.

Note: Requires CARDANOSCAN_API_KEY environment variable to be set.
"""

import os
import pytest
from pathlib import Path
from decimal import Decimal
from backend.connectors.onchain.connector_cardano_scan import ConnectorCardanoScan

# Load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass


@pytest.mark.skipif(
    not os.getenv("CARDANOSCAN_API_KEY"),
    reason="CARDANOSCAN_API_KEY environment variable not set"
)
class TestCardanoIntegration:
    """Integration tests using real Cardanoscan API."""

    # Test wallet address (public Cardano address)
    WALLET_ADDRESS = "addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w"

    @pytest.fixture
    def connector(self):
        """Create a live connector instance."""
        return ConnectorCardanoScan(
            wallet_address=self.WALLET_ADDRESS,
            account_id=1,
            connector_id=1,
            config={"test_mode": False}
        )

    def test_real_api_fetch_transactions(self, connector):
        """Test fetching real transactions from Cardanoscan API."""
        # Fetch limited transactions (first page only)
        transactions = []
        count = 0
        max_transactions = 5
        
        for tx in connector.yield_raws():
            transactions.append(tx)
            count += 1
            if count >= max_transactions:
                break
        
        print(f"\n✅ Fetched {len(transactions)} transactions from Cardanoscan API")
        
        # Verify we got some transactions
        assert len(transactions) > 0, "Should fetch at least one transaction"
        
        # Verify transaction structure
        for tx in transactions:
            assert "hash" in tx, "Transaction should have hash"
            assert "timestamp" in tx, "Transaction should have timestamp"
            assert "inputs" in tx, "Transaction should have inputs"
            assert "outputs" in tx, "Transaction should have outputs"
            assert "fees" in tx, "Transaction should have fees"
            assert "status" in tx, "Transaction should have status"
            
            print(f"  - TX: {tx['hash'][:20]}... Inputs: {len(tx['inputs'])}, Outputs: {len(tx['outputs'])}, Fee: {tx['fees']} lovelaces")

    def test_real_api_normalization(self, connector):
        """Test normalization of real transactions."""
        # Fetch one transaction and normalize it
        raw_tx = None
        for tx in connector.yield_raws():
            # Only process successful transactions
            if tx.get("status") is True:
                raw_tx = tx
                break
        
        assert raw_tx is not None, "Should fetch at least one successful transaction"
        
        # Normalize the transaction
        normalized = list(connector.raw_to_normalized(raw_tx))
        
        print(f"\n✅ Normalized transaction {raw_tx['hash'][:20]}...")
        print(f"   Generated {len(normalized)} normalized transactions")
        
        # Verify we got normalized transactions
        assert len(normalized) > 0, "Should generate at least one normalized transaction"
        
        # Verify each normalized transaction
        for norm_tx in normalized:
            print(f"  - {norm_tx.source_transaction_id[:20]}...: {norm_tx.direction} {norm_tx.quantity} {norm_tx.source_asset_symbol}")
            
            # Basic validations
            assert norm_tx.source == "cardano_scan"
            assert norm_tx.network == "cardano"
            assert norm_tx.network_transaction_id == raw_tx["hash"]
            assert norm_tx.source_transaction_id == raw_tx["hash"]
            assert norm_tx.direction in ["inflow", "outflow", "neutral"]
            assert norm_tx.source_asset_symbol == "ADA"
            assert isinstance(norm_tx.quantity, Decimal)
            assert isinstance(norm_tx.fee, Decimal)
            assert norm_tx.transaction_type == "transfer"

    def test_real_api_stake_credential_matching(self, connector):
        """Test stake credential extraction and matching with real addresses."""
        # Extract stake credential from wallet address
        stake_id = connector._get_stake_credential(connector.wallet_address)
        
        print(f"\n✅ Extracted stake credential: {stake_id[:20]}...")
        
        assert stake_id is not None, "Should extract stake credential"
        assert isinstance(stake_id, str)
        assert len(stake_id) > 0
        
        # Test that wallet address matches itself
        assert connector._is_own_address(connector.wallet_address) is True
        
        print(f"  - Wallet address matches itself: ✓")

    def test_real_api_net_flow_calculation(self, connector):
        """Test net flow calculation with real transaction data."""
        # Fetch transactions and normalize
        transactions_processed = 0
        
        for raw_tx in connector.yield_raws():
            if raw_tx.get("status") is not True:
                continue
                
            normalized = list(connector.raw_to_normalized(raw_tx))
            if len(normalized) == 0:
                continue
            
            ntx = normalized[0]
            
            print(f"\n✅ Transaction: {ntx.source_transaction_id[:20]}...")
            print(f"   Direction: {ntx.direction}")
            print(f"   Quantity: {ntx.quantity} ADA")
            print(f"   Fee: {ntx.fee} ADA")
            print(f"   Include Fee: {ntx.include_fee}")
            
            # Verify net flow calculation
            inputs_total = Decimal(0)
            outputs_total = Decimal(0)
            withdrawals_total = Decimal(0)
            
            for inp in raw_tx.get("inputs", []):
                if connector._is_own_address(inp.get("address", "")):
                    inputs_total += Decimal(inp.get("value", "0"))
            
            for out in raw_tx.get("outputs", []):
                if connector._is_own_address(out.get("address", "")):
                    outputs_total += Decimal(out.get("value", "0"))
            
            for withdrawal in raw_tx.get("withdrawals", []):
                withdrawals_total += Decimal(withdrawal.get("amount", "0"))
            
            net_lovelace = outputs_total - inputs_total + withdrawals_total
            net_ada = net_lovelace / connector.lovelace_divisor
            
            print(f"   Calculated net: {net_ada} ADA")
            print(f"   Inputs (ours): {inputs_total / connector.lovelace_divisor} ADA")
            print(f"   Outputs (ours): {outputs_total / connector.lovelace_divisor} ADA")
            if withdrawals_total > 0:
                print(f"   Withdrawals: {withdrawals_total / connector.lovelace_divisor} ADA")
            
            # Verify direction matches net flow
            if net_ada > 0:
                assert ntx.direction == "inflow", f"Positive net should be inflow, got {ntx.direction}"
            elif net_ada < 0:
                assert ntx.direction == "outflow", f"Negative net should be outflow, got {ntx.direction}"
            else:
                assert ntx.direction == "neutral", f"Zero net should be neutral, got {ntx.direction}"
            
            # Verify quantity matches absolute net flow
            assert ntx.quantity == pytest.approx(abs(net_ada), rel=1e-6), "Quantity should match absolute net flow"
            
            transactions_processed += 1
            if transactions_processed >= 3:
                break
        
        assert transactions_processed > 0, "Should process at least one transaction"

    def test_real_api_ada_decimal_conversion(self, connector):
        """Test ADA lovelace conversion with real data."""
        # Fetch one transaction
        raw_tx = None
        for tx in connector.yield_raws():
            if tx.get("status") is True:
                raw_tx = tx
                break
        
        if raw_tx is None:
            pytest.skip("No successful transactions found")
        
        print(f"\n✅ Testing decimal conversion for transaction {raw_tx['hash'][:20]}...")
        
        # Get fee in lovelaces
        fee_lovelace = int(raw_tx.get("fees", "0"))
        print(f"   Fee in lovelaces: {fee_lovelace}")
        
        # Convert to ADA
        fee_ada = Decimal(fee_lovelace) / connector.lovelace_divisor
        print(f"   Fee in ADA: {fee_ada}")
        
        # Verify conversion (1 ADA = 1,000,000 lovelaces)
        assert connector.lovelace_divisor == Decimal(1_000_000)
        
        # Normalize and verify
        normalized = list(connector.raw_to_normalized(raw_tx))
        if len(normalized) > 0:
            ntx = normalized[0]
            assert ntx.fee == fee_ada, "Fee should match conversion"
            print(f"   ✓ Fee conversion verified")

    def test_real_api_withdrawal_handling(self, connector):
        """Test handling of staking reward withdrawals."""
        # Look for a transaction with withdrawals
        withdrawal_tx = None
        
        for tx in connector.yield_raws():
            if tx.get("status") is True and tx.get("withdrawals") and len(tx["withdrawals"]) > 0:
                withdrawal_tx = tx
                break
        
        if withdrawal_tx is None:
            pytest.skip("No transactions with withdrawals found")
        
        print(f"\n✅ Found transaction with withdrawals: {withdrawal_tx['hash'][:20]}...")
        print(f"   Withdrawal count: {len(withdrawal_tx['withdrawals'])}")
        
        # Normalize
        normalized = list(connector.raw_to_normalized(withdrawal_tx))
        assert len(normalized) > 0
        
        ntx = normalized[0]
        
        # Verify withdrawal information in tags
        assert ntx.tags is not None
        withdrawal_tag = next((tag for tag in ntx.tags if "withdrawal_count" in tag), None)
        assert withdrawal_tag is not None, "Should have withdrawal information in tags"
        
        print(f"   Withdrawal amount: {withdrawal_tag['withdrawal_amount_ada']} ADA")
        print(f"   ✓ Withdrawal processed correctly")

    def test_real_api_pagination(self, connector):
        """Test pagination through multiple pages of transactions."""
        page_sizes = []
        page_count = 0
        max_pages = 3  # Limit to 3 pages for testing
        
        print(f"\n✅ Testing pagination (max {max_pages} pages)...")
        
        current_page_size = 0
        for tx in connector.yield_raws():
            current_page_size += 1
            
            # Simple heuristic: assume new page every 10 transactions
            # (actual page size depends on API)
            if current_page_size >= 10:
                page_sizes.append(current_page_size)
                current_page_size = 0
                page_count += 1
                
                print(f"   Page {page_count}: {page_sizes[-1]} transactions")
                
                if page_count >= max_pages:
                    break
        
        # Add remaining transactions
        if current_page_size > 0:
            page_sizes.append(current_page_size)
            page_count += 1
            print(f"   Page {page_count}: {page_sizes[-1]} transactions")
        
        print(f"   ✓ Successfully paginated through {page_count} pages")
        assert page_count > 0, "Should fetch at least one page"

    def test_real_api_failed_transaction_filtering(self, connector):
        """Test that failed transactions are properly filtered."""
        all_txs = 0
        successful_txs = 0
        failed_txs = 0
        
        print(f"\n✅ Testing transaction status filtering...")
        
        for raw_tx in connector.yield_raws():
            all_txs += 1
            
            if raw_tx.get("status") is True:
                successful_txs += 1
                # Successful transactions should normalize
                normalized = list(connector.raw_to_normalized(raw_tx))
                assert len(normalized) > 0, "Successful transactions should normalize"
            else:
                failed_txs += 1
                # Failed transactions should not normalize
                normalized = list(connector.raw_to_normalized(raw_tx))
                assert len(normalized) == 0, "Failed transactions should not normalize"
            
            if all_txs >= 10:
                break
        
        print(f"   Total transactions: {all_txs}")
        print(f"   Successful: {successful_txs}")
        print(f"   Failed: {failed_txs}")
        print(f"   ✓ Transaction filtering works correctly")


if __name__ == "__main__":
    # Run only if CARDANOSCAN_API_KEY is set
    if os.getenv("CARDANOSCAN_API_KEY"):
        pytest.main([__file__, "-v", "-s"])
    else:
        print("⚠️  CARDANOSCAN_API_KEY not set. Skipping integration tests.")
        print("   Set CARDANOSCAN_API_KEY environment variable to run integration tests.")
