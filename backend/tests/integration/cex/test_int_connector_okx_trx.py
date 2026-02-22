"""
Integration test for OKX trades connector.
Tests that the connector can fetch and map trade data successfully.
"""

import pytest
import logging

from backend.connectors.cex.connector_okx_trx import OKXConnectorTrx

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_okx_trx_connector_yield_normalized():
    """Test OKX trades connector yield_normalized method."""
    # Limit symbols for faster testing
    test_symbols = ["BTC-USDT", "ETH-USDT"]  # OKX uses dash format
    connector = OKXConnectorTrx(symbols=test_symbols)

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
            log.info(f"✅ Mapped trade: {mapped_item.source_asset_symbol}")

    # Assertions - connector should work even if account has no trades
    assert connector is not None, "Connector should initialize"
    assert errors == [], f"Should not have mapping errors: {errors}"

    log.info(f"📊 OKX TRX test complete: {len(results)} trades, {len(errors)} errors")
    
    # Note: It's valid for results to be empty if the account has no trading history
    if len(results) == 0:
        log.info("⚠️ No trades found - this is expected for accounts with no trading history")
