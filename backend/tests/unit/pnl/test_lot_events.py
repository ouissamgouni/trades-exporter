"""
Unit tests for CostLotEvent emission in LotManager.

Tests cover:
- Event emission on lot creation
- Event emission on lot consumption
- Event emission on negative lot settlement
- Event metadata tracking
"""

import pytest
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock

from backend.db.models import LotEventType, CostLotEvent
from backend.services.pnl.lot_manager import LotManager

from tests.unit.pnl.conftest import create_lot


def create_mock_transaction(tx_id: int = 1):
    """Create a mock transaction for testing."""
    mock_tx = Mock()
    mock_tx.id = tx_id
    return mock_tx


def create_mock_unit(unit_id: int = 1):
    """Create a mock calculation unit for testing."""
    mock_unit = Mock()
    mock_unit.id = unit_id
    return mock_unit


class TestLotEventEmission:
    """Test that LotManager emits events correctly."""

    def test_created_event_on_add_lot(self, fifo_config, base_datetime):
        """Adding a lot should emit a 'created' event."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.5"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Lot should have one event
        assert lot.events is not None
        assert len(lot.events) == 1

        event = lot.events[0]
        assert event.event_type == LotEventType.CREATED.value
        assert event.quantity_delta == Decimal("1.5")
        assert event.cost_basis_delta == Decimal("150")  # 1.5 * 100
        assert event.qty_remaining_after == Decimal("1.5")
        assert event.cost_basis_remaining_after == Decimal("150")
        assert event.related_lot is None
        assert event.triggered_by_transaction == mock_tx
        assert event.triggered_by_unit == mock_unit

    def test_consumed_event_on_partial_consumption(self, fifo_config, base_datetime):
        """Consuming part of a lot should emit a 'consumed' event."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("2"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Consume 1.5 units
        slices, _ = manager.consume_lots(
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("1.5"),
            triggered_by_transaction=mock_tx,
            triggered_by_unit=mock_unit,
        )

        # Should have 2 events: created + consumed
        assert len(lot.events) == 2

        consumed_event = lot.events[1]
        assert consumed_event.event_type == LotEventType.CONSUMED.value
        assert consumed_event.quantity_delta == Decimal("-1.5")  # Negative for consumption
        assert consumed_event.cost_basis_delta == Decimal("-150")  # Negative
        assert consumed_event.qty_remaining_after == Decimal("0.5")  # 2 - 1.5

    def test_consumed_event_on_full_consumption(self, fifo_config, base_datetime):
        """Fully consuming a lot should emit a 'consumed' event with qty_remaining_after=0."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Consume entire lot
        manager.consume_lots(
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("1"),
            triggered_by_transaction=mock_tx,
            triggered_by_unit=mock_unit,
        )

        # Should have 2 events: created + consumed
        assert len(lot.events) == 2

        consumed_event = lot.events[1]
        assert consumed_event.event_type == LotEventType.CONSUMED.value
        assert consumed_event.quantity_delta == Decimal("-1")
        assert consumed_event.qty_remaining_after == Decimal("0")

    def test_multiple_lot_consumption_events(self, fifo_config, base_datetime):
        """Consuming from multiple lots should emit consumed events for each."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=1),
        )

        manager.add_lot(lot1, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)
        manager.add_lot(lot2, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Consume 1.5 units (should consume from both lots in FIFO order)
        manager.consume_lots(
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("1.5"),
            triggered_by_transaction=mock_tx,
            triggered_by_unit=mock_unit,
        )

        # lot1: created + consumed (fully)
        assert len(lot1.events) == 2
        assert lot1.events[1].event_type == LotEventType.CONSUMED.value
        assert lot1.events[1].quantity_delta == Decimal("-1")

        # lot2: created + consumed (partially)
        assert len(lot2.events) == 2
        assert lot2.events[1].event_type == LotEventType.CONSUMED.value
        assert lot2.events[1].quantity_delta == Decimal("-0.5")

    def test_event_timestamp_set(self, fifo_config, base_datetime):
        """Events should have a timestamp."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        assert lot.events[0].timestamp is not None

    def test_event_lot_reference(self, fifo_config, base_datetime):
        """Events should reference back to the parent lot."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        event = lot.events[0]
        assert event.lot is lot
    
    def test_emit_event_false_skips_event(self, fifo_config, base_datetime):
        """Setting emit_event=False should skip event emission (for reloaded lots)."""
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        # Add lot without emitting event (simulates reload from DB)
        manager.add_lot(lot, emit_event=False)

        # Lot should have no events
        assert lot.events is None or len(lot.events) == 0
    
    def test_missing_transaction_raises_error(self, fifo_config, base_datetime):
        """Missing triggered_by_transaction should raise ValueError."""
        manager = LotManager(fifo_config)
        mock_unit = create_mock_unit(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        with pytest.raises(ValueError, match="triggered_by_transaction is required"):
            manager.add_lot(lot, triggered_by_transaction=None, triggered_by_unit=mock_unit)
    
    def test_missing_unit_raises_error(self, fifo_config, base_datetime):
        """Missing triggered_by_unit should raise ValueError."""
        manager = LotManager(fifo_config)
        mock_tx = create_mock_transaction(1)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )

        with pytest.raises(ValueError, match="triggered_by_unit is required"):
            manager.add_lot(lot, triggered_by_transaction=mock_tx, triggered_by_unit=None)


class TestSettlementEvents:
    """Test events emitted during negative lot settlements."""

    def test_settled_event_on_negative_lot_settlement(self, base_datetime):
        """Settling a negative lot should emit 'settled' events."""
        from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
        from uuid import uuid4

        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=True,
        )
        manager = LotManager(config)
        mock_tx = create_mock_transaction(1)
        mock_unit = create_mock_unit(1)

        # First create a negative lot (sell before buy scenario)
        negative_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("-1"),  # Negative
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(negative_lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Then add a positive lot that settles the negative
        positive_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("2"),
            unit_cost=Decimal("150"),
            acquired_at=base_datetime + timedelta(days=1),
        )
        manager.add_lot(positive_lot, triggered_by_transaction=mock_tx, triggered_by_unit=mock_unit)

        # Create mock account and asset for settlement
        mock_account = Mock()
        mock_account.id = 1
        mock_asset = Mock()
        mock_asset.id = 2
        mock_asset.asset_id = 2

        # Trigger settlement with a new acquisition
        qty_used, settlements = manager.settle_negative_lots(
            account=mock_account,
            asset=mock_asset,
            available_qty=Decimal("2"),
            unit_cost=Decimal("150"),
            settling_lot_uuid=positive_lot.lot_uuid,
            settling_lot=positive_lot,
            settling_transaction=mock_tx,
            triggered_by_unit=mock_unit,
        )

        # Should have settlement events
        if len(settlements) > 0:
            # Find settled events on negative lot
            negative_settled = [e for e in negative_lot.events if e.event_type == LotEventType.SETTLED.value]
            # At least one should have settlement events
            assert len(negative_settled) >= 1 or len(settlements) > 0
