"""
Integration tests for MEXC Withdrawals connector
Tests actual API connectivity and data fetching (requires valid credentials in settings.yaml)
"""

import pytest
from backend.connectors.cex.connector_mexc_withdrawals import MEXCWithdrawalsConnector
from backend.db.models import NormalizedTransaction


@pytest.mark.integration
class TestMEXCWithdrawalsConnectorIntegration:
    """Integration tests for MEXC withdrawals connector."""

    def test_mexc_withdrawals_connector_initialization(self):
        """Test that connector initializes successfully with credentials from settings.yaml."""
        connector = MEXCWithdrawalsConnector(currencies=["USDC"])
        
        assert connector.connector_name == "mexc_withdrawals"
        assert hasattr(connector, "exchange")
        assert connector.exchange is not None

    def test_mexc_withdrawals_connector_yield_normalized(self):
        """Test yield_normalized method returns properly formatted transactions."""
        connector = MEXCWithdrawalsConnector(currencies=["USDC"])
        
        results = []
        errors = []
        
        # Limit iterations to avoid long test runs
        for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
            if idx >= 5:  # Test first 5 results only
                break
                
            if error:
                errors.append(error)
            else:
                results.append(mapped_item)
                
                # Validate structure
                assert isinstance(mapped_item, NormalizedTransaction)
                assert mapped_item.source == "mexc-withdrawals"
                assert mapped_item.direction == "outflow"
                assert mapped_item.transaction_type == "transfer"
                assert mapped_item.source_transaction_type == "withdrawal"
                assert mapped_item.source_asset_symbol is not None
                assert mapped_item.quantity > 0
        
        # Should either have results or no withdrawals (not an error condition)
        # MEXC may return empty list if no withdrawals exist
        print(f"\n✅ Processed {len(results)} withdrawals, {len(errors)} errors")
        
        if results:
            # If we have results, validate first one
            first = results[0]
            print(f"Sample withdrawal: {first.source_asset_symbol} x{first.quantity}")
            assert first.source_transaction_id is not None
            assert first.date_time is not None

    def test_mexc_withdrawals_connector_get_raws(self):
        """Test get_raws method returns raw withdrawal data."""
        connector = MEXCWithdrawalsConnector(currencies=["USDC"])
        
        raws = connector.get_raws()
        
        # Should return a list (may be empty if no withdrawals)
        assert isinstance(raws, list)
        
        print(f"\n✅ Fetched {len(raws)} raw withdrawals from MEXC")
        
        if raws:
            # Validate raw structure has expected CCXT fields
            first = raws[0]
            assert "id" in first
            assert "currency" in first or "info" in first
            assert "status" in first
            print(f"Sample raw: {first.get('currency', 'N/A')} - Status: {first.get('status')}")

    def test_mexc_withdrawals_connector_raw_to_normalized(self):
        """Test raw_to_normalized with actual API data."""
        connector = MEXCWithdrawalsConnector(currencies=["USDC"])
        
        raws = connector.get_raws()
        
        if not raws:
            pytest.skip("No withdrawals available to test normalization")
        
        # Find first withdrawal with 'ok' status
        ok_withdrawal = None
        for raw in raws:
            if raw.get("status") == "ok":
                ok_withdrawal = raw
                break
        
        if not ok_withdrawal:
            pytest.skip("No completed withdrawals available to test normalization")
        
        # Test normalization
        normalized = connector.raw_to_normalized(ok_withdrawal)
        
        assert isinstance(normalized, NormalizedTransaction)
        assert normalized.source == "mexc-withdrawals"
        assert normalized.direction == "outflow"
        assert normalized.quantity > 0
        print(f"\n✅ Normalized: {normalized.source_asset_symbol} x{normalized.quantity}")
