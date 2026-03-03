"""
Unit tests for content hash computation and data health features.

Tests:
- compute_trade_content_hash() utility function
- Content hash in connector transformations
- Duplicate detection and marking
"""
import pytest
from datetime import datetime, timedelta
from decimal import Decimal


class TestContentHashComputation:
    """Tests for the content hash utility function."""

    def test_compute_trade_content_hash_basic(self):
        """Test basic hash computation with standard values."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        hash1 = compute_trade_content_hash(
            dt=dt,
            base="BTC",
            quote="USDT",
            quantity=0.5,
            price=45000.0,
            side="buy",
        )

        assert hash1 is not None
        assert len(hash1) == 32  # MD5 hex is 32 chars
        assert hash1.isalnum()

    def test_compute_trade_content_hash_deterministic(self):
        """Test that same inputs produce same hash."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        
        hash1 = compute_trade_content_hash(
            dt=dt, base="ETH", quote="USDT", quantity=1.5, price=3000.0, side="sell"
        )
        hash2 = compute_trade_content_hash(
            dt=dt, base="ETH", quote="USDT", quantity=1.5, price=3000.0, side="sell"
        )

        assert hash1 == hash2

    def test_compute_trade_content_hash_case_normalization(self):
        """Test that symbol case is normalized."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        
        hash1 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt, base="btc", quote="usdt", quantity=1.0, price=50000.0, side="BUY"
        )

        assert hash1 == hash2

    def test_compute_trade_content_hash_decimal_precision(self):
        """Test that float precision differences are handled."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        
        # These values might have float precision issues but should hash the same
        hash1 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", quantity=0.12345678, price=45000.12345678, side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", quantity=0.123456780, price=45000.123456780, side="buy"
        )

        assert hash1 == hash2

    def test_compute_trade_content_hash_different_inputs_different_hash(self):
        """Test that different inputs produce different hashes."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        
        hash1 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="sell"  # Different side
        )
        hash3 = compute_trade_content_hash(
            dt=dt, base="ETH", quote="USDT", quantity=1.0, price=50000.0, side="buy"  # Different base
        )

        assert hash1 != hash2
        assert hash1 != hash3

    def test_compute_trade_content_hash_microseconds_ignored(self):
        """Test that microseconds are ignored for consistency (truncated to seconds)."""
        from backend.core.utils import compute_trade_content_hash

        # Two datetimes with same second but different microseconds
        dt1 = datetime(2025, 1, 15, 10, 30, 0, 100000)
        dt2 = datetime(2025, 1, 15, 10, 30, 0, 900000)
        
        hash1 = compute_trade_content_hash(
            dt=dt1, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt2, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )

        # Same second = same hash (microseconds are intentionally truncated for cross-source matching)
        assert hash1 == hash2

    def test_compute_trade_content_hash_different_seconds_differ(self):
        """Test that different seconds produce different hashes."""
        from backend.core.utils import compute_trade_content_hash

        dt1 = datetime(2025, 1, 15, 10, 30, 0)
        dt2 = datetime(2025, 1, 15, 10, 30, 1)  # One second later
        
        hash1 = compute_trade_content_hash(
            dt=dt1, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt2, base="BTC", quote="USDT", quantity=1.0, price=50000.0, side="buy"
        )

        # Different seconds = different hash
        assert hash1 != hash2

    def test_compute_trade_content_hash_with_decimal_inputs(self):
        """Test hash computation with Decimal inputs."""
        from backend.core.utils import compute_trade_content_hash

        dt = datetime(2025, 1, 15, 10, 30, 0)
        
        hash1 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", 
            quantity=Decimal("0.12345678"), 
            price=Decimal("45000.12345678"), 
            side="buy"
        )
        hash2 = compute_trade_content_hash(
            dt=dt, base="BTC", quote="USDT", 
            quantity=0.12345678, 
            price=45000.12345678, 
            side="buy"
        )

        # Should produce same hash regardless of input type
        assert hash1 == hash2


class TestConnectorFileRegistration:
    """Tests for file connector registration in the registry."""

    def test_mexc_file_connector_registered(self):
        """Test that mexc-transactions-file connector is registered."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("mexc-transactions-file")

        assert info is not None
        assert info.type == "mexc-transactions-file"
        assert info.is_file_connector is True

    def test_mexc_api_connector_not_file_connector(self):
        """Test that mexc-transactions (API) is not marked as file connector."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        info = registry.get("mexc-transactions")

        assert info is not None
        assert info.is_file_connector is False

    def test_connector_family_grouping(self):
        """Test that connectors share the same family."""
        from backend.connectors.connector_registry import get_connector_registry

        registry = get_connector_registry()
        api_info = registry.get("mexc-transactions")
        file_info = registry.get("mexc-transactions-file")

        assert api_info is not None
        assert file_info is not None
        assert api_info.connector_family == file_info.connector_family == "mexc-transactions"


# NOTE: TestDuplicateTagHelpers, TestAmountMatching, and TestTransactionSummary
# were removed — the functions they tested (_has_duplicate_tag,
# _amounts_match_within_tolerance, _tx_to_summary with content_hash) were
# removed from backend.api.routes.data_health during the duplicate-detection
# redesign.
