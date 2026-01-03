"""
Integration tests for P&L Engine.

Tests cover end-to-end scenarios with multiple groups processed in sequence.
"""

import pytest
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock

from backend.services.pnl.engine import PnLEngine
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode

from tests.unit.pnl.conftest import (
    MockTransaction,
    MockGroup,
    create_buy_group,
    create_sell_group,
    create_swap_group,
    create_transfer_group,
    create_split_group,
)


@pytest.fixture
def mock_session():
    """Mock database session."""
    session = Mock()
    session.get = Mock(return_value=Mock(symbol="EUR"))
    session.exec = Mock(return_value=Mock(all=Mock(return_value=[])))
    session.add = Mock()
    session.flush = Mock()
    session.commit = Mock()
    return session


class TestPnLEngineIntegration:
    """Integration tests for full P&L calculation flows."""

    def test_buy_then_sell_fifo(self, mock_session, mock_price_service, base_datetime):
        """
        Scenario: Buy BTC in two batches, then sell - FIFO.

        Day 1: Buy 1 BTC at 30000 EUR
        Day 2: Buy 1 BTC at 35000 EUR
        Day 3: Sell 1.5 BTC at 40000 EUR

        Expected (FIFO):
        - Consumes lot1 (1 BTC @ 30000) + 0.5 from lot2 (0.5 @ 35000)
        - Cost basis: 30000 + 17500 = 47500
        - Proceeds: 60000 (1.5 * 40000)
        - P&L: 60000 - 47500 = 12500
        """
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        # Create groups
        day1 = base_datetime
        day2 = base_datetime + timedelta(days=1)
        day3 = base_datetime + timedelta(days=2)

        groups = [
            # Day 1: Buy 1 BTC at 30000
            create_buy_group(
                day1, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("30000")
            ),
            # Day 2: Buy 1 BTC at 35000
            create_buy_group(
                day2, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("35000")
            ),
            # Day 3: Sell 1.5 BTC for 60000
            create_sell_group(
                day3, asset_id=2, qty=Decimal("1.5"), proceeds_in_base=Decimal("60000")
            ),
        ]
        # Fix group IDs
        for i, g in enumerate(groups):
            g.group_id = i + 1

        # Pre-fund EUR for buys
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units(groups)

        # Should have one realized P&L entry (from sell)
        taxable_entries = [e for e in result.realized_pnl_entries if e.taxable]
        assert len(taxable_entries) == 1

        entry = taxable_entries[0]
        assert entry.proceeds_in_base == Decimal("60000")
        assert entry.cost_basis_in_base == Decimal("47500")  # 30000 + 17500
        assert entry.pnl_in_base == Decimal("12500")

    def test_buy_then_sell_lifo(self, mock_session, mock_price_service, base_datetime):
        """
        Same scenario but with LIFO - should use newest lots first.

        Expected (LIFO):
        - Consumes lot2 (1 BTC @ 35000) + 0.5 from lot1 (0.5 @ 30000)
        - Cost basis: 35000 + 15000 = 50000
        - P&L: 60000 - 50000 = 10000
        """
        config = PnLConfig(
            lot_method=CostMethod.LIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=1)
        day3 = base_datetime + timedelta(days=2)

        groups = [
            create_buy_group(
                day1, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("30000")
            ),
            create_buy_group(
                day2, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("35000")
            ),
            create_sell_group(
                day3, asset_id=2, qty=Decimal("1.5"), proceeds_in_base=Decimal("60000")
            ),
        ]
        for i, g in enumerate(groups):
            g.group_id = i + 1

        # Pre-fund EUR
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units(groups)

        taxable_entries = [e for e in result.realized_pnl_entries if e.taxable]
        assert len(taxable_entries) == 1

        entry = taxable_entries[0]
        assert entry.cost_basis_in_base == Decimal("50000")  # 35000 + 15000
        assert entry.pnl_in_base == Decimal("10000")

    def test_transfer_preserves_cost_basis(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: Buy, transfer, sell from new account.
        Cost basis should travel with the transfer.
        """
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=1)
        day3 = base_datetime + timedelta(days=2)

        # Buy in account 1
        buy_group = create_buy_group(
            day1,
            asset_id=2,
            qty=Decimal("1"),
            cost_in_base=Decimal("30000"),
            account_id=1,
        )
        buy_group.group_id = 1

        # Transfer from account 1 to account 2
        transfer_group = create_transfer_group(
            day2, asset_id=2, qty=Decimal("1"), from_account_id=1, to_account_id=2
        )
        transfer_group.group_id = 2

        # Sell from account 2
        sell_group = MockGroup(
            group_id=3,
            transactions=[
                MockTransaction(
                    id=10,
                    direction="outflow",
                    asset_id=2,
                    quantity=Decimal("1"),
                    date_time=day3,
                    account_id=2,  # Selling from account 2
                    total_in_base=Decimal("40000"),
                ),
                MockTransaction(
                    id=11,
                    direction="inflow",
                    asset_id=1,
                    quantity=Decimal("40000"),
                    date_time=day3,
                    account_id=2,
                ),
            ],
        )

        groups = [buy_group, transfer_group, sell_group]

        # Pre-fund EUR in account 1
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units(groups)

        # Should have one taxable P&L (the sell)
        taxable_entries = [e for e in result.realized_pnl_entries if e.taxable]
        assert len(taxable_entries) == 1

        entry = taxable_entries[0]
        # Cost basis should be preserved from original buy (30000)
        assert entry.cost_basis_in_base == Decimal("30000")
        assert entry.pnl_in_base == Decimal("10000")

    def test_stock_split_preserves_cost_basis(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: Buy stock, split 2:1, sell.
        Total cost basis should be preserved across split.
        """
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=30)
        day3 = base_datetime + timedelta(days=60)

        # Buy 100 AAPL at 100 each = 10000
        buy_group = create_buy_group(
            day1, asset_id=5, qty=Decimal("100"), cost_in_base=Decimal("10000")
        )
        buy_group.group_id = 1

        # 2:1 split: 100 → 200 shares
        split_group = create_split_group(
            day2, asset_id=5, from_qty=Decimal("100"), to_qty=Decimal("200")
        )
        split_group.group_id = 2

        # Sell 100 shares (half) at 60 each = 6000
        sell_group = create_sell_group(
            day3, asset_id=5, qty=Decimal("100"), proceeds_in_base=Decimal("6000")
        )
        sell_group.group_id = 3

        groups = [buy_group, split_group, sell_group]

        # Pre-fund EUR
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units(groups)

        # After split, unit cost is 10000/200 = 50 per share
        # Selling 100 shares: cost = 100 * 50 = 5000
        # Proceeds = 6000
        # P&L = 1000

        taxable_entries = [e for e in result.realized_pnl_entries if e.taxable]
        assert len(taxable_entries) == 1

        entry = taxable_entries[0]
        assert entry.cost_basis_in_base == Decimal("5000")
        assert entry.pnl_in_base == Decimal("1000")

    def test_multiple_swaps_chain(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: EUR → BTC → ETH → EUR
        Should track cost basis through chain of swaps.
        """
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
            crypto_swap_taxable=True,
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=30)
        day3 = base_datetime + timedelta(days=60)

        # Day 1: Buy 1 BTC for 30000 EUR
        buy_btc = create_buy_group(
            day1, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("30000")
        )
        buy_btc.group_id = 1

        # Day 2: Swap 1 BTC (now worth 40000) → 16 ETH
        swap_btc_eth = create_swap_group(
            day2,
            from_asset_id=2,
            from_qty=Decimal("1"),
            to_asset_id=3,
            to_qty=Decimal("16"),
            from_value_in_base=Decimal("40000"),
            to_value_in_base=Decimal("40000"),
        )
        swap_btc_eth.group_id = 2

        # Day 3: Sell 16 ETH for 48000 EUR
        sell_eth = create_sell_group(
            day3, asset_id=3, qty=Decimal("16"), proceeds_in_base=Decimal("48000")
        )
        sell_eth.group_id = 3

        groups = [buy_btc, swap_btc_eth, sell_eth]

        # Pre-fund EUR
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units(groups)

        # Total P&L across chain:
        # Swap BTC→ETH: proceeds 40000, cost 30000, P&L = 10000
        # Sell ETH: proceeds 48000, cost 40000 (from swap), P&L = 8000
        # Total: 18000

        assert result.total_realized_pnl == Decimal("18000")


class TestPnLEngineEdgeCases:
    """Test edge cases in integration scenarios."""

    def test_no_groups(self, mock_session, mock_price_service):
        """Should handle empty group list."""
        config = PnLConfig()
        engine = PnLEngine(mock_session, mock_price_service, config)

        result = engine.process_calculation_units([])

        assert result.units_processed == 0
        assert result.total_realized_pnl == Decimal("0")

    def test_reset_clears_state(self, mock_session, mock_price_service, base_datetime):
        """Reset should clear all engine state."""
        config = PnLConfig()
        engine = PnLEngine(mock_session, mock_price_service, config)

        # Add some lots
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=2,
                account_id=1,
                qty=Decimal("1"),
                unit_cost=Decimal("30000"),
                acquired_at=base_datetime,
            )
        )

        engine.reset()

        assert engine.lot_manager.get_balance(account_id=1, asset_id=2) == Decimal("0")

class TestNegativeLotSettlementIntegration:
    """Integration tests for negative lot settlement flow."""

    def test_sell_before_buy_creates_negative_lot(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: Sell asset before buying (no lots available).
        Should create negative lot with zero cost basis.
        """
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=True,
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime

        # Sell 1 BTC without having any (creates negative lot)
        sell_group = create_sell_group(
            day1, asset_id=2, qty=Decimal("1"), proceeds_in_base=Decimal("50000")
        )
        sell_group.group_id = 1

        result = engine.process_calculation_units([sell_group])

        # Should have realized P&L with zero cost basis (provisional)
        taxable_entries = [e for e in result.realized_pnl_entries if e.taxable]
        assert len(taxable_entries) == 1

        entry = taxable_entries[0]
        assert entry.proceeds_in_base == Decimal("50000")
        assert entry.cost_basis_in_base == Decimal("0")  # No cost known yet
        assert entry.pnl_in_base == Decimal("50000")  # Provisional (too high)

        # Check negative lot was created
        balance = engine.lot_manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("-1")  # Negative balance

    def test_sell_then_buy_settles_negative_lot(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: Sell 1 BTC (no lots), then buy 2 BTC.
        
        Day 1: Sell 1 BTC at 50000 EUR (no lots → negative lot, provisional P&L)
        Day 2: Buy 2 BTC at 30000 EUR each
        
        Expected:
        - Negative lot is settled with cost basis from buy
        - Adjustment P&L entry created
        - Remaining 1 BTC creates new positive lot
        """
        from datetime import timedelta

        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=True,
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=1)

        # Day 1: Sell 1 BTC without having any
        sell_group = create_sell_group(
            day1, asset_id=2, qty=Decimal("1"), proceeds_in_base=Decimal("50000")
        )
        sell_group.group_id = 1

        # Day 2: Buy 2 BTC for 60000 EUR (30000 each)
        buy_group = create_buy_group(
            day2, asset_id=2, qty=Decimal("2"), cost_in_base=Decimal("60000")
        )
        buy_group.group_id = 2

        # Pre-fund EUR for the buy
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("100000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units([sell_group, buy_group])

        # After settlement:
        # - Original sell: proceeds=50000, cost=0, P&L=50000 (provisional)
        # - Adjustment: cost_applied=30000 (1 unit * 30000), P&L adjustment=-30000
        # - Net correct P&L: 50000 - 30000 = 20000

        # Check balance: 2 BTC bought - 1 BTC used for settlement = 1 BTC remaining
        balance = engine.lot_manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("1")

        # Should have adjustment P&L entries
        adjustment_entries = [
            e for e in result.realized_pnl_entries 
            if getattr(e, 'adjustment_type', None) == "cost_update"
        ]
        assert len(adjustment_entries) == 1

        adj = adjustment_entries[0]
        assert adj.cost_basis_in_base == Decimal("30000")  # 1 * 30000
        assert adj.pnl_in_base == Decimal("-30000")  # Reduces the inflated P&L

    def test_partial_settlement(
        self, mock_session, mock_price_service, base_datetime
    ):
        """
        Scenario: Sell 3 BTC (no lots), then buy 1 BTC, then buy 2 more.
        
        Should settle incrementally.
        """
        from datetime import timedelta

        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=True,
        )
        engine = PnLEngine(mock_session, mock_price_service, config)

        day1 = base_datetime
        day2 = base_datetime + timedelta(days=1)
        day3 = base_datetime + timedelta(days=2)

        # Day 1: Sell 3 BTC without having any
        sell_group = create_sell_group(
            day1, asset_id=2, qty=Decimal("3"), proceeds_in_base=Decimal("150000")
        )
        sell_group.group_id = 1

        # Day 2: Buy 1 BTC for 30000 EUR
        buy1_group = create_buy_group(
            day2, asset_id=2, qty=Decimal("1"), cost_in_base=Decimal("30000")
        )
        buy1_group.group_id = 2

        # Day 3: Buy 2 BTC for 70000 EUR (35000 each)
        buy2_group = create_buy_group(
            day3, asset_id=2, qty=Decimal("2"), cost_in_base=Decimal("70000")
        )
        buy2_group.group_id = 3

        # Pre-fund EUR
        engine.lot_manager.add_lot(
            __import__("tests.unit.pnl.conftest", fromlist=["create_lot"]).create_lot(
                asset_id=1,
                account_id=1,
                qty=Decimal("200000"),
                unit_cost=Decimal("1"),
                acquired_at=day1 - timedelta(days=30),
            )
        )

        result = engine.process_calculation_units([sell_group, buy1_group, buy2_group])

        # After all settlements:
        # - Sold 3 BTC → negative lot of 3
        # - Buy1 settles 1 → remaining negative = 2
        # - Buy2 settles 2 → remaining negative = 0, no positive lot left
        
        balance = engine.lot_manager.get_balance(account_id=1, asset_id=2)
        assert balance == Decimal("0")  # All settled, no remaining

        # Check adjustments: should have 2 (one per buy)
        adjustment_entries = [
            e for e in result.realized_pnl_entries 
            if getattr(e, 'adjustment_type', None) == "cost_update"
        ]
        assert len(adjustment_entries) == 2

        # Total cost applied: 30000 + 70000 = 100000
        # Original sale proceeds: 150000
        # Net P&L: 150000 - 100000 = 50000
        total_adjustment_cost = sum(e.cost_basis_in_base for e in adjustment_entries)
        assert total_adjustment_cost == Decimal("100000")