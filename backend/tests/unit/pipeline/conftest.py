"""
Shared fixtures for pipeline tests.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock

from backend.db.models import NormalizedTransaction


@pytest.fixture
def mock_session():
    """Create a mock SQLModel session."""
    session = MagicMock()
    session.exec.return_value.first.return_value = None
    return session


@pytest.fixture
def sample_transaction():
    """Create a sample transaction for testing."""
    return NormalizedTransaction(
        source="test",
        source_transaction_id="test_123",
        source_transaction_type="deposit",
        source_asset_symbol="BTC",
        account="test_account",
        date_time=datetime(2024, 1, 15, 10, 0, 0),
        direction="inflow",
        transaction_type="deposit",
        quantity=1.0,
    )


@pytest.fixture
def buy_transaction():
    """Create a buy transaction that should be split."""
    return NormalizedTransaction(
        source="binance",
        source_transaction_id="buy_123",
        source_transaction_type="buy",
        source_asset_symbol="BTC",
        source_price_quote_asset_symbol="USDT",
        account="binance",
        date_time=datetime(2024, 1, 15, 10, 0, 0),
        direction="inflow",
        transaction_type="buy",
        quantity=1.0,
        price=50000.0,
        total=50000.0,
    )
