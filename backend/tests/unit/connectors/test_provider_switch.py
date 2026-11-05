"""Provider switch safety: raws read by their original provider, history cutoff."""

import json
from datetime import datetime, timezone
from pathlib import Path

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.connectors.hub.database_connector_hub import _floor_at_history_cutoff
from backend.connectors.onchain.blockscout.connector_blockscout_normal_tx import (
    ConnectorBlockscoutNormalTx,
)
from backend.connectors.onchain.connector_ankr import ConnectorAnkr
from backend.connectors.onchain.connector_moralis_wallet_history import (
    ConnectorMoralisWalletHistory,
)
from backend.db.models import NormalizedTransaction

WALLET = "0x1111111111111111111111111111111111111111"
RENORM = {"renormalize_mode": True, "disable_file_output": True}

BLOCKSCOUT_RAW = {
    "hash": "0xabc",
    "from": {"hash": WALLET},
    "to": {"hash": "0x2222222222222222222222222222222222222222"},
    "value": "1000000000000000000",
    "gas_used": "21000",
    "gas_price": "1000000000",
    "timestamp": "2026-01-10T10:00:00.000000Z",
}


def _moralis_raw():
    path = (
        Path(__file__).parents[2] / "fixtures" / "moralis" / "wallet_history_bsc.json"
    )
    return json.loads(path.read_text())["result"][0]


def _stream(connector, items):
    """Simulate renormalize: (raw source, raw) pairs as read from raw_transactions."""

    def fake_yield_raws():
        for source, raw in items:
            connector._raw_origin_source = source
            yield raw

    connector._yield_raws = fake_yield_raws
    return [n for _, n, err in connector.yield_normalized() if not err]


class TestResolveRawOrigin:
    def test_known_sources(self):
        registry = get_connector_registry()
        assert registry.resolve_raw_origin("blockscout_base_normal_tx") == (
            ConnectorBlockscoutNormalTx,
            "base",
        )
        assert registry.resolve_raw_origin("moralis_wallet_history_eth") == (
            ConnectorMoralisWalletHistory,
            "eth",
        )
        assert registry.resolve_raw_origin("ankr_bsc") == (ConnectorAnkr, "bsc")

    def test_unknown_source(self):
        assert get_connector_registry().resolve_raw_origin("polymarket_polygon") is None


class TestRenormalizeByOrigin:
    def test_ankr_reads_blockscout_and_moralis_raws(self):
        ankr = ConnectorAnkr(wallet_address=WALLET, chain_name="base", config=RENORM)
        normalized = _stream(
            ankr,
            [
                ("blockscout_base_normal_tx", BLOCKSCOUT_RAW),
                ("moralis_wallet_history_bsc", _moralis_raw()),
            ],
        )
        sources = {n.source for n in normalized}
        assert "blockscout_base_normal_tx" in sources
        assert "moralis_wallet_history_bsc" in sources
        bs = next(n for n in normalized if n.source == "blockscout_base_normal_tx")
        assert bs.source_transaction_id == "0xabc"
        assert bs.quantity == 1.0

    def test_own_raws_use_self(self):
        ankr = ConnectorAnkr(wallet_address=WALLET, chain_name="bsc", config=RENORM)
        ankr._raw_origin_source = "ankr_bsc"
        assert ankr._mapper_for_raw_origin() is ankr


class _FakeConnector(BaseConnector):
    def __init__(self, items, config):
        self._items = items
        super().__init__(config={"disable_file_output": True, **config})

    @property
    def connector_name(self):
        return "fake"

    def yield_raws(self):
        yield from self._items

    def raw_to_normalized(self, raw):
        return NormalizedTransaction(
            source="fake",
            source_transaction_id=raw["id"],
            date_time=raw["dt"],
            direction="inflow",
            transaction_type="transfer",
            source_asset_symbol="ETH",
            quantity=1,
        )


class TestHistoryCutoff:
    ITEMS = [
        {"id": "old", "dt": datetime(2026, 2, 1, tzinfo=timezone.utc)},
        {"id": "boundary", "dt": datetime(2026, 2, 5, 7, 23, 51, tzinfo=timezone.utc)},
        {"id": "new", "dt": datetime(2026, 2, 6, tzinfo=timezone.utc)},
    ]

    def test_items_at_or_before_cutoff_are_dropped(self):
        connector = _FakeConnector(
            self.ITEMS,
            {"test_mode": False, "history_cutoff": "2026-02-05T07:23:51+00:00"},
        )
        ids = [n.source_transaction_id for _, n, _ in connector.yield_normalized()]
        assert ids == ["new"]

    def test_no_cutoff_keeps_everything(self):
        connector = _FakeConnector(self.ITEMS, {"test_mode": False})
        assert len(list(connector.yield_normalized())) == 3

    def test_since_floor(self):
        cutoff = "2026-02-05T07:23:51+00:00"
        floor = datetime(2026, 2, 5, 7, 23, 51, tzinfo=timezone.utc)
        assert _floor_at_history_cutoff(None, cutoff) == floor
        assert _floor_at_history_cutoff(datetime(2025, 1, 1), cutoff) == floor
        later = datetime(2026, 3, 1, tzinfo=timezone.utc)
        assert _floor_at_history_cutoff(later, cutoff) == later
        assert _floor_at_history_cutoff(None, None) is None
