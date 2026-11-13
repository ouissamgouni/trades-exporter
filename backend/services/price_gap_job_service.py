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

# (asset_id, date_from, date_to): only gaps inside the range are fetched; None bounds = full history
GapRangeRequest = Tuple[int, Optional[date], Optional[date]]


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
        # Requests received while a job runs; the worker picks them up before finishing
        self._pending: List[Tuple[Optional[List[int]], List[GapRangeRequest]]] = []
        self._quote_asset_id: Optional[int] = None

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
            "queued_requests": 0,
        }

    # -- public API -------------------------------------------------------

    def is_running(self) -> bool:
        return self._state["status"] in ("scanning", "running")

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._state)

    def start(
        self,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: Optional[List[GapRangeRequest]] = None,
    ) -> Dict[str, Any]:
        with self._lock:
            if self.is_running():
                raise RuntimeError("A gap fix job is already running")
            self._start_locked(asset_ids, quote_asset_id, ranges or [])
        return self.get_status()

    def enqueue(
        self,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: Optional[List[GapRangeRequest]] = None,
    ) -> Dict[str, Any]:
        """Start a job, or add the request to the running one (single job, progressive scope)."""
        with self._lock:
            if self.is_running():
                self._pending.append((asset_ids, list(ranges or [])))
                scope = self._state.get("scope_asset_ids")
                if scope is not None:
                    added = (
                        list(asset_ids or []) + [r[0] for r in ranges or []]
                        if asset_ids is not None
                        else None
                    )
                    self._state["scope_asset_ids"] = (
                        None if added is None else sorted(set(scope) | set(added))
                    )
                n = len(asset_ids or []) + len(ranges or [])
                self._log("info", f"Queued {n or 'all'} more asset(s) into the running job")
                self._state["queued_requests"] = len(self._pending)
            else:
                self._start_locked(asset_ids, quote_asset_id, list(ranges or []))
        return self.get_status()

    def _start_locked(
        self,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: List[GapRangeRequest],
    ) -> None:
        self._cancel.clear()
        self._skip = set()
        self._pending = []
        self._quote_asset_id = quote_asset_id
        self._state = self._initial_state()
        scope = (
            None
            if asset_ids is None and not ranges
            else sorted(set(asset_ids or []) | {r[0] for r in ranges})
        )
        self._state.update(status="scanning", scope_asset_ids=scope, started_at=_now_iso())
        self._thread = threading.Thread(
            target=self._run, args=(asset_ids, quote_asset_id, ranges), daemon=True
        )
        self._thread.start()

    def cancel(self) -> Dict[str, Any]:
        self._cancel.set()
        return self.get_status()

    def skip_asset(self, asset_id: int) -> Dict[str, Any]:
        with self._lock:
            self._skip.add(asset_id)
        return self.get_status()

    # -- worker -----------------------------------------------------------

    def _run(
        self,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: Optional[List[GapRangeRequest]] = None,
    ):
        session = self._session_factory()
        try:
            self.execute(session, asset_ids, quote_asset_id, ranges)
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

    def _scan(
        self,
        session: Session,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: Optional[List[GapRangeRequest]],
        exclude: Optional[Dict[int, Set[date]]] = None,
    ) -> List[Dict[str, Any]]:
        """Work items (one per asset with missing days); `exclude` drops days already queued."""
        if asset_ids is None and not ranges:
            rows = session.exec(
                select(NormalizedTransaction.asset_id)
                .where(NormalizedTransaction.asset_id.isnot(None))
                .distinct()
            ).all()
            asset_ids = sorted({r[0] if isinstance(r, tuple) else r for r in rows})

        targets: List[GapRangeRequest] = [(aid, None, None) for aid in asset_ids or []]
        targets += list(ranges or [])

        by_asset: Dict[int, Dict[str, Any]] = {}
        for aid, d_from, d_to in targets:
            if self._cancel.is_set():
                break
            try:
                if d_from is None and d_to is None:
                    result = detect_gaps(session, aid, quote_asset_id=quote_asset_id)
                else:
                    result = detect_gaps(
                        session, aid, d_from, d_to, quote_asset_id=quote_asset_id
                    )
            except ValueError:
                continue
            if not result.gaps:
                continue
            is_crypto = ((result.price_type or "crypto").lower()) == "crypto"
            dates = set(missing_dates_for_gaps(result.gaps, is_crypto))
            dates -= (exclude or {}).get(aid, set())
            if not dates:
                continue
            item = by_asset.get(aid)
            if item is None:
                asset = session.get(Asset, aid)
                item = by_asset[aid] = {
                    "asset_id": aid,
                    "symbol": result.symbol,
                    "label": asset.label if asset else None,
                    "gap_count": 0,
                    "missing_days": 0,
                    "status": "pending",
                    "fetched": 0,
                    "failed": 0,
                    "last_error": None,
                    "note": None,
                    "_dates": set(),
                }
            item["gap_count"] += len(result.gaps)
            item["_dates"] |= dates
        work = list(by_asset.values())
        for item in work:
            item["_dates"] = sorted(item["_dates"])
            item["missing_days"] = len(item["_dates"])
        return work

    def execute(
        self,
        session: Session,
        asset_ids: Optional[List[int]],
        quote_asset_id: Optional[int],
        ranges: Optional[List[GapRangeRequest]] = None,
    ) -> None:
        work = self._scan(session, asset_ids, quote_asset_id, ranges)

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
        offset = 0
        while True:
            batch = work[offset:]
            if batch and not self._cancel.is_set():
                self._prefill(session, svc, batch, offset)
            for i, item in enumerate(batch):
                if self._cancel.is_set():
                    break
                self._process_asset(svc, offset + i, item)
                with self._lock:
                    self._state["completed_assets"] += 1
            offset = len(work)

            with self._lock:
                if self._cancel.is_set() or not self._pending:
                    break
                pending, self._pending = self._pending, []
                self._state["queued_requests"] = 0
            # Earlier work is finished here; only dedupe days between the queued requests
            queued: Dict[int, Set[date]] = {}
            new_work: List[Dict[str, Any]] = []
            for p_ids, p_ranges in pending:
                new_work += self._scan(
                    session, p_ids, quote_asset_id, p_ranges, exclude=queued
                )
                for w in new_work:
                    queued.setdefault(w["asset_id"], set()).update(w["_dates"])
            with self._lock:
                work += new_work
                self._state["total_assets"] += len(new_work)
                self._state["total_missing_days"] += sum(w["missing_days"] for w in new_work)
                self._state["assets"] += [
                    {k: v for k, v in w.items() if k != "_dates"} for w in new_work
                ]
                if new_work:
                    self._log("info", f"Added {len(new_work)} queued asset(s) with gaps")

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

    def _prefill(
        self, session: Session, svc: PriceService, work: List[Dict[str, Any]], offset: int = 0
    ):
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
                row = self._state["assets"][offset + index]
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
