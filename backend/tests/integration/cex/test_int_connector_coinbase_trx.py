"""
Integration test for Coinbase trades connector.
Tests that the connector can fetch and map trade data successfully.
"""

import pytest
import logging
from unittest.mock import patch

from backend.connectors.cex.connector_coinbase_trx import ConnectorCoinbaseTrx

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_coinbase_trx_connector_yield_normalized():
    """Test Coinbase trades connector yield_normalized method."""
    # Mock get_symbols to return limited test symbols
    with patch.object(
        ConnectorCoinbaseTrx,
        "get_symbols",
        return_value=["TAO-USDC"],
    ):
        connector = ConnectorCoinbaseTrx()

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
                log.info(f"✅ Mapped trade: {mapped_item.source_asset_symbol}")

        # Assertions
        assert len(results) > 0, "Should yield at least some results"

        log.info(
            f"📊 Coinbase TRX test complete: {len(results)} trades, {len(errors)} errors"
        )
