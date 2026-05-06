"""
Tests for the refactored price service.

Tests cover:
- PriceGetterResolver: Asset type to getter mapping
- CurrencyConverter: Fiat currency conversion  
- PriceService: Main price fetching logic
- ForexPriceGetter: Forex rate fetching
"""

import pytest
from datetime import datetime
from decimal import Decimal
from unittest.mock import Mock, patch, MagicMock

from backend.db.models import Asset, AssetPriceGetter
from backend.services.price_service import (
    PriceService,
    PriceGetterResolver,
    CurrencyConverter,
    PriceCache,
    ASSET_TYPE_PRICE_GETTERS,
)
from backend.services.price_getters.base import PriceGetterConfig, PriceResult
from backend.services.price_getters.forex import ForexPriceGetter


class TestPriceGetterResolver:
    """Tests for PriceGetterResolver."""

    def test_default_getters_for_crypto(self):
        """Crypto assets should use coingecko then yahoo."""
        resolver = PriceGetterResolver()
        asset = Asset(asset_id=1, symbol="BTC", price_type="crypto")
        
        getters = resolver._get_default_getters(asset)
        
        assert len(getters) >= 1
        getter_names = [g[0] for g in getters]
        assert "coingecko" in getter_names

    def test_default_getters_for_stock(self):
        """Stock assets should use datareader then yahoo."""
        resolver = PriceGetterResolver()
        asset = Asset(asset_id=1, symbol="AAPL", price_type="stock")
        
        getters = resolver._get_default_getters(asset)
        
        getter_names = [g[0] for g in getters]
        assert "datareader" in getter_names or "yahoo" in getter_names

    def test_default_getters_for_fiat(self):
        """Fiat assets should use forex getter."""
        resolver = PriceGetterResolver()
        asset = Asset(asset_id=1, symbol="USD", price_type="fiat")
        
        getters = resolver._get_default_getters(asset)
        
        getter_names = [g[0] for g in getters]
        assert "forex" in getter_names

    def test_default_getters_for_unknown_type(self):
        """Unknown price types should use fallback getters."""
        resolver = PriceGetterResolver()
        asset = Asset(asset_id=1, symbol="XYZ", price_type="unknown_type")
        
        getters = resolver._get_default_getters(asset)
        
        # Should return some getters (fallback)
        assert len(getters) > 0

    def test_configured_getters_take_priority(self):
        """Explicitly configured getters should override defaults."""
        resolver = PriceGetterResolver()
        
        # Create mock session with configured getters
        mock_session = Mock()
        mock_apg = Mock()
        mock_apg.price_getter = "custom_getter"
        mock_apg.params = {"ticker": "CUSTOM"}
        
        mock_session.exec.return_value.all.return_value = [mock_apg]
        
        configured = resolver._get_configured_getters(mock_session, 1)
        
        assert len(configured) == 1
        assert configured[0][0] == "custom_getter"


class TestCurrencyConverter:
    """Tests for CurrencyConverter."""

    def test_same_currency_no_conversion(self):
        """Same currency should return original price."""
        converter = CurrencyConverter()
        mock_session = Mock()
        
        result = converter.convert(mock_session, 100.0, "USD", "USD")
        
        assert result == 100.0

    @patch('backend.services.price_service.get_price_getter')
    def test_conversion_uses_forex_getter(self, mock_get_getter):
        """Currency conversion should use forex getter when no configured getter."""
        converter = CurrencyConverter()
        mock_session = Mock()
        
        # Mock asset lookup
        mock_asset = Mock()
        mock_asset.symbol = "USD"
        mock_asset.asset_id = 1
        # First exec().first() returns asset, second returns None (no APG)
        mock_session.exec.return_value.first.side_effect = [mock_asset, None]
        
        # Mock forex getter
        mock_forex = Mock()
        mock_forex.get_current_price.return_value = PriceResult(
            price=0.85, quote_currency="EUR", source="forex"
        )
        mock_get_getter.return_value = mock_forex
        
        result = converter.convert(mock_session, 100.0, "USD", "EUR")
        
        assert result == 85.0  # 100 * 0.85

    @patch('backend.services.price_service.get_price_getter')
    def test_conversion_prefers_configured_getter_over_forex(self, mock_get_getter):
        """When a non-forex getter is configured for the currency, use it."""
        converter = CurrencyConverter()
        mock_session = Mock()

        # Mock asset lookup
        mock_asset = Mock()
        mock_asset.symbol = "USDC"
        mock_asset.asset_id = 42

        # Mock APG row (e.g. mock getter configured for USDC)
        mock_apg = Mock()
        mock_apg.price_getter = "mock"
        mock_apg.external_id = "USDC"
        mock_apg.params = {"quote_currency": "EUR"}
        mock_apg.enabled = True
        mock_apg.priority = 1

        # First exec().first() returns asset, second returns APG
        mock_session.exec.return_value.first.side_effect = [mock_asset, mock_apg]

        # Mock the configured getter (not forex)
        mock_configured = Mock()
        mock_configured.get_current_price.return_value = PriceResult(
            price=0.92, quote_currency="EUR", source="mock"
        )
        mock_get_getter.return_value = mock_configured

        result = converter.convert(mock_session, 100.0, "USDC", "EUR")

        assert result == 92.0  # 100 * 0.92

    @patch('backend.services.price_service.get_price_getter')
    def test_conversion_raises_on_missing_currency(self, mock_get_getter):
        """Should raise if currency not in assets table."""
        converter = CurrencyConverter()
        mock_session = Mock()
        
        # Mock asset not found
        mock_session.exec.return_value.first.return_value = None
        
        with pytest.raises(ValueError, match="not found in assets"):
            converter.convert(mock_session, 100.0, "XXX", "EUR")


class TestForexPriceGetter:
    """Tests for ForexPriceGetter."""

    def test_forex_getter_name(self):
        """Forex getter should have correct name."""
        getter = ForexPriceGetter()
        assert getter.name == "forex"

    @patch('requests.get')
    def test_fetch_rate_success(self, mock_get):
        """Should fetch rate from API."""
        getter = ForexPriceGetter()
        
        # Mock successful API response
        mock_response = Mock()
        mock_response.ok = True
        mock_response.json.return_value = {
            "rates": {"EUR": 0.85}
        }
        mock_get.return_value = mock_response
        
        rate = getter._fetch_rate("USD", "EUR")
        
        assert rate == 0.85

    @patch('requests.get')
    def test_fetch_inverse_rate(self, mock_get):
        """Should calculate inverse rate if direct not available."""
        getter = ForexPriceGetter()
        
        # Mock first call (direct) fails, second (inverse) succeeds
        mock_response_fail = Mock()
        mock_response_fail.ok = True
        mock_response_fail.json.return_value = {"rates": {}}
        
        mock_response_success = Mock()
        mock_response_success.ok = True
        mock_response_success.json.return_value = {
            "rates": {"USD": 1.18}
        }
        
        mock_get.side_effect = [mock_response_fail, mock_response_success]
        
        rate = getter._fetch_rate("USD", "EUR")
        
        # Should be inverse of 1.18
        assert abs(rate - (1.0 / 1.18)) < 0.001


class TestPriceService:
    """Tests for PriceService."""

    def test_init_with_base_currency(self):
        """Should accept base currency in constructor."""
        service = PriceService(base_currency="EUR")
        assert service.default_base_currency == "EUR"

    def test_init_normalizes_currency_case(self):
        """Should uppercase base currency."""
        service = PriceService(base_currency="eur")
        assert service.default_base_currency == "EUR"

    @patch.object(PriceService, '_get_session')
    @patch.object(PriceService, '_close_session')
    def test_same_asset_returns_one(self, mock_close, mock_get_session):
        """Requesting price of asset in same currency returns 1.0."""
        mock_session = Mock()
        mock_asset = Mock()
        mock_asset.symbol = "EUR"
        mock_session.get.return_value = mock_asset
        mock_get_session.return_value = mock_session
        
        service = PriceService(base_currency="EUR")
        price = service.get_current_price(1, "EUR")
        
        assert price == 1.0


class TestAssetTypeMappings:
    """Tests for asset type to price getter mappings."""

    def test_all_asset_types_have_mappings(self):
        """All price types should have getter mappings."""
        expected_types = ["crypto", "stock", "fiat"]
        
        for price_type in expected_types:
            assert price_type in ASSET_TYPE_PRICE_GETTERS

    def test_crypto_uses_coingecko_first(self):
        """Crypto should prefer coingecko."""
        getters = ASSET_TYPE_PRICE_GETTERS["crypto"]
        assert "coingecko" in getters

    def test_stock_uses_datareader_or_yahoo(self):
        """Stock should use datareader or yahoo."""
        getters = ASSET_TYPE_PRICE_GETTERS["stock"]
        assert "datareader" in getters or "yahoo" in getters

    def test_fiat_uses_forex(self):
        """Fiat should use forex getter."""
        getters = ASSET_TYPE_PRICE_GETTERS["fiat"]
        assert "forex" in getters


class TestPriceCache:
    """Tests for PriceCache."""

    def test_cache_miss_returns_none(self):
        """Should return None when no cached price."""
        cache = PriceCache()
        mock_session = Mock()
        mock_session.exec.return_value.first.return_value = None
        
        result = cache.get(mock_session, 1, 2, datetime.utcnow())
        
        assert result is None

    def test_cache_hit_returns_price(self):
        """Should return cached price when found."""
        cache = PriceCache()
        mock_session = Mock()
        mock_snapshot = Mock()
        mock_snapshot.price = Decimal("100.50")
        mock_session.exec.return_value.first.return_value = mock_snapshot
        
        result = cache.get(mock_session, 1, 2, datetime.utcnow())
        
        assert result == Decimal("100.50")
