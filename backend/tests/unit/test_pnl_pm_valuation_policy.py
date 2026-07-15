from decimal import Decimal

from backend.api.routes.pnl import (
    _classify_asset_price_policy,
    _classify_balance_valuation,
)
from backend.db.models import Asset


def _asset(symbol: str) -> Asset:
    return Asset(asset_id=1, symbol=symbol, label=symbol)


def test_closed_polymarket_realized_balance_is_not_price_fetchable():
    policy = _classify_balance_valuation(
        _asset("PM:will-btc-hit-200k-Yes"),
        qty=Decimal("0"),
        cost_basis=Decimal("0"),
        lot_count=0,
        realized_event_count=1,
    )

    assert policy["has_open_position"] is False
    assert policy["price_fetch_eligible"] is False
    assert policy["valuation_status"] == "closed_realized"


def test_open_polymarket_without_getter_is_unsupported_not_failed():
    policy = _classify_balance_valuation(
        _asset("PM:will-btc-hit-200k-Yes"),
        qty=Decimal("10"),
        cost_basis=Decimal("4.5"),
        lot_count=1,
        realized_event_count=0,
    )

    assert policy["has_open_position"] is True
    assert policy["price_fetch_eligible"] is False
    assert policy["valuation_status"] == "unsupported"


def test_open_polymarket_with_explicit_getter_is_price_fetchable():
    policy = _classify_balance_valuation(
        _asset("PM:will-btc-hit-200k-Yes"),
        qty=Decimal("10"),
        cost_basis=Decimal("4.5"),
        lot_count=1,
        realized_event_count=0,
        enabled_getters={"polymarket"},
    )

    assert policy["has_open_position"] is True
    assert policy["price_fetch_eligible"] is True
    assert policy["valuation_status"] == "open"


def test_polymarket_fallback_artifact_is_data_artifact():
    policy = _classify_asset_price_policy(_asset("PM:some-market-0XABCDEF"))

    assert policy["price_fetch_eligible"] is False
    assert policy["valuation_status"] == "data_artifact"


def test_tiny_polymarket_residual_is_dust():
    policy = _classify_balance_valuation(
        _asset("PM:will-btc-hit-200k-Yes"),
        qty=Decimal("0.000001"),
        cost_basis=Decimal("0.000001"),
        lot_count=1,
        realized_event_count=0,
    )

    assert policy["has_open_position"] is False
    assert policy["price_fetch_eligible"] is False
    assert policy["valuation_status"] == "dust"
