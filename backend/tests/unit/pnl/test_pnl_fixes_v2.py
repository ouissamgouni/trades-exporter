"""
Unit tests for the four P&L fixes:
1. Force-settle dust lots (< $1.00 base value)
2. include_fee auto-detection (fee in inflow asset → False)
3. Snapshot consistency (include_unsettled_negative default)
4. Provisional cost lot warning enrichment (qty + FMV value)
"""
import pytest
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch

from backend.db.models import (
    CostLot, CostLotEvent, LotEventType, NormalizedTransaction,
    CalculationUnit, CalculationUnitLeg, LegType,
)
from backend.services.pnl.lot_manager import LotManager, force_settle_lot
from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.group_handler import handle_unit
from backend.services.pnl.fmv_service import FMVService

from tests.unit.pnl.conftest import (
    create_lot, seed_lot, make_unit, make_leg, make_transaction,
)


# ============================================================================
# Issue 1: Force-settle
# ============================================================================

class TestForceSettle:

    def _make_negative_lot(self, qty_remaining=Decimal("-0.0001"), unit_cost=Decimal("50000")):
        lot = CostLot(
            cost_lot_id=42,
            asset_id=2,
            account_id=1,
            qty=Decimal("-0.001"),
            qty_remaining=qty_remaining,
            unit_cost_in_base=unit_cost,
            is_negative=True,
            is_settled=False,
            acquired_at=datetime(2024, 1, 1, tzinfo=timezone.utc),
        )
        lot.events = []
        return lot

    def test_force_settle_dust_lot(self):
        """Force-settle a lot with abs value < $1.00 → succeeds."""
        lot = self._make_negative_lot(
            qty_remaining=Decimal("-0.00001"),
            unit_cost=Decimal("50000"),  # abs value = 0.5
        )
        session = MagicMock()
        session.get.return_value = lot

        result = force_settle_lot(session, 42)

        assert result.is_settled is True
        assert result.qty_remaining == Decimal(0)
        assert "manual-settle: dust" in result.notes
        assert len(result.events) == 1
        assert result.events[0].event_type == LotEventType.SETTLED.value

    def test_force_settle_rejects_large_lot(self):
        """Force-settle a lot with abs value > $1.00 → rejected."""
        lot = self._make_negative_lot(
            qty_remaining=Decimal("-0.1"),
            unit_cost=Decimal("50000"),  # abs value = 5000
        )
        session = MagicMock()
        session.get.return_value = lot

        with pytest.raises(ValueError, match="exceeds threshold"):
            force_settle_lot(session, 42)

        assert lot.is_settled is False
        assert lot.qty_remaining == Decimal("-0.1")


# ============================================================================
# Issue 2: include_fee auto-detection
# ============================================================================

class TestIncludeFeeAutoDetection:

    def _make_tx(self, direction, source_asset_symbol, source_fee_quote_asset_symbol,
                 source_price_quote_asset_symbol=None, include_fee=True):
        return NormalizedTransaction(
            source="test",
            source_transaction_id="tx-1",
            source_asset_symbol=source_asset_symbol,
            source_price_quote_asset_symbol=source_price_quote_asset_symbol,
            source_fee_quote_asset_symbol=source_fee_quote_asset_symbol,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction=direction,
            transaction_type="trade",
            quantity=Decimal("1"),
            include_fee=include_fee,
        )

    def test_include_fee_auto_false_buy_btc_fee_btc(self):
        """Buy BTC with BTC fee → include_fee should be False."""
        from backend.services.pipeline.stages.persistence import PersistenceStage
        stage = PersistenceStage()
        tx = self._make_tx(
            direction="inflow",
            source_asset_symbol="BTC",
            source_fee_quote_asset_symbol="BTC",
            include_fee=True,
        )
        result = stage._pydantic_to_sqlmodel(tx, raw_id=None)
        assert result.include_fee is False

    def test_include_fee_stays_true_buy_btc_fee_eur(self):
        """Buy BTC with EUR fee → include_fee stays True."""
        from backend.services.pipeline.stages.persistence import PersistenceStage
        stage = PersistenceStage()
        tx = self._make_tx(
            direction="inflow",
            source_asset_symbol="BTC",
            source_fee_quote_asset_symbol="EUR",
            include_fee=True,
        )
        result = stage._pydantic_to_sqlmodel(tx, raw_id=None)
        assert result.include_fee is True

    def test_include_fee_auto_false_sell_btc_fee_eur(self):
        """Sell BTC for EUR with EUR fee → include_fee should be False."""
        from backend.services.pipeline.stages.persistence import PersistenceStage
        stage = PersistenceStage()
        tx = self._make_tx(
            direction="outflow",
            source_asset_symbol="BTC",
            source_fee_quote_asset_symbol="EUR",
            source_price_quote_asset_symbol="EUR",
            include_fee=True,
        )
        result = stage._pydantic_to_sqlmodel(tx, raw_id=None)
        assert result.include_fee is False


# ============================================================================
# Issue 3: Snapshot consistency
# ============================================================================

class TestSnapshotConsistency:

    def test_compute_version_metrics_includes_unsettled_by_default(self):
        """compute_version_metrics should default to include_unsettled_negative=True."""
        import inspect
        from backend.services.pnl.metrics_service import compute_version_metrics

        sig = inspect.signature(compute_version_metrics)
        param = sig.parameters["include_unsettled_negative"]
        assert param.default is True, (
            f"Expected include_unsettled_negative default=True, got {param.default}"
        )


# ============================================================================
# Issue 4: Warning message enrichment
# ============================================================================

class TestProvisionalCostLotWarning:

    def test_provisional_cost_lot_warning_includes_qty_and_value(self, mock_price_service, base_datetime):
        """Warning message should contain qty and FMV value; details should have fmv_value."""
        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            allow_negative_balances=True,
        )
        manager = LotManager(config)
        fmv_service = FMVService(mock_price_service, config)

        # Create a sell without any lots → negative lot with FMV cost
        sell_tx = make_transaction(
            id=10, asset_id=2, quantity=Decimal("0.5"),
            account_id=1, date_time=base_datetime,
        )
        sell_leg = make_leg(
            asset_id=2, leg_type=LegType.OUTFLOW,
            quantity=Decimal("0.5"), transaction=sell_tx,
        )

        inflow_tx = make_transaction(
            id=11, asset_id=1, quantity=Decimal("20000"),
            account_id=1, date_time=base_datetime,
        )
        inflow_leg = make_leg(
            asset_id=1, leg_type=LegType.INFLOW,
            quantity=Decimal("20000"), transaction=inflow_tx,
        )

        unit = make_unit(
            legs=[sell_leg, inflow_leg],
            pattern="swap",
            unit_label="Sell 0.5 BTC",
        )
        unit.id = 1
        unit.warnings = []

        handle_unit(unit, manager, fmv_service, config)

        # Find provisional_cost_lot warning
        prov_warnings = [w for w in (unit.warnings or []) if w.warning_type == "provisional_cost_lot"]
        assert len(prov_warnings) >= 1, f"Expected provisional_cost_lot warning, got: {[w.warning_type for w in (unit.warnings or [])]}"

        w = prov_warnings[0]
        # Message should contain qty and FMV value
        assert "qty=" in w.message
        assert "FMV value=" in w.message
        # Details should include fmv_value
        assert "fmv_value" in w.details
        assert w.details["fmv_value"] > 0
