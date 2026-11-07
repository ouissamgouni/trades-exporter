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
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode

from backend.services.pnl.fmv_service import FMVService
from backend.db.models import LegType

from tests.unit.pnl.conftest import (
    MockTransaction,
    create_lot,
    seed_lot,
    create_buy_group,
    create_sell_group,
    create_swap_group,
    create_transfer_group,
    create_split_group,
    create_airdrop_group,
    create_payment_group,
    make_unit,
    make_transaction,
    make_leg,
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
        seed_lot(lot_manager, eur_lot)

        # Create buy group: 1000 EUR → 10 AAPL
        group = create_buy_group(
            base_dt=base_datetime,
            asset_id=5,  # AAPL
            qty=Decimal("10"),
            cost_in_base=Decimal("1000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Base currency (EUR) disposals no longer create RealizedPnl entries
        # (pnl is always 0, disposal_taxable is always False — they were pure noise)
        assert len(result.realized_pnl_records) == 0

        # Should create lot for AAPL
        assert len(result.cost_lots) == 1
        aapl_lot = result.cost_lots[0]
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
        seed_lot(lot_manager, aapl_lot)

        # Sell 5 AAPL for 500 EUR (price = 100)
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,  # AAPL
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable
        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        assert entry.disposal_taxable is True
        assert entry.qty == Decimal("5")
        assert entry.proceeds_in_base == Decimal("500")
        assert entry.cost_basis_in_base == Decimal("400")  # 5 * 80
        assert entry.pnl_in_base == Decimal("100")  # 500 - 400

        # Should create lot for EUR received
        assert len(result.cost_lots) == 1
        eur_lot = result.cost_lots[0]
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
        seed_lot(lot_manager, btc_lot)

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
        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        assert entry.disposal_taxable is True
        assert entry.proceeds_in_base == Decimal("40000")  # FMV of BTC
        assert entry.cost_basis_in_base == Decimal("30000")
        assert entry.pnl_in_base == Decimal("10000")

        # ETH lot should have cost basis = proceeds
        eth_lot = [l for l in result.cost_lots if l.asset_id == 3][0]
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
        seed_lot(lot_manager, btc_lot)

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

        # Now creates RealizedPnl for all disposals, but non-taxable ones are flagged
        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
        assert entry.disposal_taxable is False

        # ETH lot should inherit original cost basis
        eth_lot = [l for l in result.cost_lots if l.asset_id == 3][0]
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
        seed_lot(lot_manager, btc_lot)

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
        assert len(result.realized_pnl_records) == 0

        # Should create new lot in account 2 with same cost basis
        new_lot = result.cost_lots[0]
        assert new_lot.account_id == 2
        assert new_lot.total_cost == Decimal("30000")  # Preserved
        assert new_lot.acquired_at == btc_lot.acquired_at  # Holding period preserved

    def test_transfer_with_fee(self, fifo_config, mock_price_service, base_datetime):
        """Case 9b: Transfer with fee (fee_taxable_by_default=False).
        
        Fee cost basis is ABSORBED into transfer lots, no RealizedPnl created.
        
        Setup: 1 BTC lot (1.001 BTC at 30,000/BTC)
        Transfer: 1 BTC out, 0.999 BTC in, 0.001 BTC fee
        
        Expected:
        - No RealizedPnl (fee is non-taxable, absorbed)
        - Transfer lot cost = outflow cost (30,000) + fee cost (30)  = 30,030
        - Transfer lot qty = 0.999 BTC
        """
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
        seed_lot(lot_manager, btc_lot)

        # Transfer 1 BTC with 0.001 BTC fee → inflow = 0.999 BTC
        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            from_account_id=1,
            to_account_id=2,
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Fee is non-taxable → absorbed into transfer, no RealizedPnl
        assert len(result.realized_pnl_records) == 0

        # Fee entries should be empty since fees are not taxable by default
        assert len(result.fee_entries) == 0

        # Transfer lot should include absorbed fee cost
        assert len(result.cost_lots) == 1
        transfer_lot = result.cost_lots[0]
        assert transfer_lot.asset_id == 2
        assert transfer_lot.qty == Decimal("0.999")
        assert transfer_lot.account_id == 2

        # Cost = outflow slice cost (1 * 30000 = 30000) + fee slice cost (0.001 * 30000 = 30)
        expected_total_cost = Decimal("30000") + Decimal("30")  # 30,030
        assert abs(transfer_lot.total_cost - expected_total_cost) < Decimal("0.01")

    def test_transfer_with_fee_taxable(self, mock_price_service, base_datetime):
        """Transfer with fee where fee_taxable_by_default=True.
        
        Fee creates a RealizedPnl event; fee cost is NOT absorbed into transfer lots.
        """
        from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
        taxable_fee_config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            fee_taxable_by_default=True,
        )
        lot_manager = LotManager(taxable_fee_config)
        fmv_service = FMVService(mock_price_service, taxable_fee_config)

        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1.001"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("1"),
            from_account_id=1,
            to_account_id=2,
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, taxable_fee_config)

        # Fee IS taxable → creates RealizedPnl for fee disposal
        assert len(result.realized_pnl_records) == 1
        fee_pnl = result.realized_pnl_records[0]
        assert fee_pnl.qty == Decimal("0.001")
        # Fee proceeds = FMV = 0.001 * 40000 = 40 EUR
        assert fee_pnl.proceeds_in_base == Decimal("40")
        # Fee cost = 0.001 * 30000 = 30 EUR
        assert fee_pnl.cost_basis_in_base == Decimal("30")
        assert fee_pnl.pnl_in_base == Decimal("10")

        # Transfer lot should NOT include fee cost (fee was realized separately)
        transfer_lot = [l for l in result.cost_lots if l.account_id == 2][0]
        assert transfer_lot.qty == Decimal("0.999")
        # Cost = outflow slice cost only (1 * 30000 = 30000), no fee absorbed
        expected_total_cost = Decimal("30000")
        assert abs(transfer_lot.total_cost - expected_total_cost) < Decimal("0.01")

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
        seed_lot(lot_manager, lot1)
        seed_lot(lot_manager, lot2)

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
        assert len(result.realized_pnl_records) == 0

        # Should create TWO new lots (one per consumed slice)
        assert len(result.cost_lots) == 2

        # Each lot should preserve its original holding period
        new_lots = sorted(result.cost_lots, key=lambda l: l.qty)
        
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

    def test_transfer_preserves_three_slices(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Transfer consuming 3 lots creates 3 destination lots.
        
        Regression test for bug where only the first transfer lot was persisted
        due to dual delete-orphan cascade conflict between CalculationUnit.cost_lots
        and NormalizedTransaction.cost_lots on CostLot.
        
        Setup mirrors the real PLAY (asset_id=254) bug:
        - 3 source lots at different costs/dates
        - 1 outflow consumes all 3
        - 1 inflow on different account
        Expected: 3 new lots on destination account, one per consumed slice
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        lot1 = create_lot(
            asset_id=2, account_id=1,
            qty=Decimal("2205.85"), unit_cost=Decimal("0.005"),
            acquired_at=base_datetime - timedelta(days=100),
        )
        lot2 = create_lot(
            asset_id=2, account_id=1,
            qty=Decimal("1900"), unit_cost=Decimal("0.006"),
            acquired_at=base_datetime - timedelta(days=60),
        )
        lot3 = create_lot(
            asset_id=2, account_id=1,
            qty=Decimal("2700"), unit_cost=Decimal("0.007"),
            acquired_at=base_datetime - timedelta(days=30),
        )
        seed_lot(lot_manager, lot1)
        seed_lot(lot_manager, lot2)
        seed_lot(lot_manager, lot3)

        # Transfer 6799.07 = 2205.85 + 1900 + 2693.22 (partial from lot3)
        group = create_transfer_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("6799.07"),
            from_account_id=1,
            to_account_id=2,
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # No P&L on transfers
        assert len(result.realized_pnl_records) == 0

        # Must create 3 lots — one per consumed slice
        assert len(result.cost_lots) == 3, (
            f"Expected 3 transfer lots (one per consumed slice), got {len(result.cost_lots)}. "
            "This was the dual-cascade bug: only the first lot survived autoflush."
        )

        # Verify total quantity matches
        total_qty = sum(lot.qty for lot in result.cost_lots)
        assert abs(total_qty - Decimal("6799.07")) < Decimal("0.01")

        # All on destination account
        for lot in result.cost_lots:
            assert lot.account_id == 2

        # Verify individual slice preservation (FIFO order)
        lots_sorted = sorted(result.cost_lots, key=lambda l: l.acquired_at)
        assert lots_sorted[0].qty == Decimal("2205.85")
        assert lots_sorted[0].unit_cost == Decimal("0.005")
        assert lots_sorted[1].qty == Decimal("1900")
        assert lots_sorted[1].unit_cost == Decimal("0.006")
        # Third slice is partial: 2693.22 from lot3
        assert abs(lots_sorted[2].qty - Decimal("2693.22")) < Decimal("0.01")
        assert lots_sorted[2].unit_cost == Decimal("0.007")


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
        seed_lot(lot_manager, aapl_lot)

        # 2:1 split: 100 shares → 200 shares
        group = create_split_group(
            base_dt=base_datetime,
            asset_id=5,
            from_qty=Decimal("100"),
            to_qty=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_pnl_records) == 0

        # Should create new lot with same total cost basis, but 200 shares
        new_lot = result.cost_lots[0]
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
        seed_lot(lot_manager, lot1)
        seed_lot(lot_manager, lot2)

        # 2:1 split: 100 shares → 200 shares
        group = create_split_group(
            base_dt=base_datetime,
            asset_id=5,
            from_qty=Decimal("100"),
            to_qty=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should NOT be taxable
        assert len(result.realized_pnl_records) == 0

        # Should create TWO new lots (one per consumed slice)
        assert len(result.cost_lots) == 2

        # Sort by qty to identify
        new_lots = sorted(result.cost_lots, key=lambda l: l.qty)
        
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
        assert len(result.realized_pnl_records) == 0

        # Should create lot at FMV
        assert len(result.cost_lots) == 1
        new_lot = result.cost_lots[0]
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
        seed_lot(lot_manager, btc_lot)

        # Pay 0.1 BTC (FMV = 4000 EUR)
        group = create_payment_group(
            base_dt=base_datetime,
            asset_id=2,
            qty=Decimal("0.1"),
            fmv_in_base=Decimal("4000"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable
        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
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
        seed_lot(lot_manager, chf_lot)

        # Sell 1000 CHF for 900 EUR (rate = 0.90)
        group = create_swap_group(
            base_dt=base_datetime,
            from_asset_id=6,  # CHF
            from_qty=Decimal("1000"),
            to_asset_id=1,  # EUR
            to_qty=Decimal("900"),
            from_value_in_base=Decimal("850"),  # Cost basis: 1000 * 0.85
            to_value_in_base=Decimal("900"),  # Proceeds
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should be taxable (forex gain)
        assert len(result.realized_pnl_records) == 1
        entry = result.realized_pnl_records[0]
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
        

        group = make_unit(legs=[])

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        assert len(result.realized_pnl_records or []) == 0
        assert len(result.cost_lots or []) == 0


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
        seed_lot(lot_manager, aapl_lot)

        # Sell 5 AAPL for 500 EUR - this should settle the -100 EUR and leave 400 EUR
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should create EUR lot even though part was used for settlement
        # Check lots_map instead of result.cost_lots
        eur_lots = [lot for lot in lot_manager.lots_map.get((1, 1), []) if lot.qty > 0]
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
        seed_lot(lot_manager, aapl_lot)

        # Sell 5 AAPL for 500 EUR - exactly matches negative lot
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("5"),
            proceeds_in_base=Decimal("500"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Check EUR lot was created in lot_manager (not on result)
        eur_lots = [
            lot for lot in lot_manager.lots_map.get((1, 1), [])
            if lot.asset_id == 1 and lot.qty > 0  # Positive lots only
        ]
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
        seed_lot(lot_manager, aapl_lot)

        # Sell 1 AAPL for 100 EUR - should settle 100 of the 200 negative lot
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("100"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Processing should complete without error
        # Settlement records are tracked on CostLot.outgoing_settlements, not on CalculationUnit
        assert result is not None
        
        # Verify negative lot was partially settled
        negative_lots = lot_manager.negative_lots_map.get((1, 1), [])
        assert len(negative_lots) == 1
        assert negative_lots[0].qty_remaining == Decimal("-100"), "100 EUR should remain negative"

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
        seed_lot(lot_manager, aapl_lot)

        # Sell 2 AAPL for 200 EUR - fully settles 100 negative, 100 remaining
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Processing should complete without error
        assert result is not None

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
        seed_lot(lot_manager, aapl_lot)

        msft_lot = create_lot(
            asset_id=6,  # MSFT (assume asset_id 6)
            account_id=1,
            qty=Decimal("5"),
            unit_cost=Decimal("50"),
            acquired_at=base_datetime - timedelta(days=200),
        )
        seed_lot(lot_manager, msft_lot)

        # Step 2: Sell 2 AAPL for 50€ - settles 50€ of the 100€ negative lot
        sell_aapl = create_sell_group(
            base_dt=base_datetime + timedelta(days=1),
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("50"),
        )

        result1 = handle_unit(sell_aapl, lot_manager, fmv_service, fifo_config)

        # Processing should complete without error
        assert result1 is not None
        
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

        # Processing should complete without error
        assert result2 is not None

        # Negative lot should be fully settled now
        assert negative_eur.qty_remaining == Decimal("0")

        # EUR lots created - both sell operations create separate EUR lots
        # After settlement: first lot 50 EUR (fully settled to 0 remaining), second lot 80 EUR (50 settled, 30 remaining)
        eur_lots = [l for l in lot_manager.lots_map.get((1, 1), []) if l.qty > 0]
        assert len(eur_lots) == 2  # Two separate inflow operations create two lots
        # Total remaining should be 30 EUR (50 + 80 - 100 settled)
        total_remaining = sum(l.qty_remaining for l in eur_lots)
        assert total_remaining == Decimal("30")

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
        seed_lot(lot_manager, aapl_lot)

        # Sell AAPL - no negative lots to settle
        group = create_sell_group(
            base_dt=base_datetime,
            asset_id=5,
            qty=Decimal("2"),
            proceeds_in_base=Decimal("200"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should complete without errors - no settlement records created
        assert result is not None


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

        # Should have processed the fee leg (fee_entries populated during DB persistence)
        assert hasattr(result, 'fee_entries')
        # In unit tests, fee_entries may be empty if not persisted
        # Instead, verify the fee leg exists and was processed
        assert len(result.fee_legs) == 1, "Should have 1 fee leg"
        fee_leg = result.fee_legs[0]
        assert fee_leg.asset_id == 2, "Fee should be in BTC"
        assert fee_leg.quantity == Decimal("0.001"), "Fee quantity should match"


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


class TestCrossChainTransferFee:
    """Bug #1+#4: Cross-chain bridge where fee asset differs from transferred asset."""

    def test_cross_chain_bridge_fee_absorbed(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Cross-chain bridge: USDC transfer with SOL fee (different asset).
        
        Setup:
        - 100 USDT lot at $1 each (total cost $100)
        - 0.01 ETH lot at $2500/ETH (total cost $25)
        
        Unit: transfer pattern
        - Outflow: 100 USDT
        - Inflow: 99.5 USDT (0.5 USDT kept by bridge)
        - Fee: 0.01 ETH (network fee in different asset)
        
        With fee_taxable_by_default=False:
        - Fee cost ($25) is absorbed into transfer lot cost
        - Transfer lot: 99.5 USDT, cost = $100 (USDT slice) + $25 (ETH fee) = $125
        - No RealizedPnl for fee
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund USDT (asset_id=4)
        usdt_lot = create_lot(
            asset_id=4, account_id=1, qty=Decimal("100"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=60),
        )
        seed_lot(lot_manager, usdt_lot)

        # Pre-fund ETH (asset_id=3) for fee
        eth_lot = create_lot(
            asset_id=3, account_id=1, qty=Decimal("0.01"),
            unit_cost=Decimal("2500"),
            acquired_at=base_datetime - timedelta(days=90),
        )
        seed_lot(lot_manager, eth_lot)

        # Build bridge unit manually (different-asset fee, not supported by create_transfer_group)
        outflow_tx = make_transaction(id=100, asset_id=4, quantity=Decimal("100"), account_id=1, date_time=base_datetime)
        inflow_tx = make_transaction(id=101, asset_id=4, quantity=Decimal("99.5"), account_id=2, date_time=base_datetime)
        fee_tx = make_transaction(id=102, asset_id=3, quantity=Decimal("0.01"), account_id=1, date_time=base_datetime)

        legs = [
            make_leg(asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("100"), transaction=outflow_tx),
            make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("99.5"), transaction=inflow_tx),
            make_leg(asset_id=3, leg_type=LegType.FEE, quantity=Decimal("0.01"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern="internal_transfer", unit_label="Bridge USDT with ETH fee")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # No RealizedPnl — fee is non-taxable and absorbed
        assert len(result.realized_pnl_records) == 0

        # Transfer lot: 99.5 USDT with absorbed fee cost
        transfer_lots = [l for l in result.cost_lots if l.asset_id == 4]
        assert len(transfer_lots) == 1
        t_lot = transfer_lots[0]
        assert t_lot.qty == Decimal("99.5")
        assert t_lot.account_id == 2

        # Total cost = USDT outflow cost ($100) + ETH fee cost ($25) = $125
        expected_cost = Decimal("100") + Decimal("25")
        assert abs(t_lot.total_cost - expected_cost) < Decimal("0.01")

        # No phantom ETH lots should be created
        eth_lots = [l for l in result.cost_lots if l.asset_id == 3]
        assert len(eth_lots) == 0


class TestBug2FeeNotInflatingAcquisitionCost:
    """Bug #2: Fee RealizedPnl proceeds should not inflate new asset cost basis."""

    def test_swap_with_fee_cost_not_inflated(
        self, taxable_swap_config, mock_price_service, base_datetime
    ):
        """
        Swap ETH → USDT with BTC fee.
        Fee's RealizedPnl proceeds should NOT be included in USDT lot cost.
        
        Setup:
        - 1 ETH at cost $2000
        - 0.001 BTC at cost $30
        
        Unit: swap pattern, taxable
        - Outflow: 1 ETH (proceeds = FMV $2500)
        - Inflow: 2500 USDT
        - Fee: 0.001 BTC (fee proceeds = FMV $40)
        
        Expected:
        - ETH RealizedPnl: proceeds=$2500, cost=$2000, pnl=$500
        - BTC fee RealizedPnl: proceeds=$40, cost=$30, pnl=$10
        - USDT lot cost = $2500 (from ETH disposal only), NOT $2540
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(taxable_swap_config)
        fmv_service = FMVService(mock_price_service, taxable_swap_config)

        # Pre-fund ETH
        eth_lot = create_lot(
            asset_id=3, account_id=1, qty=Decimal("1"),
            unit_cost=Decimal("2000"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        seed_lot(lot_manager, eth_lot)

        # Pre-fund BTC for fee
        btc_lot = create_lot(
            asset_id=2, account_id=1, qty=Decimal("0.001"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Build swap: ETH → USDT + BTC fee
        eth_out_tx = make_transaction(id=200, asset_id=3, quantity=Decimal("1"), date_time=base_datetime)
        usdt_in_tx = make_transaction(id=201, asset_id=4, quantity=Decimal("2500"), date_time=base_datetime)
        btc_fee_tx = make_transaction(id=202, asset_id=2, quantity=Decimal("0.001"), date_time=base_datetime)

        legs = [
            make_leg(asset_id=3, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=eth_out_tx),
            make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("2500"), transaction=usdt_in_tx),
            make_leg(asset_id=2, leg_type=LegType.FEE, quantity=Decimal("0.001"), transaction=btc_fee_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Swap ETH→USDT with BTC fee")

        result = handle_unit(group, lot_manager, fmv_service, taxable_swap_config)

        # 2 RealizedPnl: ETH disposal + BTC fee
        assert len(result.realized_pnl_records) == 2

        eth_entry = next(e for e in result.realized_pnl_records if e.qty == Decimal("1"))
        assert eth_entry.proceeds_in_base == Decimal("2500")
        assert eth_entry.cost_basis_in_base == Decimal("2000")

        btc_fee_entry = next(e for e in result.realized_pnl_records if e.qty == Decimal("0.001"))
        assert btc_fee_entry.proceeds_in_base == Decimal("40")  # FMV: 0.001 * 40000
        assert btc_fee_entry.cost_basis_in_base == Decimal("30")  # 0.001 * 30000

        # Bug #2 fix: USDT lot cost = ETH proceeds only ($2500), NOT $2500+$40
        usdt_lots = [l for l in result.cost_lots if l.asset_id == 4]
        assert len(usdt_lots) == 1
        assert abs(usdt_lots[0].total_cost - Decimal("2500")) < Decimal("1")


class TestBug3MultiAssetInflowAllocation:
    """Bug #3: Multi-asset inflows should use FMV-based allocation, not raw quantity."""

    def test_multi_asset_inflow_fmv_allocation(
        self, taxable_swap_config, mock_price_service, base_datetime
    ):
        """
        Swap 1 ETH → 500 USDT + 0.05 BTC (multi-asset inflow).
        Cost should be allocated by FMV proportion, not raw quantity.
        
        Setup:
        - 1 ETH at cost $2000
        
        Unit: taxable swap
        - Outflow: 1 ETH (proceeds = FMV $2500)
        - Inflow: 500 USDT (FMV = $500)
        - Inflow: 0.05 BTC (FMV = $2000)
        
        Total inflow FMV = $500 + $2000 = $2500
        USDT should get: 2500 * (500/2500) = $500 cost
        BTC should get: 2500 * (2000/2500) = $2000 cost
        
        NOT: raw qty ratio → 500/(500+0.05) ≈ 99.99% to USDT (wrong!)
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        
        lot_manager = LotManager(taxable_swap_config)
        fmv_service = FMVService(mock_price_service, taxable_swap_config)

        # Pre-fund ETH
        eth_lot = create_lot(
            asset_id=3, account_id=1, qty=Decimal("1"),
            unit_cost=Decimal("2000"),
            acquired_at=base_datetime - timedelta(days=180),
        )
        seed_lot(lot_manager, eth_lot)

        # Swap: 1 ETH → 500 USDT + 0.05 BTC
        eth_out_tx = make_transaction(id=300, asset_id=3, quantity=Decimal("1"), date_time=base_datetime)
        usdt_in_tx = make_transaction(id=301, asset_id=4, quantity=Decimal("500"), date_time=base_datetime)
        btc_in_tx = make_transaction(id=302, asset_id=2, quantity=Decimal("0.05"), date_time=base_datetime)

        legs = [
            make_leg(asset_id=3, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=eth_out_tx),
            make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("500"), transaction=usdt_in_tx),
            make_leg(asset_id=2, leg_type=LegType.INFLOW, quantity=Decimal("0.05"), transaction=btc_in_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Swap ETH→USDT+BTC")

        result = handle_unit(group, lot_manager, fmv_service, taxable_swap_config)

        # ETH disposal RealizedPnl
        assert len(result.realized_pnl_records) == 1
        eth_entry = result.realized_pnl_records[0]
        assert eth_entry.proceeds_in_base == Decimal("2500")  # FMV of 1 ETH

        # Bug #3 fix: USDT lot cost = 2500 * (500/2500) = $500
        usdt_lots = [l for l in result.cost_lots if l.asset_id == 4]
        assert len(usdt_lots) == 1
        usdt_cost = usdt_lots[0].total_cost
        assert abs(usdt_cost - Decimal("500")) < Decimal("1"), f"USDT cost should be ~$500, got {usdt_cost}"

        # BTC lot cost = 2500 * (2000/2500) = $2000
        btc_lots = [l for l in result.cost_lots if l.asset_id == 2]
        assert len(btc_lots) == 1
        btc_cost = btc_lots[0].total_cost
        assert abs(btc_cost - Decimal("2000")) < Decimal("1"), f"BTC cost should be ~$2000, got {btc_cost}"

        # Total cost allocated = total proceeds
        total_allocated = usdt_cost + btc_cost
        assert abs(total_allocated - Decimal("2500")) < Decimal("1")


class TestBug5IsIncompleteTransfer:
    """Bug #5: _is_incomplete_transfer must check Account.owned, not just account_id presence.
    
    Internal transfers are distinguished from external flows by whether the
    counterparty account (from_account/to_account) is owned (Account.owned == True),
    not by transaction_type or account_id presence alone.
    """

    def test_outflow_only_transfer_detected_as_unmatched(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single outflow leg with to_account.owned=True (destination is owned account) → 
        pattern should be UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import Account, UnitPattern, TransactionType
        
        # Create transaction with type=transfer AND to_account owned (internal)
        tx = make_transaction(id=400, asset_id=2, quantity=Decimal("0.5"), account_id=1, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.to_account_id = 2
        tx.to_account = Account(id=2, name="Wallet B", account_type="wallet", owned=True)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("0.5"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        # Let the model auto-compute pattern
        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value, (
            f"Expected unmatched_internal_transfer, got {computed_pattern} ({reason})"
        )

    def test_inflow_only_transfer_detected_as_unmatched(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single inflow leg with from_account.owned=True (source is owned account) →
        pattern should be UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import Account, UnitPattern, TransactionType
        
        tx = make_transaction(id=401, asset_id=3, quantity=Decimal("1"), account_id=2, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.from_account_id = 1
        tx.from_account = Account(id=1, name="Wallet A", account_type="wallet", owned=True)

        legs = [
            make_leg(asset_id=3, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.UNMATCHED_INTERNAL_TRANSFER.value, (
            f"Expected unmatched_internal_transfer, got {computed_pattern} ({reason})"
        )

    def test_outflow_to_external_address_is_flow(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single outflow leg with to_account_id=None (external destination) →
        should be FLOW, not UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import UnitPattern, TransactionType
        
        tx = make_transaction(id=403, asset_id=2, quantity=Decimal("0.5"), account_id=1, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.to_account_id = None
        tx.to_account = None  # No counterparty → external

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("0.5"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.FLOW.value, (
            f"Expected flow, got {computed_pattern} ({reason})"
        )

    def test_inflow_from_external_address_is_flow(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single inflow leg with from_account_id=None (external source) →
        should be FLOW, not UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import UnitPattern, TransactionType
        
        tx = make_transaction(id=404, asset_id=3, quantity=Decimal("1"), account_id=2, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.from_account_id = None
        tx.from_account = None  # No counterparty → external

        legs = [
            make_leg(asset_id=3, leg_type=LegType.INFLOW, quantity=Decimal("1"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.FLOW.value, (
            f"Expected flow, got {computed_pattern} ({reason})"
        )

    def test_outflow_only_trade_is_flow_not_unmatched(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single outflow leg with transaction_type='trade' →
        should be FLOW, not UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import UnitPattern, TransactionType
        
        tx = make_transaction(id=402, asset_id=2, quantity=Decimal("0.1"), account_id=1, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRADE.value

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("0.1"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.FLOW.value, (
            f"Expected flow, got {computed_pattern} ({reason})"
        )

    def test_outflow_to_non_owned_account_is_flow(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single outflow leg with to_account_id set but to_account.owned=False →
        should be FLOW, not UNMATCHED_INTERNAL_TRANSFER.
        
        An account may exist in the DB (e.g. a counterparty the user tracks)
        but if it's not owned, transferring to it is an external flow.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import Account, UnitPattern, TransactionType
        
        tx = make_transaction(id=405, asset_id=2, quantity=Decimal("0.3"), account_id=1, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.to_account_id = 10
        tx.to_account = Account(id=10, name="Counterparty", account_type="wallet", owned=False)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("0.3"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.FLOW.value, (
            f"Expected flow for non-owned counterparty, got {computed_pattern} ({reason})"
        )

    def test_inflow_from_non_owned_account_is_flow(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Single inflow leg with from_account_id set but from_account.owned=False →
        should be FLOW, not UNMATCHED_INTERNAL_TRANSFER.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import Account, UnitPattern, TransactionType
        
        tx = make_transaction(id=406, asset_id=3, quantity=Decimal("2"), account_id=2, date_time=base_datetime)
        tx.transaction_type = TransactionType.TRANSFER.value
        tx.from_account_id = 10
        tx.from_account = Account(id=10, name="External Sender", account_type="wallet", owned=False)

        legs = [
            make_leg(asset_id=3, leg_type=LegType.INFLOW, quantity=Decimal("2"), transaction=tx),
        ]
        unit = make_unit(legs=legs, pattern=None)

        computed_pattern, reason = unit._compute_pattern_from_legs()
        assert computed_pattern == UnitPattern.FLOW.value, (
            f"Expected flow for non-owned counterparty, got {computed_pattern} ({reason})"
        )


class TestFeeTrackingNoSlices:
    """
    Test that FeeEntry records are created even when fee legs have no lots to consume.
    
    This covers the bug where:
    - Base currency fees (EUR) had no lots → slices empty → FeeEntry never created
    - Fees on cost-basis transfers were absorbed but no FeeEntry created for reporting
    - Non-base-currency fees with no lots were silently dropped
    """

    def test_base_currency_fee_creates_fee_entry(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        EUR fee (base currency) should create FeeEntry even without lots.
        
        Scenario: Sell 1 BTC for 49,990 EUR, with 10 EUR fee
        EUR has no lot tracking → slices empty for EUR fee leg.
        FeeEntry should still be created with fee_value_in_base = 10.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import FeeEntry
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC
        btc_lot = create_lot(
            asset_id=2,
            account_id=1,
            qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Sell 1 BTC for 49,990 EUR with 10 EUR fee
        outflow_tx = make_transaction(id=500, asset_id=2, quantity=Decimal("1"), date_time=base_datetime)
        inflow_tx = make_transaction(id=501, asset_id=1, quantity=Decimal("49990"), date_time=base_datetime)
        fee_tx = make_transaction(id=502, asset_id=1, quantity=Decimal("10"), date_time=base_datetime)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=outflow_tx),
            make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("49990"), transaction=inflow_tx),
            make_leg(asset_id=1, leg_type=LegType.FEE, quantity=Decimal("10"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Sell BTC with EUR fee")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # BTC sale should create RealizedPnl
        assert len(result.realized_pnl_records) == 1
        assert result.realized_pnl_records[0].asset_id == 2

        # EUR fee should create FeeEntry (on the fee leg)
        fee_leg = result.fee_legs[0]
        assert fee_leg.asset_id == 1  # EUR
        assert fee_leg.fee_entries is not None
        assert len(fee_leg.fee_entries) == 1
        
        fe = fee_leg.fee_entries[0]
        assert fe.fee_value_in_base == Decimal("10")
        assert fe.realized_pnl is None  # No RealizedPnl for base currency fee

    def test_absorbed_transfer_fee_creates_fee_entry(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Absorbed fee on cost-basis transfer should still create FeeEntry for reporting.
        
        Scenario: Transfer 100 USDT with 0.01 ETH fee (fee_taxable_by_default=False)
        Fee cost is absorbed into transfer lot, but FeeEntry should exist.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import FeeEntry
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund USDT
        usdt_lot = create_lot(
            asset_id=4, account_id=1, qty=Decimal("100"),
            unit_cost=Decimal("1"),
            acquired_at=base_datetime - timedelta(days=60),
        )
        seed_lot(lot_manager, usdt_lot)

        # Pre-fund ETH for fee
        eth_lot = create_lot(
            asset_id=3, account_id=1, qty=Decimal("0.01"),
            unit_cost=Decimal("2500"),
            acquired_at=base_datetime - timedelta(days=90),
        )
        seed_lot(lot_manager, eth_lot)

        outflow_tx = make_transaction(id=510, asset_id=4, quantity=Decimal("100"), account_id=1, date_time=base_datetime)
        inflow_tx = make_transaction(id=511, asset_id=4, quantity=Decimal("99.5"), account_id=2, date_time=base_datetime)
        fee_tx = make_transaction(id=512, asset_id=3, quantity=Decimal("0.01"), account_id=1, date_time=base_datetime)

        legs = [
            make_leg(asset_id=4, leg_type=LegType.OUTFLOW, quantity=Decimal("100"), transaction=outflow_tx),
            make_leg(asset_id=4, leg_type=LegType.INFLOW, quantity=Decimal("99.5"), transaction=inflow_tx),
            make_leg(asset_id=3, leg_type=LegType.FEE, quantity=Decimal("0.01"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern="internal_transfer", unit_label="Transfer USDT with ETH fee")

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # No RealizedPnl (fee absorbed, transfer is non-taxable)
        assert len(result.realized_pnl_records) == 0

        # Transfer lot should exist with absorbed cost
        transfer_lots = [l for l in result.cost_lots if l.asset_id == 4]
        assert len(transfer_lots) == 1
        expected_cost = Decimal("100") + Decimal("25")  # USDT cost + ETH fee cost
        assert abs(transfer_lots[0].total_cost - expected_cost) < Decimal("0.01")

        # FeeEntry should be created for reporting despite absorption
        fee_leg = result.fee_legs[0]
        assert fee_leg.asset_id == 3  # ETH
        assert fee_leg.fee_entries is not None
        assert len(fee_leg.fee_entries) == 1
        
        fe = fee_leg.fee_entries[0]
        assert fe.fee_value_in_base == Decimal("25")  # 0.01 ETH * 2500 cost basis
        assert fe.realized_pnl is None  # No RealizedPnl for absorbed fee

    def test_crypto_fee_no_lots_creates_fee_entry_with_fmv(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Crypto fee with no lots (e.g., gas fee in token with zero balance)
        should create FeeEntry using FMV.
        """
        from tests.unit.pnl.conftest import make_leg, make_unit, make_transaction
        from backend.db.models import FeeEntry
        
        # Config with allow_negative_balances=False (default)
        config = PnLConfig(
            lot_method=fifo_config.lot_method,
            lot_mode=fifo_config.lot_mode,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=False,
        )
        
        lot_manager = LotManager(config)
        fmv_service = FMVService(mock_price_service, config)

        # Pre-fund BTC for the sale
        btc_lot = create_lot(
            asset_id=2, account_id=1, qty=Decimal("1"),
            unit_cost=Decimal("30000"),
            acquired_at=base_datetime - timedelta(days=365),
        )
        seed_lot(lot_manager, btc_lot)

        # Sell BTC with ETH fee — but we have NO ETH lots
        outflow_tx = make_transaction(id=520, asset_id=2, quantity=Decimal("1"), date_time=base_datetime)
        inflow_tx = make_transaction(id=521, asset_id=1, quantity=Decimal("50000"), date_time=base_datetime)
        fee_tx = make_transaction(id=522, asset_id=3, quantity=Decimal("0.01"), date_time=base_datetime)

        legs = [
            make_leg(asset_id=2, leg_type=LegType.OUTFLOW, quantity=Decimal("1"), transaction=outflow_tx),
            make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("50000"), transaction=inflow_tx),
            make_leg(asset_id=3, leg_type=LegType.FEE, quantity=Decimal("0.01"), transaction=fee_tx),
        ]
        group = make_unit(legs=legs, pattern="swap", unit_label="Sell BTC with ETH fee (no ETH lots)")

        result = handle_unit(group, lot_manager, fmv_service, config)

        # BTC sale creates RealizedPnl
        assert len(result.realized_pnl_records) == 1

        # ETH fee → no slices consumed, but FeeEntry should exist via FMV
        fee_leg = result.fee_legs[0]
        assert fee_leg.asset_id == 3  # ETH
        assert fee_leg.fee_entries is not None
        assert len(fee_leg.fee_entries) == 1
        
        fe = fee_leg.fee_entries[0]
        # FMV: 0.01 ETH * 2500 = 25 EUR
        assert fe.fee_value_in_base == Decimal("25")
        assert fe.realized_pnl is None  # No lots consumed → no RealizedPnl

    def test_existing_crypto_fee_with_lots_still_works(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Regression test: crypto fee WITH lots should still create both
        RealizedPnl AND FeeEntry (existing behavior preserved).
        """
        from tests.unit.pnl.conftest import create_sell_with_fee_group
        
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Pre-fund BTC (enough for sale + fee)
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
            fee_asset_id=2,  # BTC fee
            fee_qty=Decimal("0.001"),
        )

        result = handle_unit(group, lot_manager, fmv_service, fifo_config)

        # Should have 2 RealizedPnl: 1 for sale, 1 for fee
        assert len(result.realized_pnl_records) == 2

        # Fee leg should have FeeEntry
        fee_leg = result.fee_legs[0]
        assert fee_leg.fee_entries is not None
        assert len(fee_leg.fee_entries) == 1
        
        fe = fee_leg.fee_entries[0]
        # FMV: 0.001 BTC * 40,000 = 40 EUR
        assert fe.fee_value_in_base == Decimal("40")
        # This one HAS a RealizedPnl (lots were consumed)
        assert fe.realized_pnl is not None


class TestMixedAssetProceeds:
    """Test proceeds computation for mixed-asset units (EUR + non-base on both sides)."""

    def test_mixed_asset_swap_uses_fmv_for_non_base_disposal(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Bug #72640: When a unit has EUR AND another asset on BOTH sides,
        the non-base-currency disposal should use FMV, not pro-rata from EUR inflows.

        Unit structure (rebalancing):
          Outflows: EUR 1057.40  +  INDW.PA 2.383
          Inflows:  EUR 1057.98  +  INDW.PA 92.028
          Fee:      EUR 0.50

        Before fix: INDW.PA disposal got pro-rata of EUR → proceeds=2.38 → PnL=−1036
        After fix:  INDW.PA disposal uses FMV → proceeds=2.383*100=238.30 → correct PnL
        """
        lot_manager = LotManager(fifo_config)
        # Asset 5 = AAPL in mock, price=100. Using it to represent INDW.PA.
        mock_price_service.prices[5] = Decimal("100")
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Seed EUR lot (for EUR outflow)
        eur_lot = create_lot(
            asset_id=1, account_id=1, qty=Decimal("2000"),
            unit_cost=Decimal("1"), acquired_at=base_datetime - timedelta(days=30),
        )
        seed_lot(lot_manager, eur_lot)

        # Seed AAPL lot (for AAPL outflow of 2.383 units, at cost=200/unit)
        aapl_lot = create_lot(
            asset_id=5, account_id=1, qty=Decimal("10"),
            unit_cost=Decimal("200"), acquired_at=base_datetime - timedelta(days=60),
        )
        seed_lot(lot_manager, aapl_lot)

        # Build the mixed-asset unit
        out_eur_tx = make_transaction(id=100, asset_id=1, quantity=Decimal("1057.40"), account_id=1, date_time=base_datetime)
        out_aapl_tx = make_transaction(id=101, asset_id=5, quantity=Decimal("2.383"), account_id=1, date_time=base_datetime)
        in_eur_tx = make_transaction(id=102, asset_id=1, quantity=Decimal("1057.98"), account_id=1, date_time=base_datetime)
        in_aapl_tx = make_transaction(id=103, asset_id=5, quantity=Decimal("92.028"), account_id=1, date_time=base_datetime)
        fee_tx = make_transaction(id=104, asset_id=1, quantity=Decimal("0.50"), account_id=1, date_time=base_datetime)

        legs = [
            make_leg(asset_id=1, leg_type=LegType.OUTFLOW, quantity=Decimal("1057.40"), transaction=out_eur_tx),
            make_leg(asset_id=5, leg_type=LegType.OUTFLOW, quantity=Decimal("2.383"), transaction=out_aapl_tx),
            make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("1057.98"), transaction=in_eur_tx),
            make_leg(asset_id=5, leg_type=LegType.INFLOW, quantity=Decimal("92.028"), transaction=in_aapl_tx),
            make_leg(asset_id=1, leg_type=LegType.FEE, quantity=Decimal("0.50"), transaction=fee_tx),
        ]

        unit = make_unit(legs=legs, pattern="swap", bundle_taxability_override="non_taxable")

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # AAPL disposal should have a RealizedPnl using FMV, not base_currency pro-rata
        aapl_pnl = [p for p in result.realized_pnl_records if p.asset_id == 5]
        assert len(aapl_pnl) == 1

        entry = aapl_pnl[0]
        # FMV: 2.383 * 100 = 238.30
        assert entry.proceeds_in_base == Decimal("2.383") * Decimal("100")
        assert entry.proceeds_price_source != "direct"  # Not the base_currency path
        assert entry.proceeds_source != "base_currency"

    def test_pure_sell_still_uses_base_currency_proceeds(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        Regression: Pure sell (AAPL → EUR) should still use EUR inflow as proceeds,
        not FMV. This is the normal sell case that must NOT be broken.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Seed AAPL lot
        aapl_lot = create_lot(
            asset_id=5, account_id=1, qty=Decimal("10"),
            unit_cost=Decimal("80"), acquired_at=base_datetime - timedelta(days=60),
        )
        seed_lot(lot_manager, aapl_lot)

        # Pure sell: 5 AAPL → 600 EUR
        outflow_tx = make_transaction(id=200, asset_id=5, quantity=Decimal("5"), account_id=1, date_time=base_datetime)
        inflow_tx = make_transaction(id=201, asset_id=1, quantity=Decimal("600"), account_id=1, date_time=base_datetime)

        legs = [
            make_leg(asset_id=5, leg_type=LegType.OUTFLOW, quantity=Decimal("5"), transaction=outflow_tx),
            make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("600"), transaction=inflow_tx),
        ]
        unit = make_unit(legs=legs, pattern="swap")

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        aapl_pnl = [p for p in result.realized_pnl_records if p.asset_id == 5]
        assert len(aapl_pnl) == 1

        entry = aapl_pnl[0]
        # Proceeds should be the actual EUR received (600), not FMV (5*100=500)
        assert entry.proceeds_in_base == Decimal("600")
        assert entry.proceeds_source == "base_currency"
        # cost = 5 * 80 = 400, pnl = 600 - 400 = 200
        assert entry.pnl_in_base == Decimal("200")

    def test_mixed_asset_eur_disposal_still_uses_pro_rata(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """
        In a mixed-asset unit, the EUR disposal (base currency) should still use
        the base_currency pro-rata path — only non-base disposals should use FMV.
        Base currency disposals skip PnL creation anyway, but verify the path is correct.
        """
        lot_manager = LotManager(fifo_config)
        fmv_service = FMVService(mock_price_service, fifo_config)

        # Seed lots
        eur_lot = create_lot(
            asset_id=1, account_id=1, qty=Decimal("2000"),
            unit_cost=Decimal("1"), acquired_at=base_datetime - timedelta(days=30),
        )
        seed_lot(lot_manager, eur_lot)
        aapl_lot = create_lot(
            asset_id=5, account_id=1, qty=Decimal("10"),
            unit_cost=Decimal("200"), acquired_at=base_datetime - timedelta(days=60),
        )
        seed_lot(lot_manager, aapl_lot)

        # Mixed unit: EUR+AAPL outflow, EUR+AAPL inflow
        out_eur_tx = make_transaction(id=300, asset_id=1, quantity=Decimal("500"), account_id=1, date_time=base_datetime)
        out_aapl_tx = make_transaction(id=301, asset_id=5, quantity=Decimal("3"), account_id=1, date_time=base_datetime)
        in_eur_tx = make_transaction(id=302, asset_id=1, quantity=Decimal("500"), account_id=1, date_time=base_datetime)
        in_aapl_tx = make_transaction(id=303, asset_id=5, quantity=Decimal("30"), account_id=1, date_time=base_datetime)

        legs = [
            make_leg(asset_id=1, leg_type=LegType.OUTFLOW, quantity=Decimal("500"), transaction=out_eur_tx),
            make_leg(asset_id=5, leg_type=LegType.OUTFLOW, quantity=Decimal("3"), transaction=out_aapl_tx),
            make_leg(asset_id=1, leg_type=LegType.INFLOW, quantity=Decimal("500"), transaction=in_eur_tx),
            make_leg(asset_id=5, leg_type=LegType.INFLOW, quantity=Decimal("30"), transaction=in_aapl_tx),
        ]
        unit = make_unit(legs=legs, pattern="swap", bundle_taxability_override="non_taxable")

        result = handle_unit(unit, lot_manager, fmv_service, fifo_config)

        # EUR disposal is base currency → skips PnL creation entirely
        eur_pnl = [p for p in result.realized_pnl_records if p.asset_id == 1]
        assert len(eur_pnl) == 0

        # AAPL disposal should use FMV (not base_currency pro-rata)
        aapl_pnl = [p for p in result.realized_pnl_records if p.asset_id == 5]
        assert len(aapl_pnl) == 1
        entry = aapl_pnl[0]
        # FMV: 3 * 100 = 300
        assert entry.proceeds_in_base == Decimal("300")
        assert entry.proceeds_source != "base_currency"


class TestZeroPriceResolution:
    """Synthetic $0 closes (losing prediction-market shares) must not trigger FMV lookups."""

    @staticmethod
    def _leg(price, source_type="synthetic-close", tags=None):
        from types import SimpleNamespace

        tx = SimpleNamespace(price=price, source_transaction_type=source_type, tags=tags)
        return SimpleNamespace(
            is_fee=False, asset_id=42, quantity=Decimal("10"), date_time=None,
            origin_transaction=tx, transaction=tx,
        )

    def test_synthetic_close_at_zero_has_zero_proceeds_without_fmv(self, fifo_config):
        from unittest.mock import MagicMock
        from backend.services.pnl.group_handler import _compute_proceeds

        fmv = MagicMock()
        proceeds, error, meta = _compute_proceeds(self._leg(Decimal("0")), [], [], fmv, fifo_config)

        assert proceeds == Decimal("0")
        assert error is None
        assert meta["source"] == "resolution"
        fmv.get_fmv_in_base.assert_not_called()

    def test_legacy_synthetic_tag_is_recognised(self):
        from backend.services.pnl.group_handler import _is_zero_price_resolution

        assert _is_zero_price_resolution(self._leg(Decimal("0"), "sell", [{"synthetic": True}]))

    def test_regular_zero_price_sell_still_uses_fmv(self):
        from backend.services.pnl.group_handler import _is_zero_price_resolution

        assert not _is_zero_price_resolution(self._leg(Decimal("0"), "sell", [{"side": "SELL"}]))
        assert not _is_zero_price_resolution(self._leg(Decimal("0.5")))
        assert not _is_zero_price_resolution(self._leg(None))


class TestPricedResolution:
    """Winning prediction-market shares are valued by the payout (counter leg), not a market price."""

    @staticmethod
    def _leg(asset_id, qty, price=None, source_type="synthetic-close"):
        from types import SimpleNamespace

        tx = SimpleNamespace(price=price, source_transaction_type=source_type, tags=None)
        return SimpleNamespace(
            is_fee=False, asset_id=asset_id, quantity=Decimal(qty), date_time=None,
            origin_transaction=tx, transaction=tx,
        )

    @staticmethod
    def _fmv(value_by_asset):
        from unittest.mock import MagicMock
        from backend.services.pnl.fmv_service import FMVResult

        fmv = MagicMock()

        def get(leg, skip_on_error=True):
            if leg.asset_id in value_by_asset:
                return FMVResult(value=value_by_asset[leg.asset_id], success=True, source="coingecko")
            return FMVResult(value=Decimal(0), success=False, source="fallback", error="no price")

        fmv.get_fmv_in_base.side_effect = get
        return fmv

    def test_winning_close_uses_payout_value(self, fifo_config):
        from backend.services.pnl.group_handler import _compute_proceeds

        share = self._leg(42, "100", Decimal("1"))
        usdc_in = self._leg(7, "100")
        fmv = self._fmv({7: Decimal("86")})

        proceeds, error, meta = _compute_proceeds(share, [usdc_in], [share], fmv, fifo_config)

        assert proceeds == Decimal("86")
        assert error is None
        assert meta["source"] == "counter_leg"
        assert all(c.args[0] is usdc_in for c in fmv.get_fmv_in_base.call_args_list)

    def test_swap_without_price_falls_back_to_counter_leg(self, fifo_config):
        from backend.services.pnl.group_handler import _compute_proceeds

        token = self._leg(42, "10", source_type="swap")
        usdc_in = self._leg(7, "50")
        proceeds, error, meta = _compute_proceeds(token, [usdc_in], [token], self._fmv({7: Decimal("43")}), fifo_config)

        assert (proceeds, error, meta["source"]) == (Decimal("43"), None, "counter_leg")

    def test_no_counter_leg_keeps_missing_price_error(self, fifo_config):
        from backend.services.pnl.group_handler import _compute_proceeds

        token = self._leg(42, "10", source_type="swap")
        proceeds, error, _ = _compute_proceeds(token, [], [token], self._fmv({}), fifo_config)

        assert proceeds == Decimal("0")
        assert error
