"""
Unit tests for balance tracking in LotManager.

Tests cover:
- get_balance() for account-level balances
- get_asset_balance() for asset-level balances across all accounts
- Balance computation in LOT_TRAVEL vs MEGA_WALLET modes
- Balance tracking after lot creation and consumption
"""

import pytest
from datetime import timedelta
from decimal import Decimal

from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.config import LotMode

from tests.unit.pnl.conftest import create_lot


class TestBalanceTracking:
    """Test balance computation methods."""

    def test_get_balance_single_lot(self, fifo_config, base_datetime):
        """Balance should reflect remaining quantity in a single lot."""
        manager = LotManager(fifo_config)
        
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)
        
        balance = manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("10.0")

    def test_get_balance_multiple_lots(self, fifo_config, base_datetime):
        """Balance should sum remaining quantities across multiple lots."""
        manager = LotManager(fifo_config)
        
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("5.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("3.5"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=1),
        )
        
        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        
        balance = manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("8.5")

    def test_get_balance_after_consumption(self, fifo_config, base_datetime):
        """Balance should decrease after consuming lots."""
        manager = LotManager(fifo_config)
        
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)
        
        # Initial balance
        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("10.0")
        
        # Consume 3.5 units
        manager.consume_lots(
            emit_event=False,
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("3.5")
        )
        
        # Balance should reflect remaining quantity
        balance = manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("6.5")

    def test_get_asset_balance_single_account_lot_travel(self, fifo_config, base_datetime):
        """Asset balance in LOT_TRAVEL mode with single account."""
        manager = LotManager(fifo_config)
        
        lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("5.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot, emit_event=False)
        
        # Asset balance should equal account balance
        asset_balance = manager.get_asset_balance(asset_id=2)
        account_balance = manager.get_balance(account_id=1, asset_id=2)
        assert asset_balance == Decimal("5.0")
        assert asset_balance == account_balance

    def test_get_asset_balance_multiple_accounts_lot_travel(self, fifo_config, base_datetime):
        """Asset balance in LOT_TRAVEL mode should sum across all accounts."""
        manager = LotManager(fifo_config)
        
        # Account 1: 10 units
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        manager.add_lot(lot1, emit_event=False)
        
        # Account 2: 7.5 units
        lot2 = create_lot(
            asset_id=2,
            account_id=2,
            qty=Decimal("7.5"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=1),
        )
        manager.add_lot(lot2, emit_event=False)
        
        # Account 3: 2.25 units
        lot3 = create_lot(
            asset_id=2,
            account_id=3,
            qty=Decimal("2.25"),
            unit_cost=Decimal("150"),
            acquired_at=base_datetime + timedelta(days=2),
        )
        manager.add_lot(lot3, emit_event=False)
        
        # Asset balance should sum all accounts
        asset_balance = manager.get_asset_balance(asset_id=2)
        assert asset_balance == Decimal("19.75")
        
        # Individual account balances should be separate
        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("10.0")
        assert manager.get_balance(account_id=2, asset_id=2) == Decimal("7.5")
        assert manager.get_balance(account_id=3, asset_id=2) == Decimal("2.25")

    def test_get_asset_balance_mega_wallet(self, mega_wallet_config, base_datetime):
        """Asset balance in MEGA_WALLET mode should equal single aggregated balance."""
        manager = LotManager(mega_wallet_config)
        
        # Add lots with different account_ids (will be aggregated)
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=2,
            qty=Decimal("5.0"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime + timedelta(days=1),
        )
        
        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        
        # In MEGA_WALLET, all lots are aggregated regardless of account
        asset_balance = manager.get_asset_balance(asset_id=2)
        assert asset_balance == Decimal("15.0")
        
        # get_balance with None should give same result
        balance_none = manager.get_balance(account_id=None, asset_id=2)
        assert balance_none == Decimal("15.0")
        assert asset_balance == balance_none

    def test_balance_with_different_assets(self, fifo_config, base_datetime):
        """Balances should be tracked separately per asset."""
        manager = LotManager(fifo_config)
        
        # Asset 2 (BTC): 10 units
        lot_btc = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("50000"),
            acquired_at=base_datetime,
        )
        
        # Asset 3 (ETH): 25 units
        lot_eth = create_lot(
            asset_id=3,
            account_id=1,
            qty=Decimal("25.0"),
            unit_cost=Decimal("3000"),
            acquired_at=base_datetime,
        )
        
        manager.add_lot(lot_btc, emit_event=False)
        manager.add_lot(lot_eth, emit_event=False)
        
        # Balances should be separate
        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("10.0")
        assert manager.get_balance(account_id=1, asset_id=3) == Decimal("25.0")
        assert manager.get_asset_balance(asset_id=2) == Decimal("10.0")
        assert manager.get_asset_balance(asset_id=3) == Decimal("25.0")

    def test_balance_zero_for_nonexistent_asset(self, fifo_config):
        """Balance should be zero for assets with no lots."""
        manager = LotManager(fifo_config)
        
        balance = manager.get_balance(account_id=1, asset_id=999)
        asset_balance = manager.get_asset_balance(asset_id=999)
        
        assert balance == Decimal("0")
        assert asset_balance == Decimal("0")

    def test_asset_balance_after_partial_consumption(self, fifo_config, base_datetime):
        """Asset balance should update correctly after consuming from one account."""
        manager = LotManager(fifo_config)
        
        # Account 1: 10 units
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("10.0"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime,
        )
        
        # Account 2: 8 units
        lot2 = create_lot(
            asset_id=2,
            account_id=2,
            qty=Decimal("8.0"),
            unit_cost=Decimal("200"),
            acquired_at=base_datetime,
        )
        
        manager.add_lot(lot1, emit_event=False)
        manager.add_lot(lot2, emit_event=False)
        
        # Initial asset balance: 18 units
        assert manager.get_asset_balance(asset_id=2) == Decimal("18.0")
        
        # Consume 6 units from account 1
        manager.consume_lots(
            emit_event=False,
            account_id=1,
            asset_id=2,
            asset_symbol="BTC",
            qty=Decimal("6.0")
        )
        
        # Account 1 should have 4 units left
        assert manager.get_balance(account_id=1, asset_id=2) == Decimal("4.0")
        # Account 2 should still have 8 units
        assert manager.get_balance(account_id=2, asset_id=2) == Decimal("8.0")
        # Asset balance should be 12 units total
        assert manager.get_asset_balance(asset_id=2) == Decimal("12.0")
