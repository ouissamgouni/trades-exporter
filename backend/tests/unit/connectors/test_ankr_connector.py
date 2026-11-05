"""Unit tests for the Ankr Advanced API connector (fixture-based, no network)."""

import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import pytest

from backend.connectors.connector_registry import get_connector_registry
from backend.connectors.onchain.connector_ankr import ConnectorAnkr

WALLET = "0xdead000000000000000000000000000000000001"


@pytest.fixture
def connector():
    return ConnectorAnkr(
        wallet_address=WALLET.upper().replace("0X", "0x"),
        chain_name="bsc",
        account_id=1,
        connector_id=1,
        config={"test_mode": True, "disable_file_output": True},
    )


@pytest.fixture
def normalized(connector):
    rows = {}
    for raw in connector.yield_raws():
        for ntx in connector.raw_to_normalized(raw):
            rows[ntx.source_transaction_id] = ntx
    return rows


def test_registry_maps_ankr():
    registry = get_connector_registry()
    assert registry.get_class("ankr") is ConnectorAnkr
    assert {"bsc", "arbitrum"} <= set(registry.get("ankr").supported_chains)


def test_unsupported_chain_rejected():
    with pytest.raises(ValueError, match="Unsupported chain"):
        ConnectorAnkr(
            wallet_address=WALLET,
            chain_name="solana",
            config={"test_mode": True, "disable_file_output": True},
        )


def test_live_mode_requires_api_key():
    with patch.dict("os.environ", {"ANKR_API_KEY": ""}):
        with pytest.raises(ValueError, match="ANKR_API_KEY"):
            ConnectorAnkr(
                wallet_address=WALLET,
                chain_name="bsc",
                config={"test_mode": False, "disable_file_output": True},
            )


def test_yield_raws_tags_kinds(connector):
    raws = list(connector.yield_raws())
    assert [r["_kind"] for r in raws].count("transaction") == 4
    assert [r["_kind"] for r in raws].count("token_transfer") == 4


def test_native_inflow(normalized):
    ntx = normalized[
        "0x1111111111111111111111111111111111111111111111111111111111111111_native_0"
    ]
    assert ntx.direction == "inflow"
    assert ntx.source_asset_symbol == "BNB"
    assert ntx.quantity == pytest.approx(0.15)
    assert ntx.fee == 0.0
    assert ntx.network == "bsc"
    assert ntx.source == "ankr_bsc"
    assert ntx.date_time == datetime.fromtimestamp(0x68E1AD61, tz=timezone.utc)


def test_native_outflow_pays_fee(normalized):
    ntx = normalized[
        "0x2222222222222222222222222222222222222222222222222222222222222222_native_0"
    ]
    assert ntx.direction == "outflow"
    assert ntx.quantity == pytest.approx(1.0)
    assert ntx.fee == pytest.approx(21000 * 1e9 / 1e18)
    assert ntx.include_fee is True


def test_contract_call_is_fee_only_row(normalized):
    tx_hash = "0x3333333333333333333333333333333333333333333333333333333333333333"
    fee_row = normalized[tx_hash]
    assert fee_row.quantity == 0.0
    assert fee_row.fee == pytest.approx(0xB3B0 * 1e9 / 1e18)
    token_row = normalized[f"{tx_hash}_erc20_3"]
    assert token_row.network_transaction_id == fee_row.network_transaction_id
    assert token_row.direction == "outflow"
    assert token_row.quantity == pytest.approx(10.0)
    assert token_row.review_status != "invalid"


def test_failed_tx_moves_no_value_but_pays_fee(normalized):
    ntx = normalized[
        "0x4444444444444444444444444444444444444444444444444444444444444444"
    ]
    assert ntx.quantity == 0.0
    assert ntx.fee > 0
    assert {"failed": True} in ntx.tags


def test_erc20_inflow(normalized):
    ntx = normalized[
        "0x5555555555555555555555555555555555555555555555555555555555555555_erc20_7"
    ]
    assert ntx.direction == "inflow"
    assert ntx.source_asset_symbol == "USDT"
    assert ntx.quantity == pytest.approx(25.5)
    assert ntx.token_contract_address == "0x55d398326f99059ff775485246999027b3197955"


def test_spoofed_sender_flagged(normalized):
    ntx = normalized[
        "0x6666666666666666666666666666666666666666666666666666666666666666_erc20_1"
    ]
    assert ntx.review_status == "invalid"
    assert "spoofed_sender" in ntx.tags[-1]["spam_reasons"]


def test_phishing_token_flagged(normalized):
    ntx = normalized[
        "0x7777777777777777777777777777777777777777777777777777777777777777_erc20_2"
    ]
    assert ntx.review_status == "invalid"
    assert {"confusable_unicode", "phishing_contract_name"} <= set(
        ntx.tags[-1]["spam_reasons"]
    )


def test_since_datetime_sent_as_from_timestamp():
    since = datetime(2025, 10, 1, tzinfo=timezone.utc)
    with patch.dict("os.environ", {"ANKR_API_KEY": "k"}):
        conn = ConnectorAnkr(
            wallet_address=WALLET,
            chain_name="arbitrum",
            config={
                "test_mode": False,
                "disable_file_output": True,
                "since_datetime": since,
            },
        )
    calls = []

    def fake_rpc(method, params):
        calls.append((method, params))
        return {}

    with patch.object(conn, "_rpc", side_effect=fake_rpc):
        assert list(conn.yield_raws()) == []
    assert [m for m, _ in calls] == [
        "ankr_getTransactionsByAddress",
        "ankr_getTokenTransfers",
    ]
    for _, params in calls:
        assert params["blockchain"] == "arbitrum"
        assert params["fromTimestamp"] == int(since.timestamp()) + 1


def test_naive_since_datetime_treated_as_utc():
    naive = datetime(2025, 10, 1)
    with patch.dict("os.environ", {"ANKR_API_KEY": "k"}):
        conn = ConnectorAnkr(
            wallet_address=WALLET,
            chain_name="bsc",
            config={
                "test_mode": False,
                "disable_file_output": True,
                "since_datetime": naive,
            },
        )
    calls = []
    with patch.object(conn, "_rpc", side_effect=lambda m, p: calls.append(p) or {}):
        list(conn.yield_raws())
    expected = int(naive.replace(tzinfo=timezone.utc).timestamp()) + 1
    assert all(p["fromTimestamp"] == expected for p in calls)


def test_legacy_moralis_raw_renormalizes_with_moralis_source():
    fixture = (
        Path(__file__).parents[2] / "fixtures" / "moralis" / "wallet_history_bsc.json"
    )
    legacy_raw = json.loads(fixture.read_text())["result"][0]
    conn = ConnectorAnkr(
        wallet_address="0x1111111111111111111111111111111111111111",
        chain_name="bsc",
        account_id=1,
        config={"renormalize_mode": True, "disable_file_output": True},
    )
    conn._raw_origin_source = "moralis_wallet_history_bsc"
    rows = list(conn._mapper_for_raw_origin().raw_to_normalized(legacy_raw))
    assert rows
    assert all(r.source == "moralis_wallet_history_bsc" for r in rows)
