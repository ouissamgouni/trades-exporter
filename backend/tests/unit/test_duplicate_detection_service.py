"""
Unit tests for duplicate detection service.

Tests cover:
- Legacy transaction hash computation (6 tests)
- Deterministic group hash (4 tests)
- Union-find transitive clustering (4 tests)
- Helper tag inspection functions (6 tests)
- Fuzzy duplicate group detection (7 tests)
- Resolution tagging with sys_* format (4 tests)

Uses mocks to isolate logic from database operations.
"""

import pytest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from unittest.mock import MagicMock, patch

from sqlmodel import Session

from backend.services.duplicate_detection_service import (
    compute_transaction_hash,
    compute_group_hash,
    detect_duplicate_groups,
    detect_duplicate_suspicions,
    mark_duplicate_resolution,
    _UnionFind,
    _transaction_has_resolution_tag,
    _transaction_has_any_resolution,
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


class TestComputeGroupHash2:
    """Test compute_group_hash (deterministic hash from sorted TX IDs)."""

    def test_deterministic(self):
        """Same IDs should always produce the same hash."""
        h1 = compute_group_hash([1, 2, 3])
        h2 = compute_group_hash([1, 2, 3])
        assert h1 == h2

    def test_order_independent(self):
        """Input order should not affect the hash."""
        h1 = compute_group_hash([3, 1, 2])
        h2 = compute_group_hash([1, 2, 3])
        assert h1 == h2

    def test_different_ids_different_hash(self):
        """Different membership should produce a different hash."""
        h1 = compute_group_hash([1, 2])
        h2 = compute_group_hash([1, 3])
        assert h1 != h2

    def test_md5_length(self):
        """Should produce a 32-character hex string."""
        h = compute_group_hash([10, 20])
        assert len(h) == 32
        assert all(c in "0123456789abcdef" for c in h)


class TestUnionFind:
    """Test _UnionFind for transitive clustering of fuzzy pairs."""

    def test_basic_union(self):
        uf = _UnionFind()
        uf.union(1, 2)
        groups = uf.groups()
        assert len(groups) == 1
        members = list(groups.values())[0]
        assert set(members) == {1, 2}

    def test_transitive_closure(self):
        """union(1,2) + union(2,3) ⇒ single group {1,2,3}."""
        uf = _UnionFind()
        uf.union(1, 2)
        uf.union(2, 3)
        groups = uf.groups()
        assert len(groups) == 1
        members = list(groups.values())[0]
        assert set(members) == {1, 2, 3}

    def test_separate_groups(self):
        uf = _UnionFind()
        uf.union(1, 2)
        uf.union(3, 4)
        groups = uf.groups()
        assert len(groups) == 2

    def test_find_creates_element(self):
        uf = _UnionFind()
        root = uf.find(42)
        assert root == 42


class TestHelperFunctions:
    """Test tag inspection helper functions."""

    def test_has_resolution_tag_true(self):
        tags = [{"sys_group": "abc123"}, {"sys_resolution": "kept"}]
        assert _transaction_has_resolution_tag(tags, "abc123") is True

    def test_has_resolution_tag_wrong_hash(self):
        tags = [{"sys_group": "other_hash"}]
        assert _transaction_has_resolution_tag(tags, "abc123") is False

    def test_has_resolution_tag_none(self):
        assert _transaction_has_resolution_tag(None, "abc123") is False

    def test_has_any_resolution_true(self):
        tags = [{"sys_resolution": "kept"}]
        assert _transaction_has_any_resolution(tags) is True

    def test_has_any_resolution_false(self):
        tags = [{"type": "other"}]
        assert _transaction_has_any_resolution(tags) is False

    def test_has_any_resolution_none(self):
        assert _transaction_has_any_resolution(None) is False


def _make_mock_tx(**kwargs):
    """Create a MagicMock transaction with sensible defaults for detect tests."""
    tx = MagicMock()
    defaults = {
        "id": 1,
        "source": "test_source",
        "source_transaction_id": "TX1",
        "source_transaction_type": None,
        "account_id": 1,
        "date_time": datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc),
        "direction": "inflow",
        "transaction_type": "deposit",
        "source_asset_symbol": "BTC",
        "source_price_quote_asset_symbol": "USDT",
        "quantity": Decimal("0.5"),
        "price": Decimal("42000.0"),
        "total": None,
        "review_status": "pending",
        "transaction_hash": None,
        "tags": None,
        "sync_connector_run_id": None,
        "synced_at": None,
        "created_at": None,
        "asset": None,
        "price_quote_asset": None,
        "fee_quote_asset": None,
    }
    defaults.update(kwargs)
    for key, val in defaults.items():
        setattr(tx, key, val)
    return tx


def _no_pairs():
    result = MagicMock()
    result.all.return_value = []
    return result


class TestDetectDuplicateGroups:
    """Test fuzzy duplicate group detection via SQL self-join + union-find."""

    def test_detects_same_onchain_tx_from_two_providers(self, mock_session):
        """Same tx hash/contract/direction from two sources groups even when symbols differ."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)
        tx1 = _make_mock_tx(id=1, source="blockscout_polygon_normal_tx", source_asset_symbol="MATIC", date_time=dt)
        tx2 = _make_mock_tx(id=2, source="ankr_polygon", source_asset_symbol="POL", date_time=dt)

        onchain_pairs = MagicMock()
        onchain_pairs.all.return_value = [(1, 2)]
        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]
        mock_session.exec.side_effect = [_no_pairs(), onchain_pairs, mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 1
        assert {tx["id"] for tx in groups[0].transactions} == {1, 2}
        onchain_sql = str(mock_session.exec.call_args_list[1].args[0])
        assert "network_transaction_id" in onchain_sql
        assert "token_contract_address" in onchain_sql
        assert "t1.source != t2.source" in onchain_sql

    def test_detects_fuzzy_duplicates(self, mock_session):
        """Should detect transactions matched by fuzzy self-join pairs."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)

        tx1 = _make_mock_tx(id=1, source="source_a", source_transaction_id="TX1", date_time=dt)
        tx2 = _make_mock_tx(id=2, source="source_b", source_transaction_id="TX2", date_time=dt)

        # First exec → fuzzy pairs, second exec → transaction objects
        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 1
        assert len(groups[0].transactions) == 2
        tx_ids = [tx["id"] for tx in groups[0].transactions]
        assert 1 in tx_ids
        assert 2 in tx_ids
        assert groups[0].match_type == "fuzzy"

    def test_filters_out_fully_resolved_groups(self, mock_session):
        """Should skip groups where all transactions carry sys_group tag."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)

        group_hash = compute_group_hash([1, 2])

        tx1 = _make_mock_tx(
            id=1, source="source_a", source_transaction_id="TX1", date_time=dt,
            tags=[{"sys_group": group_hash, "sys_resolution": "kept"}],
        )
        tx2 = _make_mock_tx(
            id=2, source="source_b", source_transaction_id="TX2", date_time=dt,
            tags=[{"sys_group": group_hash, "sys_resolution": "merged"}],
        )

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 0

    def test_includes_partially_resolved_groups(self, mock_session):
        """Should return groups with at least one unresolved transaction."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)

        group_hash = compute_group_hash([1, 2])

        tx1 = _make_mock_tx(
            id=1, source="source_a", source_transaction_id="TX1", date_time=dt,
            tags=[{"sys_group": group_hash, "sys_resolution": "kept"}],
        )
        tx2 = _make_mock_tx(
            id=2, source="source_b", source_transaction_id="TX2", date_time=dt,
            tags=None,
        )

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 1
        assert len(groups[0].transactions) == 2
        resolved_count = sum(1 for tx in groups[0].transactions if tx.get("dup_resolved"))
        assert resolved_count == 1

    def test_no_duplicates_returns_empty(self, mock_session):
        """Should return empty list when self-join finds no pairs."""
        mock_pairs = MagicMock()
        mock_pairs.all.return_value = []

        mock_session.exec.return_value = mock_pairs

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 0

    def test_filters_by_account_id(self, mock_session):
        """Should accept account_id filter and pass it to query."""
        mock_pairs = MagicMock()
        mock_pairs.all.return_value = []

        mock_session.exec.return_value = mock_pairs

        groups = detect_duplicate_groups(session=mock_session, account_id=42)

        assert len(groups) == 0
        assert mock_session.exec.call_count == 2  # fuzzy + on-chain pair queries

    def test_excludes_same_run_different_source_id(self, mock_session):
        """Should exclude same-run transactions with different source_transaction_id."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)

        tx1 = _make_mock_tx(
            id=1, source="mexc_api", source_transaction_id="DEPOSIT_123",
            date_time=dt, sync_connector_run_id=100,
        )
        tx2 = _make_mock_tx(
            id=2, source="mexc_api", source_transaction_id="DEPOSIT_456",
            date_time=dt, sync_connector_run_id=100,
        )

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 0

    def test_includes_same_run_same_source_id(self, mock_session):
        """Should keep same-run transactions when source_transaction_id matches."""
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)

        tx1 = _make_mock_tx(
            id=1, source="mexc_api", source_transaction_id="DEPOSIT_123",
            date_time=dt, sync_connector_run_id=100,
        )
        tx2 = _make_mock_tx(
            id=2, source="mexc_api", source_transaction_id="DEPOSIT_123",
            date_time=dt, sync_connector_run_id=100,
        )

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 1
        assert len(groups[0].transactions) == 2

    def test_includes_cross_run_different_source_id(self, mock_session):
        """Should keep transactions from different runs even with different source IDs.

        Regression test: previously _filter_same_run_different_id_transactions
        would incorrectly exclude single-transaction-per-run buckets because
        len([one_id]) == len(set([one_id])) is trivially True.
        """
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)

        tx1 = _make_mock_tx(
            id=1, source="okx-file", source_transaction_id="10018451232",
            date_time=dt, sync_connector_run_id=1384,
        )
        tx2 = _make_mock_tx(
            id=2, source="okx-withdrawals", source_transaction_id="1000487221",
            date_time=dt, sync_connector_run_id=1498,
        )

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        groups = detect_duplicate_groups(session=mock_session, account_id=1)

        assert len(groups) == 1
        assert len(groups[0].transactions) == 2
        tx_ids = [tx["id"] for tx in groups[0].transactions]
        assert 1 in tx_ids
        assert 2 in tx_ids


class TestDetectDuplicateSuspicions:
    """Test lightweight suspicion wrapper."""

    def test_returns_lightweight_format(self, mock_session):
        """Should return only group_hash, transaction_ids, match_criteria."""
        dt = datetime(2024, 1, 15, 10, 30, 45, tzinfo=timezone.utc)

        tx1 = _make_mock_tx(id=1, date_time=dt)
        tx2 = _make_mock_tx(id=2, source="source_b", source_transaction_id="TX2", date_time=dt)

        mock_pairs = MagicMock()
        mock_pairs.all.return_value = [(1, 2)]

        mock_txs = MagicMock()
        mock_txs.all.return_value = [tx1, tx2]

        mock_session.exec.side_effect = [mock_pairs, _no_pairs(), mock_txs]
        mock_session.get.return_value = None

        suspicions = detect_duplicate_suspicions(session=mock_session, account_id=1)

        assert len(suspicions) == 1
        s = suspicions[0]
        assert "group_hash" in s
        assert "transaction_ids" in s
        assert "match_criteria" in s
        assert set(s["transaction_ids"]) == {1, 2}


class TestMarkDuplicateResolution:
    """Test resolution tagging with sys_* tag format."""

    def test_clears_old_resolution_tags_before_applying_new(self, mock_session):
        """Should remove old sys_group tags for the hash, then apply new ones."""
        group_hash = "test_hash_abc123"

        tx1 = NormalizedTransaction(
            id=1, source="source_a", source_transaction_id="TX1",
            account_id=1,
            date_time=datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
            direction="inflow", transaction_type="trade",
            source_asset_symbol="BTC", source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"), price=Decimal("42000.0"),
            review_status="pending",
            tags=[
                {"sys_group": group_hash, "sys_resolution": "merged", "sys_resolved_at": "2024-01-01T00:00:00"},
            ],
        )

        tx2 = NormalizedTransaction(
            id=2, source="source_b", source_transaction_id="TX2",
            account_id=1,
            date_time=datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
            direction="inflow", transaction_type="trade",
            source_asset_symbol="BTC", source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"), price=Decimal("42000.0"),
            review_status="pending",
            tags=None,
        )

        def get_side_effect(model, obj_id):
            if model == NormalizedTransaction:
                return {1: tx1, 2: tx2}.get(obj_id)
            return None

        mock_session.get.side_effect = get_side_effect

        mark_duplicate_resolution(
            group_hash=group_hash,
            kept_tx_ids=[1],
            merged_tx_ids=[2],
            dismissed_tx_ids=[],
            session=mock_session,
        )

        # tx1: old "merged" cleared → new "kept" (combined tag)
        group_tags_tx1 = [tag for tag in tx1.tags if tag.get("sys_group") == group_hash]
        assert len(group_tags_tx1) == 1
        assert group_tags_tx1[0]["sys_resolution"] == "kept"
        assert "sys_resolved_at" in group_tags_tx1[0]

        # tx2: new "merged" (combined tag)
        group_tags_tx2 = [tag for tag in tx2.tags if tag.get("sys_group") == group_hash]
        assert len(group_tags_tx2) == 1
        assert group_tags_tx2[0]["sys_resolution"] == "merged"

    def test_marks_kept_merged_dismissed(self, mock_session):
        """Should correctly apply kept / merged / dismissed sys_resolution tags."""
        group_hash = "test_hash_abc123"
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc)

        tx1 = NormalizedTransaction(
            id=1, source="source_a", source_transaction_id="TX1",
            account_id=1, date_time=dt, direction="inflow",
            transaction_type="trade", source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"), price=Decimal("2000.0"),
            review_status="pending", tags=None,
        )
        tx2 = NormalizedTransaction(
            id=2, source="source_b", source_transaction_id="TX2",
            account_id=1, date_time=dt, direction="inflow",
            transaction_type="trade", source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"), price=Decimal("2000.0"),
            review_status="pending", tags=None,
        )
        tx3 = NormalizedTransaction(
            id=3, source="source_c", source_transaction_id="TX3",
            account_id=1, date_time=dt, direction="inflow",
            transaction_type="trade", source_asset_symbol="ETH",
            source_price_quote_asset_symbol="USDT",
            quantity=Decimal("1.0"), price=Decimal("2000.0"),
            review_status="pending", tags=None,
        )

        def get_side_effect(model, obj_id):
            if model == NormalizedTransaction:
                return {1: tx1, 2: tx2, 3: tx3}.get(obj_id)
            return None

        mock_session.get.side_effect = get_side_effect

        mark_duplicate_resolution(
            group_hash=group_hash,
            kept_tx_ids=[1],
            merged_tx_ids=[2],
            dismissed_tx_ids=[3],
            session=mock_session,
        )

        # tx1 → combined tag with kept + group
        group_tags_tx1 = [t for t in tx1.tags if t.get("sys_group") == group_hash]
        assert len(group_tags_tx1) == 1
        assert group_tags_tx1[0]["sys_resolution"] == "kept"

        # tx2 → combined tag with merged + sys_kept_ids
        group_tags_tx2 = [t for t in tx2.tags if t.get("sys_group") == group_hash]
        assert len(group_tags_tx2) == 1
        assert group_tags_tx2[0]["sys_resolution"] == "merged"
        assert "1" in group_tags_tx2[0]["sys_kept_ids"]

        # tx3 → combined tag with dismissed
        group_tags_tx3 = [t for t in tx3.tags if t.get("sys_group") == group_hash]
        assert len(group_tags_tx3) == 1
        assert group_tags_tx3[0]["sys_resolution"] == "dismissed"

        mock_session.commit.assert_called_once()

    def test_marks_dismissed_transaction(self, mock_session):
        """Should mark a single transaction as dismissed."""
        group_hash = "test_hash_456"

        tx1 = NormalizedTransaction(
            id=1, source="source_a", source_transaction_id="TX1",
            account_id=1,
            date_time=datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
            direction="inflow", transaction_type="trade",
            source_asset_symbol="BTC", source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"), price=Decimal("42000.0"),
            review_status="pending",
            tags=[{"type": "potential_duplicate", "group_hash": group_hash}],
        )

        def get_side_effect(model, obj_id):
            if model == NormalizedTransaction:
                if obj_id == 1:
                    return tx1
            return None

        mock_session.get.side_effect = get_side_effect

        mark_duplicate_resolution(
            group_hash=group_hash,
            kept_tx_ids=[],
            merged_tx_ids=[],
            dismissed_tx_ids=[1],
            session=mock_session,
        )

        mock_session.add.assert_called_once_with(tx1)
        mock_session.commit.assert_called_once()

        # Check combined dismissed tag
        group_tags = [t for t in tx1.tags if t.get("sys_group") == group_hash]
        assert len(group_tags) == 1
        assert group_tags[0]["sys_resolution"] == "dismissed"

    def test_preserves_existing_tags(self, mock_session):
        """Should keep non-duplicate tags intact while adding resolution tags."""
        group_hash = "test_hash_789"
        existing_tag = {"type": "custom_tag", "data": {"note": "important"}}

        tx1 = NormalizedTransaction(
            id=1, source="source_a", source_transaction_id="TX1",
            account_id=1,
            date_time=datetime(2024, 1, 15, 10, 30, 0, tzinfo=timezone.utc),
            direction="inflow", transaction_type="trade",
            source_asset_symbol="BTC", source_price_quote_asset_symbol="USDT",
            quantity=Decimal("0.5"), price=Decimal("42000.0"),
            review_status="pending",
            tags=[existing_tag],
        )

        def get_side_effect(model, obj_id):
            if model == NormalizedTransaction:
                if obj_id == 1:
                    return tx1
            return None

        mock_session.get.side_effect = get_side_effect

        mark_duplicate_resolution(
            group_hash=group_hash,
            kept_tx_ids=[1],
            merged_tx_ids=[],
            dismissed_tx_ids=[],
            session=mock_session,
        )

        mock_session.add.assert_called_once_with(tx1)
        mock_session.commit.assert_called_once()

        # custom_tag preserved
        custom_tags = [t for t in tx1.tags if t.get("type") == "custom_tag"]
        assert len(custom_tags) == 1
        assert custom_tags[0]["data"]["note"] == "important"

        # Combined resolution tag present
        group_tags = [t for t in tx1.tags if t.get("sys_group") == group_hash]
        assert len(group_tags) == 1
        assert group_tags[0]["sys_resolution"] == "kept"
