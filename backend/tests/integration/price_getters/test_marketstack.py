"""
Smoke/integration tests for MarketstackPriceGetter.

Real API calls — requires network + MARKETSTACK_API_KEY env var.
Free tier: 100 requests/month, HTTP only.

Run with: MARKETSTACK_API_KEY=xxx pytest -m network
"""

import os
import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from backend.services.price_getters.base import (
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)
from backend.tests.integration.price_getters.conftest import call_or_skip_on_flaky_error


@pytest.mark.integration
@pytest.mark.network
class TestMarketstackSmoke:
    """Real API calls against Marketstack."""

    @pytest.fixture(autouse=True)
    def skip_without_key(self):
        if not os.environ.get("MARKETSTACK_API_KEY"):
            pytest.skip("MARKETSTACK_API_KEY not set")

    def test_current_price_aapl(self, marketstack_getter):
        asset = MagicMock()
        asset.symbol = "AAPL"

        result = call_or_skip_on_flaky_error(
            marketstack_getter.get_current_price, asset
        )

        assert isinstance(result, PriceResult)
        assert result.price > 50
        assert result.source == "marketstack"

    def test_historical_price_aapl(self, marketstack_getter):
        asset = MagicMock()
        asset.symbol = "AAPL"
        target = datetime.now(timezone.utc) - timedelta(days=14)

        result = call_or_skip_on_flaky_error(
            marketstack_getter.get_historical_price, asset, target
        )

        assert result.price > 0
        assert result.source == "marketstack"

    def test_missing_api_key_raises(self):
        from backend.services.price_getters.marketstack import MarketstackPriceGetter

        getter = MarketstackPriceGetter()
        getter._api_key = ""
        asset = MagicMock()
        asset.symbol = "AAPL"

        with pytest.raises(PriceGetterError):
            getter.get_current_price(asset)
