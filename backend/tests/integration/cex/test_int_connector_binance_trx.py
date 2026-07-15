"""
Integration test for Binance trades connector.
Tests that the connector can fetch and map trade data successfully.
"""

import pytest
import logging
from datetime import datetime, timezone
from unittest.mock import patch

from backend.config.loader import has_exchange_credentials
from backend.connectors.cex.connector_binance_trx import BinanceTrxConnector

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# Only fetch recent data to speed up integration tests
TEST_SINCE = datetime(2025, 5, 1, tzinfo=timezone.utc)

pytestmark = pytest.mark.skipif(
    not has_exchange_credentials("binance"),
    reason="BINANCE_API_KEY/BINANCE_API_SECRET not configured — skipping live Binance integration test",
)


@pytest.mark.integration
def test_binance_trx_connector_yield_normalized():
    """Test Binance trades connector yield_normalized method."""
    # Mock get_symbols to return limited test symbols
    with patch.object(
        BinanceTrxConnector,
        "get_symbols",
        return_value=["BTC/USDT", "ETH/USDT", "BNB/EUR"],
    ):
        connector = BinanceTrxConnector(config={"since_datetime": TEST_SINCE})

        results = []
        errors = []

        # Fetch and validate results
        for idx, (raw_item, mapped_item, error) in enumerate(
            connector.yield_normalized()
        ):
            if idx >= 5:  # Limit test iterations
                break

            if error:
                errors.append(error)
                log.warning(f"❌ Mapping error: {error}")
            else:
                results.append(mapped_item)
                log.info(f"✅ Mapped trade: {mapped_item.id}")

        # Assertions
        assert len(results) > 0, "Should yield at least some results"

        log.info(
            f"📊 Binance TRX test complete: {len(results)} trades, {len(errors)} errors"
        )
