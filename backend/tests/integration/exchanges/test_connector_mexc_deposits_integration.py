"""
Integration tests for MEXC Deposits connector
Tests actual API connectivity and data fetching (requires valid credentials in settings.yaml)
"""

import pytest
from backend.connectors.cex.connector_mexc_deposits import MEXCDepositsConnector
from backend.db.models import NormalizedTransaction


@pytest.mark.integration
class TestMEXCDepositsConnectorIntegration:
    """Integration tests for MEXC deposits connector."""

    def test_mexc_deposits_connector_initialization(self):
        """Test that connector initializes successfully with credentials from settings.yaml."""
        connector = MEXCDepositsConnector(currencies=["USDC"])
        
        assert connector.connector_name == "mexc_deposits"
        assert hasattr(connector, "exchange")
        assert connector.exchange is not None

    def test_mexc_deposits_connector_yield_normalized(self):
        """Test yield_normalized method returns properly formatted transactions."""
        connector = MEXCDepositsConnector(currencies=["USDC"])
        
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
                assert mapped_item.source == "mexc-deposits"
                assert mapped_item.direction == "inflow"
                assert mapped_item.transaction_type == "transfer"
                assert mapped_item.source_transaction_type == "deposit"
                assert mapped_item.source_asset_symbol is not None
                assert mapped_item.quantity > 0
        
        # Should either have results or no deposits (not an error condition)
        # MEXC may return empty list if no deposits exist
        print(f"\n✅ Processed {len(results)} deposits, {len(errors)} errors")
        
        if results:
            # If we have results, validate first one
            first = results[0]
            print(f"Sample deposit: {first.source_asset_symbol} x{first.quantity}")
            assert first.source_transaction_id is not None
            assert first.date_time is not None

    def test_mexc_deposits_connector_get_raws(self):
        """Test get_raws method returns raw deposit data."""
        connector = MEXCDepositsConnector(currencies=["USDC"])
        
        raws = connector.get_raws()
        
        # Should return a list (may be empty if no deposits)
        assert isinstance(raws, list)
        
        print(f"\n✅ Fetched {len(raws)} raw deposits from MEXC")
        
        if raws:
            # Validate raw structure has expected CCXT fields
            first = raws[0]
            assert "id" in first
            assert "currency" in first
            assert "status" in first
            print(f"Sample raw: {first.get('currency', 'N/A')} - Status: {first.get('status')}")

    def test_mexc_deposits_connector_raw_to_normalized(self):
        """Test raw_to_normalized with actual API data."""
        connector = MEXCDepositsConnector(currencies=["USDC"])
        
        raws = connector.get_raws()
        
        if not raws:
            pytest.skip("No deposits available to test normalization")
        
        # Find first deposit with 'ok' status
        ok_deposit = None
        for raw in raws:
            if raw.get("status") == "ok":
                ok_deposit = raw
                break
        
        if not ok_deposit:
            pytest.skip("No completed deposits available to test normalization")
        
        # Test normalization
        normalized = connector.raw_to_normalized(ok_deposit)
        
        assert isinstance(normalized, NormalizedTransaction)
        assert normalized.source == "mexc-deposits"
        assert normalized.direction == "inflow"
        assert normalized.quantity > 0
        print(f"\n✅ Normalized: {normalized.source_asset_symbol} x{normalized.quantity}")
