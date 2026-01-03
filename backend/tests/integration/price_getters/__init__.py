"""
Integration tests for Price Getters.

Test files:
- test_registry.py: Registry tests (no network)
- test_yahoo.py: Yahoo Finance tests
- test_coingecko.py: CoinGecko tests
- conftest.py: Shared fixtures

Run all: pytest tests/integration/price_getters/ -v
Run offline only: pytest tests/integration/price_getters/ -v -m "not network"
"""
