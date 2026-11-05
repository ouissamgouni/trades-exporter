"""Unit tests for the Sui GraphQL → legacy JSON-RPC adapter (no network)."""

from decimal import Decimal
from unittest.mock import patch

from backend.connectors.onchain.connector_sui import (
    ConnectorSui,
    graphql_tx_to_legacy,
    normalize_coin_type,
)

WALLET = "0x" + "a1" * 32
SENDER = "0x" + "b2" * 32
SUI_LONG = "0x" + "0" * 63 + "2::sui::SUI"
USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"

NODE = {
    "digest": "Hd3LTD1aCTjNaL4VBimo5y84535piKJxsT49armMmb7Y",
    "sender": {"address": SENDER},
    "kind": {"__typename": "ProgrammableTransaction"},
    "effects": {
        "status": "SUCCESS",
        "timestamp": "2025-10-04T15:16:45.133Z",
        "checkpoint": {"sequenceNumber": 123},
        "gasEffects": {
            "gasSummary": {
                "computationCost": 1000000,
                "storageCost": 1976000,
                "storageRebate": 978120,
                "nonRefundableStorageFee": 9880,
            }
        },
        "balanceChanges": {
            "pageInfo": {"hasNextPage": False},
            "nodes": [
                {
                    "owner": {"address": WALLET},
                    "amount": "81679207950",
                    "coinType": {"repr": SUI_LONG},
                },
                {
                    "owner": {"address": SENDER},
                    "amount": "-81681205830",
                    "coinType": {"repr": SUI_LONG},
                },
            ],
        },
    },
}


def _connector(test_mode=True):
    return ConnectorSui(
        wallet_address=WALLET,
        account_id=1,
        config={"test_mode": test_mode, "disable_file_output": True},
    )


def test_normalize_coin_type():
    assert normalize_coin_type(SUI_LONG) == "0x2::sui::SUI"
    assert normalize_coin_type(USDC) == USDC
    assert normalize_coin_type("garbage") == "garbage"


def test_graphql_node_converts_to_legacy_shape():
    legacy = graphql_tx_to_legacy(NODE)
    assert legacy["timestampMs"] == "1759591005133"
    assert legacy["effects"]["status"] == {"status": "success"}
    assert legacy["effects"]["gasUsed"]["storageRebate"] == "978120"
    assert legacy["transaction"]["data"]["sender"] == SENDER
    assert (
        legacy["transaction"]["data"]["transaction"]["kind"]
        == "ProgrammableTransaction"
    )
    assert legacy["balanceChanges"][0] == {
        "owner": {"AddressOwner": WALLET},
        "coinType": "0x2::sui::SUI",
        "amount": "81679207950",
    }


def test_converted_tx_normalizes_with_legacy_ids():
    rows = list(_connector().raw_to_normalized(graphql_tx_to_legacy(NODE)))
    assert len(rows) == 1
    row = rows[0]
    assert row.source_transaction_id == f"{NODE['digest']}_0x2::sui::SUI_0"
    assert row.direction == "inflow"
    assert row.quantity == Decimal("81.67920795")
    assert row.source_from_account == SENDER


def test_live_fetch_pages_through_cursor():
    with patch.dict(
        "os.environ", {"SUI_GRAPHQL_URL": "https://example.invalid/graphql"}
    ):
        conn = _connector(test_mode=False)
    pages = [
        {
            "transactions": {
                "pageInfo": {"hasNextPage": True, "endCursor": "c1"},
                "nodes": [NODE],
            }
        },
        {
            "transactions": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [dict(NODE, digest="D2")],
            }
        },
    ]
    with patch.object(conn, "graphql_request", side_effect=pages) as gql:
        raws = list(conn.yield_raws())
    assert [r["digest"] for r in raws] == [NODE["digest"], "D2"]
    assert gql.call_args_list[1].args[1] == {"address": WALLET, "after": "c1"}
