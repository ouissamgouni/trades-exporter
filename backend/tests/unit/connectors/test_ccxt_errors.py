"""Shared CCXT error classification and retry."""

from unittest.mock import MagicMock

import ccxt
import pytest

from backend.connectors.base.ccxt_errors import call_with_retry, to_connector_error
from backend.connectors.base.connector_exceptions import ConnectorAPIError, ErrorReason


@pytest.mark.parametrize(
    "error, reason, retryable",
    [
        (ccxt.PermissionDenied("no withdraw permission"), ErrorReason.PERMISSION_DENIED, False),
        (ccxt.AuthenticationError("Invalid API-key"), ErrorReason.AUTHENTICATION_FAILED, False),
        (ccxt.RateLimitExceeded("-1003 Too many requests"), ErrorReason.RATE_LIMITED, True),
        (ccxt.RequestTimeout("timed out"), ErrorReason.TIMEOUT, True),
        (ccxt.OnMaintenance("maintenance"), ErrorReason.API_ERROR, True),
        (ccxt.NetworkError("conn reset"), ErrorReason.NETWORK_ERROR, True),
        (ccxt.BadRequest("bad param"), ErrorReason.BAD_REQUEST, False),
        (ccxt.ExchangeError("700002 signature"), ErrorReason.API_ERROR, False),
        (RuntimeError("HTTP 429 Too Many Requests"), ErrorReason.RATE_LIMITED, True),
        (RuntimeError("boom"), ErrorReason.API_ERROR, False),
    ],
)
def test_classification(error, reason, retryable):
    err = to_connector_error(error, "c", "op", details="BTC")
    assert err.reason == reason
    assert err.retryable is retryable
    assert "BTC" in err.details and type(error).__name__ in err.details


def test_keeps_exchange_message():
    err = to_connector_error(ccxt.ExchangeError('mexc {"code":730002,"msg":"Params error"}'), "mexc", "fetch")
    assert "730002" in str(err)


def test_retry_then_success():
    fn = MagicMock(side_effect=[ccxt.NetworkError("x"), ccxt.RequestTimeout("y"), [1]])
    sleeps = []
    assert call_with_retry(fn, "c", "op", MagicMock(), sleep=sleeps.append) == [1]
    assert len(sleeps) == 2 and sleeps[1] > sleeps[0] * 0.9


def test_non_retryable_raises_immediately():
    fn = MagicMock(side_effect=ccxt.AuthenticationError("bad key"))
    with pytest.raises(ConnectorAPIError):
        call_with_retry(fn, "c", "op", MagicMock(), sleep=lambda _: None)
    assert fn.call_count == 1


def test_gives_up_after_max_attempts():
    fn = MagicMock(side_effect=ccxt.RateLimitExceeded("429"))
    with pytest.raises(ConnectorAPIError) as exc:
        call_with_retry(fn, "c", "op", MagicMock(), max_attempts=3, sleep=lambda _: None)
    assert fn.call_count == 3
    assert exc.value.reason == ErrorReason.RATE_LIMITED
