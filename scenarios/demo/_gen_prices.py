"""THROWAWAY generator for scenarios/demo/prices.yaml.

Run once, then delete. Produces a dense (gap-free) mock price series from
hand-picked waypoints so the demo Portfolio Performance chart is smooth and
tells a clear story: the portfolio beats the S&P 500 benchmark (^GSPC) at all
times while still showing genuine drawdowns and rallies.

Design:
- Each asset has an ordered list of (date, price) waypoints (including the
  transaction-matched anchors). Prices are interpolated between waypoints
  (log-linear for real assets, linear for [0,1] prediction markets) and given
  small deterministic noise (fixed RNG seed → fully reproducible).
- The ^GSPC benchmark is intentionally tame (~+35% total). Portfolio assets —
  especially the heavyweight CW8 ETF plus crypto — outperform it comfortably.
"""

import math
import random
from datetime import date, timedelta

OUT = __file__.rsplit("/", 1)[0] + "/prices.yaml"
END = date(2026, 7, 13)


def d(s: str) -> date:
    y, m, dd = map(int, s.split("-"))
    return date(y, m, dd)


# (symbol, quote, freq, interp, round_dp, noise_sigma, waypoints[(date, price)])
# freq: "daily" | "bdays"; interp: "log" | "lin"
ASSETS = [
    (
        "BTC",
        "EUR",
        "daily",
        "log",
        2,
        0.012,
        [
            ("2024-01-05", 37000),
            ("2024-01-15", 38000),
            ("2024-03-01", 45000),
            ("2024-06-20", 58000),
            ("2024-08-05", 53000),
            ("2024-09-01", 60000),
            ("2024-11-15", 88000),
            ("2024-12-20", 95000),
            ("2025-02-25", 80000),
            ("2025-04-15", 86000),
            ("2025-06-01", 90000),
            ("2025-09-10", 85000),
            ("2025-11-15", 97000),
            ("2026-01-10", 92000),
            ("2026-03-01", 90000),
            ("2026-05-01", 97000),
            ("2026-07-13", 98000),
        ],
    ),
    (
        "ETH",
        "EUR",
        "daily",
        "log",
        2,
        0.013,
        [
            ("2024-02-10", 2300),
            ("2024-04-01", 2900),
            ("2024-05-01", 3000),
            ("2024-07-01", 3300),
            ("2024-08-01", 3400),
            ("2024-08-15", 3150),
            ("2024-12-15", 3900),
            ("2025-02-25", 3050),
            ("2025-04-15", 3300),
            ("2025-06-01", 3200),
            ("2025-09-10", 3050),
            ("2026-01-01", 3550),
            ("2026-03-01", 3350),
            ("2026-05-01", 3550),
            ("2026-07-13", 3600),
        ],
    ),
    (
        "SOL",
        "EUR",
        "daily",
        "log",
        2,
        0.018,
        [
            ("2024-03-05", 95),
            ("2024-07-20", 130),
            ("2024-11-01", 175),
            ("2024-12-20", 200),
            ("2025-02-25", 130),
            ("2025-04-01", 150),
            ("2025-07-01", 168),
            ("2025-09-10", 140),
            ("2026-01-01", 172),
            ("2026-03-01", 140),
            ("2026-05-01", 158),
            ("2026-07-13", 150),
        ],
    ),
    (
        "USDC",
        "EUR",
        "daily",
        "log",
        4,
        0.002,
        [
            ("2024-06-05", 0.92),
            ("2024-12-01", 0.95),
            ("2025-04-15", 0.90),
            ("2025-10-01", 0.92),
            ("2026-03-01", 0.94),
            ("2026-07-13", 0.92),
        ],
    ),
    (
        "XRP",
        "EUR",
        "daily",
        "log",
        4,
        0.016,
        [
            ("2025-01-10", 2.10),
            ("2025-02-25", 1.75),
            ("2025-06-01", 2.35),
            ("2025-09-10", 2.00),
            ("2026-01-01", 2.65),
            ("2026-03-01", 2.30),
            ("2026-07-13", 2.50),
        ],
    ),
    (
        "BNB",
        "EUR",
        "daily",
        "log",
        2,
        0.013,
        [
            ("2025-03-01", 320),
            ("2025-06-01", 430),
            ("2025-09-10", 380),
            ("2026-01-01", 520),
            ("2026-02-15", 560),
            ("2026-04-01", 540),
            ("2026-07-13", 560),
        ],
    ),
    (
        "AAPL",
        "EUR",
        "bdays",
        "log",
        2,
        0.006,
        [
            ("2024-02-01", 180),
            ("2024-06-01", 196),
            ("2024-08-01", 200),
            ("2024-12-01", 245),
            ("2025-02-25", 208),
            ("2025-03-01", 220),
            ("2025-06-01", 225),
            ("2025-09-10", 215),
            ("2026-01-01", 250),
            ("2026-03-01", 238),
            ("2026-07-13", 250),
        ],
    ),
    (
        "MSFT",
        "EUR",
        "bdays",
        "log",
        2,
        0.006,
        [
            ("2024-03-01", 340),
            ("2024-08-01", 400),
            ("2024-12-01", 450),
            ("2025-02-25", 400),
            ("2025-05-01", 430),
            ("2025-07-01", 400),
            ("2025-09-10", 440),
            ("2026-01-01", 490),
            ("2026-03-01", 470),
            ("2026-07-13", 510),
        ],
    ),
    (
        "GOOGL",
        "EUR",
        "bdays",
        "log",
        2,
        0.007,
        [
            ("2024-05-01", 130),
            ("2024-12-01", 155),
            ("2025-02-25", 135),
            ("2025-06-01", 145),
            ("2025-09-10", 130),
            ("2026-01-01", 140),
            ("2026-02-01", 125),
            ("2026-04-01", 135),
            ("2026-07-13", 150),
        ],
    ),
    (
        "ASML",
        "EUR",
        "bdays",
        "log",
        2,
        0.007,
        [
            ("2024-09-15", 780),
            ("2024-12-01", 900),
            ("2025-02-25", 820),
            ("2025-06-01", 950),
            ("2025-09-10", 900),
            ("2026-01-01", 1050),
            ("2026-03-01", 1000),
            ("2026-07-13", 1080),
        ],
    ),
    (
        "CW8",
        "EUR",
        "bdays",
        "log",
        2,
        0.004,
        [
            ("2024-01-15", 420),
            ("2024-06-01", 448),
            ("2024-07-16", 450),
            ("2024-08-05", 442),
            ("2024-10-01", 475),
            ("2024-12-20", 505),
            ("2025-02-25", 468),
            ("2025-04-15", 485),
            ("2025-06-01", 480),
            ("2025-09-10", 520),
            ("2025-12-01", 560),
            ("2026-03-01", 590),
            ("2026-05-01", 620),
            ("2026-07-13", 650),
        ],
    ),
    (
        "USD",
        "EUR",
        "bdays",
        "log",
        4,
        0.002,
        [
            ("2024-03-01", 0.92),
            ("2024-12-01", 0.95),
            ("2025-05-01", 0.95),
            ("2025-10-01", 0.93),
            ("2026-07-13", 0.92),
        ],
    ),
    (
        "PM:bitcoin-200k-2025-Yes",
        "USDC",
        "daily",
        "lin",
        4,
        0.006,
        [
            ("2024-10-01", 0.28),
            ("2024-11-15", 0.20),
            ("2024-12-15", 0.10),
            ("2025-01-05", 0.01),
        ],
    ),
    (
        "PM:fed-rate-cut-mar-2025-Yes",
        "USDC",
        "daily",
        "lin",
        4,
        0.006,
        [
            ("2024-10-10", 0.55),
            ("2024-12-01", 0.63),
            ("2025-01-31", 0.72),
            ("2025-03-01", 0.90),
            ("2025-03-20", 1.00),
        ],
    ),
    (
        "PM:senate-control-2026-Yes",
        "USDC",
        "daily",
        "lin",
        4,
        0.006,
        [
            ("2025-11-01", 0.45),
            ("2025-12-15", 0.54),
            ("2026-02-01", 0.62),
            ("2026-04-01", 0.66),
            ("2026-07-13", 0.68),
        ],
    ),
    (
        "PM:eth-etf-inflows-2026-Yes",
        "USDC",
        "daily",
        "lin",
        4,
        0.006,
        [
            ("2026-04-01", 0.40),
            ("2026-05-15", 0.44),
            ("2026-07-13", 0.46),
        ],
    ),
    # Benchmark — intentionally modest so the portfolio stays above it.
    (
        "^GSPC",
        "USD",
        "bdays",
        "log",
        2,
        0.004,
        [
            ("2024-01-05", 4700),
            ("2024-03-15", 5100),
            ("2024-06-01", 5300),
            ("2024-08-05", 5150),
            ("2024-10-01", 5750),
            ("2024-12-20", 6050),
            ("2025-02-25", 5580),
            ("2025-04-15", 5780),
            ("2025-06-15", 6000),
            ("2025-09-10", 5750),
            ("2025-12-01", 6200),
            ("2026-03-01", 6050),
            ("2026-05-01", 6300),
            ("2026-07-13", 6350),
        ],
    ),
]


def interp(p0, p1, t0, t1, t, mode):
    if t1 == t0:
        return p1
    frac = (t - t0) / (t1 - t0)
    if mode == "log":
        return math.exp(math.log(p0) + frac * (math.log(p1) - math.log(p0)))
    return p0 + frac * (p1 - p0)


def gen_series(symbol, freq, mode, dp, sigma, waypoints):
    rng = random.Random(f"demo-{symbol}")
    wps = [(d(ds), float(p)) for ds, p in waypoints]
    wp_dates = {wd for wd, _ in wps}
    start = wps[0][0]
    end = min(END, wps[-1][0]) if wps[-1][0] < END else END
    # Extend the last waypoint flat to END if it stops earlier (open positions).
    end = END if wps[-1][0] >= start else wps[-1][0]

    out = []
    cur = start
    seg = 0
    while cur <= END:
        # advance segment
        while seg < len(wps) - 1 and cur > wps[seg + 1][0]:
            seg += 1
        emit = True
        if freq == "bdays" and cur.weekday() >= 5:
            emit = False
        if emit:
            if cur in wp_dates:
                # exact anchor, no noise
                price = next(p for wd, p in wps if wd == cur)
            else:
                if cur <= wps[-1][0]:
                    p0d, p0 = wps[seg]
                    p1d, p1 = wps[seg + 1] if seg + 1 < len(wps) else wps[seg]
                    price = interp(
                        p0,
                        p1,
                        p0d.toordinal(),
                        p1d.toordinal(),
                        cur.toordinal(),
                        mode,
                    )
                else:
                    price = wps[-1][1]
                if mode == "log":
                    price *= math.exp(rng.gauss(0, sigma))
                else:
                    price += rng.gauss(0, sigma)
                    price = max(0.005, min(0.999, price))
            out.append((cur.isoformat() + "T00:00:00", round(price, dp)))
        cur += timedelta(days=1)

    out.append(("current", round(wps[-1][1], dp)))
    return out


def fmt_price(v, dp):
    s = f"{v:.{dp}f}".rstrip("0").rstrip(".") if dp else f"{v:.0f}"
    return s if s else "0"


lines = [
    "# Product Demo Scenario — Prices",
    "# =================================",
    "# Dense (gap-free) mock price series generated from hand-picked waypoints",
    "# (see scenarios/demo/_gen_prices.py, a throwaway authoring tool — not part",
    "# of runtime). Crypto/USDC/PM = daily; stocks/CW8/USD/^GSPC = business days.",
    "# The portfolio is engineered to beat the S&P 500 (^GSPC) benchmark at all",
    "# times while still showing realistic draw-downs and rallies. Transaction",
    "# anchors are pinned verbatim; between them prices interpolate with small",
    "# deterministic noise (fixed RNG seed → reproducible).",
    "#",
    "# ^GSPC is not held; it powers the S&P 500 reference line via",
    "# /pnl/benchmark-series when mock mode is enabled.",
    "",
    "prices:",
]

for symbol, quote, freq, mode, dp, sigma, wps in ASSETS:
    series = gen_series(symbol, freq, mode, dp, sigma, wps)
    lines.append(f"- asset_symbol: {symbol}")
    lines.append(f"  quote_currency: {quote}")
    lines.append("  entries:")
    for at, price in series:
        lines.append(f"  - at: '{at}'")
        lines.append(f"    price: '{fmt_price(price, dp)}'")

with open(OUT, "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"Wrote {OUT}: {sum(1 for l in lines if l.strip().startswith('- at'))} entries")
