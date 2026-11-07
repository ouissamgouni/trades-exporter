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



def _job_gap_result(asset_id, symbol, start, end, days):
    return _gap_result(
        asset_id,
        symbol,
        [GapRange(start_date=start, end_date=end, missing_days_count=days)],
    )


def _run_job(monkeypatch, fetch):
    from backend.services import price_gap_job_service as job_mod

    def fake_detect(session_arg, asset_id, quote_asset_id=None):
        if asset_id == 1:
            return _job_gap_result(1, "BAD", "2024-01-01", "2024-01-10", 10)
        return _job_gap_result(2, "GOOD", "2024-01-01", "2024-01-02", 2)

    monkeypatch.setattr(job_mod, "detect_gaps", fake_detect)
    monkeypatch.setattr(job_mod, "fetch_day_price", fetch)
    monkeypatch.setattr(job_mod, "PriceService", MagicMock())
    session = MagicMock()
    session.get.return_value = None
    svc = job_mod.GapFixJobService(session_factory=lambda: session)
    svc.execute(session, [1, 2], quote_asset_id=99)
    return svc.get_status()


def test_gap_job_circuit_breaker_skips_failing_asset_and_continues(monkeypatch):
    def fetch(svc, asset_id, d, **kwargs):
        if asset_id == 1:
            raise RuntimeError("getter down")
        return MagicMock()

    state = _run_job(monkeypatch, fetch)

    assert state["status"] == "complete"
    bad, good = state["assets"]
    assert bad["status"] == "skipped"
    assert bad["failed"] == 5
    assert "consecutive failures" in bad["note"]
    assert good["status"] == "done"
    assert good["fetched"] == 2
    assert state["processed_days"] == state["total_missing_days"] == 12


def test_gap_job_cancel_marks_remaining_assets(monkeypatch):
    from backend.services import price_gap_job_service as job_mod

    holder = {}

    def fetch(svc, asset_id, d, **kwargs):
        holder["svc"].cancel()
        return MagicMock()

    orig_init = job_mod.GapFixJobService.__init__

    def init(self, *a, **kw):
        orig_init(self, *a, **kw)
        holder["svc"] = self

    monkeypatch.setattr(job_mod.GapFixJobService, "__init__", init)
    state = _run_job(monkeypatch, fetch)

    assert state["status"] == "cancelled"
    assert [a["status"] for a in state["assets"]] == ["cancelled", "cancelled"]


def test_gap_job_start_rejects_concurrent_run(monkeypatch):
    from backend.services import price_gap_job_service as job_mod

    svc = job_mod.GapFixJobService(session_factory=MagicMock())
    svc._state["status"] = "running"
    try:
        svc.start([1], None)
        raised = False
    except RuntimeError:
        raised = True
    assert raised
