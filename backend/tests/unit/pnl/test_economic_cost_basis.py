"""Economic vs tax cost basis.

Non-taxable swaps (tax deferral, e.g. French crypto-to-crypto) record the gain in
the economic view and step the received lot's economic cost up to market value,
while the tax cost is carried over. Each gain must be counted exactly once in the
economic view, and the taxable figures must not change.
"""

from datetime import timedelta
from decimal import Decimal

from backend.db.models import ConsumedLotSlice, CostLot, RealizedPnl
from backend.services.pnl.fmv_service import FMVService
from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.lot_manager import LotManager

from tests.unit.pnl.conftest import (
    create_lot,
    create_sell_group,
    create_swap_group,
    create_transfer_group,
    create_buy_group,
    seed_lot,
)

EUR, BTC, ETH, USDC = 1, 2, 3, 8


def _open_lots(lot_manager):
    return [
        l
        for l in lot_manager.get_all_lots()
        if not l.is_negative and l.qty_remaining > 0
    ]


def _economic_unrealized(lot_manager, prices):
    return sum(
        l.qty_remaining * prices[l.asset_id] - l.economic_remaining_cost_in_base
        for l in _open_lots(lot_manager)
    )


def _tax_unrealized(lot_manager, prices):
    return sum(
        l.qty_remaining * prices[l.asset_id] - l.remaining_cost_in_base
        for l in _open_lots(lot_manager)
    )


class _Chain:
    """BTC bought at 30k → swapped to ETH → swapped to USDC → sold for EUR."""

    def __init__(self, config, price_service, base_dt):
        self.config = config
        self.prices = price_service.prices
        self.prices[USDC] = Decimal("1")
        self.lots = LotManager(config)
        self.fmv = FMVService(price_service, config)
        self.base_dt = base_dt
        self.entries: list[RealizedPnl] = []
        seed_lot(
            self.lots,
            create_lot(
                BTC, 1, Decimal("1"), Decimal("30000"), base_dt - timedelta(days=200)
            ),
        )

    def run(self, unit):
        result = handle_unit(unit, self.lots, self.fmv, self.config)
        self.entries.extend(result.realized_pnl_records or [])
        return result

    def swap_btc_to_eth(self):
        return self.run(
            create_swap_group(
                self.base_dt,
                BTC,
                Decimal("1"),
                ETH,
                Decimal("16"),
                Decimal("40000"),
                Decimal("40000"),
            )
        )

    def swap_eth_to_usdc(self):
        self.prices[ETH] = Decimal("3000")
        return self.run(
            create_swap_group(
                self.base_dt + timedelta(days=10),
                ETH,
                Decimal("16"),
                USDC,
                Decimal("48000"),
                Decimal("48000"),
                Decimal("48000"),
            )
        )

    def sell_usdc(self):
        return self.run(
            create_sell_group(
                self.base_dt + timedelta(days=20),
                USDC,
                Decimal("48000"),
                Decimal("48000"),
            )
        )

    @property
    def economic_realized(self):
        return sum(e.economic_pnl for e in self.entries)

    @property
    def taxable_realized(self):
        return sum(e.pnl_in_base for e in self.entries if e.disposal_taxable)

    def assert_views_reconcile(self):
        economic_total = self.economic_realized + _economic_unrealized(
            self.lots, self.prices
        )
        tax_total = self.taxable_realized + _tax_unrealized(self.lots, self.prices)
        assert economic_total == tax_total


class TestNonTaxableSwapChain:
    def test_first_swap_steps_up_economic_cost_only(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        result = chain.swap_btc_to_eth()

        entry = result.realized_pnl_records[0]
        assert entry.disposal_taxable is False
        assert entry.pnl_in_base == Decimal("10000")
        # Source lot has no economic override, so both views agree on this disposal
        assert entry.economic_pnl_in_base is None
        assert entry.economic_pnl == Decimal("10000")

        eth_lot = next(l for l in result.cost_lots if l.asset_id == ETH)
        assert eth_lot.total_cost_in_base == Decimal("30000")
        assert eth_lot.economic_unit_cost_in_base == Decimal("2500")
        chain.assert_views_reconcile()

    def test_second_swap_counts_only_the_new_gain(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        result = chain.swap_eth_to_usdc()

        entry = result.realized_pnl_records[0]
        assert entry.pnl_in_base == Decimal(
            "18000"
        )  # tax view: cumulative deferred gain
        assert entry.economic_cost_basis_in_base == Decimal("40000")
        assert entry.economic_pnl_in_base == Decimal("8000")

        usdc_lot = next(l for l in result.cost_lots if l.asset_id == USDC)
        assert usdc_lot.total_cost_in_base == Decimal("30000")
        assert usdc_lot.economic_remaining_cost_in_base == Decimal("48000")
        chain.assert_views_reconcile()

    def test_final_sale_realizes_deferred_gain_for_tax_only(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        chain.swap_eth_to_usdc()
        result = chain.sell_usdc()

        entry = result.realized_pnl_records[0]
        assert entry.disposal_taxable is True
        assert entry.pnl_in_base == Decimal("18000")
        assert entry.economic_pnl_in_base == Decimal("0")

        assert chain.economic_realized == Decimal("18000")
        assert chain.taxable_realized == Decimal("18000")
        # The old "all realized" (tax P&L of every entry) counted the gain three times
        assert sum(e.pnl_in_base for e in chain.entries) == Decimal("46000")
        chain.assert_views_reconcile()

    def test_partial_disposal_uses_proportional_economic_cost(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        chain.prices[ETH] = Decimal("3000")
        result = chain.run(
            create_sell_group(
                base_datetime + timedelta(days=5),
                ETH,
                Decimal("8"),
                Decimal("24000"),
            )
        )

        entry = result.realized_pnl_records[0]
        assert entry.cost_basis_in_base == Decimal("15000")
        assert entry.pnl_in_base == Decimal("9000")
        assert entry.economic_cost_basis_in_base == Decimal("20000")
        assert entry.economic_pnl_in_base == Decimal("4000")
        chain.assert_views_reconcile()


class TestEconomicCostTravels:
    def test_transfer_keeps_both_costs(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        result = chain.run(
            create_transfer_group(
                base_datetime + timedelta(days=1),
                ETH,
                Decimal("16"),
                from_account_id=1,
                to_account_id=2,
            )
        )

        assert result.realized_pnl_records in (None, [])
        moved = next(l for l in result.cost_lots if l.account_id == 2)
        assert moved.total_cost_in_base == Decimal("30000")
        assert moved.economic_unit_cost_in_base == Decimal("2500")
        chain.assert_views_reconcile()

    def test_transfer_fee_absorbed_in_both_views(
        self, fifo_config, mock_price_service, base_datetime
    ):
        chain = _Chain(fifo_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        result = chain.run(
            create_transfer_group(
                base_datetime + timedelta(days=1),
                ETH,
                Decimal("16"),
                from_account_id=1,
                to_account_id=2,
                fee_qty=Decimal("1"),
            )
        )

        moved = [l for l in result.cost_lots if l.account_id == 2]
        assert sum(l.total_cost_in_base for l in moved) == Decimal("30000")
        assert sum(l.qty * l.economic_unit_cost for l in moved) == Decimal("40000")


class TestNoDivergence:
    def test_taxable_swap_keeps_single_cost(
        self, taxable_swap_config, mock_price_service, base_datetime
    ):
        chain = _Chain(taxable_swap_config, mock_price_service, base_datetime)
        chain.swap_btc_to_eth()
        chain.swap_eth_to_usdc()
        chain.sell_usdc()

        assert all(e.economic_pnl_in_base is None for e in chain.entries)
        assert all(
            l.economic_unit_cost_in_base is None for l in chain.lots.get_all_lots()
        )
        assert chain.economic_realized == chain.taxable_realized == Decimal("18000")

    def test_buy_with_base_currency_keeps_single_cost(
        self, fifo_config, mock_price_service, base_datetime
    ):
        lots = LotManager(fifo_config)
        seed_lot(
            lots,
            create_lot(
                EUR, 1, Decimal("1000"), Decimal("1"), base_datetime - timedelta(days=1)
            ),
        )
        result = handle_unit(
            create_buy_group(base_datetime, 5, Decimal("10"), Decimal("1000")),
            lots,
            FMVService(mock_price_service, fifo_config),
            fifo_config,
        )
        assert result.cost_lots[0].economic_unit_cost_in_base is None


class TestModelFallbacks:
    def test_consume_copies_economic_cost(self, base_datetime):
        lot = CostLot(
            asset_id=ETH,
            qty=Decimal("4"),
            qty_remaining=Decimal("4"),
            unit_cost_in_base=Decimal("10"),
            economic_unit_cost_in_base=Decimal("25"),
            acquired_at=base_datetime,
        )
        part = lot.consume(Decimal("2"))
        assert part.total_cost_in_base == Decimal("20")
        assert part.economic_cost == Decimal("50")

    def test_null_economic_columns_fall_back_to_tax(self, base_datetime):
        lot = CostLot(
            asset_id=ETH,
            qty=Decimal("1"),
            qty_remaining=Decimal("1"),
            unit_cost_in_base=Decimal("10"),
            acquired_at=base_datetime,
        )
        assert lot.economic_unit_cost == Decimal("10")
        part = ConsumedLotSlice(
            quantity=Decimal("1"),
            unit_cost_in_base=Decimal("10"),
            total_cost_in_base=Decimal("10"),
        )
        assert part.economic_cost == Decimal("10")
        entry = RealizedPnl(
            asset_id=ETH,
            qty=Decimal("1"),
            proceeds_in_base=Decimal("12"),
            cost_basis_in_base=Decimal("10"),
            pnl_in_base=Decimal("2"),
        )
        assert entry.economic_pnl == Decimal("2")
        assert entry.economic_cost_basis == Decimal("10")
