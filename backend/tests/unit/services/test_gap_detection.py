"""
Tests for price gap detection.

Covers:
- _is_business_day: weekday detection
- _expected_trading_days: expected date lists for crypto vs stock
- detect_gaps: full gap detection with mocked DB session
"""

import pytest
from datetime import date, datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

from backend.services.price_service import (
    _is_business_day,
    _expected_trading_days,
    detect_gaps,
    GapRange,
    GapDetectionResult,
)
from backend.db.models import Asset, PriceSnapshot


# ============================================================================
# _is_business_day
# ============================================================================


class TestIsBusinessDay:
    def test_monday(self):
        assert _is_business_day(date(2024, 1, 1)) is True   # Monday

    def test_friday(self):
        assert _is_business_day(date(2024, 1, 5)) is True   # Friday

    def test_saturday(self):
        assert _is_business_day(date(2024, 1, 6)) is False  # Saturday

    def test_sunday(self):
        assert _is_business_day(date(2024, 1, 7)) is False  # Sunday


# ============================================================================
# _expected_trading_days
# ============================================================================


class TestExpectedTradingDays:
    def test_crypto_includes_weekends(self):
        """Crypto should include every calendar day."""
        start = date(2024, 1, 1)  # Mon
        end = date(2024, 1, 7)    # Sun
        days = _expected_trading_days(start, end, is_crypto=True)
        assert len(days) == 7
        assert date(2024, 1, 6) in days  # Sat
        assert date(2024, 1, 7) in days  # Sun

    def test_stock_excludes_weekends(self):
        """Stock should skip Sat/Sun."""
        start = date(2024, 1, 1)  # Mon
        end = date(2024, 1, 7)    # Sun
        days = _expected_trading_days(start, end, is_crypto=False)
        assert len(days) == 5  # Mon-Fri
        assert date(2024, 1, 6) not in days  # Sat
        assert date(2024, 1, 7) not in days  # Sun

    def test_single_day(self):
        days = _expected_trading_days(date(2024, 1, 3), date(2024, 1, 3), is_crypto=True)
        assert len(days) == 1
        assert days[0] == date(2024, 1, 3)

    def test_empty_weekend_only_for_stock(self):
        """Sat-Sun range for stock should return empty."""
        days = _expected_trading_days(date(2024, 1, 6), date(2024, 1, 7), is_crypto=False)
        assert len(days) == 0

    def test_two_weeks_stock(self):
        """Two full weeks: 10 business days."""
        start = date(2024, 1, 1)  # Mon
        end = date(2024, 1, 12)   # Fri
        days = _expected_trading_days(start, end, is_crypto=False)
        assert len(days) == 10  # 5 + 5


# ============================================================================
# detect_gaps
# ============================================================================


def _make_mock_session(asset: Asset, existing_dates: list[date]):
    """Create a mock session that returns the given asset and snapshot dates."""
    session = MagicMock()
    session.get.return_value = asset

    # Use a counter to track calls and return appropriate results
    call_results = []

    # First call: min(snapshot_time) → not used when date_from is explicit
    # If no date_from is provided, it returns the first snapshot date
    min_date = min(existing_dates) if existing_dates else None
    min_dt = datetime.combine(min_date, datetime.min.time()) if min_date else None

    # We'll mock .exec() to return appropriate results per query.
    # The detect_gaps function makes these exec calls:
    #   1. (optional) first_dt = session.exec(select(func.min(...))).one()
    #   2. existing dates = session.exec(select(func.date(...))).all()
    #   3+ per-gap: session.exec(select(PriceSnapshot)...).first()
    exec_mock = MagicMock()

    # Build a list of results for successive .exec() calls
    results_queue = []

    # We always provide date_from/date_to explicitly in tests,
    # so the first call is the "existing dates" query → .all()
    date_rows = [(d,) for d in existing_dates]
    dates_result = MagicMock()
    dates_result.all.return_value = date_rows
    results_queue.append(dates_result)

    # For each gap, detect_gaps queries the last snapshot before the gap.
    # We'll add mock results for each potential gap query.
    # Since we don't know how many gaps there'll be, add extra None-returning mocks.
    for _ in range(20):
        no_snap = MagicMock()
        no_snap.first.return_value = None
        results_queue.append(no_snap)

    call_count = [0]
    def exec_side_effect(*args, **kwargs):
        idx = call_count[0]
        call_count[0] += 1
        if idx < len(results_queue):
            return results_queue[idx]
        r = MagicMock()
        r.first.return_value = None
        r.all.return_value = []
        return r

    session.exec.side_effect = exec_side_effect
    return session


class TestDetectGaps:

    def test_no_gaps_full_coverage_crypto(self):
        """Crypto asset with prices for every day → no gaps."""
        asset = Asset(asset_id=1, symbol="BTC", price_type="crypto")
        all_dates = [date(2024, 1, d) for d in range(1, 8)]  # 7 days
        session = _make_mock_session(asset, all_dates)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 7))

        assert result.asset_id == 1
        assert result.symbol == "BTC"
        assert result.total_expected == 7
        assert result.total_covered == 7
        assert result.coverage_pct == 100.0
        assert result.gaps == []

    def test_single_gap_crypto(self):
        """Crypto with one missing day in the middle."""
        asset = Asset(asset_id=1, symbol="BTC", price_type="crypto")
        # Missing Jan 3
        existing = [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 4), date(2024, 1, 5)]
        session = _make_mock_session(asset, existing)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 5))

        assert result.total_expected == 5
        assert result.total_covered == 4
        assert len(result.gaps) == 1
        assert result.gaps[0].start_date == "2024-01-03"
        assert result.gaps[0].end_date == "2024-01-03"
        assert result.gaps[0].missing_days_count == 1

    def test_multiple_gaps_crypto(self):
        """Crypto with two separate gap ranges."""
        asset = Asset(asset_id=1, symbol="ETH", price_type="crypto")
        # Week: Jan 1 (Mon) - Jan 10
        # Missing: Jan 3, Jan 4 (gap 1), Jan 8 (gap 2)
        existing = [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 5),
                    date(2024, 1, 6), date(2024, 1, 7), date(2024, 1, 9), date(2024, 1, 10)]
        session = _make_mock_session(asset, existing)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 10))

        assert result.total_expected == 10
        assert result.total_covered == 7
        assert len(result.gaps) == 2

        # Gap 1: Jan 3-4 (consecutive → merged)
        assert result.gaps[0].start_date == "2024-01-03"
        assert result.gaps[0].end_date == "2024-01-04"
        assert result.gaps[0].missing_days_count == 2

        # Gap 2: Jan 8
        assert result.gaps[1].start_date == "2024-01-08"
        assert result.gaps[1].end_date == "2024-01-08"
        assert result.gaps[1].missing_days_count == 1

    def test_stock_skips_weekends(self):
        """Stock asset: weekends are not expected, so missing Sat/Sun isn't a gap."""
        asset = Asset(asset_id=1, symbol="AAPL", price_type="stock")
        # Full business week Jan 1 (Mon) - Jan 5 (Fri)
        existing = [date(2024, 1, d) for d in range(1, 6)]
        session = _make_mock_session(asset, existing)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 7))

        # 5 expected business days (Mon-Fri), all covered
        assert result.total_expected == 5
        assert result.total_covered == 5
        assert result.gaps == []

    def test_stock_gap_across_weekend(self):
        """Stock: missing Fri + Mon should merge across weekend (3-day max gap jump)."""
        asset = Asset(asset_id=1, symbol="AAPL", price_type="stock")
        # Jan 1 Mon - Jan 12 Fri
        # Missing: Jan 5 (Fri) and Jan 8 (Mon) — should merge into one gap
        existing = [date(2024, 1, 1), date(2024, 1, 2), date(2024, 1, 3), date(2024, 1, 4),
                    # skip Jan 5 (Fri), skip Jan 8 (Mon)
                    date(2024, 1, 9), date(2024, 1, 10), date(2024, 1, 11), date(2024, 1, 12)]
        session = _make_mock_session(asset, existing)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 12))

        assert result.total_expected == 10  # 10 business days
        assert result.total_covered == 8
        # Fri + Mon should merge (3-day jump for stock covers weekend gap)
        assert len(result.gaps) == 1
        assert result.gaps[0].missing_days_count == 2

    def test_empty_data(self):
        """No existing snapshots → everything is a gap."""
        asset = Asset(asset_id=1, symbol="BTC", price_type="crypto")
        session = _make_mock_session(asset, [])

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 5))

        assert result.total_expected == 5
        assert result.total_covered == 0
        assert result.coverage_pct == 0.0
        assert len(result.gaps) == 1
        assert result.gaps[0].missing_days_count == 5

    def test_asset_not_found_raises(self):
        """Should raise ValueError for unknown asset ID."""
        session = MagicMock()
        session.get.return_value = None

        with pytest.raises(ValueError, match="Asset ID 999 not found"):
            detect_gaps(session, 999, date_from=date(2024, 1, 1), date_to=date(2024, 1, 5))

    def test_coverage_pct_calculation(self):
        """Coverage percentage should be correctly calculated."""
        asset = Asset(asset_id=1, symbol="BTC", price_type="crypto")
        # 3 out of 5 days present → 60%
        existing = [date(2024, 1, 1), date(2024, 1, 3), date(2024, 1, 5)]
        session = _make_mock_session(asset, existing)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 5))

        assert result.total_expected == 5
        assert result.total_covered == 3
        assert result.coverage_pct == 60.0

    def test_default_price_type_is_crypto(self):
        """If price_type is None, should default to crypto (daily)."""
        asset = Asset(asset_id=1, symbol="UNKNOWN", price_type=None)
        # Span includes a weekend: 7 days total, all present
        all_dates = [date(2024, 1, d) for d in range(1, 8)]
        session = _make_mock_session(asset, all_dates)

        result = detect_gaps(session, 1, date_from=date(2024, 1, 1), date_to=date(2024, 1, 7))

        # Default is crypto → should expect all 7 days (including weekend)
        assert result.total_expected == 7
        assert result.total_covered == 7
