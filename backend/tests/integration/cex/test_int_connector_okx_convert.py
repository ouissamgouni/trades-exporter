"""
Integration test for OKX convert connector.
Tests that the connector can fetch and map convert data successfully.
"""

import pytest
import logging

from backend.connectors.cex.connector_okx_convert import OKXConvertConnector

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_okx_convert_connector_yield_normalized():
    """Test OKX convert connector yield_normalized method."""
    connector = OKXConvertConnector()

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

    # Assertions
    assert len(results) > 0, "Should yield at least some results"

    log.info(
        f"📊 OKX Convert test complete: {len(results)} converts, {len(errors)} errors"
    )
