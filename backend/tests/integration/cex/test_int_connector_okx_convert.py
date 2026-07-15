"""
Integration test for OKX convert connector.
Tests that the connector can fetch and map convert data successfully.
"""

import pytest
import logging
from datetime import datetime, timezone

from backend.config.loader import has_exchange_credentials
from backend.connectors.cex.connector_okx_convert import OKXConvertConnector

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)

# Only fetch recent data to speed up integration tests
TEST_SINCE = datetime(2025, 5, 1, tzinfo=timezone.utc)

pytestmark = pytest.mark.skipif(
    not has_exchange_credentials("okx"),
    reason="OKX_API_KEY/OKX_API_SECRET not configured — skipping live OKX integration test",
)


@pytest.mark.integration
def test_okx_convert_connector_yield_normalized():
    """Test OKX convert connector yield_normalized method."""
    connector = OKXConvertConnector(config={"since_datetime": TEST_SINCE})

    results = []
    errors = []

    # Fetch and validate results
    for idx, (raw_item, mapped_item, error) in enumerate(connector.yield_normalized()):
        if idx >= 5:  # Limit test iterations
            break

        if error:
            errors.append(error)
            log.warning(f"❌ Mapping error: {error}")
        else:
            results.append(mapped_item)
            log.info(
                f"✅ Mapped convert: {mapped_item.source_asset_symbol} -> {mapped_item.source_price_quote_asset_symbol}"
            )

    # Assertions - connector should work even if account has no converts
    assert connector is not None, "Connector should initialize"
    assert errors == [], f"Should not have mapping errors: {errors}"

    log.info(
        f"📊 OKX Convert test complete: {len(results)} converts, {len(errors)} errors"
    )

    # Note: It's valid for results to be empty if the account has no conversion history
    if len(results) == 0:
        log.info(
            "⚠️ No conversions found - this is expected for accounts with no conversion history"
        )
