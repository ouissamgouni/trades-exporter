from unittest.mock import MagicMock

from backend.api.routes import price_snapshots
from backend.services.price_service import GapDetectionResult, GapRange


def _gap_result(asset_id: int, symbol: str, gaps: list[GapRange]) -> GapDetectionResult:
    return GapDetectionResult(
        asset_id=asset_id,
        symbol=symbol,
        price_type="crypto",
        total_expected=10,
        total_covered=8,
        coverage_pct=80.0,
        gaps=gaps,
    )


def test_gap_candidates_returns_transaction_assets_with_gaps(monkeypatch):
    session = MagicMock()
    tx_rows = MagicMock()
    tx_rows.all.return_value = [(2,), (1,), (None,), (3,)]
    session.exec.return_value = tx_rows

    def fake_detect_gaps(session_arg, asset_id, quote_asset_id=None):
        assert session_arg is session
        assert quote_asset_id == 99
        if asset_id == 1:
            return _gap_result(
                1,
                "BTC",
                [GapRange(start_date="2024-01-01", end_date="2024-01-02", missing_days_count=2)],
            )
        if asset_id == 2:
            raise ValueError("Asset ID 2 not found")
        return _gap_result(3, "ETH", [])

    monkeypatch.setattr(price_snapshots, "detect_gaps", fake_detect_gaps)

    response = price_snapshots.get_price_gap_candidates(quote_asset_id=99, session=session)

    assert len(response.items) == 1
    item = response.items[0]
    assert item.asset_id == 1
    assert item.symbol == "BTC"
    assert len(item.gaps) == 1
    assert item.gaps[0].missing_days_count == 2


def test_gap_candidates_omits_empty_transaction_set(monkeypatch):
    session = MagicMock()
    tx_rows = MagicMock()
    tx_rows.all.return_value = []
    session.exec.return_value = tx_rows
    detect_gaps = MagicMock()
    monkeypatch.setattr(price_snapshots, "detect_gaps", detect_gaps)

    response = price_snapshots.get_price_gap_candidates(quote_asset_id=99, session=session)

    assert response.items == []
    detect_gaps.assert_not_called()
