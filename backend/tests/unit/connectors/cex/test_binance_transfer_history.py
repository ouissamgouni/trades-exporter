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
