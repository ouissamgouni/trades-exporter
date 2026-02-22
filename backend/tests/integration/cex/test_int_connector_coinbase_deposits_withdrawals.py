"""
Integration test for Coinbase deposits and withdrawals connectors.
Tests that the connectors can fetch and map deposit/withdrawal data successfully.
"""

import pytest
import logging

from backend.connectors.cex.connector_coinbase_deposits import (
    ConnectorCoinbaseDeposits,
)
from backend.connectors.cex.connector_coinbase_withdrawals import (
    ConnectorCoinbaseWithdrawals,
)

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger(__name__)


@pytest.mark.integration
def test_coinbase_deposits_connector_yield_normalized():
    """Test Coinbase deposits connector yield_normalized method."""
    connector = ConnectorCoinbaseDeposits()

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
        f"📊 Coinbase Deposits test complete: {len(results)} deposits, {len(errors)} errors"
    )


@pytest.mark.integration
def test_coinbase_withdrawals_connector_yield_normalized():
    """Test Coinbase withdrawals connector yield_normalized method."""
    connector = ConnectorCoinbaseWithdrawals()

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
                f"✅ Mapped withdrawal: {mapped_item.source_asset_symbol} - {mapped_item.quantity}"
            )

    # Assertions
    assert len(results) > 0, "Should yield at least some results"

    log.info(
        f"📊 Coinbase Withdrawals test complete: {len(results)} withdrawals, {len(errors)} errors"
    )
