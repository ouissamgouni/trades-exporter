"""
Generate a dense (gap-free) daily/business-day prices.yaml for the demo
scenario, from the existing sparse waypoints.

Rules (mirrors backend/scripts/gap_analysis.py):
  - crypto assets (BTC, ETH, SOL, USDC, XRP, BNB): one entry per CALENDAR day.
  - everything else (stocks, CW8, USD, PM:* markets): one entry per BUSINESS
    day (Mon-Fri).

Exact waypoint dates/prices from the original prices.yaml are preserved
verbatim (they anchor transaction cost-basis continuity). All other days
are log-linearly interpolated between the surrounding anchors, then:
  - a shared "macro correction" dip (~14%) is applied across ALL assets
    over 2025-01-15 .. 2025-04-15, so the portfolio value doesn't move in
    a straight line (creates a realistic draw-down/recovery cycle to
    compare against a benchmark index).
  - small deterministic random noise is layered on top for realism.

Run:
    .venv/bin/python scenarios/demo/generate_dense_prices.py
"""

import math
import random
from datetime import date, datetime, timedelta

import yaml

TODAY = date(2026, 7, 14)

CRYPTO_SYMBOLS = {"BTC", "ETH", "SOL", "USDC", "XRP", "BNB"}

CORRECTION_START = date(2025, 1, 15)
CORRECTION_END = date(2025, 4, 15)
CORRECTION_DEPTH = 0.14  # ~14% dip at the trough (mid-window)

NOISE_SIGMA = {
    "crypto": 0.010,
    "stock": 0.0045,
    "stable": 0.0015,  # USD, USDC
    "pm": 0.0,  # prediction markets: no macro noise, pure interpolation
}

random.seed(42)


def is_business_day(d: date) -> bool:
    return d.weekday() < 5


def correction_multiplier(d: date) -> float:
    if d < CORRECTION_START or d > CORRECTION_END:
        return 1.0
    span = (CORRECTION_END - CORRECTION_START).days
    frac = (d - CORRECTION_START).days / span
    dip = CORRECTION_DEPTH * (1 - math.cos(2 * math.pi * frac)) / 2
    return 1.0 - dip


def daterange(start: date, end: date, all_days: bool):
    d = start
    while d <= end:
        if all_days or is_business_day(d):
            yield d
        d += timedelta(days=1)


def loglinear(p0: float, p1: float, t: float) -> float:
    # t in [0, 1]
    if p0 <= 0 or p1 <= 0:
        return p0 + (p1 - p0) * t
    return math.exp(math.log(p0) + (math.log(p1) - math.log(p0)) * t)


def generate_series(
    anchors: list, all_days: bool, sigma: float, apply_correction: bool
):
    """anchors: sorted list of (date, price) with the last one at TODAY."""
    start = anchors[0][0]
    end = anchors[-1][0]
    anchor_map = {d: p for d, p in anchors}

    out = []
    covered = set()
    for d in daterange(start, end, all_days):
        if d in anchor_map:
            price = anchor_map[d]
        else:
            # find bracketing anchors (linear scan; anchor lists are tiny)
            lo_i = 0
            for i in range(len(anchors) - 1):
                if anchors[i][0] <= d <= anchors[i + 1][0]:
                    lo_i = i
                    break
            d0, p0 = anchors[lo_i]
            d1, p1 = anchors[lo_i + 1]
            span = (d1 - d0).days
            t = 0.0 if span == 0 else (d - d0).days / span
            price = loglinear(p0, p1, t)
            if apply_correction:
                price *= correction_multiplier(d)
            if sigma:
                price *= 1.0 + max(-3 * sigma, min(3 * sigma, random.gauss(0, sigma)))
        out.append((d, price))
        covered.add(d)

    # Anchor dates always win, even if they fall outside the business-day
    # walk (e.g. a fake transaction happened on a weekend) — extra entries
    # on off-schedule days are harmless and preserve exact cost-basis
    # continuity with the transaction's own recorded price.
    for d, p in anchors:
        if d not in covered:
            out.append((d, p))

    out.sort(key=lambda x: x[0])
    return out


def fmt(price: float) -> str:
    if price < 1:
        return f"{price:.4f}"
    return f"{price:.2f}"


def build_entries(symbol, existing_entries, category, quote_currency):
    anchors = []
    for e in existing_entries:
        at = e["at"]
        d = TODAY if at == "current" else datetime.fromisoformat(str(at)).date()
        anchors.append((d, float(e["price"])))
    anchors.sort(key=lambda x: x[0])
    # dedupe same-day anchors (keep last)
    dedup = {}
    for d, p in anchors:
        dedup[d] = p
    anchors = sorted(dedup.items())

    all_days = symbol in CRYPTO_SYMBOLS
    sigma = NOISE_SIGMA[category]
    apply_correction = category in ("crypto", "stock", "stable")

    series = generate_series(anchors, all_days, sigma, apply_correction)

    # Preserve original comments/precision on the exact original anchor
    # timestamps (not just the date) by keeping their original "at" strings.
    original_by_date = {}
    for e in existing_entries:
        at = e["at"]
        d = TODAY if at == "current" else datetime.fromisoformat(str(at)).date()
        original_by_date[d] = e

    entries_out = []
    for d, price in series:
        if d in original_by_date:
            orig = original_by_date[d]
            entries_out.append({"at": orig["at"], "price": str(orig["price"])})
        else:
            at_str = datetime.combine(d, datetime.min.time()).isoformat()
            entries_out.append({"at": at_str, "price": fmt(price)})

    # Ensure a literal "current" entry exists at the end (mock getter fallback).
    if not any(e["at"] == "current" for e in entries_out):
        last_price = entries_out[-1]["price"] if entries_out else "0"
        entries_out.append({"at": "current", "price": last_price})

    return entries_out


CATEGORY_BY_SYMBOL = {
    "BTC": "crypto",
    "ETH": "crypto",
    "SOL": "crypto",
    "USDC": "stable",
    "XRP": "crypto",
    "BNB": "crypto",
    "AAPL": "stock",
    "MSFT": "stock",
    "GOOGL": "stock",
    "ASML": "stock",
    "CW8": "stock",
    "USD": "stable",
}


def main():
    with open("prices.yaml") as f:
        data = yaml.safe_load(f)

    new_prices = []
    for group in data["prices"]:
        symbol = group["asset_symbol"]
        quote = group["quote_currency"]
        category = CATEGORY_BY_SYMBOL.get(symbol, "pm")
        entries = build_entries(symbol, group["entries"], category, quote)
        new_prices.append(
            {
                "asset_symbol": symbol,
                "quote_currency": quote,
                "entries": entries,
            }
        )

    with open("prices.yaml", "w") as f:
        f.write(
            "# Product Demo Scenario — Prices\n"
            "# =================================\n"
            "# Dense (gap-free) mock price series generated from hand-picked\n"
            "# waypoints via generate_dense_prices.py. Crypto = daily; stocks/\n"
            "# CW8/USD/PM markets = business days. A shared ~14% macro\n"
            "# correction is layered across all market assets over\n"
            "# 2025-01-15..2025-04-15 for a realistic draw-down/recovery cycle.\n"
            "# DO NOT hand-edit generated (non-anchor) entries — re-run the\n"
            "# generator instead; the original hand-picked anchors (matching\n"
            "# transaction dates/prices) are preserved verbatim.\n\n"
        )
        yaml.safe_dump({"prices": new_prices}, f, sort_keys=False, width=100)

    total = sum(len(g["entries"]) for g in new_prices)
    print(f"Generated {total} price entries across {len(new_prices)} asset groups.")
    for g in new_prices:
        print(f"  {g['asset_symbol']:30} {len(g['entries']):5} entries")


if __name__ == "__main__":
    main()
