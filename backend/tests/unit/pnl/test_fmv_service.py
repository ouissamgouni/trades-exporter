"""
Unit tests for FMVService.

Tests cover:
- FMV calculation
- Fallback behavior
- Error handling
- Caching of failed lookups
- Stablecoin peg fallback
"""

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

from backend.services.pnl.config import PnLConfig, CostMethod, LotMode
from backend.services.pnl.fmv_service import FMVService
from backend.db.models import LegType

from tests.unit.pnl.conftest import make_transaction, make_leg, make_asset


class TestFMVService:
    """Test FMV service."""

    def test_base_currency_returns_qty(self, fifo_config, base_datetime):
        """Base currency FMV = qty (1:1)."""
        fmv_service = FMVService(None, fifo_config)

        tx = make_transaction(id=1, 
            asset_id=1,  # EUR (base currency)
            quantity=Decimal("1000"),
            date_time=base_datetime,
        )

        result = fmv_service.get_fmv_in_base(tx)

        assert result.success is True
        assert result.value == Decimal("1000")
        assert result.source == "base_currency"

    def test_fetches_from_price_service(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Should fetch price from service when needed."""
        fmv_service = FMVService(mock_price_service, fifo_config)

        tx = make_transaction(id=1, 
            asset_id=2,  # BTC
            quantity=Decimal("1"),
            date_time=base_datetime,
        )

        result = fmv_service.get_fmv_in_base(tx)

        assert result.success is True
        assert result.value == Decimal("40000")  # 1 * 40000 (mock price)
        assert result.source == "price_service"

    def test_fallback_on_price_service_error(self, fifo_config, base_datetime):
        """Should return zero on price service error."""
        mock_service = Mock()
        # FMVService calls get_price_with_fallback when use_price_fallback=True (default)
        mock_service.get_price_with_fallback.side_effect = Exception("API error")

        fmv_service = FMVService(mock_service, fifo_config)

        tx = make_transaction(id=1, 
            asset_id=2,
            quantity=Decimal("1"),
            date_time=base_datetime,
        )

        result = fmv_service.get_fmv_in_base(tx, skip_on_error=True)

        assert result.success is False
        assert result.value == Decimal("0")
        assert result.source == "fallback"
        assert "API error" in result.error

    def test_caches_failed_lookups(self, fifo_config, base_datetime):
        """Should cache failed lookups to avoid repeated calls."""
        mock_service = Mock()
        # FMVService calls get_price_with_fallback when use_price_fallback=True (default)
        mock_service.get_price_with_fallback.side_effect = Exception("API error")

        fmv_service = FMVService(mock_service, fifo_config)

        tx = make_transaction(id=1, 
            asset_id=2,
            quantity=Decimal("1"),
            date_time=base_datetime,
        )

        # First call
        fmv_service.get_fmv_in_base(tx)
        # Second call (should use cache)
        fmv_service.get_fmv_in_base(tx)

        # Price service should only be called once (get_price_with_fallback is the method used)
        assert mock_service.get_price_with_fallback.call_count == 1

    def test_clear_cache(self, fifo_config, base_datetime):
        """Should clear failed lookup cache."""
        mock_service = Mock()
        # FMVService calls get_price_with_fallback when use_price_fallback=True (default)
        mock_service.get_price_with_fallback.side_effect = Exception("API error")

        fmv_service = FMVService(mock_service, fifo_config)

        tx = make_transaction(id=1, 
            asset_id=2,
            quantity=Decimal("1"),
            date_time=base_datetime,
        )

        # First call
        fmv_service.get_fmv_in_base(tx)

        # Clear cache
        fmv_service.clear_cache()

        # Second call (should hit service again)
        fmv_service.get_fmv_in_base(tx)

        assert mock_service.get_price_with_fallback.call_count == 2


class TestStablecoinPegFallback:
    """Test stablecoin peg fallback when price lookup returns no price."""

    def _make_usdc_leg(self, qty, dt):
        """Create a USDC CalculationUnitLeg (asset_id=8, symbol=USDC)."""
        usdc_asset = make_asset(8, "USDC")
        tx = make_transaction(id=99, asset_id=8, quantity=qty, date_time=dt)
        tx.asset = usdc_asset
        leg = make_leg(asset_id=8, leg_type=LegType.INFLOW, quantity=qty, transaction=tx)
        leg.asset = usdc_asset
        return leg

    def test_stablecoin_peg_fallback_success(self, base_datetime):
        """USDC should use USD→EUR forex rate when price lookup returns nothing."""
        mock_service = Mock()
        mock_service.get_price_with_fallback.return_value = SimpleNamespace(
            price=None, source=None, actual_price_date=None,
            is_fallback=False, is_stale=False, staleness_days=0,
        )
        mock_service.converter.convert.return_value = 0.92  # USD→EUR rate

        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            stablecoin_pegs={"USDC": "USD"},
        )
        fmv = FMVService(mock_service, config, session=Mock())
        leg = self._make_usdc_leg(Decimal("100"), base_datetime)

        result = fmv.get_fmv_in_base(leg)

        assert result.success is True
        assert result.source == "stablecoin_peg"
        assert result.value == Decimal("100") * Decimal("0.92")
        mock_service.converter.convert.assert_called_once()

    def test_stablecoin_peg_not_triggered_for_non_stablecoin(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """BTC should use normal price service, not stablecoin fallback."""
        fmv = FMVService(mock_price_service, fifo_config)
        tx = make_transaction(id=1, asset_id=2, quantity=Decimal("1"), date_time=base_datetime)

        result = fmv.get_fmv_in_base(tx)

        assert result.source == "price_service"
        assert result.value == Decimal("40000")

    def test_stablecoin_peg_skipped_without_session(self, base_datetime):
        """Stablecoin peg fallback requires a session; without it, falls through."""
        mock_service = Mock()
        mock_service.get_price_with_fallback.return_value = SimpleNamespace(
            price=None, source=None, actual_price_date=None,
            is_fallback=False, is_stale=False, staleness_days=0,
        )

        config = PnLConfig(
            lot_method=CostMethod.FIFO,
            lot_mode=LotMode.LOT_TRAVEL,
            base_currency_id=1,
            base_currency_symbol="EUR",
            stablecoin_pegs={"USDC": "USD"},
        )
        # No session passed
        fmv = FMVService(mock_service, config)
        leg = self._make_usdc_leg(Decimal("100"), base_datetime)

        result = fmv.get_fmv_in_base(leg)

        assert result.success is False
        assert result.source == "fallback"
