"""
Unit tests for FrenchCryptoTaxCalculator — Art. 150 VH bis CGI.

Tests cover:
- PFU 30% on net annual crypto gains
- Loss carryforward across fiscal years
- Edge cases: zero gains, all losses, mixed taxable/non-taxable
- TaxJurisdiction.STANDARD bypass (no crypto tax)
- Multi-year scenarios
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import Mock

from backend.services.pnl.fr_crypto_tax import (
    FrenchCryptoTaxCalculator,
    FR_PFU_TOTAL_RATE,
)
from backend.services.pnl.tax_models import TaxReport, TaxJurisdiction
from backend.db.models import RealizedPnl, Asset


# ============================================================================
# Test Helpers
# ============================================================================


def make_realized_pnl(
    pnl_id: int = None,
    asset_id: int = 2,
    qty: Decimal = Decimal("1"),
    proceeds: Decimal = Decimal("50000"),
    cost_basis: Decimal = Decimal("40000"),
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


def make_asset(asset_id: int = 2, symbol: str = "BTC", price_type: str = "crypto") -> Asset:
    a = Mock(spec=Asset)
    a.asset_id = asset_id
    a.symbol = symbol
    a.price_type = price_type
    return a


# ============================================================================
# Tests
# ============================================================================


class TestFrCryptoTaxBasic:
    """Basic crypto tax computation scenarios."""

    def test_single_gain_pfu_30(self):
        """Single crypto disposal with gain → 30% PFU."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("50000"), cost_basis=Decimal("40000"))]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert len(report.summaries) == 1
        s = report.summaries[0]
        assert s.fiscal_year == 2025
        assert s.taxable_gains == Decimal("10000")
        assert s.net_taxable == Decimal("10000")
        assert s.tax_total == (Decimal("10000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))

    def test_single_loss_no_tax(self):
        """Single crypto disposal with loss → no tax, loss carried forward."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("30000"), cost_basis=Decimal("40000"))]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.net_taxable <= 0
        assert s.tax_total == Decimal("0")

    def test_empty_entries_returns_empty_report(self):
        """No entries → empty report."""
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute([], {})
        assert len(report.summaries) == 0

    def test_non_taxable_disposals_excluded(self):
        """Disposals with disposal_taxable=False are excluded."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("50000"), cost_basis=Decimal("40000"), disposal_taxable=False),
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        # Non-taxable → no line items
        assert len(report.summaries) == 0 or report.summaries[0].taxable_disposals == 0

    def test_mixed_taxable_and_non_taxable_line_items(self):
        """Both taxable and non-taxable entries appear in line_items but only taxable ones contribute to tax."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("50000"), cost_basis=Decimal("40000"), disposal_taxable=True),
            make_realized_pnl(pnl_id=2, proceeds=Decimal("30000"), cost_basis=Decimal("20000"), disposal_taxable=False),
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        # Both entries in line_items
        assert len(s.line_items) == 2
        assert s.total_disposals == 2
        # Only taxable one counted
        assert s.taxable_disposals == 1
        assert s.non_taxable_disposals == 1
        # Tax only on the taxable gain (10000)
        assert s.taxable_gains == Decimal("10000")
        assert s.tax_total == (Decimal("10000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))


class TestFrCryptoTaxMultiYear:
    """Multi-year and loss carryforward scenarios."""

    def test_two_years_gain_and_loss(self):
        """Year 1 loss, Year 2 gain — carryforward reduces Year 2 tax."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("30000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),
            make_realized_pnl(pnl_id=2, proceeds=Decimal("60000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert len(report.summaries) == 2
        # Year 2024: loss
        s2024 = next(s for s in report.summaries if s.fiscal_year == 2024)
        assert s2024.tax_total == Decimal("0")
        # Year 2025: gain (potentially reduced by carryforward)
        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.taxable_gains > 0

    def test_multiple_disposals_same_year(self):
        """Multiple disposals in same year are aggregated."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("15000"), cost_basis=Decimal("10000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),
            make_realized_pnl(pnl_id=2, proceeds=Decimal("25000"), cost_basis=Decimal("20000"),
                              realized_at=datetime(2025, 9, 1, tzinfo=timezone.utc)),
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert len(report.summaries) == 1
        s = report.summaries[0]
        # Both gains: 5000 + 5000 = 10000
        assert s.taxable_gains == Decimal("10000")


class TestFrCryptoTaxNetting:
    """Gains/losses netting within and across fiscal years."""

    def test_gains_and_losses_net_within_year(self):
        """BTC gain + ETH loss in same year → net taxable = gain - |loss|."""
        entries = [
            make_realized_pnl(pnl_id=1, asset_id=2, proceeds=Decimal("50000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),  # +10k
            make_realized_pnl(pnl_id=2, asset_id=3, proceeds=Decimal("2000"), cost_basis=Decimal("5000"),
                              realized_at=datetime(2025, 7, 1, tzinfo=timezone.utc)),  # -3k
        ]
        asset_map = {2: make_asset(2, "BTC"), 3: make_asset(3, "ETH")}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.taxable_gains == Decimal("10000")
        assert s.taxable_losses == Decimal("-3000")
        assert s.net_taxable == Decimal("7000")
        expected_tax = (Decimal("7000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))
        assert s.tax_total == expected_tax

    def test_loss_carryforward_exact_amount(self):
        """2024 loss of -5k, 2025 gain of +20k → net taxable 2025 = 15k."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("35000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),  # -5k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("60000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),  # +20k
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s2024 = next(s for s in report.summaries if s.fiscal_year == 2024)
        assert s2024.tax_total == Decimal("0")
        assert s2024.loss_carryforward == Decimal("-5000")

        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.net_taxable == Decimal("15000")
        expected_tax = (Decimal("15000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))
        assert s2025.tax_total == expected_tax

    def test_loss_carryforward_exceeds_gain(self):
        """2024 loss of -20k, 2025 gain of +5k → no tax 2025, remaining carryforward -15k."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("20000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),  # -20k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("45000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),  # +5k
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.net_taxable == Decimal("0")
        assert s2025.tax_total == Decimal("0")
        assert s2025.loss_carryforward == Decimal("-15000")

    def test_three_year_chained_carryforward(self):
        """2023 loss, 2024 small gain (still net loss), 2025 large gain → tax only on residual."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("30000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2023, 6, 1, tzinfo=timezone.utc)),  # -10k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("43000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2024, 6, 1, tzinfo=timezone.utc)),  # +3k
            make_realized_pnl(pnl_id=3, proceeds=Decimal("60000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 6, 1, tzinfo=timezone.utc)),  # +20k
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        # 2023: loss -10k → carryforward -10k
        s2023 = next(s for s in report.summaries if s.fiscal_year == 2023)
        assert s2023.tax_total == Decimal("0")
        assert s2023.loss_carryforward == Decimal("-10000")

        # 2024: gain +3k, net after carryforward = -7k → no tax
        s2024 = next(s for s in report.summaries if s.fiscal_year == 2024)
        assert s2024.tax_total == Decimal("0")
        assert s2024.loss_carryforward == Decimal("-7000")

        # 2025: gain +20k, net after carryforward = +13k → tax on 13k
        s2025 = next(s for s in report.summaries if s.fiscal_year == 2025)
        assert s2025.net_taxable == Decimal("13000")
        expected_tax = (Decimal("13000") * FR_PFU_TOTAL_RATE).quantize(Decimal("0.01"))
        assert s2025.tax_total == expected_tax

    def test_all_losses_year(self):
        """All disposals in a year are losses → no tax, full loss carried forward."""
        entries = [
            make_realized_pnl(pnl_id=1, asset_id=2, proceeds=Decimal("30000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),  # -10k
            make_realized_pnl(pnl_id=2, asset_id=3, proceeds=Decimal("1500"), cost_basis=Decimal("3000"),
                              realized_at=datetime(2025, 7, 1, tzinfo=timezone.utc)),  # -1.5k
        ]
        asset_map = {2: make_asset(2, "BTC"), 3: make_asset(3, "ETH")}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.tax_total == Decimal("0")
        assert s.loss_carryforward == Decimal("-11500")


class TestFrCryptoTaxDistribution:
    """Tax is distributed proportionally across taxable gain line items."""

    def test_tax_distributed_proportionally(self):
        """Two gains of 5k and 15k → tax distributed in 1:3 ratio."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("45000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),  # +5k
            make_realized_pnl(pnl_id=2, proceeds=Decimal("55000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 9, 1, tzinfo=timezone.utc)),  # +15k
        ]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.net_taxable == Decimal("20000")

        # Line items should have proportional tax
        gain_items = [i for i in s.line_items if i.gain_or_loss > 0]
        assert len(gain_items) == 2

        # 5k/20k = 25% and 15k/20k = 75% of total tax
        total_tax = s.tax_total
        item_taxes = sorted([i.tax_total for i in gain_items])
        assert item_taxes[0] + item_taxes[1] == total_tax
        # The smaller item should get ~25% of total tax
        assert item_taxes[0] == (total_tax * Decimal("5000") / Decimal("20000")).quantize(Decimal("0.01"))

    def test_loss_items_get_no_tax(self):
        """Loss line items get zero tax even when there's a net gain."""
        entries = [
            make_realized_pnl(pnl_id=1, proceeds=Decimal("60000"), cost_basis=Decimal("40000"),
                              realized_at=datetime(2025, 3, 1, tzinfo=timezone.utc)),  # +20k
            make_realized_pnl(pnl_id=2, asset_id=3, proceeds=Decimal("2000"), cost_basis=Decimal("5000"),
                              realized_at=datetime(2025, 7, 1, tzinfo=timezone.utc)),  # -3k
        ]
        asset_map = {2: make_asset(2, "BTC"), 3: make_asset(3, "ETH")}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        loss_items = [i for i in s.line_items if i.gain_or_loss < 0]
        for item in loss_items:
            assert item.tax_total == Decimal("0")


class TestFrCryptoTaxEdgeCases:
    """Edge cases and boundary conditions."""

    def test_zero_gain_zero_tax(self):
        """Proceeds == cost_basis → zero gain, zero tax."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("40000"), cost_basis=Decimal("40000"))]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        if report.summaries:
            s = report.summaries[0]
            assert s.tax_total == Decimal("0")

    def test_report_has_correct_jurisdiction(self):
        """Report carries the correct tax_jurisdiction."""
        entries = [make_realized_pnl(pnl_id=1)]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        assert report.tax_jurisdiction == TaxJurisdiction.FR

    def test_pfu_breakdown_matches_total(self):
        """Income tax (12.8%) + social (17.2%) = total (30%)."""
        entries = [make_realized_pnl(pnl_id=1, proceeds=Decimal("50000"), cost_basis=Decimal("40000"))]
        asset_map = {2: make_asset()}
        calc = FrenchCryptoTaxCalculator("EUR")
        report = calc.compute(entries, asset_map)

        s = report.summaries[0]
        assert s.tax_income == Decimal("1280.00")   # 10000 * 12.8%
        assert s.tax_social == Decimal("1720.00")   # 10000 * 17.2%
        assert s.tax_total == Decimal("3000.00")     # 10000 * 30%
        assert s.tax_total == s.tax_income + s.tax_social
