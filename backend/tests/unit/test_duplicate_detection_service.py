"""
Unit tests for duplicate detection service.

Tests cover:
- Group hash computation (6 tests)
- Duplicate group detection (5 tests)
- Resolution tagging (3 tests)

Uses mocks to isolate logic from database operations.
"""

import pytest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from sqlmodel import Session

from backend.services.duplicate_detection_service import (
    compute_transaction_hash,
    detect_duplicate_groups,
    mark_duplicate_resolution,
)
from backend.db.models import NormalizedTransaction


@pytest.fixture
def mock_session():
    """Create a mock database session."""
    return MagicMock(spec=Session)


class TestComputeGroupHash:
    """Test group hash computation."""
    
    def test_identical_values_same_hash(self):
        """Identical values should produce the same hash."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        hash1 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        hash2 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        assert hash1 == hash2
        assert isinstance(hash1, str)
        assert len(hash1) == 32  # MD5 hash length
    
    def test_different_direction_different_hash(self):
        """Different directions should produce different hashes."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        hash_inflow = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        hash_outflow = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="outflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        assert hash_inflow != hash_outflow
    
    def test_case_insensitive_symbols(self):
        """Symbol case should not affect hash."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        hash1 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        hash2 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="btc",
            source_price_quote_asset_symbol="usdt",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        assert hash1 == hash2
    
    def test_microseconds_ignored(self):
        """Microsecond precision should be ignored."""
        dt1 = datetime(2024, 1, 15, 10, 30, 45, 123456, tzinfo=timezone.utc)
        dt2 = datetime(2024, 1, 15, 10, 30, 45, 999999, tzinfo=timezone.utc)
        
        hash1 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt1,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        hash2 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt2,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        assert hash1 == hash2
    
    def test_different_account_different_hash(self):
        """Different accounts should produce different hashes."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        hash1 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        hash2 = compute_transaction_hash(
            account_id=2,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        assert hash1 != hash2
    
    def test_decimal_precision_normalized(self):
        """Decimal values should be normalized to 8 decimal places."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        # These should produce the same hash due to 8-decimal normalization
        hash1 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.50000000"),
            price=Decimal("42000.00000000")
        )
        
        hash2 = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000")
        )
        
        assert hash1 == hash2


class TestDetectDuplicateGroups:
    """Test duplicate group detection using transaction_hash column."""
    
    def test_detects_exact_duplicates(self, mock_session):
        """Should detect transactions with identical transaction_hash."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        # Compute hash for test data
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        # Create two transactions with same hash (duplicates)
        tx1 = NormalizedTransaction(
            id=1,
            source="mexc_transactions_file",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="mexc_api_sync",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        
        # Mock session.exec() for two queries:
        # 1. Query for duplicate hashes (GROUP BY with HAVING COUNT > 1)
        # 2. Query for transactions with that hash
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = [(test_hash, 2)]  # hash, count
        
        mock_tx_result = MagicMock()
        mock_tx_result.all.return_value = [tx1, tx2]
        
        # Setup mock to return different results for each call
        mock_session.exec.side_effect = [mock_hash_result, mock_tx_result]
        mock_session.get.return_value = None  # No connector run
        
        # Detect duplicates with new signature
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        # Should find 1 group
        assert len(groups) == 1
        # Check group has both transactions
        assert len(groups[0].transactions) == 2
        # Verify transaction IDs
        tx_ids = [tx["id"] for tx in groups[0].transactions]
        assert 1 in tx_ids
        assert 2 in tx_ids
    
    def test_filters_out_fully_resolved_groups(self, mock_session):
        """Should not return groups where all transactions are resolved."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0")
        )
        
        # Both transactions are resolved
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=[{"type": "duplicate_resolution", "resolution": "kept", "group_hash": test_hash}],
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="source_b",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=[{"type": "duplicate_resolution", "resolution": "merged", "group_hash": test_hash}],
        )
        
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = [(test_hash, 2)]
        
        mock_tx_result = MagicMock()
        mock_tx_result.all.return_value = [tx1, tx2]
        
        mock_session.exec.side_effect = [mock_hash_result, mock_tx_result]
        mock_session.get.return_value = None
        
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        # Should return 0 groups since all transactions are resolved
        assert len(groups) == 0
    
    def test_includes_partially_resolved_groups(self, mock_session):
        """Should return groups with at least one unresolved transaction."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="SOL",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("100.0"),
            price=Decimal("50.0")
        )
        
        # tx1 is resolved, tx2 is unresolved
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="SOL",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("100.0"),
            price=Decimal("50.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=[{"type": "duplicate_resolution", "resolution": "kept", "group_hash": test_hash}],
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="source_b",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="SOL",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("100.0"),
            price=Decimal("50.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,  # Unresolved
        )
        
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = [(test_hash, 2)]
        
        mock_tx_result = MagicMock()
        mock_tx_result.all.return_value = [tx1, tx2]
        
        mock_session.exec.side_effect = [mock_hash_result, mock_tx_result]
        mock_session.get.return_value = None
        
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        # Should return 1 group with both resolved and unresolved transactions
        assert len(groups) == 1
        assert len(groups[0].transactions) == 2
        # Check resolved flag is set correctly
        resolved_count = sum(1 for tx in groups[0].transactions if tx.get("dup_resolved"))
        assert resolved_count == 1
    
    def test_no_duplicates_returns_empty(self, mock_session):
        """Should return empty list when no duplicate hashes exist."""
        # Mock no duplicate hashes found
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = []  # No hashes with count > 1
        
        mock_session.exec.return_value = mock_hash_result
        
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        assert len(groups) == 0
    
    def test_filters_by_account_id(self, mock_session):
        """Should filter results by account_id when provided."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="source_b",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="outflow",  # Different direction
            transaction_type="trade",
            source_asset_symbol="ETH",  # Different asset
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),  # Different quantity
            price=Decimal("2000.0"),
            review_status="pending",
        )
        
        mock_exec = MagicMock()
        mock_exec.all.return_value = [tx1, tx2]
        mock_session.exec.return_value = mock_exec
        
        groups = detect_duplicate_groups([1, 2], mock_session)
        
        assert len(groups) == 0
    
    def test_excludes_same_run_different_source_id(self, mock_session):
        """Should exclude transactions from same run with different source_transaction_id."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        # Two transactions from same connector run but different source IDs
        # These should NOT be considered duplicates
        tx1 = NormalizedTransaction(
            id=1,
            source="mexc_api",
            source_transaction_id="DEPOSIT_123",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            sync_connector_run_id=100,  # Same run
            tags=None,
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="mexc_api",
            source_transaction_id="DEPOSIT_456",  # Different ID
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            sync_connector_run_id=100,  # Same run
            tags=None,
        )
        
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = [(test_hash, 2)]
        
        mock_tx_result = MagicMock()
        mock_tx_result.all.return_value = [tx1, tx2]
        
        mock_session.exec.side_effect = [mock_hash_result, mock_tx_result]
        mock_session.get.return_value = None
        
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        # Should NOT find any groups (filtered out due to same run, different IDs)
        assert len(groups) == 0
    
    def test_includes_same_run_same_source_id(self, mock_session):
        """Should include transactions from same run with same source_transaction_id as duplicates."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        # Two transactions from same connector run AND same source ID
        # These SHOULD be considered duplicates (shouldn't happen, but test the logic)
        tx1 = NormalizedTransaction(
            id=1,
            source="mexc_api",
            source_transaction_id="DEPOSIT_123",  # Same ID
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            sync_connector_run_id=100,
            tags=None,
        )
        tx2 = NormalizedTransaction(
            id=2,
            source="mexc_api",
            source_transaction_id="DEPOSIT_123",  # Same ID
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="deposit",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            sync_connector_run_id=100,
            tags=None,
        )
        
        mock_hash_result = MagicMock()
        mock_hash_result.all.return_value = [(test_hash, 2)]
        
        mock_tx_result = MagicMock()
        mock_tx_result.all.return_value = [tx1, tx2]
        
        mock_session.exec.side_effect = [mock_hash_result, mock_tx_result]
        mock_session.get.return_value = None
        
        groups = detect_duplicate_groups(session=mock_session, account_id=1)
        
        # Should find 1 group (not filtered out)
        assert len(groups) == 1
        assert len(groups[0].transactions) == 2


class TestMarkDuplicateResolution:
    """Test duplicate resolution marking (Option B: Re-resolve entire group)."""
    
    def test_clears_old_resolution_tags_before_applying_new(self, mock_session):
        """Should clear all old resolution tags for the group_hash before applying new ones."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        test_hash = compute_transaction_hash(
            account_id=1,
            datetime_obj=dt,
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            direction="inflow",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0")
        )
        
        # tx1 has old resolution tag
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=[{"type": "duplicate_resolution", "resolution": "merged", "group_hash": test_hash}],
        )
        
        # tx2 has no tags
        tx2 = NormalizedTransaction(
            id=2,
            source="source_b",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        
        # Mock session.exec to return all transactions with this hash
        mock_exec = MagicMock()
        mock_exec.all.return_value = [tx1, tx2]
        mock_session.exec.return_value = mock_exec
        
        # Mock session.get to return specific transactions
        def get_side_effect(model, tx_id):
            if tx_id == 1:
                return tx1
            elif tx_id == 2:
                return tx2
            return None
        
        mock_session.get.side_effect = get_side_effect
        
        # Mark tx1 as kept, tx2 as merged (opposite of old state)
        mark_duplicate_resolution(
            group_hash=test_hash,
            kept_tx_ids=[1],
            merged_tx_ids=[2],
            dismissed_tx_ids=[],
            session=mock_session,
        )
        
        # Verify old tags were cleared and new tags applied
        # tx1 should now have "kept" tag (old "merged" tag cleared)
        resolution_tags_tx1 = [tag for tag in tx1.tags if tag.get("type") == "duplicate_resolution"]
        assert len(resolution_tags_tx1) == 1
        assert resolution_tags_tx1[0]["resolution"] == "kept"
        
        # tx2 should now have "merged" tag
        resolution_tags_tx2 = [tag for tag in tx2.tags if tag.get("type") == "duplicate_resolution"]
        assert len(resolution_tags_tx2) == 1
        assert resolution_tags_tx2[0]["resolution"] == "merged"
    
    def test_marks_kept_merged_dismissed(self, mock_session):
        """Should correctly mark kept, merged, and dismissed transactions."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        test_hash = "test_hash_abc123"
        
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        
        tx2 = NormalizedTransaction(
            id=2,
            source="source_b",
            source_transaction_id="TX2",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        
        tx3 = NormalizedTransaction(
            id=3,
            source="source_c",
            source_transaction_id="TX3",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"),
            price=Decimal("2000.0"),
            review_status="pending",
            transaction_hash=test_hash,
            tags=None,
        )
        
        # Mock session.exec for clearing old tags
        mock_exec = MagicMock()
        mock_exec.all.return_value = [tx1, tx2, tx3]
        mock_session.exec.return_value = mock_exec
        
        # Mock session.get to return specific transactions
        def get_side_effect(model, tx_id):
            if tx_id == 1:
                return tx1
            elif tx_id == 2:
                return tx2
            elif tx_id == 3:
                return tx3
            return None
        
        mock_session.get.side_effect = get_side_effect
        
        # Mark tx1 as kept, tx2 as merged, tx3 as dismissed
        mark_duplicate_resolution(
            group_hash=test_hash,
            kept_tx_ids=[1],
            merged_tx_ids=[2],
            dismissed_tx_ids=[3],
            session=mock_session,
        )
        
        # Verify tx1 is marked as kept
        kept_tags = [tag for tag in tx1.tags if tag.get("type") == "duplicate_resolution"]
        assert len(kept_tags) == 1
        assert kept_tags[0]["resolution"] == "kept"
        
        # Verify tx2 is marked as merged with reference to kept tx
        merged_tags = [tag for tag in tx2.tags if tag.get("type") == "duplicate_resolution"]
        assert len(merged_tags) == 1
        assert merged_tags[0]["resolution"] == "merged"
        assert 1 in merged_tags[0]["kept_tx_ids"]
        
        # Verify tx3 is marked as dismissed
        dismissed_tags = [tag for tag in tx3.tags if tag.get("type") == "duplicate_resolution"]
        assert len(dismissed_tags) == 1
        assert dismissed_tags[0]["resolution"] == "dismissed"
        
        # Verify commit was called
        mock_session.commit.assert_called_once()
    
    def test_marks_dismissed_transaction(self, mock_session):
        """Should mark transaction as dismissed."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            tags=[{"type": "potential_duplicate", "group_hash": "test_hash_456"}],
        )
        
        mock_session.get.return_value = tx1
        
        # Dismiss tx1
        mark_duplicate_resolution(
            group_hash="test_hash_456",
            kept_tx_ids=[],
            merged_tx_ids=[],
            dismissed_tx_ids=[1],
            session=mock_session,
        )
        
        mock_session.get.assert_called_once_with(NormalizedTransaction, 1)
        mock_session.add.assert_called_once_with(tx1)
        mock_session.commit.assert_called_once()
        
        # Check tx1 has dismissed tag
        resolution_tags = [tag for tag in tx1.tags if tag.get("type") == "duplicate_resolution"]
        assert len(resolution_tags) == 1
        assert resolution_tags[0]["status"] == "dismissed"
        assert resolution_tags[0]["group_hash"] == "test_hash_456"
    
    def test_preserves_existing_tags(self, mock_session):
        """Should preserve non-duplicate tags when adding resolution tag."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)
        
        existing_tag = {"type": "custom_tag", "data": {"note": "important"}}
        
        tx1 = NormalizedTransaction(
            id=1,
            source="source_a",
            source_transaction_id="TX1",
            account_id=1,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_asset_symbol="BTC",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"),
            price=Decimal("42000.0"),
            review_status="pending",
            tags=[
                {"type": "potential_duplicate", "group_hash": "test_hash_789"},
                existing_tag
            ],
        )
        
        mock_session.get.return_value = tx1
        
        # Mark as kept
        mark_duplicate_resolution(
            group_hash="test_hash_789",
            kept_tx_ids=[1],
            merged_tx_ids=[],
            dismissed_tx_ids=[],
            session=mock_session,
        )
        
        mock_session.get.assert_called_once_with(NormalizedTransaction, 1)
        mock_session.add.assert_called_once_with(tx1)
        mock_session.commit.assert_called_once()
        
        # Check tags: potential_duplicate tag is removed by design, custom tag is preserved
        assert len(tx1.tags) == 2  # custom_tag + resolution (potential_duplicate removed)
        
        # Find each tag type
        custom_tags = [tag for tag in tx1.tags if tag.get("type") == "custom_tag"]
        assert len(custom_tags) == 1
        assert custom_tags[0]["data"]["note"] == "important"
        
        # potential_duplicate tag should be removed after resolution
        potential_dup_tags = [tag for tag in tx1.tags if tag.get("type") == "potential_duplicate"]
        assert len(potential_dup_tags) == 0
        
        resolution_tags = [tag for tag in tx1.tags if tag.get("type") == "duplicate_resolution"]
        assert len(resolution_tags) == 1
        assert resolution_tags[0]["status"] == "kept"
