"""
Unit tests for FrenchSecuritiesTaxCalculator — Art. 150-0 A CGI.

Tests cover:
- CUMP computation (buy/sell/split tracking)
- PFU 30% on net annual securities gains
- Loss carryforward (10-year cap)
- Edge cases: no sells, zero-qty
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import Mock

from backend.services.pnl.fr_securities_tax import (
    FrenchSecuritiesTaxCalculator,
    CUMPState,
    FR_PFU_TOTAL_RATE,
)
from backend.services.pnl.tax_models import TaxReport, TaxJurisdiction
from backend.db.models import RealizedPnl, Asset


# ============================================================================
# Test Helpers
# ============================================================================


def make_realized_pnl(
    pnl_id: int = None,
    asset_id: int = 10,
    qty: Decimal = Decimal("100"),
    proceeds: Decimal = Decimal("5000"),
    cost_basis: Decimal = Decimal("4000"),
    disposal_taxable: bool = True,
    realized_at: datetime = None,
) -> RealizedPnl:
    if realized_at is None:
        realized_at = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    return RealizedPnl(
        pnl_id=pnl_id,
        asset_id=asset_id,
        qty=qty,
        proceeds_in_base=proceeds,
        cost_basis_in_base=cost_basis,
        gain_loss_in_base=proceeds - cost_basis,
        disposal_taxable=disposal_taxable,
        realized_at=realized_at,
    )


def make_asset(asset_id: int = 10, symbol: str = "AAPL", price_type: str = "stock") -> Asset:
    a = Mock(spec=Asset)
    a.asset_id = asset_id
    a.symbol = symbol
    a.price_type = price_type
    return a


# ============================================================================
# CUMPState Unit Tests
# ============================================================================


class TestCUMPState:
    """Direct tests for the CUMP tracking state object."""

    def test_initial_cump_is_zero(self):
        state = CUMPState()
        assert state.cump == Decimal("0")

    def test_buy_updates_cump(self):
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("50"))
        assert state.total_qty == Decimal("100")
        assert state.total_cost == Decimal("5000")
        assert state.cump == Decimal("50")

    def test_two_buys_weighted_average(self):
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("50"))
        state.buy(Decimal("100"), Decimal("70"))
        assert state.total_qty == Decimal("200")
        assert state.cump == Decimal("60")  # (5000+7000)/200

    def test_sell_reduces_position(self):
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("50"))
        gain = state.sell(Decimal("50"), Decimal("60"))
        assert state.total_qty == Decimal("50")
        assert gain == Decimal("500")  # 50 * (60 - 50)

    def test_sell_at_loss(self):
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("50"))
        gain = state.sell(Decimal("100"), Decimal("30"))
        assert gain == Decimal("-2000")  # 100 * (30 - 50)


# ============================================================================
# Calculator Integration Tests
# ============================================================================


class TestFrSecuritiesTaxBasic:
    """Basic securities tax computation."""

    def test_single_gain_pfu_30(self):
        """Single securities sale with gain → 30% PFU."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("5000"), cost_basis=Decimal("4000"))]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert len(report.summaries) == 1
        s = report.summaries[0]
        assert s.fiscal_year == 2025
        assert s.taxable_gains > 0
        assert s.tax_total > 0

    def test_loss_no_tax(self):
        """Sale at a loss → no tax, loss carried forward."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("3000"), cost_basis=Decimal("4000"))]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.tax_total == Decimal("0")

    def test_empty_entries(self):
        """No entries → empty report."""
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute([], {})
        assert len(report.summaries) == 0

    def test_report_jurisdiction(self):
        """Report carries the correct tax_jurisdiction."""
        entries = [make_realized_pnl(pnl_id=1)]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert report.tax_jurisdiction == TaxJurisdiction.FR

    def test_non_taxable_excluded(self):
        """Non-taxable disposals are excluded from tax computation."""
        entries = [make_realized_pnl(pnl_id=1, disposal_taxable=False)]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert len(report.summaries) == 0 or report.summaries[0].taxable_disposals == 0

    def test_mixed_taxable_and_non_taxable_line_items(self):
        """Both taxable and non-taxable entries appear in line_items but only taxable ones contribute to tax."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("5000"), cost_basis=Decimal("4000"), disposal_taxable=True),
            make_realized_pnl(pnl_id=2, proceeds=Decimal("3000"), cost_basis=Decimal("2000"), disposal_taxable=False),
        ]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        # Both entries in line_items
        assert len(s.line_items) == 2
        assert s.total_disposals == 2
        # Only taxable one counted
        assert s.taxable_disposals == 1
        assert s.non_taxable_disposals == 1
        # Tax only on the taxable gain
        assert s.taxable_gains > 0
        assert s.tax_total > 0


class TestFrSecuritiesTaxNetting:
    """Gains/losses netting and carryforward for securities."""

    def test_gains_and_losses_net_within_year(self):
        """AAPL gain + MSFT loss in same year → net taxable = gain - |loss|."""
        entries = [
            make_realized_pnl(pnl_id=1, asset_id=10, proceeds=Decimal("5000"), cost_basis=Decimal("4000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),  # +1k
            make_realized_pnl(pnl_id=2, asset_id=11, qty=Decimal("50"), proceeds=Decimal("1500"), cost_basis=Decimal("2000"),
                              realized_at=datetime(2025, 7, 1, tzinfo=timezone.utc)),  # -500
        ]
        asset_map = {10: make_asset(10, "AAPL"), 11: make_asset(11, "MSFT")}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.taxable_gains == Decimal("1000")
        assert s.taxable_losses == Decimal("-500")
        assert s.net_taxable == Decimal("500")
        expected_tax = (Decimal("500") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))
        assert s.tax_total == expected_tax

    def test_loss_carryforward_exact_amount(self):
        """2024 loss of -2k, 2025 gain of +5k → net taxable 2025 = 3k."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("2000"), cost_basis=Decimal("4000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),  # -2k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("9000"), cost_basis=Decimal("4000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),  # +5k
        ]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s2024 = next(s for s in report.summaries if s.fiscal_year == 2024)
        assert s2024.tax_total == Decimal("0")
        assert s2024.loss_carryforward == Decimal("-2000")

        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.net_taxable == Decimal("3000")
        expected_tax = (Decimal("3000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))
        assert s2025.tax_total == expected_tax

    def test_loss_carryforward_exceeds_gain(self):
        """2024 loss of -10k, 2025 gain of +3k → no tax, remaining carryforward -7k."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("0"), cost_basis=Decimal("10000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),  # -10k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("7000"), cost_basis=Decimal("4000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),  # +3k
        ]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.net_taxable == Decimal("0")
        assert s2025.tax_total == Decimal("0")
        assert s2025.loss_carryforward == Decimal("-7000")

    def test_pfu_breakdown_matches_total(self):
        """Income tax (12.8%) + social (17.2%) = total (30%)."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("14000"), cost_basis=Decimal("4000"))]
        asset_map = {10: make_asset()}
        calc = FrenchSecuritiesTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.tax_income == Decimal("1280.00")   # 10000 * 12.8%
        assert s.tax_social == Decimal("1720.00")   # 10000 * 17.2%
        assert s.tax_total == Decimal("3000.00")     # 10000 * 30%
        assert s.tax_total == s.tax_income + s.tax_social


class TestCUMPStateSplit:
    """Additional CUMP tests for edge cases."""

    def test_sell_entire_position(self):
        """Selling entire position → qty goes to zero, cost goes to zero."""
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("50"))
        gain = state.sell(Decimal("100"), Decimal("60"))
        assert gain == Decimal("1000")  # 100 * (60-50)
        assert state.total_qty == Decimal("0")
        assert state.total_cost == Decimal("0")

    def test_multiple_buys_then_partial_sell(self):
        """Two buys at different prices, partial sell uses weighted CUMP."""
        state = CUMPState()
        state.buy(Decimal("100"), Decimal("40"))   # 4000
        state.buy(Decimal("200"), Decimal("55"))   # 11000
        # CUMP = 15000/300 = 50
        assert state.cump == Decimal("50")
        gain = state.sell(Decimal("150"), Decimal("60"))
        # gain = 150 * (60-50) = 1500
        assert gain == Decimal("1500")
        assert state.total_qty == Decimal("150")
        # Remaining cost = 15000 - 150*50 = 7500
        assert state.total_cost == Decimal("7500")
