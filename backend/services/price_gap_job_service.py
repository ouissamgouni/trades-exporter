"""Background job that backfills missing daily prices (price gaps) for a set of assets."""

import threading
import time
import copy
from datetime import date, datetime, timezone
from typing import Any, Callable, Collection, Dict, List, Optional, Set, Tuple

from sqlmodel import Session, select

from backend.config.loader import configure_logging, load_settings
from backend.db.database import get_engine
from backend.db.models import Asset, NormalizedTransaction
from backend.services.price_getters import get_price_getter
from backend.services.price_getters.base import PriceGetterConfig, PriceResult
from backend.services.price_service import (
    GapRange,
    PriceService,
    _expected_trading_days,
    detect_gaps,
)

log = configure_logging("price_gap_job")

MAX_CONSECUTIVE_FAILURES = 5
ASSET_TIME_BUDGET_SECONDS = 300
DAY_FETCH_TIMEOUT_SECONDS = 15
MAX_LOG_ENTRIES = 200


def missing_dates_for_gaps(gaps: List[GapRange], is_crypto: bool) -> List[date]:
    dates: set[date] = set()
    for g in gaps:
        dates.update(
            _expected_trading_days(
                date.fromisoformat(g.start_date),
                date.fromisoformat(g.end_date),
                is_crypto,
            )
        )
    return sorted(dates)


def fetch_day_price(
    svc: PriceService,
    asset_id: int,
    d: date,
    exclude_getters: Optional[Collection[str]] = None,
) -> PriceResult:
    dt = datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)
    return svc.get_price_with_fallback(
        asset_id=asset_id,
        dt=dt,
        use_fallback=False,
        max_timeout_seconds=DAY_FETCH_TIMEOUT_SECONDS,
        exclude_getters=exclude_getters,
    )


def _range_plan(
    session: Session, svc: PriceService, asset: Asset
) -> List[Tuple[str, PriceGetterConfig]]:
    """Leading getters (priority order) that support period requests; stops at the first that doesn't."""
    plan: List[Tuple[str, PriceGetterConfig]] = []
    for name, config in svc.resolver.resolve(session, asset):
        try:
            if not get_price_getter(name).supports_range:
                break
        except Exception:
            break
        plan.append((name, config))
    return plan


def prefill_with_ranges(
    session: Session,
    svc: PriceService,
    missing: Dict[int, List[date]],
    already_tried: Optional[Dict[int, Set[str]]] = None,
) -> Tuple[Dict[int, Dict[date, PriceResult]], Dict[int, Set[str]]]:
    """
    Fill missing dates with period requests before any per-day fetch. Assets sharing
    the same next getter are batched into one call (multi-symbol APIs such as
    marketstack then cost one request for all of them).

    Returns the filled prices and, per asset, the getters already asked, which the
    per-day pass should skip to save request quota.
    """
    remaining = {aid: set(dates) for aid, dates in missing.items() if dates}
    assets: Dict[int, Asset] = {}
    plans: Dict[int, List[Tuple[str, PriceGetterConfig]]] = {}
    for aid in remaining:
        asset = session.get(Asset, aid)
        if asset is not None:
            assets[aid] = asset
            skip = (already_tried or {}).get(aid, set())
            plans[aid] = [p for p in _range_plan(session, svc, asset) if p[0] not in skip]

    filled: Dict[int, Dict[date, PriceResult]] = {}
    tried: Dict[int, Set[str]] = {}
    step = 0
    while True:
        groups: Dict[str, List[Tuple[Asset, PriceGetterConfig, List[date]]]] = {}
        for aid, plan in plans.items():
            if step < len(plan) and remaining[aid]:
                name, config = plan[step]
                groups.setdefault(name, []).append(
                    (assets[aid], config, sorted(remaining[aid]))
                )
        if not groups:
            break
        for name, group in groups.items():
            for asset, _, _ in group:
                tried.setdefault(asset.asset_id, set()).add(name)
            try:
                got = svc.fill_missing_range(name, group)
            except Exception as e:
                log.warning(f"Range fill via {name} failed: {str(e)[:200]}")
                continue
            for aid, by_date in got.items():
                filled.setdefault(aid, {}).update(by_date)
                remaining[aid] -= by_date.keys()
        step += 1
    return filled, tried


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class GapFixJobService:
    """In-memory, single-job runner. Progress is lost on backend restart."""

    def __init__(self, session_factory: Optional[Callable[[], Session]] = None):
        self._session_factory = session_factory or (lambda: Session(get_engine()))
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._skip: set[int] = set()
        self._thread: Optional[threading.Thread] = None
        self._state: Dict[str, Any] = self._initial_state()

    @staticmethod
    def _initial_state() -> Dict[str, Any]:
        return {
            "status": "idle",
            "scope_asset_ids": None,
            "started_at": None,
            "finished_at": None,
            "total_assets": 0,
            "completed_assets": 0,
            "total_missing_days": 0,
            "processed_days": 0,
            "fetched_count": 0,
            "failed_count": 0,
            "current_asset_id": None,
            "current_date": None,
            "error": None,
            "assets": [],
            "log": [],
        }

    # -- public API -------------------------------------------------------

    def is_running(self) -> bool:
        return self._state["status"] in ("scanning", "running")

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._state)

    def start(
        self, asset_ids: Optional[List[int]], quote_asset_id: Optional[int]
    ) -> Dict[str, Any]:
        with self._lock:
            if self.is_running():
                raise RuntimeError("A gap fix job is already running")
            self._cancel.clear()
            self._skip = set()
            self._state = self._initial_state()
            self._state.update(
                status="scanning",
                scope_asset_ids=asset_ids,
                started_at=_now_iso(),
            )
        self._thread = threading.Thread(
            target=self._run, args=(asset_ids, quote_asset_id), daemon=True
        )
        self._thread.start()
        return self.get_status()

    def cancel(self) -> Dict[str, Any]:
        self._cancel.set()
        return self.get_status()

    def skip_asset(self, asset_id: int) -> Dict[str, Any]:
        with self._lock:
            self._skip.add(asset_id)
        return self.get_status()

    # -- worker -----------------------------------------------------------

    def _run(self, asset_ids: Optional[List[int]], quote_asset_id: Optional[int]):
        session = self._session_factory()
        try:
            self.execute(session, asset_ids, quote_asset_id)
        except Exception as e:  # keep the job state consistent if the worker crashes
            log.exception("gap_fix_job_crashed")
            with self._lock:
                self._state.update(status="error", error=str(e), finished_at=_now_iso())
        finally:
            session.close()

    def _log(self, level: str, message: str, asset_id: Optional[int] = None):
        entries = self._state["log"]
        entries.append(
            {"ts": _now_iso(), "level": level, "asset_id": asset_id, "message": message}
        )
        if len(entries) > MAX_LOG_ENTRIES:
            del entries[: len(entries) - MAX_LOG_ENTRIES]

    def execute(
        self,
        session: Session,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
    ) -> None:
        if asset_ids is None:
            rows = session.exec(
                select(NormalizedTransaction.asset_id)
                .where(NormalizedTransaction.asset_id.isnot(None))
                .distinct()
            ).all()
            asset_ids = sorted({r[0] if isinstance(r, tuple) else r for r in rows})

        work: List[Dict[str, Any]] = []
        for aid in asset_ids:
            if self._cancel.is_set():
                break
            try:
                result = detect_gaps(session, aid, quote_asset_id=quote_asset_id)
            except ValueError:
                continue
            if not result.gaps:
                continue
            asset = session.get(Asset, aid)
            is_crypto = ((result.price_type or "crypto").lower()) == "crypto"
            dates = missing_dates_for_gaps(result.gaps, is_crypto)
            work.append(
                {
                    "asset_id": aid,
                    "symbol": result.symbol,
                    "label": asset.label if asset else None,
                    "gap_count": len(result.gaps),
                    "missing_days": len(dates),
                    "status": "pending",
                    "fetched": 0,
                    "failed": 0,
                    "last_error": None,
                    "note": None,
                    "_dates": dates,
                }
            )

        with self._lock:
            self._state.update(
                status="running",
                total_assets=len(work),
                total_missing_days=sum(w["missing_days"] for w in work),
                assets=[{k: v for k, v in w.items() if k != "_dates"} for w in work],
            )
            self._log("info", f"Found {len(work)} asset(s) with gaps")

        svc = PriceService(
            session=session, base_currency=load_settings().get("base_currency", "EUR")
        )
        if not self._cancel.is_set():
            self._prefill(session, svc, work)
        for index, item in enumerate(work):
            if self._cancel.is_set():
                break
            self._process_asset(svc, index, item)
            with self._lock:
                self._state["completed_assets"] += 1

        with self._lock:
            cancelled = self._cancel.is_set()
            if cancelled:
                for a in self._state["assets"]:
                    if a["status"] in ("pending", "running"):
                        a["status"] = "cancelled"
            self._state.update(
                status="cancelled" if cancelled else "complete",
                current_asset_id=None,
                current_date=None,
                finished_at=_now_iso(),
            )
            self._log("info", "Cancelled" if cancelled else "Complete")

    def _prefill(self, session: Session, svc: PriceService, work: List[Dict[str, Any]]):
        filled, tried = prefill_with_ranges(
            session, svc, {w["asset_id"]: w["_dates"] for w in work}
        )
        with self._lock:
            for index, item in enumerate(work):
                aid = item["asset_id"]
                item["_exclude"] = tried.get(aid, set())
                got = filled.get(aid)
                if not got:
                    continue
                item["_dates"] = [d for d in item["_dates"] if d not in got]
                row = self._state["assets"][index]
                row["fetched"] += len(got)
                self._state["fetched_count"] += len(got)
                self._state["processed_days"] += len(got)
                sources = ", ".join(sorted({r.source for r in got.values()}))
                self._log(
                    "info",
                    f"{item['label'] or item['symbol']}: {len(got)} day(s) filled by period request ({sources})",
                    aid,
                )

    def _process_asset(self, svc: PriceService, index: int, item: Dict[str, Any]):
        aid = item["asset_id"]
        name = item["label"] or item["symbol"]
        with self._lock:
            row = self._state["assets"][index]
            row["status"] = "running"
            self._state["current_asset_id"] = aid
            if item["_dates"]:
                self._log("info", f"{name}: fetching {len(item['_dates'])} day(s)", aid)

        started = time.monotonic()
        consecutive_failures = 0
        stop_note: Optional[str] = None
        dates: List[date] = item["_dates"]
        processed = 0
        for d in dates:
            if self._cancel.is_set():
                return
            if aid in self._skip:
                stop_note = "Skipped by user"
                break
            if time.monotonic() - started > ASSET_TIME_BUDGET_SECONDS:
                stop_note = f"Time budget of {ASSET_TIME_BUDGET_SECONDS}s exceeded"
                break
            with self._lock:
                self._state["current_date"] = d.isoformat()
            try:
                fetch_day_price(svc, aid, d, exclude_getters=item.get("_exclude"))
                ok, err = True, None
            except Exception as e:  # any getter failure counts as a failed day
                ok, err = False, str(e)[:200]
            processed += 1
            with self._lock:
                self._state["processed_days"] += 1
                if ok:
                    consecutive_failures = 0
                    row["fetched"] += 1
                    self._state["fetched_count"] += 1
                else:
                    consecutive_failures += 1
                    row["failed"] += 1
                    row["last_error"] = err
                    self._state["failed_count"] += 1
                    self._log("warning", f"{name} {d.isoformat()}: {err}", aid)
            if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                stop_note = (
                    f"Stopped after {MAX_CONSECUTIVE_FAILURES} consecutive failures"
                )
                break

        with self._lock:
            # Days never attempted still count towards overall progress
            self._state["processed_days"] += len(dates) - processed
            if stop_note:
                row["status"] = "skipped"
                row["note"] = stop_note
                self._log("warning", f"{name}: {stop_note}", aid)
            elif row["failed"] == 0:
                row["status"] = "done"
            elif row["fetched"] == 0:
                row["status"] = "failed"
            else:
                row["status"] = "partial"
            self._log(
                "info",
                f"{name}: {row['fetched']} fetched, {row['failed']} failed",
                aid,
            )


gap_fix_jobs = GapFixJobService()
