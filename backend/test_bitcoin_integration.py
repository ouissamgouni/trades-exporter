"""
Integration test for Bitcoin Blockstream Esplora connector.
Tests real API calls with a live Bitcoin address.

Note: No API key required - uses free Blockstream API.
"""

import os
import pytest
from pathlib import Path
from decimal import Decimal
from backend.connectors.onchain.connector_bitcoin_esplora import ConnectorBitcoinEsplora

# Load .env file if python-dotenv is available
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        load_dotenv(env_path)
except ImportError:
    pass


class TestBitcoinIntegration:
    """Integration tests using real Blockstream Esplora API."""

    # Test wallet address (public Bitcoin address with some transaction history)
    # This is a well-known address for testing purposes
    WALLET_ADDRESS = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"

    @pytest.fixture
    def connector(self):
        """Create a live connector instance."""
        return ConnectorBitcoinEsplora(
            wallet_address=self.WALLET_ADDRESS,
            account_id=1,
            connector_id=1,
            config={"test_mode": False}
        )

    def test_real_api_fetch_transactions(self, connector):
        """Test fetching real transactions from Blockstream Esplora API."""
        # Fetch limited transactions (first page only)
        transactions = []
        count = 0
        max_transactions = 5
        
        print(f"\n🔍 Fetching Bitcoin transactions for: {self.WALLET_ADDRESS}")
        
        for tx in connector.yield_raws():
            transactions.append(tx)
            count += 1
            if count >= max_transactions:
                break
        
        print(f"✅ Fetched {len(transactions)} confirmed transactions from Blockstream API")
        
        if len(transactions) == 0:
            pytest.skip("No confirmed transactions found for test address")
        
        # Verify transaction structure
        for tx in transactions:
            assert "txid" in tx, "Transaction should have txid"
            assert "fee" in tx, "Transaction should have fee"
            assert "vin" in tx, "Transaction should have inputs (vin)"
            assert "vout" in tx, "Transaction should have outputs (vout)"
            assert "status" in tx, "Transaction should have status"
            
            status = tx.get("status", {})
            assert status.get("confirmed") is True, "Transaction should be confirmed"
            
            print(f"  - TX: {tx['txid'][:20]}... Inputs: {len(tx['vin'])}, Outputs: {len(tx['vout'])}, Fee: {tx['fee']} sats")

    def test_real_api_normalization(self, connector):
        """Test normalization of real transactions."""
        # Fetch one transaction and normalize it
        raw_tx = None
        for tx in connector.yield_raws():
            # Only process confirmed transactions
            if tx.get("status", {}).get("confirmed"):
                raw_tx = tx
                break
        
        if raw_tx is None:
            pytest.skip("No confirmed transactions found for normalization test")
        
        # Normalize the transaction
        normalized = list(connector.raw_to_normalized(raw_tx))
        
        print(f"\n✅ Normalized Bitcoin transaction {raw_tx['txid'][:20]}...")
        print(f"   Generated {len(normalized)} normalized transaction(s)")
        
        # Verify we got normalized transactions
        assert len(normalized) > 0, "Should generate at least one normalized transaction"
        
        # Verify each normalized transaction
        for norm_tx in normalized:
            print(f"  - {norm_tx.source_transaction_id}: {norm_tx.direction} {norm_tx.quantity} {norm_tx.source_asset_symbol}")
            print(f"    Fee: {norm_tx.fee} BTC (include_fee: {norm_tx.include_fee})")
            
            # Basic validations
            assert norm_tx.source == "bitcoin_esplora"
            assert norm_tx.network == "bitcoin"
            assert norm_tx.network_transaction_id == raw_tx["txid"]
            assert norm_tx.source_transaction_id.startswith(raw_tx["txid"])
            assert norm_tx.source_transaction_id.endswith("_in") or norm_tx.source_transaction_id.endswith("_out")
            assert norm_tx.direction in ["inflow", "outflow"]
            assert norm_tx.source_asset_symbol == "BTC"
            assert norm_tx.quantity > 0, "Quantity should be positive"
            assert norm_tx.fee >= 0, "Fee should be non-negative"
            assert norm_tx.transaction_type == "transfer"
            
            # Validate fee inclusion logic
            if norm_tx.direction == "outflow":
                assert norm_tx.include_fee is True, "Outflows should include fees"
            else:
                assert norm_tx.include_fee is False, "Inflows should not include fees"

    def test_real_api_address_validation(self, connector):
        """Test Bitcoin address validation with real addresses."""
        print(f"\n✅ Testing Bitcoin address validation")
        
        # Wallet address should match itself
        assert connector._is_own_address(connector.wallet_address) is True
        print(f"  - Wallet address matches itself: ✓")
        
        # Test different address types
        test_addresses = {
            "P2PKH": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
            "P2SH": "3J98t1WpEZ73CNmYviecrnyiWrnqRhWNLy",
            "Bech32": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        }
        
        for addr_type, addr in test_addresses.items():
            is_valid = connector._validate_bitcoin_address(addr)
            assert is_valid is True, f"{addr_type} address should be valid"
            print(f"  - {addr_type} validation: ✓")

    def test_real_api_utxo_aggregation(self, connector):
        """Test UTXO aggregation with real transaction data."""
        print(f"\n✅ Testing UTXO aggregation")
        
        # Fetch and process first transaction
        for raw_tx in connector.yield_raws():
            if not raw_tx.get("status", {}).get("confirmed"):
                continue
            
            normalized = list(connector.raw_to_normalized(raw_tx))
            if len(normalized) == 0:
                continue
            
            txid = raw_tx["txid"]
            print(f"\n  Transaction: {txid[:20]}...")
            
            # Calculate totals from raw data
            total_inflow_sats = 0
            total_outflow_sats = 0
            
            for vout in raw_tx.get("vout", []):
                addr = vout.get("scriptpubkey_address")
                if addr and connector._is_own_address(addr):
                    total_inflow_sats += vout.get("value", 0)
            
            for vin in raw_tx.get("vin", []):
                prevout = vin.get("prevout", {})
                addr = prevout.get("scriptpubkey_address")
                if addr and connector._is_own_address(addr):
                    total_outflow_sats += prevout.get("value", 0)
            
            print(f"  - Total inflow:  {total_inflow_sats:,} sats ({total_inflow_sats / 100_000_000:.8f} BTC)")
            print(f"  - Total outflow: {total_outflow_sats:,} sats ({total_outflow_sats / 100_000_000:.8f} BTC)")
            print(f"  - Fee: {raw_tx.get('fee', 0):,} sats")
            
            # Verify normalized transactions
            for ntx in normalized:
                print(f"  - Normalized: {ntx.direction} {ntx.quantity} BTC (fee: {ntx.fee} BTC)")
                
                # Convert to satoshis for comparison
                qty_sats = int(ntx.quantity * 100_000_000)
                
                if ntx.direction == "inflow":
                    # Inflow should match total inflow
                    assert qty_sats == total_inflow_sats, "Inflow aggregation mismatch"
                elif ntx.direction == "outflow":
                    # Outflow should be net outflow (outflow - inflow)
                    net_outflow_sats = total_outflow_sats - total_inflow_sats
                    assert qty_sats == net_outflow_sats, "Outflow aggregation mismatch"
            
            # Only test first transaction
            break

    def test_real_api_pagination(self, connector):
        """Test API pagination works correctly."""
        print(f"\n✅ Testing API pagination")
        
        # Fetch multiple pages
        transactions = []
        max_transactions = 30  # More than one page (25 per page)
        
        for tx in connector.yield_raws():
            transactions.append(tx)
            if len(transactions) >= max_transactions:
                break
        
        print(f"  - Fetched {len(transactions)} transactions across multiple pages")
        
        if len(transactions) > 25:
            print(f"  - Pagination working: fetched more than one page (25 txs/page)")
        elif len(transactions) > 0:
            print(f"  - Only {len(transactions)} transactions available (less than one page)")
        
        # Verify uniqueness (no duplicate txids from pagination)
        txids = [tx["txid"] for tx in transactions]
        unique_txids = set(txids)
        assert len(txids) == len(unique_txids), "Pagination should not return duplicate transactions"
        print(f"  - All transaction IDs are unique: ✓")

    def test_real_api_end_to_end(self, connector):
        """End-to-end test: fetch, normalize, and validate."""
        print(f"\n✅ Running end-to-end integration test")
        
        total_raw = 0
        total_normalized = 0
        total_inflows = 0
        total_outflows = 0
        
        # Process first 10 transactions
        for raw_tx in connector.yield_raws():
            total_raw += 1
            
            normalized = list(connector.raw_to_normalized(raw_tx))
            total_normalized += len(normalized)
            
            for ntx in normalized:
                if ntx.direction == "inflow":
                    total_inflows += 1
                elif ntx.direction == "outflow":
                    total_outflows += 1
            
            if total_raw >= 10:
                break
        
        print(f"  - Processed {total_raw} raw transactions")
        print(f"  - Generated {total_normalized} normalized transactions")
        print(f"    - Inflows: {total_inflows}")
        print(f"    - Outflows: {total_outflows}")
        
        assert total_normalized > 0, "Should generate at least one normalized transaction"
        assert total_normalized <= total_raw * 2, "Should not generate more than 2 normalized txs per raw tx"


if __name__ == "__main__":
    # Run tests directly
    pytest.main([__file__, "-v", "-s"])
