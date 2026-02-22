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


class TestDuplicateTagHelpers:
    """Tests for duplicate tag helper functions."""

    def test_has_duplicate_tag_empty(self):
        """Test that empty tags returns False."""
        from backend.api.routes.data_health import _has_duplicate_tag

        assert _has_duplicate_tag(None) is False
        assert _has_duplicate_tag([]) is False

    def test_has_duplicate_tag_with_duplicate(self):
        """Test detection of duplicate tag."""
        from backend.api.routes.data_health import _has_duplicate_tag

        tags = [{"type": "duplicate", "canonical_id": "123"}]
        assert _has_duplicate_tag(tags) is True

    def test_has_duplicate_tag_with_other_tags(self):
        """Test that other tags don't trigger duplicate detection."""
        from backend.api.routes.data_health import _has_duplicate_tag

        tags = [{"type": "manual", "reason": "corrected"}]
        assert _has_duplicate_tag(tags) is False

    def test_has_duplicate_tag_mixed_tags(self):
        """Test duplicate detection with mixed tags."""
        from backend.api.routes.data_health import _has_duplicate_tag

        tags = [
            {"type": "manual", "reason": "corrected"},
            {"type": "duplicate", "canonical_id": "456"},
        ]
        assert _has_duplicate_tag(tags) is True


class TestAmountMatching:
    """Tests for amount tolerance matching."""

    def test_amounts_match_exact(self):
        """Test exact amount matching."""
        from backend.api.routes.data_health import _amounts_match_within_tolerance

        result = _amounts_match_within_tolerance(
            qty_a=1.0, qty_b=1.0, total_a=100.0, total_b=100.0, tolerance_percent=1.0
        )
        assert result is True

    def test_amounts_match_within_tolerance(self):
        """Test amounts match within tolerance."""
        from backend.api.routes.data_health import _amounts_match_within_tolerance

        # 1% difference on quantity
        result = _amounts_match_within_tolerance(
            qty_a=1.0, qty_b=1.005, total_a=None, total_b=None, tolerance_percent=1.0
        )
        assert result is True

    def test_amounts_no_match_outside_tolerance(self):
        """Test amounts don't match outside tolerance."""
        from backend.api.routes.data_health import _amounts_match_within_tolerance

        # 5% difference on quantity but only 1% tolerance
        result = _amounts_match_within_tolerance(
            qty_a=1.0, qty_b=1.05, total_a=None, total_b=None, tolerance_percent=1.0
        )
        assert result is False

    def test_amounts_match_via_total_fallback(self):
        """Test that total is checked if quantity doesn't match."""
        from backend.api.routes.data_health import _amounts_match_within_tolerance

        # Quantity doesn't match but total does
        result = _amounts_match_within_tolerance(
            qty_a=1.0, qty_b=2.0, total_a=100.0, total_b=100.5, tolerance_percent=1.0
        )
        assert result is True

    def test_amounts_zero_handling(self):
        """Test handling of zero amounts."""
        from backend.api.routes.data_health import _amounts_match_within_tolerance

        result = _amounts_match_within_tolerance(
            qty_a=0.0, qty_b=0.0, total_a=None, total_b=None, tolerance_percent=1.0
        )
        assert result is False  # Zero quantities don't match


class TestTransactionSummary:
    """Tests for transaction summary conversion."""

    def test_tx_to_summary_basic(self):
        """Test basic transaction to summary conversion."""
        from backend.api.routes.data_health import _tx_to_summary, TransactionSummary
        from backend.db.models import NormalizedTransaction

        tx = NormalizedTransaction(
            id=123,
            source="mexc-transactions",
            source_transaction_id="abc123",
            date_time=datetime(2025, 1, 15, 10, 30, 0),
            source_asset_symbol="BTC",
            quantity=Decimal("1.5"),
            price=Decimal("50000.0"),
            total=Decimal("75000.0"),
            source_transaction_type="buy",
            source_price_quote_asset_symbol="USDT",
            account_id=1,
            content_hash="abcdef123456",
            review_status="pending",
        )

        summary = _tx_to_summary(tx)

        assert isinstance(summary, TransactionSummary)
        assert summary.id == 123
        assert summary.source == "mexc-transactions"
        assert summary.source_asset_symbol == "BTC"
        assert summary.quantity == 1.5
        assert summary.content_hash == "abcdef123456"
