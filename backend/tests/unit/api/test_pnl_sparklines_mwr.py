from unittest.mock import MagicMock


def test_account_sparklines_return_twr_and_mwr(monkeypatch):
    from backend.api.routes import pnl
    from backend.services.pnl import portfolio_timeline

    # One deposit of 100 at the start, worth 110 after two years: TWR +10%, MWR ≈ +4.9%/y
    series = {
        5: [
            {"date": "2022-01-01", "value": 100.0, "pnl": 0.0},
            {"date": "2023-01-01", "value": 105.0, "pnl": 5.0},
            {"date": "2024-01-01", "value": 110.0, "pnl": 10.0},
        ]
    }
    monkeypatch.setattr(portfolio_timeline, "compute_account_sparklines", lambda **kw: series)

    out = pnl.get_account_sparklines(
        version_id=1,
        account_ids="5",
        period="all",
        asset_ids=None,
        category_ids=None,
        include_unsettled_negative=False,
        session=MagicMock(),
    )

    assert out["twr"]["5"] == 10.0
    assert 4.8 < out["mwr"]["5"] < 5.0
