"""Period (range) price fetching: getters fetch a whole span in one request instead of per day."""

from datetime import date, datetime, timedelta
from unittest.mock import MagicMock

import pytest

from backend.db.models import Asset
from backend.services import price_gap_job_service as job_mod
from backend.services import price_service as ps_mod
from backend.services.price_getters.base import PriceGetterConfig, PriceResult
from backend.services.price_getters.marketstack import MarketstackPriceGetter
from backend.services.price_service import PriceService


def _bar(d: date, price: float, quote="EUR", source="ms") -> PriceResult:
    return PriceResult(
        price=price,
        quote_currency=quote,
        source=source,
        timestamp=datetime.combine(d, datetime.min.time()),
    )


def _resp(payload):
    r = MagicMock()
    r.status_code = 200
    r.json.return_value = payload
    return r


class TestMarketstackRange:
    def test_batches_symbols_and_paginates(self):
        g = MarketstackPriceGetter()
        g._api_key = "k"
        g._session = MagicMock()
        g._session.get.side_effect = [
            _resp(
                {
                    "pagination": {"total": 3},
                    "data": [
                        {
                            "symbol": "WBIT.XETRA",
                            "date": "2026-05-04T00:00:00+0000",
                            "close": 10.0,
                        },
                        {
                            "symbol": "WETH.XETRA",
                            "date": "2026-05-04T00:00:00+0000",
                            "close": 2.0,
                        },
                    ],
                }
            ),
            _resp(
                {
                    "pagination": {"total": 3},
                    "data": [
                        {
                            "symbol": "WBIT.XETRA",
                            "date": "2026-05-05T00:00:00+0000",
                            "close": 11.0,
                        }
                    ],
                }
            ),
        ]
        a1 = Asset(asset_id=1, symbol="WBIT.DE")
        a2 = Asset(asset_id=2, symbol="WETH.DE")
        cfg = lambda t: PriceGetterConfig(
            external_id=t, extra={"native_quote_currency": "EUR"}
        )

        out = g.get_historical_prices_range_many(
            [(a1, cfg("WBIT.XETRA")), (a2, cfg("WETH.XETRA"))],
            date(2026, 5, 1),
            date(2026, 5, 5),
        )

        assert g._session.get.call_count == 2
        first_params = g._session.get.call_args_list[0].kwargs["params"]
        assert first_params["symbols"] == "WBIT.XETRA,WETH.XETRA"
        assert g._session.get.call_args_list[1].kwargs["params"]["offset"] == 2
        assert [(b.timestamp.date(), b.price) for b in out[1]] == [
            (date(2026, 5, 4), 10.0),
            (date(2026, 5, 5), 11.0),
        ]
        assert [b.price for b in out[2]] == [2.0]
        assert out[2][0].quote_currency == "EUR"


class TestFillMissingRange:
    def _service(self, monkeypatch, getter):
        monkeypatch.setattr(ps_mod, "get_price_getter", lambda name: getter)
        svc = PriceService(session=MagicMock(), base_currency="EUR")
        monkeypatch.setattr(svc, "_get_quote_asset_id", lambda s, q: 99)
        svc.cache = MagicMock()
        return svc

    def test_one_call_fills_days_and_carries_forward_weekends(self, monkeypatch):
        getter = MagicMock(supports_range=True, max_history_days=None)
        fri, sat, sun, mon = (date(2026, 5, 1) + timedelta(days=i) for i in range(4))
        getter.get_historical_prices_range_many.return_value = {
            1: [_bar(mon, 12.0), _bar(fri, 10.0)]
        }
        svc = self._service(monkeypatch, getter)
        asset = Asset(asset_id=1, symbol="X")

        filled = svc.fill_missing_range(
            "ms", [(asset, PriceGetterConfig(), [fri, sat, sun, mon])]
        )

        getter.get_historical_prices_range_many.assert_called_once()
        assert {d: r.price for d, r in filled[1].items()} == {
            fri: 10.0,
            sat: 10.0,
            sun: 10.0,
            mon: 12.0,
        }
        assert svc.cache.store.call_count == 4

    def test_skips_request_when_dates_older_than_history_limit(self, monkeypatch):
        getter = MagicMock(supports_range=True, max_history_days=365)
        svc = self._service(monkeypatch, getter)
        old = date.today() - timedelta(days=800)

        assert (
            svc.fill_missing_range(
                "ms", [(Asset(asset_id=1, symbol="X"), PriceGetterConfig(), [old])]
            )
            == {}
        )
        getter.get_historical_prices_range_many.assert_not_called()

    def test_no_bar_within_carry_forward_window_stays_missing(self, monkeypatch):
        getter = MagicMock(supports_range=True, max_history_days=None)
        getter.get_historical_prices_range_many.return_value = {
            1: [_bar(date(2026, 5, 1), 10.0)]
        }
        svc = self._service(monkeypatch, getter)

        filled = svc.fill_missing_range(
            "ms",
            [(Asset(asset_id=1, symbol="X"), PriceGetterConfig(), [date(2026, 5, 20)])],
        )

        assert filled == {}


class TestPrefillWithRanges:
    def test_batches_assets_on_shared_getter_and_reports_tried(self, monkeypatch):
        range_getter = MagicMock(supports_range=True)
        day_getter = MagicMock(supports_range=False)
        getters = {
            "yahoo_direct": range_getter,
            "marketstack": range_getter,
            "manual": day_getter,
        }
        monkeypatch.setattr(job_mod, "get_price_getter", lambda n: getters[n])

        a1, a2 = Asset(asset_id=1, symbol="A"), Asset(asset_id=2, symbol="B")
        session = MagicMock()
        session.get.side_effect = lambda model, aid: {1: a1, 2: a2}[aid]
        d1, d2 = date(2026, 5, 4), date(2026, 5, 5)

        svc = MagicMock()
        svc.resolver.resolve.return_value = [
            ("yahoo_direct", PriceGetterConfig()),
            ("marketstack", PriceGetterConfig()),
            ("manual", PriceGetterConfig()),
        ]

        def fill(name, group):
            if name == "yahoo_direct":
                return {1: {d1: _bar(d1, 1.0)}, 2: {d2: _bar(d2, 1.5)}}
            return {
                aid: {d2: _bar(d2, 2.0)} for aid in (a.asset_id for a, _, _ in group)
            }

        svc.fill_missing_range.side_effect = fill

        filled, tried = job_mod.prefill_with_ranges(
            session, svc, {1: [d1, d2], 2: [d2]}
        )

        calls = [
            (c.args[0], [a.asset_id for a, _, _ in c.args[1]])
            for c in svc.fill_missing_range.call_args_list
        ]
        assert calls == [("yahoo_direct", [1, 2]), ("marketstack", [1])]
        assert set(filled[1]) == {d1, d2}
        assert tried == {1: {"yahoo_direct", "marketstack"}, 2: {"yahoo_direct"}}


class TestRefreshCurrentPrices:
    def _service(self, monkeypatch, getters, assets, resolve, missing=None):
        monkeypatch.setattr(ps_mod, "get_price_getter", lambda name: getters[name])
        prefill = MagicMock(return_value=({}, {}))
        monkeypatch.setattr(job_mod, "prefill_with_ranges", prefill)
        session = MagicMock()
        session.get.side_effect = lambda model, aid: assets.get(aid)
        svc = PriceService(session=session, base_currency="EUR")
        monkeypatch.setattr(svc, "_get_quote_asset_id", lambda s, q: 99)
        monkeypatch.setattr(svc, "_get_cache_exclude_sources", lambda s: ["mock"])
        monkeypatch.setattr(
            svc, "_missing_history_dates", lambda *a, **k: dict(missing or {})
        )
        svc.cache = MagicMock()
        svc.cache.get_with_source.return_value = None
        svc.resolver = MagicMock()
        svc.resolver.resolve.side_effect = lambda s, asset: resolve[asset.asset_id]
        svc.get_price_with_fallback = MagicMock(
            return_value=PriceResult(price=7.0, quote_currency="EUR", source="yahoo")
        )
        return svc, prefill

    def test_one_batched_call_per_getter(self, monkeypatch):
        ms = MagicMock(supports_current_with_range=False)
        ms.get_current_prices_many.return_value = {
            1: PriceResult(price=10.0, quote_currency="EUR", source="marketstack"),
            2: PriceResult(price=2.0, quote_currency="EUR", source="marketstack"),
        }
        assets = {1: Asset(asset_id=1, symbol="A"), 2: Asset(asset_id=2, symbol="B")}
        resolve = {aid: [("marketstack", PriceGetterConfig())] for aid in assets}
        svc, prefill = self._service(monkeypatch, {"marketstack": ms}, assets, resolve)

        out = svc.refresh_current_prices([1, 2], price_quote="EUR")

        ms.get_current_prices_many.assert_called_once()
        assert [a.asset_id for a, _ in ms.get_current_prices_many.call_args.args[0]] == [1, 2]
        assert {aid: r.price for aid, r in out.items()} == {1: 10.0, 2: 2.0}
        assert svc.cache.store.call_count == 2
        svc.get_price_with_fallback.assert_not_called()
        prefill.assert_not_called()

    def test_missing_history_rides_on_the_live_request(self, monkeypatch):
        yd = MagicMock(supports_current_with_range=True)
        d = date.today() - timedelta(days=30)
        yd.get_current_and_range.return_value = (
            PriceResult(price=12.0, quote_currency="EUR", source="yahoo_direct"),
            [_bar(d, 9.0, source="yahoo_direct")],
        )
        assets = {1: Asset(asset_id=1, symbol="A")}
        resolve = {1: [("yahoo_direct", PriceGetterConfig())]}
        svc, prefill = self._service(
            monkeypatch, {"yahoo_direct": yd}, assets, resolve, missing={1: [d]}
        )

        out = svc.refresh_current_prices([1], price_quote="EUR", history_dates=[d])

        yd.get_current_and_range.assert_called_once()
        yd.get_current_prices_many.assert_not_called()
        assert out[1].price == 12.0
        stored = sorted(c.args[3] for c in svc.cache.store.call_args_list)
        assert stored == [9.0, 12.0]
        prefill.assert_not_called()

    def test_unfilled_history_goes_to_range_prefill_without_retrying_getter(self, monkeypatch):
        yd = MagicMock(supports_current_with_range=True)
        d = date.today() - timedelta(days=30)
        yd.get_current_and_range.return_value = (
            PriceResult(price=12.0, quote_currency="EUR", source="yahoo_direct"),
            [],
        )
        assets = {1: Asset(asset_id=1, symbol="A")}
        resolve = {1: [("yahoo_direct", PriceGetterConfig())]}
        svc, prefill = self._service(
            monkeypatch, {"yahoo_direct": yd}, assets, resolve, missing={1: [d]}
        )

        svc.refresh_current_prices([1], price_quote="EUR", history_dates=[d])

        prefill.assert_called_once()
        assert prefill.call_args.args[2] == {1: [d]}
        assert prefill.call_args.kwargs["already_tried"] == {1: {"yahoo_direct"}}

    def test_batch_miss_falls_back_to_other_getters(self, monkeypatch):
        cg = MagicMock(supports_current_with_range=False)
        cg.get_current_prices_many.return_value = {}
        assets = {1: Asset(asset_id=1, symbol="A")}
        resolve = {1: [("coingecko", PriceGetterConfig()), ("yahoo", PriceGetterConfig())]}
        svc, _ = self._service(monkeypatch, {"coingecko": cg}, assets, resolve)

        out = svc.refresh_current_prices([1], price_quote="EUR")

        assert out[1].price == 7.0
        assert svc.get_price_with_fallback.call_args.kwargs["exclude_getters"] == {"coingecko"}

    def test_skips_base_currency_and_fresh_cache(self, monkeypatch):
        assets = {1: Asset(asset_id=1, symbol="EUR"), 2: Asset(asset_id=2, symbol="B")}
        svc, _ = self._service(monkeypatch, {}, assets, {})
        svc.cache.get_with_source.return_value = MagicMock(
            price=5, source="yahoo", snapshot_time=datetime(2026, 1, 1)
        )

        out = svc.refresh_current_prices([1, 2], price_quote="EUR")

        assert list(out) == [2] and out[2].price == 5.0
        svc.resolver.resolve.assert_not_called()


class TestBatchedCurrentGetters:
    def test_marketstack_latest_for_many_symbols_in_one_call(self):
        g = MarketstackPriceGetter()
        g._api_key = "k"
        g._session = MagicMock()
        g._session.get.return_value = _resp(
            {
                "data": [
                    {"symbol": "WBIT.XETRA", "close": 10.0},
                    {"symbol": "WETH.XETRA", "close": 2.0},
                ]
            }
        )
        cfg = lambda t: PriceGetterConfig(
            external_id=t, extra={"native_quote_currency": "EUR"}
        )

        out = g.get_current_prices_many(
            [
                (Asset(asset_id=1, symbol="WBIT.DE"), cfg("WBIT.XETRA")),
                (Asset(asset_id=2, symbol="WETH.DE"), cfg("WETH.XETRA")),
            ]
        )

        assert g._session.get.call_count == 1
        assert g._session.get.call_args.kwargs["params"]["symbols"] == "WBIT.XETRA,WETH.XETRA"
        assert {aid: (r.price, r.quote_currency) for aid, r in out.items()} == {
            1: (10.0, "EUR"),
            2: (2.0, "EUR"),
        }

    def test_missing_history_dates_throttles_retries(self, monkeypatch):
        monkeypatch.setattr(ps_mod, "_history_attempts", {})
        session = MagicMock()
        session.exec.return_value.all.return_value = []
        svc = PriceService(session=session, base_currency="EUR")
        d = date.today() - timedelta(days=10)

        first = svc._missing_history_dates(session, [1], 99, [d, date.today()], None, date.today())
        second = svc._missing_history_dates(session, [1], 99, [d], None, date.today())

        assert first == {1: [d]}
        assert second == {}
