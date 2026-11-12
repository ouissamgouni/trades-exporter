"""
Unit tests for PersistenceStage update detection.

Covers the three root causes of spurious updates:
1. date_time timezone-naive vs timezone-aware comparison
2. User-editable fields (review_status, include_fee, taxability_status) not triggering updates
3. Float/Decimal tolerance-based comparison
"""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from backend.db.models import NormalizedTransaction
from backend.services.pipeline.stages.persistence import (
    UPDATABLE_FIELDS,
    FLOAT_FIELDS,
    DATETIME_FIELDS,
    PersistenceStage,
)


def _make_tx(**overrides) -> NormalizedTransaction:
    """Helper: create a NormalizedTransaction with sensible defaults."""
    defaults = dict(
        source="test",
        source_transaction_id="tx_001",
        source_transaction_type="buy",
        source_asset_symbol="BTC",
        source_price_quote_asset_symbol="USDT",
        source_fee_quote_asset_symbol="USDT",
        date_time=datetime(2025, 6, 15, 12, 0, 0),
        direction="inflow",
        transaction_type="trade",
        quantity=Decimal("1.5"),
        price=Decimal("50000.0"),
        fee=Decimal("0.001"),
        source_account="binance",
        network_transaction_id="0xabc",
    )
    defaults.update(overrides)
    return NormalizedTransaction(**defaults)


class TestDatetimeComparison:
    """Verify that naive-vs-aware datetimes don't cause spurious updates."""

    def test_naive_vs_aware_utc_is_equal(self):
        """Core bug: DB returns naive, connector produces aware — should be equal."""
        stage = PersistenceStage()

        existing = _make_tx(date_time=datetime(2025, 6, 15, 12, 0, 0))  # naive (from DB)
        new = _make_tx(date_time=datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc))  # aware (from connector)

        assert stage._needs_update(existing, new) is False

    def test_aware_vs_aware_same_is_equal(self):
        """Both aware, same instant — no update needed."""
        stage = PersistenceStage()

        dt = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
        existing = _make_tx(date_time=dt)
        new = _make_tx(date_time=dt)

        assert stage._needs_update(existing, new) is False

    def test_naive_vs_naive_same_is_equal(self):
        """Both naive, same value — no update needed."""
        stage = PersistenceStage()

        dt = datetime(2025, 6, 15, 12, 0, 0)
        existing = _make_tx(date_time=dt)
        new = _make_tx(date_time=dt)

        assert stage._needs_update(existing, new) is False

    def test_different_datetimes_trigger_update(self):
        """Actually different timestamps must trigger an update."""
        stage = PersistenceStage()

        existing = _make_tx(date_time=datetime(2025, 6, 15, 12, 0, 0))
        new = _make_tx(date_time=datetime(2025, 6, 15, 13, 0, 0, tzinfo=timezone.utc))

        assert stage._needs_update(existing, new) is True

    def test_datetimes_equal_none_handling(self):
        """_datetimes_equal handles None values correctly."""
        stage = PersistenceStage()
        assert stage._datetimes_equal(None, None) is True
        assert stage._datetimes_equal(None, datetime(2025, 1, 1)) is False
        assert stage._datetimes_equal(datetime(2025, 1, 1), None) is False


class TestUserEditableFieldsNotOverwritten:
    """Verify user-editable fields are excluded from UPDATABLE_FIELDS."""

    @pytest.mark.parametrize("field", ["review_status", "include_fee", "taxability_status"])
    def test_user_editable_field_not_in_updatable(self, field):
        """User-editable fields must NOT be in UPDATABLE_FIELDS."""
        assert field not in UPDATABLE_FIELDS, (
            f"{field} should not be in UPDATABLE_FIELDS — "
            "connector resyncs must not overwrite user edits"
        )

    def test_review_status_change_does_not_trigger_update(self):
        """A user changing review_status should NOT cause a resync update."""
        stage = PersistenceStage()

        # DB has user-edited review_status="valid"
        existing = _make_tx(review_status="valid")
        # Connector produces default review_status="pending"
        new = _make_tx(review_status="pending")

        # Should NOT detect a change (review_status is not compared)
        assert stage._needs_update(existing, new) is False

    def test_include_fee_change_does_not_trigger_update(self):
        """User toggling include_fee should survive resyncs."""
        stage = PersistenceStage()

        existing = _make_tx(include_fee=True)
        new = _make_tx(include_fee=False)

        assert stage._needs_update(existing, new) is False

    def test_taxability_status_change_does_not_trigger_update(self):
        """User changing taxability_status should survive resyncs."""
        stage = PersistenceStage()

        existing = _make_tx(taxability_status="taxable")
        new = _make_tx(taxability_status="unknown")

        assert stage._needs_update(existing, new) is False


class TestFloatComparison:
    """Verify float tolerance comparison is correct."""

    def test_identical_floats_no_update(self):
        """Exact same float values — no update."""
        stage = PersistenceStage()

        existing = _make_tx(quantity=Decimal("1.5"))
        new = _make_tx(quantity=Decimal("1.5"))

        assert stage._needs_update(existing, new) is False

    def test_tiny_float_difference_no_update(self):
        """Insignificant precision difference — no update."""
        stage = PersistenceStage()

        existing = _make_tx(quantity=Decimal("1.500000000000001"))
        new = _make_tx(quantity=Decimal("1.500000000000002"))

        assert stage._needs_update(existing, new) is False

    def test_significant_float_difference_triggers_update(self):
        """Meaningful quantity change — must trigger update."""
        stage = PersistenceStage()

        existing = _make_tx(quantity=Decimal("1.5"))
        new = _make_tx(quantity=Decimal("2.0"))

        assert stage._needs_update(existing, new) is True


class TestNoSpuriousUpdateEndToEnd:
    """End-to-end: identical re-sync data must not trigger an update."""

    def test_identical_resync_no_update(self):
        """Simulate what happens on a second sync with identical raw data.

        The connector produces timezone-aware datetimes and float values.
        The DB record has naive datetimes and Decimal values.
        _needs_update must return False.
        """
        stage = PersistenceStage()

        # Simulate DB record (naive datetime, Decimal from Numeric column)
        existing = _make_tx(
            date_time=datetime(2025, 6, 15, 12, 0, 0),  # naive from DB
            quantity=Decimal("0.76"),
            price=Decimal("716.61"),
            fee=Decimal("0.24508"),
        )

        # Simulate connector output (aware datetime, Decimal from float coercion)
        new = _make_tx(
            date_time=datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc),  # aware from connector
            quantity=Decimal("0.76"),
            price=Decimal("716.61"),
            fee=Decimal("0.24508"),
        )

        assert stage._needs_update(existing, new) is False


class TestFieldSets:
    """Verify field set definitions are consistent."""

    def test_float_fields_are_in_updatable(self):
        """All FLOAT_FIELDS must be in UPDATABLE_FIELDS."""
        for field in FLOAT_FIELDS:
            assert field in UPDATABLE_FIELDS

    def test_datetime_fields_are_in_updatable(self):
        """All DATETIME_FIELDS must be in UPDATABLE_FIELDS."""
        for field in DATETIME_FIELDS:
            assert field in UPDATABLE_FIELDS

    def test_date_time_in_datetime_fields(self):
        """date_time must be in DATETIME_FIELDS for timezone-safe comparison."""
        assert "date_time" in DATETIME_FIELDS


class TestChangedFieldsDiagnostics:
    def test_lists_changed_fields_with_values(self):
        stage = PersistenceStage()
        existing = _make_tx(network="ethereum")
        new = _make_tx(network="arbitrum", quantity=Decimal("2"))

        changed = stage._changed_fields(existing, new)

        assert any(c.startswith("network: 'ethereum' -> 'arbitrum'") for c in changed)
        assert any(c.startswith("quantity:") for c in changed)

    def test_no_changes_is_empty(self):
        stage = PersistenceStage()
        assert stage._changed_fields(_make_tx(), _make_tx()) == []
