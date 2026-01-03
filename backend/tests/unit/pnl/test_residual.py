"""
Unit tests for residual computation.

Tests cover:
- Residual calculation between inflows/outflows
- Configuration options for skipping residual
- Error handling when FMV fails
"""

from decimal import Decimal
from unittest.mock import Mock

from backend.services.pnl.fmv_service import FMVService, compute_group_residual

from tests.unit.pnl.conftest import MockTransaction


class TestResidualComputation:
    """Test residual computation."""

    def test_compute_residual(self, fifo_config, mock_price_service, base_datetime):
        """Should compute residual correctly."""
        fmv_service = FMVService(mock_price_service, fifo_config)

        inflows = [
            MockTransaction(asset_id=1, quantity=Decimal("1000")),  # 1000 EUR
        ]
        outflows = [
            MockTransaction(
                asset_id=2,
                quantity=Decimal("0.025"),
                date_time=base_datetime,
            ),
        ]
        fees = []

        result = compute_group_residual(
            inflows, outflows, fees, fmv_service, fifo_config
        )

        assert result is not None
        assert result["inflow_value"] == Decimal("1000")
        assert result["outflow_value"] == Decimal("1000")  # 0.025 * 40000
        assert result["residual"] == Decimal("0")
        assert result["residual_pct"] == Decimal("0")

    def test_compute_residual_with_imbalance(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Should compute residual when values don't match."""
        fmv_service = FMVService(mock_price_service, fifo_config)

        inflows = [
            MockTransaction(asset_id=1, quantity=Decimal("1100")),  # 1100 EUR
        ]
        outflows = [
            MockTransaction(
                asset_id=2,
                quantity=Decimal("0.025"),  # Worth 1000 EUR at mock price
                date_time=base_datetime,
            ),
        ]
        fees = []

        result = compute_group_residual(
            inflows, outflows, fees, fmv_service, fifo_config
        )

        assert result is not None
        assert result["inflow_value"] == Decimal("1100")
        assert result["outflow_value"] == Decimal("1000")
        assert result["residual"] == Decimal("100")

    def test_skip_residual_when_disabled(self, fifo_config):
        """Should skip residual when disabled in config."""
        fifo_config.compute_residuals = False
        fmv_service = FMVService(None, fifo_config)

        result = compute_group_residual([], [], [], fmv_service, fifo_config)

        assert result is None

    def test_skip_residual_on_fmv_error(self, fifo_config, base_datetime):
        """Should skip residual when FMV fetch fails."""
        mock_service = Mock()
        mock_service.get_price.return_value = None

        fmv_service = FMVService(mock_service, fifo_config)
        fifo_config.skip_fmv_on_error = True

        outflows = [
            MockTransaction(asset_id=2, quantity=Decimal("1"), date_time=base_datetime),
        ]

        result = compute_group_residual([], outflows, [], fmv_service, fifo_config)

        # Should skip because FMV failed and skip_fmv_on_error is True
        assert result is None

    def test_residual_includes_fees(
        self, fifo_config, mock_price_service, base_datetime
    ):
        """Should include fees in residual computation."""
        fmv_service = FMVService(mock_price_service, fifo_config)

        inflows = [
            MockTransaction(asset_id=1, quantity=Decimal("1000")),
        ]
        outflows = [
            MockTransaction(
                asset_id=2,
                quantity=Decimal("0.02"),  # Worth 800 EUR
                date_time=base_datetime,
            ),
        ]
        fees = [
            MockTransaction(
                asset_id=1,
                quantity=Decimal("10"),  # 10 EUR fee
            ),
        ]

        result = compute_group_residual(
            inflows, outflows, fees, fmv_service, fifo_config
        )

        assert result is not None
        assert result["inflow_value"] == Decimal("1000")
        assert result["fee_value"] == Decimal("10")
