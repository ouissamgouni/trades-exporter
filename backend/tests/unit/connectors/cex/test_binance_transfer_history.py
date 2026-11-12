"""Binance deposit/withdraw history is capped to 90-day windows; the walker must cover since -> now."""

from unittest.mock import patch

from backend.connectors.cex import binance_common
from backend.connectors.cex.binance_common import MAX_WINDOW_MS, iter_transfer_history

DAY = 24 * 60 * 60 * 1000


def test_walks_90_day_windows_up_to_now():
    since = 1_700_000_000_000
    now = since + 200 * DAY
    calls = []

    def fetch(since, limit, params):
        calls.append((since, params))
        return [{"id": f"w{since}"}]

    with patch.object(binance_common.time, "time", return_value=now / 1000):
        items = list(iter_transfer_history(fetch, since))

    assert [c[0] for c in calls] == [since, since + MAX_WINDOW_MS, since + 2 * MAX_WINDOW_MS]
    assert len(items) == 3


def test_pages_with_offset_and_dedupes_window_boundaries():
    since = 1_700_000_000_000
    pages = {
        (since, 0): [{"id": str(i)} for i in range(binance_common.PAGE_LIMIT)],
        (since, binance_common.PAGE_LIMIT): [{"id": "last"}],
        (since + MAX_WINDOW_MS, 0): [{"id": "last"}],
    }

    def fetch(since, limit, params):
        return pages.get((since, params.get("offset", 0)), [])

    with patch.object(binance_common.time, "time", return_value=(since + 100 * DAY) / 1000):
        ids = [i["id"] for i in iter_transfer_history(fetch, since)]

    assert len(ids) == binance_common.PAGE_LIMIT + 1
    assert ids[-1] == "last"


def _withdrawals_connector(exchange):
    from unittest.mock import MagicMock
    from backend.connectors.cex.connector_binance_withdrawals import BinanceWithdrawalsConnector

    with patch("backend.connectors.cex.connector_binance_withdrawals.load_credentials",
               return_value={"api_key": "k", "api_secret": "s"}), \
         patch("ccxt.binance", return_value=exchange):
        return BinanceWithdrawalsConnector(account_id=1, config={"test_mode": False, "disable_file_output": True})


def test_connector_retries_rate_limit_and_passes_offset():
    import ccxt
    from unittest.mock import MagicMock

    exchange = MagicMock()
    exchange.fetch_withdrawals.side_effect = [ccxt.RateLimitExceeded("-1003"), [{"id": "w1"}]]
    connector = _withdrawals_connector(exchange)

    with patch("backend.connectors.base.ccxt_errors.time.sleep"):
        assert connector.get_withdrawals(since=1, limit=1000, params={"offset": 5}) == [{"id": "w1"}]
    assert exchange.fetch_withdrawals.call_args.kwargs["params"] == {"offset": 5}


def test_connector_auth_error_is_not_retried():
    import ccxt
    import pytest
    from unittest.mock import MagicMock
    from backend.connectors.base.connector_exceptions import ConnectorAPIError, ErrorReason

    exchange = MagicMock()
    exchange.fetch_withdrawals.side_effect = ccxt.AuthenticationError("Invalid API-key")
    connector = _withdrawals_connector(exchange)

    with pytest.raises(ConnectorAPIError) as exc:
        connector.get_withdrawals(since=1)
    assert exc.value.reason == ErrorReason.AUTHENTICATION_FAILED
    assert exchange.fetch_withdrawals.call_count == 1
