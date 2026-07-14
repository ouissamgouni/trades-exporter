#!/usr/bin/env python3
"""
Smoke Test: Price Getters for All Assets
=========================================
Tests each configured price getter for every asset in the dev DB.
For each (asset, getter) pair, attempts both a current and historical price fetch.
Outputs a formatted console summary with per-getter success rates and reordering recommendations.

Usage:
    cd backend
    PYTHONPATH=/path/to/trades-exporter ../.venv/bin/python scripts/smoke_test_prices.py
"""

import sys
import os
import time
import signal
from datetime import datetime, timezone
from dataclasses import dataclass, field
from typing import Optional, List, Dict, Tuple

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.db.database import get_session
from backend.db.models import Asset, AssetPriceGetter
from backend.services.price_getters import get_price_getter, list_price_getters
from backend.services.price_getters.base import PriceGetterConfig, PriceResult
from sqlmodel import select

# ── Config ──────────────────────────────────────────────────────────────────
HISTORICAL_DATE = datetime(2026, 1, 15, 12, 0, 0)
TIMEOUT_PER_CALL = 15  # seconds
RATE_LIMITS = {  # seconds between consecutive calls per getter
    "coingecko": 2.5,  # free tier is ~10-30 req/min
    "yahoo": 0.3,
    "yahoo_direct": 0.3,
    "datareader": 0.5,
    "forex": 0.2,
}

# ANSI colors
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


# ── Data classes ────────────────────────────────────────────────────────────
@dataclass
class TestResult:
    asset_symbol: str
    asset_type: str
    getter_name: str
    external_id: Optional[str]
    priority: int
    test_type: str  # "current" or "historical"
    success: bool
    price: Optional[float] = None
    quote_currency: Optional[str] = None
    error: Optional[str] = None
    elapsed_ms: float = 0.0


@dataclass
class AssetTestSummary:
    symbol: str
    price_type: str
    results: List[TestResult] = field(default_factory=list)

    @property
    def has_any_success(self) -> bool:
        return any(r.success for r in self.results)

    @property
    def best_getter(self) -> Optional[str]:
        """Getter with most successes (current+historical), lowest priority as tiebreak."""
        getter_scores: Dict[str, Tuple[int, int]] = {}  # name -> (successes, -priority)
        for r in self.results:
            if r.getter_name not in getter_scores:
                getter_scores[r.getter_name] = (0, -r.priority)
            if r.success:
                old = getter_scores[r.getter_name]
                getter_scores[r.getter_name] = (old[0] + 1, old[1])
        if not getter_scores:
            return None
        return max(getter_scores, key=lambda k: getter_scores[k])


# ── Timeout helper ──────────────────────────────────────────────────────────
class TimeoutError(Exception):
    pass


def _timeout_handler(signum, frame):
    raise TimeoutError("Call timed out")


# ── Core test function ──────────────────────────────────────────────────────
def test_getter_call(
    getter, asset: Asset, config: PriceGetterConfig, dt: Optional[datetime] = None
) -> TestResult:
    """Test a single getter call (current or historical)."""
    test_type = "historical" if dt else "current"
    start = time.monotonic()

    # Set alarm-based timeout
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(TIMEOUT_PER_CALL)

    try:
        if dt:
            result = getter.get_historical_price(asset, dt, config)
        else:
            result = getter.get_current_price(asset, config)

        signal.alarm(0)
        elapsed = (time.monotonic() - start) * 1000

        return TestResult(
            asset_symbol=asset.symbol,
            asset_type=asset.price_type or "unknown",
            getter_name=getter.name,
            external_id=config.external_id,
            priority=0,
            test_type=test_type,
            success=True,
            price=result.price,
            quote_currency=result.quote_currency,
            elapsed_ms=elapsed,
        )
    except Exception as e:
        signal.alarm(0)
        elapsed = (time.monotonic() - start) * 1000
        err_msg = str(e)[:120]
        return TestResult(
            asset_symbol=asset.symbol,
            asset_type=asset.price_type or "unknown",
            getter_name=getter.name,
            external_id=config.external_id,
            priority=0,
            test_type=test_type,
            success=False,
            error=err_msg,
            elapsed_ms=elapsed,
        )
    finally:
        signal.signal(signal.SIGALRM, old_handler)


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    print(f"\n{BOLD}{'=' * 80}{RESET}")
    print(f"{BOLD}  SMOKE TEST: Price Getters for All Assets{RESET}")
    print(f"{BOLD}{'=' * 80}{RESET}")
    print(f"  Current price:    now")
    print(f"  Historical price: {HISTORICAL_DATE.strftime('%Y-%m-%d')}")
    print(f"  Timeout per call: {TIMEOUT_PER_CALL}s")
    print(f"  Available getters: {', '.join(list_price_getters())}")
    print(f"{'=' * 80}\n")

    # Pre-load getter instances
    getter_instances = {}
    for name in list_price_getters():
        try:
            getter_instances[name] = get_price_getter(name)
        except Exception as e:
            print(f"  {RED}WARN: Could not load getter '{name}': {e}{RESET}")

    # Load assets + their price getters from DB
    all_summaries: List[AssetTestSummary] = []
    last_call_time: Dict[str, float] = {}  # rate limit tracker per getter

    with get_session() as session:
        assets = session.exec(select(Asset).order_by(Asset.symbol)).all()

        # For each asset, eager-load price getters
        asset_getter_map: List[Tuple[Asset, List[AssetPriceGetter]]] = []
        for asset in assets:
            getters = session.exec(
                select(AssetPriceGetter)
                .where(AssetPriceGetter.asset_id == asset.asset_id)
                .where(AssetPriceGetter.enabled == True)
                .order_by(AssetPriceGetter.priority)
            ).all()
            if getters:
                asset_getter_map.append((asset, getters))

        total_tests = len(asset_getter_map) * 2  # current + historical per getter-pair
        # Actually, total_tests = sum of (len(getters)*2 for each asset)
        total_calls = sum(len(gs) * 2 for _, gs in asset_getter_map)
        print(f"  Assets with getters: {len(asset_getter_map)}")
        print(f"  Total API calls:     {total_calls}")
        est_minutes = total_calls * 1.5 / 60  # rough average
        print(f"  Estimated time:      ~{est_minutes:.0f} min\n")

        test_num = 0
        for asset, db_getters in asset_getter_map:
            summary = AssetTestSummary(
                symbol=asset.symbol, price_type=asset.price_type or "unknown"
            )
            sym_display = f"{asset.symbol:20s}"

            for apg in db_getters:
                getter_name = apg.price_getter
                if getter_name not in getter_instances:
                    print(
                        f"  {sym_display} {YELLOW}SKIP{RESET} getter={getter_name} (not registered)"
                    )
                    continue

                getter = getter_instances[getter_name]
                config = PriceGetterConfig.from_db(apg.external_id, apg.params)

                # Rate limit
                now = time.monotonic()
                delay = RATE_LIMITS.get(getter_name, 0.3)
                last = last_call_time.get(getter_name, 0)
                wait = max(0, delay - (now - last))
                if wait > 0:
                    time.sleep(wait)

                # ── Test current price ──
                test_num += 1
                r_curr = test_getter_call(getter, asset, config, dt=None)
                r_curr.priority = apg.priority
                last_call_time[getter_name] = time.monotonic()
                summary.results.append(r_curr)

                status_curr = (
                    f"{GREEN}OK{RESET}" if r_curr.success else f"{RED}FAIL{RESET}"
                )
                price_str = (
                    f"{r_curr.price:.4f} {r_curr.quote_currency}"
                    if r_curr.success
                    else r_curr.error[:50]
                )

                # Rate limit before historical
                time.sleep(delay)

                # ── Test historical price ──
                test_num += 1
                r_hist = test_getter_call(getter, asset, config, dt=HISTORICAL_DATE)
                r_hist.priority = apg.priority
                last_call_time[getter_name] = time.monotonic()
                summary.results.append(r_hist)

                status_hist = (
                    f"{GREEN}OK{RESET}" if r_hist.success else f"{RED}FAIL{RESET}"
                )
                price_hist_str = (
                    f"{r_hist.price:.4f} {r_hist.quote_currency}"
                    if r_hist.success
                    else (r_hist.error[:50] if r_hist.error else "?")
                )

                ext_display = (apg.external_id or asset.symbol)[:20]
                print(
                    f"  [{test_num:3d}/{total_calls}] {sym_display} "
                    f"{getter_name:12s} ({ext_display:20s}) pri={apg.priority}  "
                    f"curr={status_curr} {price_str:30s}  "
                    f"hist={status_hist} {price_hist_str}"
                )

            all_summaries.append(summary)

    # ── Print Summary ───────────────────────────────────────────────────────
    print(f"\n{BOLD}{'=' * 80}{RESET}")
    print(f"{BOLD}  RESULTS SUMMARY{RESET}")
    print(f"{'=' * 80}\n")

    # 1. Per-getter success rates
    getter_stats: Dict[
        str, Dict[str, int]
    ] = {}  # getter -> {total, success, current_ok, hist_ok}
    for s in all_summaries:
        for r in s.results:
            if r.getter_name not in getter_stats:
                getter_stats[r.getter_name] = {
                    "total": 0,
                    "success": 0,
                    "curr_ok": 0,
                    "hist_ok": 0,
                    "curr_total": 0,
                    "hist_total": 0,
                }
            gs = getter_stats[r.getter_name]
            gs["total"] += 1
            if r.success:
                gs["success"] += 1
            if r.test_type == "current":
                gs["curr_total"] += 1
                if r.success:
                    gs["curr_ok"] += 1
            else:
                gs["hist_total"] += 1
                if r.success:
                    gs["hist_ok"] += 1

    print(f"  {BOLD}1. Success Rates by Getter{RESET}\n")
    print(f"  {'Getter':<14s} {'Overall':>10s}  {'Current':>10s}  {'Historical':>10s}")
    print(f"  {'─' * 50}")
    for gname, gs in sorted(getter_stats.items()):
        overall = f"{gs['success']}/{gs['total']} ({100 * gs['success'] / max(gs['total'], 1):.0f}%)"
        curr = f"{gs['curr_ok']}/{gs['curr_total']} ({100 * gs['curr_ok'] / max(gs['curr_total'], 1):.0f}%)"
        hist = f"{gs['hist_ok']}/{gs['hist_total']} ({100 * gs['hist_ok'] / max(gs['hist_total'], 1):.0f}%)"
        print(f"  {gname:<14s} {overall:>10s}  {curr:>10s}  {hist:>10s}")

    # 2. Assets where ALL getters failed
    total_fail = [s for s in all_summaries if not s.has_any_success]
    print(f"\n  {BOLD}2. Assets Where ALL Getters Failed ({len(total_fail)}){RESET}\n")
    if total_fail:
        for s in total_fail:
            errors = set()
            for r in s.results:
                if r.error:
                    errors.add(f"{r.getter_name}: {r.error[:60]}")
            print(f"  {RED}✗{RESET} {s.symbol:20s} ({s.price_type})")
            for e in errors:
                print(f"      {DIM}{e}{RESET}")
    else:
        print(f"  {GREEN}None — all assets have at least one working getter!{RESET}")

    # 3. Reorder candidates: lower-priority getter works but higher-priority fails
    print(f"\n  {BOLD}3. Reorder Candidates{RESET}")
    print(
        f"  {DIM}(Assets where a lower-priority getter succeeded but a higher-priority one failed){RESET}\n"
    )
    reorder_count = 0
    for s in all_summaries:
        # Group results by getter_name
        getter_results: Dict[str, Dict] = {}
        for r in s.results:
            if r.getter_name not in getter_results:
                getter_results[r.getter_name] = {
                    "priority": r.priority,
                    "successes": 0,
                    "total": 0,
                }
            getter_results[r.getter_name]["total"] += 1
            if r.success:
                getter_results[r.getter_name]["successes"] += 1

        # Sort by priority (ascending = higher priority first)
        sorted_getters = sorted(getter_results.items(), key=lambda x: x[1]["priority"])

        # Check if higher-priority getter failed but a lower-priority succeeded
        for i, (gname, gdata) in enumerate(sorted_getters):
            if gdata["successes"] == 0:  # this getter fully failed
                # Check if any later (lower-priority) getter succeeded
                for j in range(i + 1, len(sorted_getters)):
                    later_name, later_data = sorted_getters[j]
                    if later_data["successes"] > 0:
                        reorder_count += 1
                        print(
                            f"  {YELLOW}↻{RESET} {s.symbol:20s} ({s.price_type:8s}) "
                            f"pri={gdata['priority']} {RED}{gname}{RESET} failed → "
                            f"pri={later_data['priority']} {GREEN}{later_name}{RESET} works"
                        )
                        break  # only report the first better alternative

    if reorder_count == 0:
        print(f"  {GREEN}None — current priority ordering is optimal!{RESET}")

    # 4. Per-type recommendations
    print(f"\n  {BOLD}4. Recommendations by Asset Type{RESET}\n")

    type_getter_success: Dict[
        str, Dict[str, Tuple[int, int]]
    ] = {}  # type -> getter -> (ok, total)
    for s in all_summaries:
        pt = s.price_type
        if pt not in type_getter_success:
            type_getter_success[pt] = {}
        for r in s.results:
            if r.getter_name not in type_getter_success[pt]:
                type_getter_success[pt][r.getter_name] = (0, 0)
            old_ok, old_total = type_getter_success[pt][r.getter_name]
            type_getter_success[pt][r.getter_name] = (
                old_ok + (1 if r.success else 0),
                old_total + 1,
            )

    for pt in sorted(type_getter_success.keys()):
        getters_ranked = sorted(
            type_getter_success[pt].items(),
            key=lambda x: x[1][0] / max(x[1][1], 1),
            reverse=True,
        )
        print(f"  {CYAN}{pt:10s}{RESET}  Recommended order:", end="")
        for gname, (ok, total) in getters_ranked:
            pct = 100 * ok / max(total, 1)
            color = GREEN if pct >= 80 else (YELLOW if pct >= 50 else RED)
            print(f"  {color}{gname}{RESET} ({pct:.0f}%)", end="")
        print()

    # 5. Specific failures detail
    print(f"\n  {BOLD}5. Detailed Failure List{RESET}\n")
    print(f"  {'Asset':<20s} {'Getter':<12s} {'Type':<10s} {'ExtID':<22s} {'Error'}")
    print(f"  {'─' * 100}")
    failure_count = 0
    for s in all_summaries:
        for r in s.results:
            if not r.success:
                failure_count += 1
                print(
                    f"  {r.asset_symbol:<20s} {r.getter_name:<12s} {r.test_type:<10s} "
                    f"{(r.external_id or '-'):<22s} {r.error[:60] if r.error else '?'}"
                )
    if failure_count == 0:
        print(f"  {GREEN}No failures!{RESET}")

    print(f"\n{BOLD}{'=' * 80}{RESET}")
    print(
        f"  Total tests: {sum(len(s.results) for s in all_summaries)}, "
        f"Successes: {sum(1 for s in all_summaries for r in s.results if r.success)}, "
        f"Failures: {failure_count}"
    )
    print(f"{BOLD}{'=' * 80}{RESET}\n")


if __name__ == "__main__":
    main()
