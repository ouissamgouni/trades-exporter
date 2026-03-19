"""
Smoke/integration tests for ForexPriceGetter.

Real API calls — requires network. Uses free exchangerate-api.com (no key).

Run with: pytest -m network
"""

import pytest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

from backend.services.price_getters.base import PriceGetterConfig, PriceResult


@pytest.mark.integration
@pytest.mark.network
class TestForexSmoke:
    """Real API calls against exchangerate-api.com."""

    def test_usd_to_eur(self, forex_getter):
        asset = MagicMock()
        asset.symbol = "USD"
        config = PriceGetterConfig(extra={"to_currency": "EUR"})

        result = forex_getter.get_current_price(asset, config=config)

        assert isinstance(result, PriceResult)
        assert 0.5 < result.price < 2.0  # EUR/USD range sanity
        assert result.quote_currency == "EUR"
        assert result.source == "forex"

    def test_eur_to_usd(self, forex_getter):
        asset = MagicMock()
        asset.symbol = "EUR"

        result = forex_getter.get_current_price(asset)

        assert 0.5 < result.price < 2.0
        assert result.quote_currency == "USD"

    def test_gbp_to_usd(self, forex_getter):
        asset = MagicMock()
        asset.symbol = "GBP"

        result = forex_getter.get_current_price(asset)

        assert result.price > 0
        assert result.source == "forex"
