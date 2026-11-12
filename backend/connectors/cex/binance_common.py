"""Shared helpers for Binance live connectors."""

import time
from typing import Any, Callable, Dict, Generator, List, Optional

# Binance capital deposit/withdraw history: max 90-day [startTime, endTime] range,
# CCXT always sends endTime = since + 90d, and omitting since returns only the last 90 days.
MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000
PAGE_LIMIT = 1000
HISTORY_START_MS = 1499990400000  # 2017-07-14, Binance launch


def iter_transfer_history(
    fetch: Callable[..., List[Dict[str, Any]]], since_ms: Optional[int]
) -> Generator[Dict[str, Any], None, None]:
    """Walk 90-day windows from since_ms to now, paging with offset inside each window."""
    start = since_ms if since_ms is not None else HISTORY_START_MS
    now = int(time.time() * 1000)
    seen = set()
    while start <= now:
        offset = 0
        while True:
            page = fetch(
                since=start, limit=PAGE_LIMIT, params={"offset": offset} if offset else {}
            )
            for item in page:
                key = item.get("id")
                if key in seen:
                    continue
                seen.add(key)
                yield item
            if len(page) < PAGE_LIMIT:
                break
            offset += len(page)
        start += MAX_WINDOW_MS
