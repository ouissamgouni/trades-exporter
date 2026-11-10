"""Unit tests for the mapping workbench: suggestions, status and filtering."""

from datetime import datetime
from types import SimpleNamespace

from backend.db.models import Account, Asset
from backend.services import raw_mapping_overview as svc


def _acc(id, name, address=None):
    return Account(id=id, name=name, address_or_identifier=address, account_type="wallet")


def test_symbol_suggestion_prefers_known_mapping_then_exact_symbol():
    btc, wbtc = Asset(asset_id=1, symbol="BTC"), Asset(asset_id=2, symbol="WBTC")
    by_id = {1: btc, 2: wbtc}
    by_symbol = {"BTC": [btc], "WBTC": [wbtc]}

    s = svc.symbol_suggestion("btc", {"BTC": {1}}, by_symbol, by_id)
    assert (s.id, s.reason, s.confidence) == (1, "known_symbol", 0.95)

    s = svc.symbol_suggestion("WBTC", {}, by_symbol, by_id)
    assert (s.id, s.reason) == (2, "exact_symbol")
    assert s.confidence >= svc.VERIFIED_CONFIDENCE

    # Conflicting mappings elsewhere fall back to the exact symbol
    s = svc.symbol_suggestion("BTC", {"BTC": {1, 2}}, by_symbol, by_id)
    assert s.reason == "exact_symbol"
    assert svc.symbol_suggestion("XYZ", {}, by_symbol, by_id) is None


def test_account_suggestion_scopes_known_label_by_network():
    addr = "0xAbC"
    accounts = [_acc(1, "Wallet Base", addr), _acc(2, "Wallet BSC", addr)]
    raws = [
        SimpleNamespace(label=addr, network="base", account_id=1, dismissed=False),
        SimpleNamespace(label=addr, network="bsc", account_id=2, dismissed=False),
    ]
    index = svc.mapped_label_index(raws)

    s = svc.account_suggestion("0xabc", "ankr_bsc", "bsc", accounts, index, {})
    assert (s.id, s.reason) == (2, "known_label")
    # Ambiguous across networks and no same-network row: no "known" guess
    s = svc.account_suggestion("0xabc", "x", "", accounts, index, {})
    assert s is None or s.reason != "known_label"


def test_account_suggestion_exact_address_disambiguated_by_connector_chain():
    addr = "0xabc"
    accounts = [_acc(1, "Wallet Base", addr), _acc(2, "Wallet BSC", addr)]
    connectors = {
        1: [SimpleNamespace(config={"chain": "base"})],
        2: [SimpleNamespace(config={"chain": "bsc"})],
    }
    s = svc.account_suggestion(addr, "ankr_base", "base", accounts, {}, connectors)
    assert (s.id, s.reason, s.confidence) == (1, "exact_address", 1.0)


def test_fuzzy_account_suggestion_is_never_verified():
    accounts = [_acc(1, "Binance Spot")]
    s = svc.account_suggestion("binance", "binance", "", accounts, {}, {})
    assert s.reason == "similar"
    assert s.confidence < svc.VERIFIED_CONFIDENCE


def test_account_usage_network_scoping():
    t1, t2 = datetime(2024, 1, 1), datetime(2024, 6, 1)
    entries = [("base", "to", 3, t1, t1), ("bsc", "from", 2, t2, t2)]
    assert svc.account_usage_for(entries, "base")["usage_count"] == 3
    u = svc.account_usage_for(entries, "")
    assert (u["usage_count"], u["to_count"], u["from_count"]) == (5, 3, 2)
    assert (u["first_seen"], u["last_seen"]) == (t1, t2)


def test_filter_items_counts_ignore_status_filter():
    items = [
        {"source": "a", "network": "", "symbol": "BTC", "status": "mapped", "usage_count": 1},
        {"source": "a", "network": "", "symbol": "ETH", "status": "suggested", "usage_count": 5},
        {"source": "b", "network": "base", "symbol": "USDC", "status": "unmapped", "usage_count": 9},
    ]
    rows, counts = svc.filter_items(items, ("symbol",), status="mapped", source="a")
    assert [r["symbol"] for r in rows] == ["BTC"]
    assert counts == {"suggested": 1, "unmapped": 0, "mapped": 1, "ignored": 0}

    rows, _ = svc.filter_items(items, ("symbol",))
    assert [r["symbol"] for r in rows] == ["ETH", "USDC", "BTC"]


def test_status_of():
    s = SimpleNamespace()
    assert svc.status_of(True, True, s) == "ignored"
    assert svc.status_of(False, True, s) == "mapped"
    assert svc.status_of(False, False, s) == "suggested"
    assert svc.status_of(False, False, None) == "unmapped"
