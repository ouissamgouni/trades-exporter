from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException

from backend.services.pnl.return_metrics import ReturnMetrics


def _call(**kw):
    from backend.api.routes import pnl

    args = dict(
        version_id=1,
        group_by="asset",
        period="all",
        asset_ids=None,
        account_ids=None,
        category_ids=None,
        dimension_id=None,
        include_unsettled_negative=False,
        session=MagicMock(),
    )
    args.update(kw)
    return pnl.get_group_return_metrics(**args)


def test_group_return_metrics_returns_twr_and_mwr(monkeypatch):
    from backend.services.pnl import group_returns

    monkeypatch.setattr(
        group_returns,
        "compute_group_return_metrics",
        lambda *a, **kw: {
            3: ReturnMetrics(730, 10.0, 4.88, 4.9, 10.0),
            4: ReturnMetrics(30, None, None, None, None),
        },
    )

    out = _call()

    assert out["twr"] == {"3": 10.0, "4": None}
    assert out["mwr"] == {"3": 4.9, "4": None}


def test_group_return_metrics_rejects_unknown_period():
    with pytest.raises(HTTPException) as exc:
        _call(period="2w")
    assert exc.value.status_code == 422
