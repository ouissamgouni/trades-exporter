"""
Integration test for Binance deposits connector.
Tests that the connector can fetch and map deposit data successfully.
"""

import pytest
import logging

from backend.connectors.cex.connector_binance_deposits import (
    ConnectorBinanceDeposits,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_binance_deposits_connector_yield_normalized():
    """Test Binance deposits connector yield_normalized method."""
    connector = ConnectorBinanceDeposits()

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
                f"✅ Mapped deposit: {mapped_item.source_asset_symbol} - {mapped_item.quantity}"
            )

    # Assertions
    assert len(results) > 0, "Should yield at least some results"

    log.info(
        f"📊 Binance Deposits test complete: {len(results)} deposits, {len(errors)} errors"
    )
