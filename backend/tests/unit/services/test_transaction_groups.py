from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from backend.services.transaction_groups import period_utc_bounds, resolve_timezone


def test_month_bounds_in_paris_span_dst_change():
    lower, upper = period_utc_bounds(date(2024, 3, 1), "month", ZoneInfo("Europe/Paris"))
    assert lower == datetime(2024, 2, 29, 23, 0)
    # April 1st local is UTC+2 after the DST switch
    assert upper == datetime(2024, 3, 31, 21, 59, 59, 999999)


def test_december_rolls_over_to_next_year():
    _, upper = period_utc_bounds(date(2024, 12, 1), "month", ZoneInfo("UTC"))
    assert upper == datetime(2024, 12, 31, 23, 59, 59, 999999)


def test_resolve_timezone_rejects_unknown():
    with pytest.raises(ValueError):
        resolve_timezone("Mars/Olympus")
