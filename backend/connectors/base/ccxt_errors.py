"""Shared CCXT error classification and retry for CEX connectors."""

import random
import time
from typing import Callable, Optional, TypeVar

import ccxt

from backend.connectors.base.connector_exceptions import ConnectorAPIError, ErrorReason

T = TypeVar("T")

# (exception class, reason, retryable, http status) - order matters: subclasses first
_CCXT_ERROR_MAP = [
    (ccxt.PermissionDenied, ErrorReason.PERMISSION_DENIED, False, 403),
    (ccxt.AuthenticationError, ErrorReason.AUTHENTICATION_FAILED, False, 401),
    (ccxt.RateLimitExceeded, ErrorReason.RATE_LIMITED, True, 429),
    (ccxt.DDoSProtection, ErrorReason.RATE_LIMITED, True, 429),
    (ccxt.RequestTimeout, ErrorReason.TIMEOUT, True, None),
    (ccxt.OnMaintenance, ErrorReason.API_ERROR, True, 503),
    (ccxt.ExchangeNotAvailable, ErrorReason.API_ERROR, True, 503),
    (ccxt.NetworkError, ErrorReason.NETWORK_ERROR, True, None),
    (ccxt.BadSymbol, ErrorReason.BAD_REQUEST, False, 400),
    (ccxt.BadRequest, ErrorReason.BAD_REQUEST, False, 400),
]

# Fallback for non-CCXT exceptions (requests, raw HTTP errors)
_TEXT_ERROR_MAP = [
    (
        ("401", "unauthorized", "invalid api key"),
        ErrorReason.AUTHENTICATION_FAILED,
        False,
        401,
    ),
    (("403", "forbidden"), ErrorReason.PERMISSION_DENIED, False, 403),
    (("429", "rate limit", "too many requests"), ErrorReason.RATE_LIMITED, True, 429),
    (("timeout", "timed out"), ErrorReason.TIMEOUT, True, None),
    (("connection", "network"), ErrorReason.NETWORK_ERROR, True, None),
]


def to_connector_error(
    error: Exception, connector_name: str, operation: str, details: Optional[str] = None
) -> ConnectorAPIError:
    """Map any exception raised by a CCXT call to a structured ConnectorAPIError (keeps the exchange message)."""
    if isinstance(error, ConnectorAPIError):
        return error
    reason, retryable, status = ErrorReason.API_ERROR, False, None
    for cls, r, retry, code in _CCXT_ERROR_MAP:
        if isinstance(error, cls):
            reason, retryable, status = r, retry, code
            break
    else:
        text = str(error).lower()
        for needles, r, retry, code in _TEXT_ERROR_MAP:
            if any(n in text for n in needles):
                reason, retryable, status = r, retry, code
                break
    exchange_msg = f"{type(error).__name__}: {str(error)[:500]}"
    return ConnectorAPIError(
        message=reason.value.replace("_", " "),
        connector_name=connector_name,
        operation=operation,
        reason=reason,
        http_status_code=status,
        retryable=retryable,
        original_error=error,
        details=f"{details} - {exchange_msg}" if details else exchange_msg,
    )


def call_with_retry(
    fn: Callable[[], T],
    connector_name: str,
    operation: str,
    log,
    details: Optional[str] = None,
    max_attempts: int = 4,
    base_delay: float = 1.0,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Call fn, retrying retryable errors (rate limit, timeout, network, maintenance) with backoff + jitter."""
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as e:
            err = to_connector_error(e, connector_name, operation, details)
            if not err.retryable or attempt == max_attempts:
                raise err from e
            delay = base_delay * 2 ** (attempt - 1) + random.uniform(0, base_delay)
            log.warning(
                f"⏳ [{connector_name}] {operation} {err.reason.value} "
                f"(attempt {attempt}/{max_attempts}), retrying in {delay:.1f}s: {err.details}"
            )
            sleep(delay)
    raise AssertionError("unreachable")
