"""Unit tests for the Algorand connector."""

from decimal import Decimal
from unittest.mock import patch

import pytest

from backend.connectors.onchain.connector_algorand import ConnectorAlgorand

WALLET = "5SNZVDHT7UJPJ2HOFGWO5L3GMV4YFVDDWBLPQY6OLRPANPHRPJWFMXH7DI"


@pytest.fixture
def connector():
    return ConnectorAlgorand(
        wallet_address=WALLET, account_id=1, connector_id=1, config={"test_mode": True}
    )


@pytest.fixture
def raws(connector):
    return {tx["id"]: tx for tx in connector.yield_raws()}


def _norm(connector, raw):
    return list(connector.raw_to_normalized(raw))


def test_inflow_payment(connector, raws):
    txs = _norm(connector, raws["7YZ7THNT62R4EZH2FLG2TEN4P7TNPPBUUKRI7RF5SZPQH6F3MTJQ"])
    assert len(txs) == 1
    tx = txs[0]
    assert tx.direction == "inflow"
    assert tx.source_asset_symbol == "ALGO"
    assert tx.quantity == Decimal("785.73")
    assert tx.network == "algorand"
    assert (
        tx.network_transaction_id
        == "7YZ7THNT62R4EZH2FLG2TEN4P7TNPPBUUKRI7RF5SZPQH6F3MTJQ"
    )
    assert (
        tx.source_transaction_id
        == "7YZ7THNT62R4EZH2FLG2TEN4P7TNPPBUUKRI7RF5SZPQH6F3MTJQ_0_pay"
    )


def test_outflow_payment_with_fee(connector, raws):
    transfer, fee = _norm(
        connector, raws["OUTPAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]
    )
    assert (transfer.direction, transfer.quantity) == ("outflow", Decimal("100"))
    assert fee.transaction_type == "cost"
    assert fee.quantity == Decimal("0.001")
    assert fee.source_transaction_id.endswith("_fee")


def test_opt_in_yields_only_fee(connector, raws):
    txs = _norm(connector, raws["OPTINAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
    assert [t.transaction_type for t in txs] == ["cost"]


def test_swap_inner_txn_leg(connector, raws):
    txs = _norm(connector, raws["SWAPAPPLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
    usdc = [t for t in txs if t.transaction_type == "transfer"]
    assert len(usdc) == 1
    assert usdc[0].direction == "inflow"
    assert usdc[0].source_asset_symbol == "USDC"
    assert usdc[0].quantity == Decimal("1.85")
    assert usdc[0].token_contract_address == "31566704"
    assert (
        usdc[0].source_transaction_id
        == "SWAPAPPLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0.0_axfer"
    )
    assert {"group": "R1JPVVBBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="} in usdc[0].tags


def test_close_out_and_rewards(connector, raws):
    txs = _norm(connector, raws["CLOSEOUTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"])
    by_type = {
        t.source_transaction_type: t for t in txs if t.transaction_type == "transfer"
    }
    assert by_type["PAY_CLOSE"].direction == "outflow"
    assert by_type["PAY_CLOSE"].quantity == Decimal("675.719")
    assert by_type["REWARD"].direction == "inflow"
    assert by_type["REWARD"].quantity == Decimal("0.0015")
    assert "PAY" not in by_type  # zero-amount payment


def test_source_transaction_ids_unique(connector, raws):
    ids = [
        t.source_transaction_id for raw in raws.values() for t in _norm(connector, raw)
    ]
    assert len(ids) == len(set(ids))


def test_get_balance_reserves_min_balance(connector):
    account = {
        "amount": 785730000,
        "min-balance": 200000,
        "assets": [
            {"asset-id": 31566704, "amount": 1850000},
            {"asset-id": 1, "amount": 0},
        ],
    }
    with patch.object(connector, "safe_request", return_value=account):
        entries = connector.get_balance()
    algo, usdc = entries
    assert (algo.asset_symbol, algo.total, algo.available, algo.locked) == (
        "ALGO",
        Decimal("785.73"),
        Decimal("785.53"),
        Decimal("0.2"),
    )
    assert (usdc.asset_symbol, usdc.total, usdc.contract_address) == (
        "USDC",
        Decimal("1.85"),
        "31566704",
    )
