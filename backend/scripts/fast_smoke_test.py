#!/usr/bin/env python3
"""
Fast Smoke Test: Price Getters — parallel, 1 attempt, short timeout.

Tests each (asset, getter) pair with a single current-price call.
Uses ThreadPoolExecutor for parallelism within each getter type.
Total runtime: ~30-60 seconds.

Usage:
    cd backend
    ALPHAVANTAGE_API_KEY=xxx MARKETSTACK_API_KEY=xxx \
      PYTHONPATH=/path/to/trades-exporter ../.venv/bin/python scripts/fast_smoke_test.py
"""

import sys, os, time
from datetime import datetime, timezone
from concurrent.futures import (
    ThreadPoolExecutor,
    as_completed,
    TimeoutError as FuturesTimeout,
)
from dataclasses import dataclass, field
from typing import Optional, List, Dict
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

# ── Minimal logging to avoid noise ──
import logging

logging.getLogger().setLevel(logging.WARNING)

from backend.db.database import get_session
from backend.db.models import Asset, AssetPriceGetter
from backend.services.price_getters.registry import (
    get_price_getter,
    _initialize_registry,
)
from backend.services.price_getters.base import PriceGetterConfig, PriceResult
from sqlmodel import select

CALL_TIMEOUT = 8  # seconds per API call
HISTORICAL_DATE = datetime(2026, 1, 15, 12, 0, 0)

# Workers per getter type (respect rate limits)
GETTER_WORKERS = {
    "yahoo_direct": 5,
    "datareader": 3,
    "coingecko": 1,  # strict rate limit
    "alphavantage": 1,  # 25 req/day free, 75/min with key
    "marketstack": 2,
    "forex": 2,
}

GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


@dataclass
class TestResult:
    symbol: str
    price_type: str
    getter: str
    ext_id: str
    priority: int
    current_ok: bool = False
    current_price: Optional[float] = None
    current_err: str = ""
    historical_ok: bool = False
    historical_price: Optional[float] = None
    historical_err: str = ""


def test_one(
    asset: Asset, getter_name: str, ext_id: str, priority: int, params: dict
) -> TestResult:
    """Test one (asset, getter) pair — current + historical, 1 attempt, hard timeout."""
    r = TestResult(
        symbol=asset.symbol,
        price_type=asset.price_type or "?",
        getter=getter_name,
        ext_id=ext_id or asset.symbol,
        priority=priority,
    )

    try:
        getter = get_price_getter(getter_name)
    except Exception as e:
        r.current_err = r.historical_err = f"Getter not found: {e}"
        return r

    config = PriceGetterConfig(
        external_id=ext_id if ext_id else None,
        extra=params or {},
    )

    # Override retry to 1 attempt
    orig_retries = getter.max_retries
    getter.max_retries = 1

    # ── Current price ──
    try:
        result = getter.get_current_price(asset, config)
        if result and result.price:
            r.current_ok = True
            r.current_price = float(result.price)
    except Exception as e:
        r.current_err = str(e)[:120]

    # ── Historical price ──
    try:
        result = getter.get_historical_price(asset, HISTORICAL_DATE, config)
        if result and result.price:
            r.historical_ok = True
            r.historical_price = float(result.price)
    except Exception as e:
        r.historical_err = str(e)[:120]

    getter.max_retries = orig_retries
    return r


def main():
    t0 = time.monotonic()
    _initialize_registry()

    # ── Load all (asset, getter) pairs from DB ──
    with get_session() as session:
        stmt = (
            select(Asset, AssetPriceGetter)
            .join(AssetPriceGetter, Asset.asset_id == AssetPriceGetter.asset_id)
            .where(AssetPriceGetter.enabled == True)
            .order_by(Asset.symbol, AssetPriceGetter.priority)
        )
        rows = session.exec(stmt).all()
        pairs = []
        for asset, apg in rows:
            # Detach from session
            a = Asset(
                asset_id=asset.asset_id,
                symbol=asset.symbol,
                label=asset.label,
                price_type=asset.price_type,
            )
            pairs.append(
                (a, apg.price_getter, apg.external_id, apg.priority, apg.params or {})
            )

    print(
        f"{BOLD}Fast Smoke Test — {len(pairs)} getter assignments across {len(set(p[0].symbol for p in pairs))} assets{RESET}"
    )
    print(f"Historical date: {HISTORICAL_DATE.strftime('%Y-%m-%d')}")
    print()

    # ── Group by getter type ──
    by_getter: Dict[str, list] = {}
    for p in pairs:
        by_getter.setdefault(p[1], []).append(p)

    all_results: List[TestResult] = []

    for getter_name, getter_pairs in sorted(by_getter.items()):
        workers = GETTER_WORKERS.get(getter_name, 2)
        print(
            f"  {CYAN}Testing {getter_name}{RESET} ({len(getter_pairs)} assets, {workers} workers)...",
            end=" ",
            flush=True,
        )
        gt0 = time.monotonic()

        # Sequential for single-worker getters (rate-limited), parallel otherwise
        results = []
        if workers == 1:
            for asset, gn, ext, pri, params in getter_pairs:
                r = test_one(asset, gn, ext, pri, params)
                results.append(r)
                sym = f"{GREEN}✓{RESET}" if r.current_ok else f"{RED}✗{RESET}"
                print(sym, end="", flush=True)
        else:
            with ThreadPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(test_one, asset, gn, ext, pri, params): asset.symbol
                    for asset, gn, ext, pri, params in getter_pairs
                }
                for future in as_completed(futures):
                    try:
                        r = future.result(timeout=CALL_TIMEOUT * 2 + 5)
                    except Exception as e:
                        sym_name = futures[future]
                        r = TestResult(
                            symbol=sym_name,
                            price_type="?",
                            getter=getter_name,
                            ext_id="?",
                            priority=99,
                            current_err=str(e)[:80],
                            historical_err=str(e)[:80],
                        )
                    results.append(r)
                    sym = f"{GREEN}✓{RESET}" if r.current_ok else f"{RED}✗{RESET}"
                    print(sym, end="", flush=True)

        elapsed = time.monotonic() - gt0
        ok = sum(1 for r in results if r.current_ok)
        print(f"  {ok}/{len(results)} in {elapsed:.1f}s")
        all_results.extend(results)

    # ════════════════════════ SUMMARY ════════════════════════
    total_elapsed = time.monotonic() - t0
    print(f"\n{'=' * 80}")
    print(f"{BOLD}  RESULTS SUMMARY{RESET}")
    print(f"{'=' * 80}\n")

    # 1. Success rates by getter
    print(f"  {BOLD}1. Success Rates by Getter{RESET}\n")
    print(f"  {'Getter':<18s} {'Overall':>13s}  {'Current':>13s}  {'Historical':>13s}")
    print(f"  {'─' * 62}")
    getter_stats: Dict[str, dict] = {}
    for r in all_results:
        s = getter_stats.setdefault(
            r.getter, {"cur_ok": 0, "cur_tot": 0, "hist_ok": 0, "hist_tot": 0}
        )
        s["cur_tot"] += 1
        s["hist_tot"] += 1
        if r.current_ok:
            s["cur_ok"] += 1
        if r.historical_ok:
            s["hist_ok"] += 1
    for gn, s in sorted(
        getter_stats.items(), key=lambda x: -(x[1]["cur_ok"] + x[1]["hist_ok"])
    ):
        total_ok = s["cur_ok"] + s["hist_ok"]
        total_t = s["cur_tot"] + s["hist_tot"]
        pct = total_ok / total_t * 100 if total_t else 0
        cpct = s["cur_ok"] / s["cur_tot"] * 100 if s["cur_tot"] else 0
        hpct = s["hist_ok"] / s["hist_tot"] * 100 if s["hist_tot"] else 0
        print(
            f"  {gn:<18s} {total_ok:>3d}/{total_t:<3d} ({pct:>3.0f}%)  "
            f"{s['cur_ok']:>3d}/{s['cur_tot']:<3d} ({cpct:>3.0f}%)  "
            f"{s['hist_ok']:>3d}/{s['hist_tot']:<3d} ({hpct:>3.0f}%)"
        )

    # 2. Assets where ALL getters failed
    from collections import defaultdict

    by_asset = defaultdict(list)
    for r in all_results:
        by_asset[r.symbol].append(r)

    all_failed = {
        sym: rs
        for sym, rs in by_asset.items()
        if not any(r.current_ok or r.historical_ok for r in rs)
    }
    print(f"\n  {BOLD}2. Assets Where ALL Getters Failed ({len(all_failed)}){RESET}\n")
    for sym in sorted(all_failed):
        rs = all_failed[sym]
        print(f"  {RED}✗{RESET} {sym:<22s} ({rs[0].price_type})")
        for r in rs:
            err = r.current_err or r.historical_err
            if err:
                print(f"      {DIM}{r.getter}: {err[:90]}{RESET}")

    # 3. Reorder candidates
    print(f"\n  {BOLD}3. Reorder Candidates{RESET}")
    reorder = []
    for sym, rs in sorted(by_asset.items()):
        rs_sorted = sorted(rs, key=lambda r: r.priority)
        for i, hi in enumerate(rs_sorted):
            if not hi.current_ok:
                for lo in rs_sorted[i + 1 :]:
                    if lo.current_ok:
                        reorder.append((sym, hi, lo))
                        break
    if reorder:
        for sym, hi, lo in reorder:
            print(
                f"  ↻ {sym:<22s} pri={hi.priority} {hi.getter} failed → pri={lo.priority} {lo.getter} works"
            )
    else:
        print(f"  {GREEN}None — current priority ordering is optimal!{RESET}")

    # 4. Partial failures (getter works for current but not historical, or vice versa)
    print(f"\n  {BOLD}4. Partial Failures (current OK but historical FAIL){RESET}\n")
    partial = [r for r in all_results if r.current_ok and not r.historical_ok]
    if partial:
        for r in sorted(partial, key=lambda r: r.symbol):
            print(
                f"  {YELLOW}⚠{RESET} {r.symbol:<22s} {r.getter:<15s} current={r.current_price:.4f}  hist_err={r.historical_err[:60]}"
            )
    else:
        print(f"  {GREEN}None{RESET}")

    # 5. Detailed failure list
    failures = [r for r in all_results if not r.current_ok or not r.historical_ok]
    print(f"\n  {BOLD}5. Detailed Failures ({len(failures)}){RESET}\n")
    print(
        f"  {'Asset':<20s} {'Getter':<14s} {'ExtID':<22s} {'Cur':>4s} {'Hist':>5s}  Error"
    )
    print(f"  {'─' * 100}")
    for r in sorted(failures, key=lambda r: (r.symbol, r.getter)):
        cur_s = f"{GREEN}OK{RESET}" if r.current_ok else f"{RED}✗{RESET} "
        hist_s = f"{GREEN}OK{RESET}" if r.historical_ok else f"{RED}✗{RESET} "
        err = r.current_err if not r.current_ok else r.historical_err
        print(
            f"  {r.symbol:<20s} {r.getter:<14s} {r.ext_id:<22s} {cur_s}  {hist_s}   {err[:55]}"
        )

    print(f"\n{'=' * 80}")
    total_tests = len(all_results) * 2
    total_ok = sum(1 for r in all_results if r.current_ok) + sum(
        1 for r in all_results if r.historical_ok
    )
    print(
        f"  Total: {total_tests} tests, {total_ok} passed, {total_tests - total_ok} failed"
    )
    print(f"  Runtime: {total_elapsed:.1f}s")
    print(f"{'=' * 80}")


if __name__ == "__main__":
    main()
