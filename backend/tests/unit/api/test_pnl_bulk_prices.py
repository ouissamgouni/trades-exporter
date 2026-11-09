from unittest.mock import MagicMock

from backend.api.routes import pnl as pnl_routes
from backend.db.models import Asset
from backend.services.price_getters.base import PriceResult


def test_bulk_prices_use_one_batched_refresh(monkeypatch):
    assets = [
        Asset(asset_id=1, symbol="BTC"),
        Asset(asset_id=2, symbol="ETH"),
        Asset(asset_id=3, symbol="EUR"),
    ]
    session = MagicMock()
    session.exec.return_value.all.return_value = assets
    monkeypatch.setattr(
        pnl_routes, "_get_enabled_price_getters_by_asset", lambda s, ids: {}
    )

    svc = MagicMock()
    svc.refresh_current_prices.return_value = {
        1: PriceResult(price=60000.0, quote_currency="EUR", source="coingecko"),
    }
    svc.cache.get_latest_before.return_value = None
    monkeypatch.setattr(pnl_routes, "PriceService", lambda session: svc)

    resp = pnl_routes.get_current_prices(
        pnl_routes.PriceRequest(
            asset_ids=[1, 2, 3], base_currency="EUR", force_live=True
        ),
        session=session,
    )

    svc.refresh_current_prices.assert_called_once()
    assert svc.refresh_current_prices.call_args.args[0] == [1, 2, 3]
    assert svc.refresh_current_prices.call_args.kwargs["force_live"] is True
    svc.get_price_with_fallback.assert_not_called()
    by_id = {p.asset.id: p for p in resp.prices}
    assert by_id[1].price == 60000.0 and by_id[1].source == "coingecko"
    assert by_id[2].price is None and by_id[2].error
    assert by_id[3].price == 1.0
    assert (resp.successful_count, resp.failed_count) == (2, 1)
