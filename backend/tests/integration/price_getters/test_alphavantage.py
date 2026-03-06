"""
Smoke/integration tests for AlphaVantagePriceGetter.

Real API calls — requires network + ALPHAVANTAGE_API_KEY env var.
Free tier: 25 requests/day.

Run with: ALPHAVANTAGE_API_KEY=xxx pytest -m network
"""

import os
import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from backend.services.price_getters.base import PriceGetterConfig, PriceGetterError, PriceResult


@pytest.mark.integration
@pytest.mark.network
class TestAlphaVantageSmoke:
    """Real API calls against Alpha Vantage."""

    @pytest.fixture(autouse=True)
    def skip_without_key(self):
        if not os.environ.get("ALPHAVANTAGE_API_KEY") or os.environ.get("ALPHAVANTAGE_API_KEY") == "demo":
            pytest.skip("ALPHAVANTAGE_API_KEY not set or is demo key")

    def test_current_price_aapl(self, alphavantage_getter):
        asset = MagicMock()
        asset.symbol = "AAPL"
        asset.price_type = "stock"

        result = alphavantage_getter.get_current_price(asset)

        assert isinstance(result, PriceResult)
        assert result.price > 50
        assert result.source == "alphavantage"

    def test_current_price_btc(self, alphavantage_getter):
        asset = MagicMock()
        asset.symbol = "BTC"
        asset.price_type = "crypto"

        result = alphavantage_getter.get_current_price(asset)

        assert result.price > 1000
        assert result.source == "alphavantage"

    def test_historical_price_aapl(self, alphavantage_getter):
        asset = MagicMock()
        asset.symbol = "AAPL"
        asset.price_type = "stock"
        target = datetime.now(timezone.utc) - timedelta(days=14)

        result = alphavantage_getter.get_historical_price(asset, target)

        assert result.price > 0
        assert result.source == "alphavantage"
