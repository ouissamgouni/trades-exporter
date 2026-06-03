"""
Unit tests for group_handler _flatten_tags and dividend currency conversion.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timezone
from unittest.mock import Mock, MagicMock, patch

from backend.services.pnl.group_handler import _flatten_tags, _handle_dividend


# ---------------------------------------------------------------------------
# Tests: _flatten_tags
# ---------------------------------------------------------------------------

class TestFlattenTags:

    def test_list_of_dicts(self):
        tags = [{"withholding_amount": "1.07"}, {"withholding_jurisdiction": "US"}]
        result = _flatten_tags(tags)
        assert result == {"withholding_amount": "1.07", "withholding_jurisdiction": "US"}

    def test_flat_dict(self):
        tags = {"withholding_amount": "1.07", "withholding_jurisdiction": "US"}
        result = _flatten_tags(tags)
        assert result == tags

    def test_none(self):
        assert _flatten_tags(None) == {}

    def test_empty_list(self):
        assert _flatten_tags([]) == {}

    def test_empty_dict(self):
        assert _flatten_tags({}) == {}

    def test_mixed_list_items(self):
        """List with non-dict items should be skipped."""
        tags = [{"key": "val"}, "not_a_dict", 42, {"key2": "val2"}]
        result = _flatten_tags(tags)
        assert result == {"key": "val", "key2": "val2"}

    def test_full_dividend_tags(self):
        """Full dividend tag list as produced by the connector."""
        tags = [
            {"withholding_amount": "1.07"},
            {"withholding_jurisdiction": "US"},
            {"withholding_rate": "0.2997"},
            {"fx_rate": "1.0850"},
            {"net_amount_base": "2.30"},
            {"source_currency": "USD"},
            {"gross_amount_source": "3.57"},
            {"wht_amount_source": "1.07"},
        ]
        result = _flatten_tags(tags)
        assert result["fx_rate"] == "1.0850"
        assert result["wht_amount_source"] == "1.07"
        assert result["source_currency"] == "USD"
        assert len(result) == 8

    def test_integer_input(self):
        assert _flatten_tags(42) == {}

    def test_string_input(self):
        assert _flatten_tags("tags") == {}


# ---------------------------------------------------------------------------
# Tests: Dividend currency conversion in _handle_dividend
# ---------------------------------------------------------------------------

class TestDividendCurrencyConversion:
    """
    Test _handle_dividend directly for WHT currency conversion.
    """

    def _make_dividend_unit(self, tags, gross_base=Decimal("3.00")):
        """Build a minimal CalculationUnit for dividend processing."""
        now = datetime(2025, 1, 2, 8, 30, tzinfo=timezone.utc)

        # Create the transaction mock
        tx = Mock()
        tx.id = 1
        tx.tags = tags
        tx.attributed_asset_id = 100
        tx.source_transaction_type = "dividend"
        tx.transaction_type = "dividend"

        # Create the inflow leg mock
        leg = Mock()
        leg.transaction = tx
        leg.asset_id = 1  # EUR (cash)
        leg.quantity = float(gross_base)
        leg.date_time = now
        leg.leg_type = "inflow"
        leg.direction = "inflow"

        # Create the unit mock
        unit = Mock()
        unit.id = 42
        unit.version_id = 1
        unit.inflow_legs = [leg]
        unit.outflow_legs = []
        unit.legs = [leg]
        unit.fee_legs = []
        unit.income_events = None
        unit.cost_lots = None
        unit.warnings = []

        return unit, leg

    def _make_fmv_service(self, base_value: Decimal):
        """Create mock FMV service returning a fixed base value."""
        fmv = Mock()
        result = Mock()
        result.value = base_value
        fmv.get_fmv_in_base.return_value = result
        return fmv

    def _make_lot_manager(self):
        return Mock()

    def _make_config(self):
        from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
        return PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            residual_tolerance_pct=Decimal("0.05"),
            allow_negative_balances=False,
        )

    @patch("backend.services.pnl.group_handler._handle_acquisition")
    def _run_handle_dividend(self, tags, gross_base, mock_acq=None):
        """Run _handle_dividend and return the IncomeEvent."""
        unit, leg = self._make_dividend_unit(tags, gross_base)
        fmv = self._make_fmv_service(gross_base)
        lot_mgr = self._make_lot_manager()
        config = self._make_config()

        _handle_dividend(unit, lot_mgr, fmv, config)

        assert unit.income_events is not None
        assert len(unit.income_events) >= 1
        return unit.income_events[0]

    def test_wht_conversion_with_fx_rate(self):
        """WHT in USD + fx_rate → correct EUR amounts on IncomeEvent."""
        tags = [
            {"withholding_amount": "1.07"},
            {"withholding_jurisdiction": "US"},
            {"withholding_rate": "0.30"},
            {"fx_rate": "1.0850"},
            {"source_currency": "USD"},
            {"gross_amount_source": "3.57"},
            {"wht_amount_source": "1.07"},
        ]

        gross_base = Decimal("3.29")
        ie = self._run_handle_dividend(tags, gross_base)

        # WHT should be converted: 1.07 USD / 1.085 ≈ 0.986... EUR
        expected_wht = Decimal("1.07") / Decimal("1.0850")
        assert abs(ie.withholding_amount_in_base - expected_wht) < Decimal("0.01")

        # Net = gross - converted WHT
        expected_net = gross_base - expected_wht
        assert abs(ie.net_amount_in_base - expected_net) < Decimal("0.01")

    def test_wht_proportional_conversion(self):
        """WHT in USD, no fx_rate → proportional conversion."""
        tags = [
            {"withholding_amount": "1.07"},
            {"withholding_jurisdiction": "US"},
            {"source_currency": "USD"},
            {"gross_amount_source": "3.57"},
        ]

        gross_base = Decimal("3.29")
        ie = self._run_handle_dividend(tags, gross_base)

        # Proportional: wht_raw * (gross_base / gross_source) = 1.07 * (3.29 / 3.57)
        ratio = gross_base / Decimal("3.57")
        expected_wht = Decimal("1.07") * ratio
        assert abs(ie.withholding_amount_in_base - expected_wht) < Decimal("0.01")

    def test_same_currency_no_conversion(self):
        """EUR dividend → WHT used as-is (no conversion)."""
        tags = [
            {"withholding_amount": "1.04"},
            {"withholding_jurisdiction": "NL"},
            {"source_currency": "EUR"},
            {"gross_amount_source": "5.20"},
        ]

        gross_base = Decimal("5.20")
        ie = self._run_handle_dividend(tags, gross_base)

        # Proportional: 1.04 * (5.20 / 5.20) = 1.04
        assert abs(ie.withholding_amount_in_base - Decimal("1.04")) < Decimal("0.01")
        assert abs(ie.net_amount_in_base - Decimal("4.16")) < Decimal("0.01")

    def test_tags_none_no_crash(self):
        """No tags at all → zero withholding, no crash."""
        gross_base = Decimal("5.20")
        ie = self._run_handle_dividend(None, gross_base)

        assert ie.withholding_amount_in_base == Decimal("0")
        assert ie.net_amount_in_base == gross_base

    def test_tags_empty_list_no_crash(self):
        """Empty tags list → zero withholding, no crash."""
        gross_base = Decimal("5.20")
        ie = self._run_handle_dividend([], gross_base)

        assert ie.withholding_amount_in_base == Decimal("0")
        assert ie.net_amount_in_base == gross_base
