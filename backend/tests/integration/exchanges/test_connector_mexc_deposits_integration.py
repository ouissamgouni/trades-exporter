"""
Integration tests for MEXC Deposits connector
Tests actual API connectivity and data fetching (requires valid credentials in settings.yaml)
"""

import pytest
from backend.connectors.cex.connector_mexc_deposits import MEXCDepositsConnector
from backend.db.models import NormalizedTransaction


@pytest.mark.integration
@pytest.mark.timeout(30)
class TestMEXCDepositsConnectorIntegration:
    """Integration tests for MEXC deposits connector."""

    def test_mexc_deposits_connector_initialization(self):
        """Test that connector initializes successfully with credentials from settings.yaml."""
        try:
            connector = MEXCDepositsConnector(currencies=["USDC"])
            
            assert connector.connector_name == "mexc_deposits"
            assert hasattr(connector, "exchange")
            # Note: exchange might be None if network/API initialization fails
            print(f"\n\u2705 MEXC deposits connector initialized (exchange: {connector.exchange is not None})")
        except Exception as e:
            # Network errors (DNS, connection timeout) are acceptable in test environments
            if "Failed to resolve" in str(e) or "NetworkError" in str(e) or "connection" in str(e).lower():
                pytest.skip(f"Network error during initialization (expected in some test environments): {e}")
            else:
                raise

    def test_mexc_deposits_connector_yield_normalized(self):
        """Test yield_normalized method returns properly formatted transactions."""
        try:
            connector = MEXCDepositsConnector(currencies=["USDC"])
        except Exception as e:
            if "Failed to resolve" in str(e) or "NetworkError" in str(e) or "connection" in str(e).lower():
                pytest.skip(f"Network error during initialization: {e}")
            else:
                raise
        
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
