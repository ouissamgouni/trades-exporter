"""
Unit tests for LotManager.

Tests cover:
- FIFO, LIFO, HIFO ordering
- LOT_TRAVEL vs MEGA_WALLET modes
- Lot consumption
- Edge cases (insufficient lots, negative balances)

Note: These tests use emit_event=False since they focus on lot ordering and
consumption behavior, not event emission. Event emission is tested separately
in test_lot_events.py.
"""

import pytest
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock

from backend.db.models import Asset, Account
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


class TestLotManagerFIFO:
    """Test FIFO (First In, First Out) lot ordering."""

    def test_fifo_consumption_order(self, fifo_config, base_datetime):
        """Lots should be consumed in acquisition order (oldest first)."""
        manager = LotManager(fifo_config)

        # Add lots: lot1 (oldest), lot2 (middle), lot3 (newest)
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
        lot3 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("300"),
            acquired_at=base_datetime + timedelta(days=2),
        )

        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        manager.add_lot(lot3, emit_event=False)

        # Consume 1.5 units
        slices, _ = manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("1.5"))

        # Should consume from lot1 (1.0) + lot2 (0.5)
        assert len(slices) == 2
        assert slices[0].unit_cost_in_base == Decimal("100")  # lot1
        assert slices[0].quantity == Decimal("1")
        assert slices[1].unit_cost_in_base == Decimal("200")  # lot2
        assert slices[1].quantity == Decimal("0.5")

    def test_fifo_total_cost_calculation(self, fifo_config, base_datetime):
        """Total cost should reflect consumed lot costs."""
        manager = LotManager(fifo_config)

        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("2"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot1, emit_event=False)

        slices, _ = manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("1.5"))

        total_cost = sum(s.total_cost_in_base for s in slices)
        assert total_cost == Decimal("150")  # 1.5 * 100


class TestLotManagerLIFO:
    """Test LIFO (Last In, First Out) lot ordering."""

    def test_lifo_consumption_order(self, lifo_config, base_datetime):
        """Lots should be consumed in reverse acquisition order (newest first)."""
        manager = LotManager(lifo_config)

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
        lot3 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("300"),
            acquired_at=base_datetime + timedelta(days=2),
        )

        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        manager.add_lot(lot3, emit_event=False)

        # Consume 1.5 units
        slices, _ = manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("1.5"))

        # Should consume from lot3 (1.0) + lot2 (0.5)
        assert len(slices) == 2
        assert slices[0].unit_cost_in_base == Decimal("300")  # lot3 (newest)
        assert slices[1].unit_cost_in_base == Decimal("200")  # lot2


class TestLotManagerHIFO:
    """Test HIFO (Highest In, First Out) lot ordering."""

    def test_hifo_consumption_order(self, hifo_config, base_datetime):
        """Lots should be consumed by highest cost first."""
        manager = LotManager(hifo_config)

        # Add lots with different costs (not in cost order)
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
            unit_cost=Decimal("300"),
            acquired_at=base_datetime + timedelta(days=1),
        )
        lot3 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=2),
        )

        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        manager.add_lot(lot3, emit_event=False)

        # Consume 1.5 units
        slices, _ = manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("1.5"))

        # Should consume from lot2 (300) + lot3 (200)
        assert len(slices) == 2
        assert slices[0].unit_cost_in_base == Decimal("300")  # highest
        assert slices[1].unit_cost_in_base == Decimal("200")  # second highest


class TestLotManagerModes:
    """Test LOT_TRAVEL vs MEGA_WALLET modes."""

    def test_lot_travel_separates_accounts(self, fifo_config, base_datetime):
        """LOT_TRAVEL mode should keep lots separate per account."""
        manager = LotManager(fifo_config)

        # Add lots to different accounts
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=2,
            qty=Decimal("1"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime,
        )

        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)

        # Consume from account 1
        slices, _ = manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("0.5"))

        # Should only consume from account 1's lot
        assert len(slices) == 1
        assert slices[0].unit_cost_in_base == Decimal("100")

        # Account 2's lot should be untouched
        assert manager.get_balance(account_id=2, asset_id=2) == Decimal("1")

    def test_mega_wallet_aggregates_accounts(self, mega_wallet_config, base_datetime):
        """MEGA_WALLET mode should aggregate lots across accounts."""
        manager = LotManager(mega_wallet_config)

        # Add lots to different accounts
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=2,
            qty=Decimal("1"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=1),
        )

        # In MEGA_WALLET, account_id is ignored for lot storage
        lot1.account_id = None
        lot2.account_id = None

        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)

        # Consume 1.5 units (should span both original lots)
        slices, _ = manager.consume_lots(
            emit_event=False,
            account_id=1,  # account_id ignored in MEGA_WALLET
            asset_id=2, asset_symbol="",
            qty=Decimal("1.5"),
        )

        # Should consume from both lots (FIFO order)
        assert len(slices) == 2


class TestLotManagerEdgeCases:
    """Test edge cases and error handling."""

    def test_insufficient_lots_raises_error(self, fifo_config, base_datetime):
        """Should raise ValueError when insufficient lots."""
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        with pytest.raises(ValueError, match="Insufficient lots"):
            manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("2"))

    def test_insufficient_lots_with_allow_negative(self, fifo_config, base_datetime):
        """Should create negative lot when allowed."""
        fifo_config.allow_negative_balances = True
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        slices, negative_lot = manager.consume_lots(
            emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("2"), allow_negative=True
        )

        assert len(slices) == 2
        assert negative_lot is not None
        assert negative_lot.qty == Decimal("-1")
        assert negative_lot.is_zero_cost

    def test_empty_lots_returns_empty(self, fifo_config):
        """Should raise error when no lots exist."""
        manager = LotManager(fifo_config)

        with pytest.raises(ValueError):
            manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("1"))

    def test_get_balance(self, fifo_config, base_datetime):
        """Should correctly calculate remaining balance."""
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("3"))

        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("7")

    def test_get_cost_basis(self, fifo_config, base_datetime):
        """Should correctly calculate remaining cost basis."""
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        manager.consume_lots(emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("3"))

        # 7 remaining * 100 unit cost = 700
        assert manager.get_cost_basis(account_id=1, asset_id=2) == Decimal("700")

    def test_clear(self, fifo_config, base_datetime):
        """Should clear all lots."""
        manager = LotManager(fifo_config)

        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        manager.clear()

        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("0")

class TestNegativeLotSettlement:
    """Test negative lot settlement functionality."""

    def test_settle_negative_lots_full_settlement(self, fifo_config, base_datetime):
        """Negative lot should be fully settled when acquisition covers it."""
        from uuid import uuid4
        fifo_config.allow_negative_balances = True
        manager = LotManager(fifo_config)

        # Create a negative lot (simulating sell before buy)
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        # Consume more than available (creates negative lot)
        slices, negative_lot = manager.consume_lots(
            emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("2"), allow_negative=True
        )
        assert negative_lot is not None
        assert negative_lot.qty == Decimal("-1")

        # Settle with new acquisition
        # Create mock objects for the new signature
        mock_account = Account(id=1, name="Test", account_type="cex")
        mock_asset = Asset(asset_id=2, symbol="TEST", price_type="crypto")
        
        remaining_qty, settlement_records = manager.settle_negative_lots(
            account=mock_account,
            asset=mock_asset,
            available_qty=Decimal("3"),
            unit_cost=Decimal("150"),
            settling_lot_uuid=uuid4(),
            emit_event=False,
        )

        # Should have settled the 1 unit negative lot
        assert len(settlement_records) == 1
        assert settlement_records[0].qty_settled == Decimal("1")
        assert settlement_records[0].cost_basis_applied == Decimal("150")  # 1 * 150
        assert remaining_qty == Decimal("2")  # 3 - 1 settled

    def test_settle_negative_lots_partial_settlement(self, fifo_config, base_datetime):
        """Negative lot should be partially settled when acquisition is smaller."""
        from uuid import uuid4
        fifo_config.allow_negative_balances = True
        manager = LotManager(fifo_config)

        # Create a negative lot of 2 units
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        slices, negative_lot = manager.consume_lots(
            emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("3"), allow_negative=True
        )
        assert negative_lot.qty == Decimal("-2")

        # Settle with only 1 unit
        mock_account = Account(id=1, name="Test", account_type="cex")
        mock_asset = Asset(asset_id=2, symbol="TEST", price_type="crypto")
        
        remaining_qty, settlement_records = manager.settle_negative_lots(
            account=mock_account,
            asset=mock_asset,
            available_qty=Decimal("1"),
            unit_cost=Decimal("200"),
            settling_lot_uuid=uuid4(),
            emit_event=False,
        )

        # Should have partially settled
        assert len(settlement_records) == 1
        assert settlement_records[0].qty_settled == Decimal("1")
        assert remaining_qty == Decimal("0")  # All used for settlement

        # Check that 1 unit still unsettled
        unsettled = manager.get_unsettled_negative_lots(account_id=1, asset_id=2)
        total_unsettled = sum(abs(lot.qty_remaining) for lot in unsettled)
        assert total_unsettled == Decimal("1")

    def test_no_settlement_when_no_negative_lots(self, fifo_config):
        """Should return full qty when no negative lots to settle."""
        from uuid import uuid4
        manager = LotManager(fifo_config)

        mock_account = Account(id=1, name="Test", account_type="cex")
        mock_asset = Asset(asset_id=2, symbol="TEST", price_type="crypto")
        
        remaining_qty, settlement_records = manager.settle_negative_lots(
            account=mock_account,
            asset=mock_asset,
            available_qty=Decimal("5"),
            unit_cost=Decimal("100"),
            settling_lot_uuid=uuid4(),
            emit_event=False,
        )

        assert len(settlement_records) == 0
        assert remaining_qty == Decimal("5")

    def test_get_balance_subtracts_negative_lots(self, fifo_config, base_datetime):
        """Balance should account for unsettled negative lots."""
        fifo_config.allow_negative_balances = True
        manager = LotManager(fifo_config)

        # Create positive lot
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("5"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)

        # Consume more than available (creates negative lot of 2)
        slices, negative_lot = manager.consume_lots(
            emit_event=False, account_id=1, asset_id=2, asset_symbol="", qty=Decimal("7"), allow_negative=True
        )

        # Balance should be -2 (negative lot)
        balance = manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("-2")