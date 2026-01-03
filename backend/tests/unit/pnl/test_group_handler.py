"""
Unit tests for handle_group function.

Tests cover all 13+ use cases:
1. Buy AAPL (EUR → AAPL) - not taxable
2. Sell AAPL (AAPL → EUR) - taxable
3. Swap T1 → T2 - configurable
4-6. Buy with base currency variations
7-8. Sell/swap forex (CHF, JPY)
9. Transfer with fee
10. Stock split
11. Payment (outflow only)
12. Airdrop (inflow only)
13. Buy T7 with JPY (foreign fiat taxable)
"""

from datetime import timedelta
from decimal import Decimal

from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.lot_manager import LotManager

from backend.services.pnl.fmv_service import FMVService

from tests.unit.pnl.conftest import (
    MockTransaction,
    MockGroup,
    create_lot,
    seed_lot,
    create_buy_group,
    create_sell_group,
    create_swap_group,
    create_transfer_group,
    create_split_group,
    create_airdrop_group,
    create_payment_group,
)


class TestBuyScenarios:
    """Test BUY scenarios (EUR → Asset)."""

    def test_buy_with_base_currency(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 1: Buy AAPL with EUR - not taxable, creates lot with cost = EUR spent."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund EUR (base currency)
        eur_lot = create_lot(
            asset_id=1,
            account_id=1,
            qty=Decimal("1000"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=30),
        )
        lot_manager.add_lot(eur_lot)

        # Create buy group: 1000 EUR → 10 AAPL
        group = create_buy_group(
            base_dt=base_datetime,
            asset_id=5,  # AAPL
            qty=Decimal("10"),
            cost_in_base=Decimal("1000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable (buying is not taxable)
        assert len(result.realized_entries) == 0

        # Should create lot for AAPL
        assert len(result.created_lots) == 1
        aapl_lot = result.created_lots[0]
        assert aapl_lot.asset_id == 5
        assert aapl_lot.qty == Decimal("10")
        assert aapl_lot.total_cost == Decimal("1000")  # Cost = EUR spent
        assert aapl_lot.unit_cost == Decimal("100")  # 1000/10


class TestSellScenarios:
    """Test SELL scenarios (Asset → EUR)."""

    def test_sell_to_base_currency_taxable(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 2: Sell AAPL for EUR - taxable, realizes P&L."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund AAPL with cost basis of 80 per share
        aapl_lot = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("80"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell 5 AAPL for 500 EUR (price = 100)
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,  # AAPL
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable
        assert len(result.realized_entries) == 1
        entry = result.realized_entries[0]
        assert entry.disposal_taxable is True
        assert entry.qty == Decimal("5")
        assert entry.proceeds_in_base == Decimal("500")
        assert entry.cost_basis_in_base == Decimal("400")  # 5 * 80
        assert entry.pnl_in_base == Decimal("100")  # 500 - 400

        # Should create lot for EUR received
        assert len(result.created_lots) == 1
        eur_lot = result.created_lots[0]
        assert eur_lot.asset_id == 1  # EUR


class TestSwapScenarios:
    """Test SWAP scenarios (Asset1 → Asset2)."""

    def test_crypto_swap_taxable_when_configured(
        self, taxable_swap_config, mock_price_service, base_datetime
    ):
        """Case 3: Swap BTC → ETH - taxable when configured (e.g., US jurisdiction)."""
        lot_manager = LotManager(taxable_swap_config)
        fmv_service = FMVService(mock_price_service, taxable_swap_config)

        # Pre-fund BTC with cost basis of 30000
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        lot_manager.add_lot(btc_lot)

        # Swap 1 BTC (FMV 40000) → 16 ETH (FMV 2500 each = 40000)
        group = create_swap_group(
            base_dt=base_datetime,
            from_asset_id=2,  # BTC
            from_qty=Decimal("1"),
            to_asset_id=3,  # ETH
            to_qty=Decimal("16"),
            from_value_in_base=Decimal("40000"),
            to_value_in_base=Decimal("40000"),
        )

        result = handle_unit(
            group, lot_manager, fmv_service, taxable_swap_config
        )

        # Should be taxable (crypto swap configured as taxable)
        assert len(result.realized_entries) == 1
        entry = result.realized_entries[0]
        assert entry.disposal_taxable is True
        assert entry.proceeds_in_base == Decimal("40000")  # FMV of BTC
        assert entry.cost_basis_in_base == Decimal("30000")
        assert entry.pnl_in_base == Decimal("10000")

        # ETH lot should have cost basis = proceeds
        eth_lot = [l for l in result.created_lots if l.asset_id == 3][0]
        assert eth_lot.total_cost == Decimal("40000")

    def test_crypto_swap_non_taxable_by_default(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Swap is non-taxable by default - cost basis transfers."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund BTC
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        lot_manager.add_lot(btc_lot)

        group = create_swap_group(
            base_dt=base_datetime,
            from_asset_id=2,
            from_qty=Decimal("1"),
            to_asset_id=3,
            to_qty=Decimal("16"),
            from_value_in_base=Decimal("40000"),
            to_value_in_base=Decimal("40000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable (default)
        assert len(result.realized_entries) == 0

        # ETH lot should inherit original cost basis
        eth_lot = [l for l in result.created_lots if l.asset_id == 3][0]
        assert eth_lot.total_cost == Decimal("30000")  # Original cost


class TestTransferScenarios:
    """Test TRANSFER scenarios (same asset, different accounts)."""

    def test_internal_transfer_not_taxable(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 9a: Transfer BTC between accounts - not taxable, lot travels."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund BTC in account 1
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(btc_lot)

        # Transfer 1 BTC from account 1 to account 2
        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            from_account_id=1,
            to_account_id=2,
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_entries) == 0

        # Should create new lot in account 2 with same cost basis
        new_lot = result.created_lots[0]
        assert new_lot.account_id == 2
        assert new_lot.total_cost == Decimal("30000")  # Preserved
        assert new_lot.acquired_at == btc_lot.acquired_at  # Holding period preserved

    def test_transfer_with_fee(self, fifo_config, mock_price_service, base_datetime):
        """Case 9b: Transfer with fee - fee consumption is logged but NOT taxable by default."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund BTC: 1.001 to cover transfer (1) + fee (0.001)
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.001"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(btc_lot)

        # Transfer 1 BTC with 0.001 BTC fee
        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            from_account_id=1,
            to_account_id=2,
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Fee is consumed (logged) but NOT taxable by default
        # Two consumed slices: 1 BTC for transfer + 0.001 BTC for fee
        assert len(result.consumed_slices) == 2

        # Fee entries should be empty since fees are not taxable by default
        assert len(result.fee_entries) == 0

        # Transfer itself should not be taxable either
        assert len(result.realized_entries) == 0

    def test_transfer_preserves_individual_slices(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Transfer from multiple lots should preserve each lot's holding period."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund with TWO lots at different times/costs
        lot1 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("0.5"),
            unit_cost=Decimal("20000"),  # Bought at $20k
            acquired_at=base_datetime - timedelta(days=400),  # Old lot
        )
        lot2 = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("0.5"),
            unit_cost=Decimal("40000"),  # Bought at $40k
            acquired_at=base_datetime - timedelta(days=30),  # Recent lot
        )
        lot_manager.add_lot(lot1)
        lot_manager.add_lot(lot2)

        # Transfer full 1 BTC from account 1 to account 2
        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            from_account_id=1,
            to_account_id=2,
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_entries) == 0

        # Should create TWO new lots (one per consumed slice)
        assert len(result.created_lots) == 2

        # Each lot should preserve its original holding period
        new_lots = sorted(result.created_lots, key=lambda l: l.qty)
        
        # Both should be 0.5 BTC
        assert new_lots[0].qty == Decimal("0.5")
        assert new_lots[1].qty == Decimal("0.5")
        
        # Should preserve individual costs
        assert new_lots[0].unit_cost == Decimal("20000")
        assert new_lots[1].unit_cost == Decimal("40000")
        
        # Should preserve individual acquired_at dates
        assert new_lots[0].acquired_at == lot1.acquired_at
        assert new_lots[1].acquired_at == lot2.acquired_at
        
        # Both should be in account 2
        assert new_lots[0].account_id == 2
        assert new_lots[1].account_id == 2


class TestSplitScenarios:
    """Test SPLIT scenarios (same asset, qty changes)."""

    def test_stock_split_not_taxable(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 10: Stock split (2:1) - not taxable, cost basis preserved."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund AAPL: 100 shares at $100 each = $10000 cost basis
        aapl_lot = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("100"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # 2:1 split: 100 shares → 200 shares
        group = create_split_group(
            base_dt=base_datetime,
            asset_id=5,
            from_qty=Decimal("100"),
            to_qty=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_entries) == 0

        # Should create new lot with same total cost basis, but 200 shares
        new_lot = result.created_lots[0]
        assert new_lot.qty == Decimal("200")
        assert new_lot.total_cost == Decimal("10000")  # Same total cost
        assert new_lot.unit_cost == Decimal("50")  # 10000/200
        assert new_lot.acquired_at == aapl_lot.acquired_at  # Holding period preserved

    def test_split_preserves_individual_slices(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Split from multiple lots should preserve each lot's holding period with scaled qty."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund with TWO AAPL lots at different times
        lot1 = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("60"),  # 60 shares at $80
            unit_cost=Decimal("80"),
            acquired_at=base_datetime - timedelta(days=400),  # Old lot
        )
        lot2 = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("40"),  # 40 shares at $120
            unit_cost=Decimal("120"),
            acquired_at=base_datetime - timedelta(days=30),  # Recent lot
        )
        lot_manager.add_lot(lot1)
        lot_manager.add_lot(lot2)

        # 2:1 split: 100 shares → 200 shares
        group = create_split_group(
            base_dt=base_datetime,
            asset_id=5,
            from_qty=Decimal("100"),
            to_qty=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_entries) == 0

        # Should create TWO new lots (one per consumed slice)
        assert len(result.created_lots) == 2

        # Sort by qty to identify
        new_lots = sorted(result.created_lots, key=lambda l: l.qty)
        
        # Lot1 had 60 shares → 120 shares, cost $4800 total
        # Lot2 had 40 shares → 80 shares, cost $4800 total
        assert new_lots[0].qty == Decimal("80")  # From lot2 (40 * 2)
        assert new_lots[1].qty == Decimal("120")  # From lot1 (60 * 2)
        
        # Total cost preserved per lot
        assert new_lots[0].total_cost == Decimal("4800")  # 40 * 120
        assert new_lots[1].total_cost == Decimal("4800")  # 60 * 80
        
        # Unit cost adjusted (halved due to 2:1 split)
        assert new_lots[0].unit_cost == Decimal("60")  # 120/2
        assert new_lots[1].unit_cost == Decimal("40")  # 80/2
        
        # Holding periods preserved
        assert new_lots[0].acquired_at == lot2.acquired_at  # Recent
        assert new_lots[1].acquired_at == lot1.acquired_at  # Old


class TestAirdropScenarios:
    """Test AIRDROP scenarios (inflow only)."""

    def test_airdrop_creates_lot_at_fmv(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 12: Airdrop - not taxable acquisition, cost basis = FMV."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Receive 100 tokens worth 1000 EUR
        group = create_airdrop_group(
            base_dt=base_datetime,
            asset_id=3,  # ETH
            qty=Decimal("1"),
            fmv_in_base=Decimal("2500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable (acquisition)
        assert len(result.realized_entries) == 0

        # Should create lot at FMV
        assert len(result.created_lots) == 1
        new_lot = result.created_lots[0]
        assert new_lot.asset_id == 3
        assert new_lot.qty == Decimal("1")
        assert new_lot.total_cost_in_base == Decimal("2500")  # FMV


class TestPaymentScenarios:
    """Test PAYMENT scenarios (outflow only)."""

    def test_payment_taxable_disposal(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 11: Payment - taxable disposal."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund BTC
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        lot_manager.add_lot(btc_lot)

        # Pay 0.1 BTC (FMV = 4000 EUR)
        group = create_payment_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("0.1"),
            fmv_in_base=Decimal("4000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable
        assert len(result.realized_entries) == 1
        entry = result.realized_entries[0]
        assert entry.disposal_taxable is True
        assert entry.qty == Decimal("0.1")
        assert entry.proceeds_in_base == Decimal("4000")  # FMV
        assert entry.cost_basis_in_base == Decimal("3000")  # 0.1 * 30000
        assert entry.pnl_in_base == Decimal("1000")  # 4000 - 3000


class TestForexScenarios:
    """Test forex scenarios (foreign fiat)."""

    def test_foreign_fiat_disposal_taxable(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Case 7/8: Disposing CHF for EUR - forex gain/loss taxable."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # Pre-fund CHF with cost basis of 0.85 EUR per CHF
        chf_lot = create_lot(
            asset_id=6,
            account_id=1,
            qty=Decimal("1000"),
            unit_cost=Decimal("0.85"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        lot_manager.add_lot(chf_lot)

        # Sell 1000 CHF for 900 EUR (rate = 0.90)
        group = MockGroup(
            group_id=1,
            transactions=[
                MockTransaction(
                    id=1,
                    direction="outflow",
                    asset_id=6,  # CHF
                    quantity=Decimal("1000"),
                    date_time=base_datetime,
                    total_in_base=Decimal("900"),
                ),
                MockTransaction(
                    id=2,
                    direction="inflow",
                    asset_id=1,  # EUR
                    quantity=Decimal("900"),
                    date_time=base_datetime,
                ),
            ],
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable (forex gain)
        assert len(result.realized_entries) == 1
        entry = result.realized_entries[0]
        assert entry.disposal_taxable is True
        assert entry.proceeds_in_base == Decimal("900")
        assert entry.cost_basis_in_base == Decimal("850")  # 1000 * 0.85
        assert entry.pnl_in_base == Decimal("50")  # Forex gain


class TestEdgeCases:
    """Test edge cases and error handling."""

    def test_insufficient_lots_warning(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Should add warning when lots are insufficient."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        # No pre-funding
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("10"),
            proceeds_in_base=Decimal("1000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have warning
        assert len(result.warnings) >= 1
        assert any("Insufficient" in w.message for w in result.warnings)

    def test_empty_group(self, fifo_config, mock_price_service, base_datetime):
        """Should handle empty group gracefully."""
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)
        

        group = MockGroup(group_id=1, transactions=[])

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_entries) == 0
        assert len(result.created_lots) == 0


class TestBaseCurrencyLotCreation:
    """Test that base currency (EUR) lots are always created for visibility."""

    def test_sell_creates_eur_lot_even_when_settling_negative(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Case: Fee payment creates negative EUR lot, then SELL receives EUR.
        The EUR inflow should create a lot for UI visibility even if fully settled.
        """
        # Enable negative balances
        fifo_config.allow_negative_balances = True
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Create a negative EUR lot (simulating prior fee payment without balance)
        negative_lot = create_lot(
            asset_id=1,  # EUR (base currency)
            account_id=1,
            qty=Decimal("-100"),  # Negative - owed
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=1),
        )
        negative_lot.is_negative = True
        lot_manager.negative_lots_map[(1, 1)] = [negative_lot]  # (account_id, asset_id)

        # Pre-fund AAPL for the sell
        aapl_lot = create_lot(
            asset_id=5,  # AAPL
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("80"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell 5 AAPL for 500 EUR - this should settle the -100 EUR and leave 400 EUR
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should create EUR lot even though part was used for settlement
        eur_lots = [lot for lot in result.created_lots if lot.asset_id == 1]
        assert len(eur_lots) == 1, "EUR lot should be created for UI visibility"
        
        eur_lot = eur_lots[0]
        assert eur_lot.qty == Decimal("500"), "Lot should show full inflow quantity"
        assert eur_lot.qty_remaining == Decimal("400"), "400 EUR remaining after settling 100"
        assert eur_lot.unit_cost_in_base == Decimal("1"), "Base currency always unit_cost=1"
        assert "Settled" in (eur_lot.notes or ""), "Notes should mention settlement"

    def test_sell_creates_eur_lot_fully_settled(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Case: Negative EUR exactly matches sell proceeds - lot still created with qty_remaining=0.
        """
        fifo_config.allow_negative_balances = True
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Create negative EUR lot equal to sell proceeds
        negative_lot = create_lot(
            asset_id=1,
            account_id=1,
            qty=Decimal("-500"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=1),
        )
        negative_lot.is_negative = True
        lot_manager.negative_lots_map[(1, 1)] = [negative_lot]

        # Pre-fund AAPL
        aapl_lot = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("80"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell 5 AAPL for 500 EUR - exactly matches negative lot
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should still create EUR lot for visibility
        eur_lots = [lot for lot in result.created_lots if lot.asset_id == 1]
        assert len(eur_lots) == 1, "EUR lot should be created even when fully settled"
        
        eur_lot = eur_lots[0]
        assert eur_lot.qty == Decimal("500"), "Lot shows full inflow"
        assert eur_lot.qty_remaining == Decimal("0"), "Fully consumed by settlement"
        assert "Settled 500" in (eur_lot.notes or ""), "Notes should show full settlement"


class TestSettlementRecordGeneration:
    """Test that settlement records are generated for audit trail."""

    def test_settlement_records_created_on_partial_settlement(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Settlement records should be created when negative lot is partially settled.
        
        Scenario: Sell before buy creates negative EUR, later sell settles part of it.
        """
        fifo_config.allow_negative_balances = True
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Create negative EUR lot of 200 EUR
        negative_lot = create_lot(
            asset_id=1,  # EUR
            account_id=1,
            qty=Decimal("-200"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=5),
        )
        negative_lot.is_negative = True
        lot_manager.negative_lots_map[(1, 1)] = [negative_lot]

        # Pre-fund AAPL
        aapl_lot = create_lot(
            asset_id=5,  # AAPL
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell 1 AAPL for 100 EUR - should settle 100 of the 200 negative lot
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("100"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have settlement records
        assert hasattr(result, 'settlement_records')
        assert len(result.settlement_records) == 1, "Should have 1 settlement record"
        
        settlement = result.settlement_records[0]
        assert settlement.negative_lot_uuid == negative_lot.lot_uuid
        assert settlement.qty_settled == Decimal("100")
        # The settling_lot_uuid should match the EUR lot created
        assert settlement.settling_lot_uuid is not None

    def test_settlement_records_created_on_full_settlement(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Settlement records should be created when negative lot is fully settled.
        """
        fifo_config.allow_negative_balances = True
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Create negative EUR lot of 100 EUR
        negative_lot = create_lot(
            asset_id=1,  # EUR
            account_id=1,
            qty=Decimal("-100"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=5),
        )
        negative_lot.is_negative = True
        lot_manager.negative_lots_map[(1, 1)] = [negative_lot]

        # Pre-fund AAPL
        aapl_lot = create_lot(
            asset_id=5,  # AAPL
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell 2 AAPL for 200 EUR - fully settles 100 negative, 100 remaining
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have settlement records
        assert len(result.settlement_records) == 1
        settlement = result.settlement_records[0]
        assert settlement.qty_settled == Decimal("100"), "Should settle the full negative lot"

        # Negative lot should be fully settled (qty_remaining = 0)
        assert negative_lot.qty_remaining == Decimal("0")

    def test_multi_inflow_settlement_scenario(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Test the complete multi-inflow settlement scenario:
        1. BUY 3 BTC with 100€ → negative EUR lot created for 100€
        2. SELL 2 AAPL for 50€ → negative EUR adjusted (50€ settled)
        3. SELL 1 MSFT for 80€ → negative EUR fully settled (50€), +30€ remaining
        """
        fifo_config.allow_negative_balances = True
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Step 1: Buy BTC creates negative EUR lot
        # First we need some BTC to dispose (or we create the negative lot directly)
        # For simplicity, let's simulate the negative lot that would be created
        negative_eur = create_lot(
            asset_id=1,  # EUR
            account_id=1,
            qty=Decimal("-100"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime,
        )
        negative_eur.is_negative = True
        lot_manager.negative_lots_map[(1, 1)] = [negative_eur]

        # Pre-fund AAPL and MSFT
        aapl_lot = create_lot(
            asset_id=5,  # AAPL
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("20"),  # Bought at 20€ each
            acquired_at=base_datetime - timedelta(days=400),
        )
        lot_manager.add_lot(aapl_lot)

        msft_lot = create_lot(
            asset_id=6,  # MSFT (assume asset_id 6)
            account_id=1,
            qty=Decimal("5"),
            unit_cost=Decimal("50"),
            acquired_at=base_datetime - timedelta(days=200),
        )
        lot_manager.add_lot(msft_lot)

        # Step 2: Sell 2 AAPL for 50€ - settles 50€ of the 100€ negative lot
        sell_aapl = create_sell_group(
            base_dt=base_datetime + timedelta(days=1),
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("50"),
        )

        result1 = handle_unit(sell_aapl, lot_manager, fmv_service, fifo_config)

        # Should have 1 settlement record
        assert len(result1.settlement_records) == 1
        assert result1.settlement_records[0].qty_settled == Decimal("50")
        
        # Negative lot should still have 50 unsettled
        assert negative_eur.qty_remaining == Decimal("-50")

        # Step 3: Sell 1 MSFT for 80€ - settles remaining 50€, leaves 30€
        sell_msft = create_sell_group(
            base_dt=base_datetime + timedelta(days=2),
            asset_id=6,  # MSFT
            qty=Decimal("1"),
            proceeds_in_base=Decimal("80"),
        )

        result2 = handle_unit(sell_msft, lot_manager, fmv_service, fifo_config)

        # Should have 1 settlement record for the remaining 50
        assert len(result2.settlement_records) == 1
        assert result2.settlement_records[0].qty_settled == Decimal("50")

        # Negative lot should be fully settled now
        assert negative_eur.qty_remaining == Decimal("0")

        # EUR lot created should have 30 remaining (80 - 50 settled)
        eur_lots = [l for l in result2.created_lots if l.asset_id == 1]
        assert len(eur_lots) == 1
        assert eur_lots[0].qty == Decimal("80")
        assert eur_lots[0].qty_remaining == Decimal("30")

    def test_no_settlement_records_when_no_negative_lots(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        No settlement records should be created when there are no negative lots.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund AAPL
        aapl_lot = create_lot(
            asset_id=5,
            account_id=1,
            qty=Decimal("10"),
            unit_cost=Decimal("100"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        lot_manager.add_lot(aapl_lot)

        # Sell AAPL - no negative lots to settle
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have no settlement records (list should be empty)
        assert hasattr(result, 'settlement_records')
        assert len(result.settlement_records) == 0


class TestFeeHandling:
    """Test fee handling and proceeds calculation for fee legs."""

    def test_fee_uses_fmv_not_base_inflows(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Fee legs should use FMV for proceeds, not base currency inflows.
        
        Scenario: Sell 1 BTC for 50,000 EUR with 0.001 BTC fee
        - BTC outflow proceeds = 50,000 EUR (from inflow)
        - BTC fee proceeds = FMV of 0.001 BTC = 40 EUR (NOT 50,000 EUR!)
        """
        from tests.unit.pnl.conftest import create_sell_with_fee_group
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC with cost basis of 30,000 per BTC
        btc_lot = create_lot(
            asset_id=2,  # BTC
            account_id=1,
            qty=Decimal("1.001"),  # Enough for sale + fee
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Sell 1 BTC for 50,000 EUR with 0.001 BTC fee
        # BTC FMV = 40,000 (from mock_price_service)
        group = create_sell_with_fee_group(
            base_dt=base_datetime,
            asset_id=2,  # BTC
            qty=Decimal("1"),
            proceeds_in_base=Decimal("50000"),
            fee_asset_id=2,  # BTC fee
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have 2 realized entries: 1 for sale, 1 for fee
        assert len(result.realized_pnl_records) == 2

        # Find sale entry (non-fee, larger qty)
        sale_entries = [e for e in result.realized_pnl_records if e.qty == Decimal("1")]
        assert len(sale_entries) == 1
        sale_entry = sale_entries[0]
        
        # Sale: proceeds = 50,000 EUR (actual inflow)
        assert sale_entry.proceeds_in_base == Decimal("50000")
        assert sale_entry.cost_basis_in_base == Decimal("30000")  # 1 * 30,000
        assert sale_entry.pnl_in_base == Decimal("20000")  # 50k - 30k

        # Find fee entry (smaller qty)
        fee_entries = [e for e in result.realized_pnl_records if e.qty == Decimal("0.001")]
        assert len(fee_entries) == 1
        fee_entry = fee_entries[0]
        
        # Fee: proceeds = FMV = 0.001 * 40,000 = 40 EUR (NOT 50,000!)
        assert fee_entry.proceeds_in_base == Decimal("40")  # 0.001 * 40,000 FMV
        assert fee_entry.cost_basis_in_base == Decimal("30")  # 0.001 * 30,000 cost
        assert fee_entry.pnl_in_base == Decimal("10")  # 40 - 30

    def test_fee_standalone_uses_fmv(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Standalone fee (no inflows) should use FMV for proceeds.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund ETH
        eth_lot = create_lot(
            asset_id=3,  # ETH
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("2000"),  # Cost 2000 EUR
            acquired_at=base_datetime - timedelta(days=100),
        )
        seed_lot(lot_manager, eth_lot)

        # Fee-only unit (e.g., network fee on failed tx)
        fee_tx = make_transaction(id=50, asset_id=3, quantity=Decimal("0.01"), date_time=base_datetime)
        legs = [
            make_leg(asset_id=3, leg_type="fee", quantity=Decimal("0.01"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern=None, unit_label="Fee-only tx")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have 1 realized entry for the fee
        assert len(result.realized_pnl_records) == 1
        fee_entry = result.realized_pnl_records[0]
        
        # Fee proceeds = FMV = 0.01 * 2500 = 25 EUR
        assert fee_entry.proceeds_in_base == Decimal("25")
        assert fee_entry.cost_basis_in_base == Decimal("20")  # 0.01 * 2000
        assert fee_entry.pnl_in_base == Decimal("5")  # 25 - 20

    def test_fee_entry_created_for_fee_legs(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        FeeEntry index records should be created for fee legs.
        """
        from tests.unit.pnl.conftest import create_sell_with_fee_group
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.001"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        group = create_sell_with_fee_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("50000"),
            fee_asset_id=2,
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have fee_entries on the unit
        assert hasattr(result, 'fee_entries')
        assert len(result.fee_entries) == 1
        
        fee_entry_idx = result.fee_entries[0]
        # FeeEntry should link to the fee leg and realized_pnl
        assert fee_entry_idx.fee_leg is not None
        assert fee_entry_idx.realized_pnl is not None
        # FeeEntry.fee_value_in_base should store the fee value directly
        assert fee_entry_idx.fee_value_in_base == Decimal("40")  # 0.001 * 40,000 FMV


class TestProRataAllocation:
    """Test pro-rata allocation of proceeds for multiple outflow legs (same asset)."""

    def test_multiple_outflow_legs_prorata_allocation(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        When selling same asset from multiple legs, proceeds should be
        allocated proportionally based on quantity.
        
        Scenario: Sell 1 BTC (leg1) + 0.5 BTC (leg2) for 60,000 EUR total
        - Leg1 proportion = 1 / 1.5 = 66.67%
        - Leg2 proportion = 0.5 / 1.5 = 33.33%
        - Leg1 proceeds = 60,000 * (1/1.5) = 40,000
        - Leg2 proceeds = 60,000 * (0.5/1.5) = 20,000
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC (enough for both legs)
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.5"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Create two BTC outflow legs + EUR inflow
        btc_outflow1_tx = make_transaction(id=30, asset_id=2, quantity=Decimal("1"), date_time=base_datetime)
        btc_outflow2_tx = make_transaction(id=31, asset_id=2, quantity=Decimal("0.5"), date_time=base_datetime)
        eur_inflow_tx = make_transaction(id=32, asset_id=1, quantity=Decimal("60000"), date_time=base_datetime)
        
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=btc_outflow1_tx),
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("0.5"), transaction=btc_outflow2_tx),
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("60000"), transaction=eur_inflow_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Multi-leg BTC sell for 60000 EUR")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have 2 realized entries (one per outflow leg)
        assert len(result.realized_pnl_records) == 2

        # Find entries by qty
        leg1_entry = next(e for e in result.realized_pnl_records if e.qty == Decimal("1"))
        leg2_entry = next(e for e in result.realized_pnl_records if e.qty == Decimal("0.5"))

        # Check pro-rata allocation by quantity
        # Leg1: 60,000 * (1 / 1.5) = 40,000
        # Leg2: 60,000 * (0.5 / 1.5) = 20,000
        assert abs(leg1_entry.proceeds_in_base - Decimal("40000")) < Decimal("1")
        assert abs(leg2_entry.proceeds_in_base - Decimal("20000")) < Decimal("1")
        
        # Verify total proceeds equals inflow
        total_allocated = leg1_entry.proceeds_in_base + leg2_entry.proceeds_in_base
        assert abs(total_allocated - Decimal("60000")) < Decimal("1")

    def test_single_outflow_gets_full_proceeds(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        When there's only one outflow, it should get full proceeds (no pro-rata needed).
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Single asset sell
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("50000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        
        # Should get full proceeds
        assert entry.proceeds_in_base == Decimal("50000")

    def test_multi_leg_sell_with_fee_correct_allocation(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Multi-leg sell (same asset) with fee: fee uses FMV, outflows share proceeds pro-rata by qty.
        
        Scenario: Sell 1 BTC (leg1) + 0.5 BTC (leg2) for 60,000 EUR, with 0.001 BTC fee
        - Fee proceeds = FMV of 0.001 BTC = 40 EUR (separate from main proceeds)
        - Remaining outflows share 60,000 EUR pro-rata by quantity
        - Leg1: 60,000 * (1 / 1.5) = 40,000
        - Leg2: 60,000 * (0.5 / 1.5) = 20,000
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC (enough for sale + fee)
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.501"),  # 1 + 0.5 + 0.001
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Create multi-leg BTC sell with fee
        btc_outflow1_tx = make_transaction(id=60, asset_id=2, quantity=Decimal("1"), date_time=base_datetime)
        btc_outflow2_tx = make_transaction(id=61, asset_id=2, quantity=Decimal("0.5"), date_time=base_datetime)
        eur_inflow_tx = make_transaction(id=62, asset_id=1, quantity=Decimal("60000"), date_time=base_datetime)
        fee_tx = make_transaction(id=63, asset_id=2, quantity=Decimal("0.001"), date_time=base_datetime)
        
        legs = [
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("1"), transaction=btc_outflow1_tx),
            make_leg(asset_id=2, leg_type="outflow", quantity=Decimal("0.5"), transaction=btc_outflow2_tx),
            make_leg(asset_id=1, leg_type="inflow", quantity=Decimal("60000"), transaction=eur_inflow_tx),
            make_leg(asset_id=2, leg_type="fee", quantity=Decimal("0.001"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Multi-leg BTC sell with fee")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have 3 realized entries: 2 BTC sales + 1 BTC fee
        assert len(result.realized_pnl_records) == 3

        # Find fee entry (qty = 0.001)
        fee_entries = [e for e in result.realized_pnl_records if e.qty == Decimal("0.001")]
        assert len(fee_entries) == 1
        fee_entry = fee_entries[0]
        
        # Fee should use FMV, NOT the 60,000 EUR inflow
        # Fee FMV = 0.001 * 40,000 = 40 EUR
        assert fee_entry.proceeds_in_base == Decimal("40")

        # Find sale entries (qty = 1 or 0.5)
        sale_entries = [e for e in result.realized_pnl_records if e.qty in [Decimal("1"), Decimal("0.5")]]
        assert len(sale_entries) == 2
        
        # Check pro-rata allocation by quantity
        leg1_entry = next(e for e in sale_entries if e.qty == Decimal("1"))
        leg2_entry = next(e for e in sale_entries if e.qty == Decimal("0.5"))
        
        # Leg1: 60,000 * (1 / 1.5) = 40,000
        # Leg2: 60,000 * (0.5 / 1.5) = 20,000
        assert abs(leg1_entry.proceeds_in_base - Decimal("40000")) < Decimal("1")
        assert abs(leg2_entry.proceeds_in_base - Decimal("20000")) < Decimal("1")
        
        # Total proceeds allocated to sales should equal 60,000
        total_sale_proceeds = sum(e.proceeds_in_base for e in sale_entries)
        assert abs(total_sale_proceeds - Decimal("60000")) < Decimal("1")
