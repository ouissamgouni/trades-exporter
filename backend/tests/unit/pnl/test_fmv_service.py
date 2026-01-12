"""
Unit tests for FMVService.

Tests cover:
- FMV calculation
- Fallback behavior
- Error handling
- Caching of failed lookups
"""

from decimal import Decimal
from unittest.mock import Mock

from backend.services.pnl.fmv_service import FMVService

from tests.unit.pnl.conftest import make_transaction


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
