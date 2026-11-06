from datetime import datetime, timezone

import pytest

from backend.db.models import AccountConnector
from backend.db.repositories import NormalizedTransactionRepository
from backend.services import sync_window as sw


@pytest.fixture
def last_tx(monkeypatch):
    holder = {"value": None}
    monkeypatch.setattr(
        NormalizedTransactionRepository,
        "get_max_datetime_by_connector",
        lambda self, connector_id: holder["value"],
    )
    return holder


def _connector(connector_type, **config):
    return AccountConnector(id=1, account_id=1, connector_type=connector_type, config=config)


class TestResolveSyncWindow:
    def test_incremental_uses_last_transaction(self, last_tx):
        last_tx["value"] = datetime(2025, 11, 20, 0, 35, 41)
        w = sw.resolve_sync_window(None, _connector("ankr", chain="bsc"))
        assert w["source"] == "last_transaction"
        assert w["since"] == datetime(2025, 11, 20, 0, 35, 41)
        assert "last stored transaction" in sw.describe_sync_window(w)

    def test_incremental_falls_back_to_config_start(self, last_tx):
        w = sw.resolve_sync_window(
            None, _connector("binance-deposits", start_datetime="2025-10-01T00:00:00")
        )
        assert w["source"] == "config_start"
        assert w["since"] == datetime(2025, 10, 1)

    def test_history_cutoff_floors_since(self, last_tx):
        last_tx["value"] = datetime(2025, 1, 1)
        w = sw.resolve_sync_window(
            None, _connector("ankr", chain="base", history_cutoff="2026-02-05T07:23:51+00:00")
        )
        assert w["source"] == "history_cutoff"
        assert w["since"] == datetime(2026, 2, 5, 7, 23, 51, tzinfo=timezone.utc)

    def test_override_full_sync_still_respects_cutoff(self, last_tx):
        w = sw.resolve_sync_window(
            None,
            _connector("ankr", chain="base", history_cutoff="2026-02-05T07:23:51+00:00"),
            override_since=None,
        )
        assert w["source"] == "history_cutoff"

    def test_connector_default_start(self, last_tx):
        w = sw.resolve_sync_window(None, _connector("hyperliquid-perps"))
        assert w["since"] is None
        assert w["source"] == "connector_default"
        assert "2025-10-01" in sw.describe_sync_window(w)

    def test_non_incremental_is_full_history(self, last_tx):
        last_tx["value"] = datetime(2025, 11, 2)
        w = sw.resolve_sync_window(None, _connector("blockscout", chain="ethereum"))
        assert w["since"] is None
        assert w["source"] == "full_history"
        assert "full history every run" in sw.describe_sync_window(w)
        assert sw.sync_window_to_dict(w)["last_transaction_at"].startswith("2025-11-02")
