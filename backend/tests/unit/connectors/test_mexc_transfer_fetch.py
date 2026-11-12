"""MEXC deposit/withdrawal history: coin-less 7-day windows, page splitting, surfaced failures."""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import ccxt
import pytest

from backend.connectors.base.base_connector import FETCH_ERROR_KEY
from backend.connectors.cex import connector_mexc_base as base
from backend.connectors.cex.connector_mexc_withdrawals import MEXCWithdrawalsConnector


@pytest.fixture
def exchange():
    with patch("backend.connectors.cex.connector_mexc_base.load_credentials") as creds, \
         patch("backend.connectors.cex.connector_mexc_base.ccxt.mexc") as cls:
        creds.return_value = {"api_key": "k", "api_secret": "s"}
        instance = MagicMock()
        cls.return_value = instance
        yield instance


def _connector(since=None, **kwargs):
    config = {"test_mode": False, "disable_file_output": True}
    if since:
        config["since_datetime"] = since
    return MEXCWithdrawalsConnector(account_id=1, config=config, **kwargs)


def test_fetches_all_coins_per_window_without_iterating_currencies(exchange):
    exchange.fetch_withdrawals.return_value = [{"id": "w1"}]
    since = datetime.now(timezone.utc) - timedelta(days=20)

    items = list(_connector(since=since).yield_raws())

    assert [i["id"] for i in items] == ["w1"]  # same id from every window is deduped
    calls = exchange.fetch_withdrawals.call_args_list
    assert len(calls) == 3  # 20 days -> three 7-day windows
    assert all(c.kwargs["code"] is None for c in calls)
    assert all(c.kwargs["params"]["endTime"] - c.kwargs["params"]["startTime"] <= base.WINDOW_MS for c in calls)
    assert calls[0].kwargs["limit"] == base.PAGE_LIMIT
    exchange.fetch_balance.assert_not_called()


def test_splits_window_when_page_limit_reached(exchange, monkeypatch):
    monkeypatch.setattr(base, "PAGE_LIMIT", 2)
    full = [{"id": "a"}, {"id": "b"}]
    exchange.fetch_withdrawals.side_effect = [full, [{"id": "a"}], [{"id": "b"}, {"id": "c"}][:1]]
    since = datetime.now(timezone.utc) - timedelta(days=5)

    items = list(_connector(since=since).yield_raws())

    assert sorted(i["id"] for i in items) == ["a", "b"]
    assert exchange.fetch_withdrawals.call_count == 3


def test_failed_window_is_surfaced_and_fetch_continues(exchange):
    since = datetime.now(timezone.utc) - timedelta(days=10)
    exchange.fetch_withdrawals.side_effect = [[{"id": "new"}], ccxt.ExchangeError("mexc 500 internal")]

    items = list(_connector(since=since).yield_raws())

    assert items[0]["id"] == "new"
    assert FETCH_ERROR_KEY in items[1] and "500 internal" in items[1][FETCH_ERROR_KEY]


def test_fetch_error_becomes_item_error_in_yield_normalized(exchange):
    since = datetime.now(timezone.utc) - timedelta(days=3)
    exchange.fetch_withdrawals.side_effect = ccxt.ExchangeError("boom")

    out = list(_connector(since=since).yield_normalized())

    assert len(out) == 1 and out[0][1] is None and "boom" in out[0][2]


def test_bad_request_falls_back_to_per_currency(exchange):
    exchange.fetch_withdrawals.side_effect = lambda code, since, limit, params: (
        (_ for _ in ()).throw(ccxt.BadRequest("coin required")) if code is None else [{"id": f"{code}-1"}]
    )
    exchange.currencies = {"BTC": {"active": True}}
    exchange.fetch_balance.return_value = {}
    since = datetime.now(timezone.utc) - timedelta(days=3)

    items = list(_connector(since=since).yield_raws())

    assert [i["id"] for i in items] == ["BTC-1"]


def test_per_currency_failure_is_surfaced(exchange):
    exchange.fetch_withdrawals.side_effect = ccxt.ExchangeError("730002 Params error")
    since = datetime.now(timezone.utc) - timedelta(days=3)

    items = list(_connector(since=since, currencies=["SKYAI"]).yield_raws())

    assert len(items) == 1 and "SKYAI" in items[0][FETCH_ERROR_KEY] and "730002" in items[0][FETCH_ERROR_KEY]


def test_lookback_older_than_90_days_is_clamped_with_warning(exchange):
    exchange.fetch_withdrawals.return_value = []
    connector = _connector(since=datetime(2020, 1, 1, tzinfo=timezone.utc))
    log = MagicMock()
    connector._get_logger = lambda: log

    list(connector.yield_raws())

    first_start = exchange.fetch_withdrawals.call_args_list[-1].kwargs["params"]["startTime"]
    now_ms = datetime.now(timezone.utc).timestamp() * 1000
    assert now_ms - first_start <= base.MAX_LOOKBACK_MS + 60_000
    assert any("only returns the last 90 days" in str(c) for c in log.warning.call_args_list)
