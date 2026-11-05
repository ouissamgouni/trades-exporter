"""
Integration tests for the Ankr Advanced API connector (live API).

Requires:
    ANKR_API_KEY=...
    ANKR_TEST_WALLET=0x...   (EVM address with history on ANKR_TEST_CHAIN)
    ANKR_TEST_CHAIN=arbitrum (optional, default arbitrum)
"""

import os

import pytest

from backend.connectors.onchain.connector_ankr import ConnectorAnkr
from backend.db.models import NormalizedTransaction

WALLET = os.environ.get("ANKR_TEST_WALLET")
CHAIN = os.environ.get("ANKR_TEST_CHAIN", "arbitrum")

pytestmark = [
    pytest.mark.integration,
    pytest.mark.timeout(180),
    pytest.mark.skipif(
        not (WALLET and os.environ.get("ANKR_API_KEY")),
        reason="ANKR_API_KEY / ANKR_TEST_WALLET not set — skipping live Ankr tests",
    ),
]


@pytest.fixture
def connector():
    return ConnectorAnkr(
        wallet_address=WALLET,
        chain_name=CHAIN,
        account_id=1,
        config={"test_mode": False, "disable_file_output": True},
    )


def test_fetch_and_normalize(connector):
    raws = list(connector.yield_raws())
    assert raws, f"No Ankr history for {WALLET} on {CHAIN}"
    normalized = [n for raw in raws for n in connector.raw_to_normalized(raw)]
    assert all(isinstance(n, NormalizedTransaction) for n in normalized)
    assert all(n.source == f"ankr_{CHAIN}" for n in normalized)
    assert any(n.direction in ("inflow", "outflow") for n in normalized)
    assert len({n.source_transaction_id for n in normalized}) == len(normalized)


def test_balance(connector):
    balance = connector.get_balance()
    assert isinstance(balance, list)
    assert all(b.chain == CHAIN and b.total > 0 for b in balance)
