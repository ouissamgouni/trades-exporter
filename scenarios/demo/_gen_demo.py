#!/usr/bin/env python3
"""THROWAWAY demo-data generator (delete after use).

Reads REAL price series dumped from the dev DB (/tmp/demo_series2.csv) and
emits scenarios/demo/{prices,transactions,positions}.yaml with:
  - real market variance/frequency (fixes "too sharp / fake looking" charts),
  - a real S&P-500 shape for the ^GSPC benchmark line (reuses PE500.PA),
  - a crypto-tilted, profit-taking narrative engineered so the portfolio ROI
    line ENDS above the S&P benchmark while staying bounded/realistic,
  - a balanced best/worst breakdown (several winners AND several losers, no
    single dominator),
  - RANDOMIZED (seeded) investment sizes so real dev totals are not exposed.

Run:  python scenarios/demo/_gen_demo.py
"""

from __future__ import annotations

import csv
import random
from datetime import date, datetime, timedelta
from decimal import Decimal, getcontext
from pathlib import Path

getcontext().prec = 28

HERE = Path(__file__).parent
CSV = Path("/tmp/demo_series2.csv")
START = date(2024, 1, 5)
END = date(2026, 7, 13)
RNG = random.Random("demo-portfolio-v2")

# demo symbol -> (dev series key in CSV, output quote label, price_type)
MAP = {
    "BTC": ("BTC", "EUR", "crypto"),
    "ETH": ("ETH", "EUR", "crypto"),
    "SOL": ("SOL", "EUR", "crypto"),
    "XRP": ("XRP", "EUR", "crypto"),
    "USDC": ("USDC", "EUR", "crypto"),
    "AAPL": ("AAPL", "EUR", "stock"),
    "MSFT": ("MSFT", "EUR", "stock"),
    "GOOGL": ("GOOGL", "EUR", "stock"),
    "GOLD": ("EGLN.L", "EUR", "stock"),
    "CW8": ("MWRD.PA", "EUR", "stock"),
    "^GSPC": ("PE500.PA", "EUR", "stock"),
}


def load_series() -> dict[str, list[tuple[date, Decimal]]]:
    raw: dict[str, list[tuple[date, Decimal]]] = {}
    with open(CSV, newline="") as f:
        for row in csv.reader(f):
            if len(row) < 4:
                continue
            sym, _quote, d, p = row[0], row[1], row[2], row[3]
            raw.setdefault(sym, []).append((date.fromisoformat(d), Decimal(p)))
    for s in raw:
        raw[s].sort(key=lambda t: t[0])
    return raw


DEV = load_series()


def dev_key(sym: str) -> str:
    return MAP[sym][0]


def series_for(sym: str) -> list[tuple[date, Decimal]]:
    return DEV[dev_key(sym)]


def price_on(sym: str, d: date) -> Decimal:
    """LOCF lookup: last known price on/before d (or first if before start)."""
    s = series_for(sym)
    lo, hi, ans = 0, len(s) - 1, s[0][1]
    for dd, pp in s:
        if dd <= d:
            ans = pp
        else:
            break
    return ans


def end_price(sym: str) -> Decimal:
    return series_for(sym)[-1][1]


def start_price(sym: str) -> Decimal:
    return price_on(sym, START)


# ---------------------------------------------------------------------------
# Portfolio spec: invested EUR (pre-jitter), profit-take plan.
# Winner-tilted so realized+unrealized beats the +55% S&P path.
# ---------------------------------------------------------------------------
def jit(x: float, pct: float = 0.14) -> Decimal:
    """Randomize an amount +/- pct (seeded) so dev totals are not exposed."""
    return Decimal(str(round(x * (1 + RNG.uniform(-pct, pct)), 2)))


# Each asset: buys [(date, invest_eur)], sells [(date, frac_of_bought_qty)]
# account is the primary trading account for that asset.
#
# Strategy: a diversified investor whose portfolio beats the S&P by a MODEST
# end-margin, driven by real stock / index / gold winners. All price series are
# REAL (dev DB + Yahoo history), so the ROI line reflects genuine 2024->2026
# market moves. Winners, ranked by end P&L (the "best" list):
#   GOOGL Alphabet (+150%)  >  CW8 MSCI World (+53%)  >  BTC Bitcoin (+53%, small
#   early weight)  >  GOLD iShares Physical Gold (+88%, small weight keeps its
#   P&L under BTC). AAPL (+76%) is a small extra winner; MSFT (~flat) rounds the
#   middle.
# Crypto is deliberately reduced and lands on the "worst" list: XRP / ETH / SOL
# are bought NEAR THEIR mid-2025 PEAKS (a realistic FOMO chase) so they end deep
# in the red -- XRP is the single biggest LOSER.
#
# NB on the ROI-line peak: Alphabet's real run to +184% (May 2026) vs the S&P's
# +35% at that date means ANY meaningful GOOGL position leads the S&P by ~+40pp
# mid-2026 -- this Alphabet-vs-S&P divergence (not crypto) sets the floor for
# the line's peak. Early-BTC is capped at ~8.5k so its 2025 crypto hump stays
# below that Alphabet floor rather than adding a second, higher spike.
SPEC = {
    # --- Winners, ranked by end P&L: GOOGL > CW8 > BTC > GOLD ---
    # NB: CW8 (a low-volatility index fund) is the earliest buy so the ROI-line
    # rebase anchor (first point) sits on a calm position rather than a spiky
    # asset -- a big day-1 jump would otherwise be subtracted from the whole
    # line by the rebase-to-first-point.
    "CW8": {
        "acct": "Linxea Vie",
        "buys": [("2024-01-09", 9500), ("2024-06-03", 3000)],
        "sells": [],
    },
    "GOOGL": {
        "acct": "Degiro",
        "buys": [("2024-02-01", 8500), ("2024-09-02", 2000)],
        "sells": [],
    },
    "BTC": {
        "acct": "Binance",
        "buys": [("2024-01-16", 8500)],
        "sells": [],
    },
    "GOLD": {
        "acct": "Degiro",
        "buys": [("2024-02-01", 2200), ("2024-09-02", 900)],
        "sells": [],
    },
    # --- Modest extra positions ---
    "AAPL": {"acct": "Degiro", "buys": [("2024-02-01", 700)], "sells": []},
    "MSFT": {"acct": "Degiro", "buys": [("2024-03-01", 700)], "sells": []},
    # --- Real losers (bought near their mid-2025 peaks -> end deep in the red) ---
    # XRP is the single biggest loser; ETH and SOL are the other two losers.
    "XRP": {"acct": "Binance", "buys": [("2025-07-21", 3000)], "sells": []},
    "ETH": {
        "acct": "Coinbase",
        "buys": [("2025-08-22", 900)],
        "sells": [],
    },
    "SOL": {
        "acct": "Binance",
        "buys": [("2025-07-01", 700)],
        "sells": [],
    },
}


def d(s: str) -> date:
    return date.fromisoformat(s)


def estimate():
    """Average-cost estimate of end portfolio ROI vs S&P (for tuning)."""
    tot_open = Decimal(0)
    tot_unreal = Decimal(0)
    tot_real = Decimal(0)
    rows = []
    for sym, spec in SPEC.items():
        buy_qty = Decimal(0)
        buy_cost = Decimal(0)
        for bd, inv in spec["buys"]:
            p = price_on(sym, d(bd))
            q = jit(inv) / p
            buy_qty += q
            buy_cost += q * p
        avg = buy_cost / buy_qty
        sold_qty = Decimal(0)
        realized = Decimal(0)
        for sd, frac in spec["sells"]:
            q = buy_qty * Decimal(str(frac))
            sp = price_on(sym, d(sd))
            realized += q * (sp - avg)
            sold_qty += q
        rem = buy_qty - sold_qty
        open_basis = rem * avg
        unreal = rem * (end_price(sym) - avg)
        tot_open += open_basis
        tot_unreal += unreal
        tot_real += realized
        rows.append(
            (
                sym,
                float(open_basis),
                float(unreal),
                float(realized),
                float((end_price(sym) / avg - 1) * 100),
            )
        )
    # small income: perp gains + PM net (net positive, small)
    income = Decimal("650")
    roi = (tot_unreal + tot_real + income) / tot_open * 100
    sp_ret = (end_price("^GSPC") / start_price("^GSPC") - 1) * 100
    print("== per-asset (open_basis, unreal, realized, asset_ret%) ==")
    for r in sorted(rows, key=lambda x: -x[4]):
        print(
            f"  {r[0]:6} basis={r[1]:9.0f} unreal={r[2]:9.0f} real={r[3]:9.0f} ret={r[4]:6.1f}%"
        )
    print(
        f"\n  open_basis={float(tot_open):.0f}  unreal={float(tot_unreal):.0f}  "
        f"realized={float(tot_real):.0f}  income={float(income):.0f}"
    )
    print(
        f"  >>> portfolio end ROI = {float(roi):.1f}%   S&P = {float(sp_ret):.1f}%   "
        f"margin = {float(roi - sp_ret):+.1f}pp"
    )


def fmt(x: Decimal, dp: int = 18) -> str:
    q = Decimal(1).scaleb(-dp)
    return str(x.quantize(q))


def at(dstr: str, t: str = "T00:00:00") -> str:
    return f"{dstr}{t}"


# ---------------------------------------------------------------------------
# prices.yaml
# ---------------------------------------------------------------------------
def emit_prices() -> None:
    blocks: list[dict] = []

    def real_block(sym: str, quote: str) -> dict:
        pts = [(d, p) for d, p in series_for(sym) if START <= d <= END]
        # ensure START + END anchors (LOCF)
        if not pts or pts[0][0] > START:
            pts.insert(0, (START, price_on(sym, START)))
        if pts[-1][0] < END:
            pts.append((END, pts[-1][1]))
        entries = [{"at": at(d.isoformat()), "price": fmt(p, 8)} for d, p in pts]
        return {"asset_symbol": sym, "quote_currency": quote, "entries": entries}

    for sym in [
        "BTC",
        "ETH",
        "SOL",
        "XRP",
        "USDC",
        "AAPL",
        "MSFT",
        "GOOGL",
        "GOLD",
        "CW8",
        "^GSPC",
    ]:
        blocks.append(real_block(sym, "EUR"))

    # USD fiat (EUR per USD) — gentle monthly walk
    usd_entries = []
    cur = START
    val = 0.915
    while cur <= END:
        val = max(0.88, min(0.96, val + RNG.uniform(-0.006, 0.006)))
        usd_entries.append(
            {"at": at(cur.isoformat()), "price": fmt(Decimal(str(round(val, 4))), 8)}
        )
        cur += timedelta(days=30)
    blocks.append(
        {"asset_symbol": "USD", "quote_currency": "EUR", "entries": usd_entries}
    )

    # Prediction markets (USDC-quoted, 0..1) — plausible monthly paths
    def pm_block(sym, waypoints):
        wp = [(d(ds), Decimal(str(v))) for ds, v in waypoints]
        entries = []
        cur = wp[0][0]
        while cur <= END:
            # piecewise-linear interpolate
            seg = 0
            while seg < len(wp) - 1 and cur > wp[seg + 1][0]:
                seg += 1
            d0, v0 = wp[seg]
            d1, v1 = wp[min(seg + 1, len(wp) - 1)]
            if d1 == d0:
                v = v1
            else:
                frac = Decimal((cur - d0).days) / Decimal((d1 - d0).days)
                v = v0 + frac * (v1 - v0)
            v = max(Decimal(0), min(Decimal(1), v))
            entries.append({"at": at(cur.isoformat()), "price": fmt(v, 4)})
            cur += timedelta(days=15)
        return {"asset_symbol": sym, "quote_currency": "USDC", "entries": entries}

    blocks.append(
        pm_block(
            "PM:bitcoin-200k-2025-Yes",
            [
                ("2024-10-01", 0.28),
                ("2024-12-01", 0.08),
                ("2025-01-05", 0.0),
                ("2026-07-13", 0.0),
            ],
        )
    )
    blocks.append(
        pm_block(
            "PM:fed-rate-cut-mar-2025-Yes",
            [
                ("2024-10-10", 0.55),
                ("2025-01-01", 0.72),
                ("2025-03-20", 1.0),
                ("2026-07-13", 1.0),
            ],
        )
    )
    blocks.append(
        pm_block(
            "PM:senate-control-2026-Yes",
            [("2025-11-01", 0.45), ("2026-02-01", 0.62), ("2026-07-13", 0.70)],
        )
    )
    blocks.append(
        pm_block(
            "PM:eth-etf-inflows-2026-Yes", [("2026-04-01", 0.40), ("2026-07-13", 0.45)]
        )
    )

    _dump(
        "prices.yaml",
        {"prices": blocks},
        header=(
            "# Product Demo Scenario — Prices\n"
            "# =================================\n"
            "# Real market price series (variance + frequency) reused from the local\n"
            "# dev database and relabelled onto the demo tickers; investment sizes are\n"
            "# randomized so real totals are never exposed. ^GSPC reuses a real S&P-500\n"
            "# ETF path and powers the S&P 500 reference line via /pnl/benchmark-series\n"
            "# when mock mode is enabled. Generated by _gen_demo.py (throwaway tool).\n"
        ),
    )


# ---------------------------------------------------------------------------
# transactions.yaml
# ---------------------------------------------------------------------------
_TXID = [0]
_qty_cache: dict[str, Decimal] = {}


def _tid(slug: str) -> str:
    _TXID[0] += 1
    return f"demo_{_TXID[0]:03d}_{slug}"


def _trade(
    acct,
    sym,
    qty,
    direction,
    dstr,
    price,
    fee,
    taxab="unknown",
    quote="EUR",
    ttime="T10:00:00",
    extra=None,
):
    tx = {
        "source": "scenario-demo",
        "source_transaction_id": _tid(
            f"{acct.lower().replace(' ', '')}_{direction}_{sym.lower()}"
        ),
        "account_name": acct,
        "asset_symbol": sym,
        "quantity": fmt(qty),
        "direction": direction,
        "transaction_type": "trade",
        "date_time": at(dstr, ttime),
        "price": fmt(price),
        "price_quote_asset_symbol": quote,
        "fee": fmt(fee),
        "fee_quote_asset_symbol": quote,
        "review_status": "valid",
        "taxability_status": taxab,
        "tags": [{"scenario": "demo"}],
    }
    if extra:
        tx.update(extra)
    return tx


def emit_transactions() -> None:
    # Reseed so jittered quantities reproduce the tuned estimate() exactly
    # (estimate() consumes the same jit() draws from a fresh seed, in SPEC order).
    RNG.seed("demo-portfolio-v2")
    TX: list[dict] = []
    stock = {"AAPL", "MSFT", "GOOGL", "GOLD", "CW8"}

    # ---- spot buys/sells from SPEC ----
    for sym, spec in SPEC.items():
        acct = spec["acct"]
        taxab = "taxable" if sym in stock else "unknown"
        total_qty = Decimal(0)
        for bd, inv in spec["buys"]:
            p = price_on(sym, d(bd))
            q = jit(inv) / p
            total_qty += q
            notional = q * p
            fee = (
                (Decimal("2") + notional * Decimal("0.001"))
                if sym in stock
                else notional * Decimal("0.001")
            )
            TX.append(_trade(acct, sym, q, "inflow", bd, p, fee, taxab))
        for sd, frac in spec["sells"]:
            q = total_qty * Decimal(str(frac))
            p = price_on(sym, d(sd))
            notional = q * p
            fee = (
                (Decimal("2") + notional * Decimal("0.001"))
                if sym in stock
                else notional * Decimal("0.001")
            )
            TX.append(
                _trade(
                    acct,
                    sym,
                    q,
                    "outflow",
                    sd,
                    p,
                    fee,
                    ("taxable" if sym in stock else "unknown"),
                )
            )
        _qty_cache[sym] = total_qty

    # ---- Revolut EUR<->USD FX round trip: intentionally OMITTED ----
    # A partial/closed FX trip leaves idle EUR/USD sitting in cost_basis_in_base
    # (which includes cash at face value), diluting ROI with zero P&L. The demo
    # keeps capital invested instead of parked in cash.

    # ---- Internal transfers (bundles 1..8) ----
    def transfer(slug, acct_out, acct_in, sym, qty, dstr, bundle, ttime="T08:00:00"):
        common = dict(
            source="scenario-demo",
            asset_symbol=sym,
            review_status="valid",
            taxability_status="non_taxable",
            source_from_account=acct_out,
            source_to_account=acct_in,
            bundle_id=bundle,
        )
        TX.append(
            {
                **common,
                "source_transaction_id": _tid(slug + "_out"),
                "account_name": acct_out,
                "quantity": fmt(qty),
                "direction": "outflow",
                "transaction_type": "withdrawal",
                "date_time": at(dstr, ttime),
                "tags": [{"scenario": "demo"}, {"leg_type": "disposed"}],
            }
        )
        TX.append(
            {
                **common,
                "source_transaction_id": _tid(slug + "_in"),
                "account_name": acct_in,
                "quantity": fmt(qty),
                "direction": "inflow",
                "transaction_type": "deposit",
                "date_time": at(dstr, ttime),
                "tags": [{"scenario": "demo"}, {"leg_type": "acquired"}],
            }
        )

    transfer(
        "binance_to_mexc_btc",
        "Binance",
        "MEXC",
        "BTC",
        _qty_cache["BTC"] * Decimal("0.08"),
        "2024-07-15",
        1,
    )
    transfer(
        "binance_to_hl_usdc",
        "Binance",
        "Hyperliquid",
        "USDC",
        Decimal("2000"),
        "2024-06-05",
        2,
        "T10:00:00",
    )
    transfer(
        "coinbase_to_ledger_btc",
        "Coinbase",
        "Ledger Bitcoin",
        "BTC",
        _qty_cache["BTC"] * Decimal("0.25"),
        "2024-10-01",
        3,
        "T07:00:00",
    )
    transfer(
        "coinbase_to_ledger_eth",
        "Coinbase",
        "Ledger Ethereum",
        "ETH",
        _qty_cache["ETH"] * Decimal("0.30"),
        "2025-09-05",
        4,
        "T07:30:00",
    )
    transfer(
        "binance_to_ledger_xrp",
        "Binance",
        "Ledger XRP",
        "XRP",
        _qty_cache["XRP"] * Decimal("0.30"),
        "2025-08-05",
        5,
        "T09:00:00",
    )
    transfer(
        "binance_to_polygon_1",
        "Binance",
        "Ledger Polygon",
        "USDC",
        Decimal("500"),
        "2024-09-25",
        7,
        "T10:00:00",
    )
    transfer(
        "binance_to_polygon_2",
        "Binance",
        "Ledger Polygon",
        "USDC",
        Decimal("400"),
        "2025-10-25",
        8,
        "T10:00:00",
    )

    # ---- Prediction markets (USDC-quoted) ----
    def pm(
        slug,
        sym,
        qty,
        direction,
        dstr,
        price,
        taxab,
        ttype="trade",
        goal=None,
        fee="0.5",
    ):
        tags = [{"scenario": "demo"}]
        if goal:
            tags.append({"goal": goal})
        TX.append(
            {
                "source": "scenario-demo",
                "source_transaction_id": _tid(slug),
                "account_name": "Ledger Polygon",
                "asset_symbol": sym,
                "quantity": fmt(Decimal(str(qty))),
                "direction": direction,
                "transaction_type": ttype,
                "date_time": at(dstr, "T12:00:00"),
                "price": fmt(Decimal(str(price))),
                "price_quote_asset_symbol": "USDC",
                "fee": fmt(Decimal(str(fee))),
                "fee_quote_asset_symbol": "USDC",
                "review_status": "valid",
                "taxability_status": taxab,
                "tags": tags,
            }
        )

    pm(
        "pm_buy_btc200k",
        "PM:bitcoin-200k-2025-Yes",
        300,
        "inflow",
        "2024-10-01",
        0.28,
        "unknown",
        goal="Prediction market — resolves NO (loss)",
    )
    pm(
        "pm_buy_fedcut",
        "PM:fed-rate-cut-mar-2025-Yes",
        400,
        "inflow",
        "2024-10-10",
        0.55,
        "unknown",
        goal="Prediction market — resolves YES (win)",
    )
    pm(
        "pm_resolve_btc200k_loss",
        "PM:bitcoin-200k-2025-Yes",
        300,
        "outflow",
        "2025-01-05",
        0.0,
        "taxable",
        goal="Resolved NO — full loss",
        fee="0.2",
    )
    pm(
        "pm_resolve_fedcut_win",
        "PM:fed-rate-cut-mar-2025-Yes",
        400,
        "outflow",
        "2025-03-20",
        1.0,
        "taxable",
        goal="Resolved YES — full win",
        fee="0.2",
    )
    pm(
        "pm_buy_senate",
        "PM:senate-control-2026-Yes",
        500,
        "inflow",
        "2025-11-01",
        0.45,
        "unknown",
        goal="Prediction market — partially sold later",
    )
    pm(
        "pm_sell_senate_partial",
        "PM:senate-control-2026-Yes",
        200,
        "outflow",
        "2026-02-01",
        0.62,
        "taxable",
        goal="Partial take-profit — 300 open",
        fee="0.3",
    )
    pm(
        "pm_buy_ethetf",
        "PM:eth-etf-inflows-2026-Yes",
        350,
        "inflow",
        "2026-04-01",
        0.40,
        "unknown",
        goal="Prediction market — still open",
    )

    # ---- Hyperliquid perp income (funding + 2 winning closes) ----
    def hl(slug, qty, direction, dstr, ttype, attr, taxab, goal, fee=None):
        tx = {
            "source": "scenario-demo",
            "source_transaction_id": _tid(slug),
            "account_name": "Hyperliquid",
            "asset_symbol": "USDC",
            "quantity": fmt(Decimal(str(qty))),
            "direction": direction,
            "transaction_type": ttype,
            "source_transaction_type": ttype,
            "date_time": at(dstr, "T15:00:00"),
            "price": fmt(Decimal("0.91")),
            "price_quote_asset_symbol": "EUR",
            "review_status": "valid",
            "taxability_status": taxab,
            "source_attributed_asset_symbol": attr,
            "tags": [{"scenario": "demo"}, {"goal": goal}],
        }
        if fee is not None:
            tx["fee"] = fmt(Decimal(str(fee)))
            tx["fee_quote_asset_symbol"] = "USDC"
        return tx

    TX.append(
        hl(
            "hl_perp_close_eth_gain",
            180,
            "inflow",
            "2024-07-10",
            "perp_close",
            "ETH",
            "taxable",
            "ETH perp gain",
        )
    )
    TX.append(
        hl(
            "hl_funding_eth",
            12,
            "inflow",
            "2025-02-01",
            "funding",
            "ETH",
            "taxable",
            "ETH funding income",
        )
    )
    TX.append(
        hl(
            "hl_perp_close_sol_gain",
            220,
            "inflow",
            "2025-05-20",
            "perp_close",
            "SOL",
            "taxable",
            "SOL perp gain",
            fee=2,
        )
    )

    _dump(
        "transactions.yaml",
        {"transactions": TX},
        header=(
            "# Product Demo Scenario — Transactions\n"
            "# =======================================\n"
            "# Crypto-tilted, profit-taking narrative (2024-01 → 2026-07) engineered so\n"
            "# the portfolio ROI line beats the S&P 500 at the end with realistic variance.\n"
            "# Prices trace real market series (see prices.yaml); quantities are randomized\n"
            "# so real totals are never exposed. Generated by _gen_demo.py (throwaway).\n"
        ),
    )
    print(f"\n  emitted {len(TX)} transactions")


# ---------------------------------------------------------------------------
# positions.yaml — tiny, near-even open perps (no ROI drag)
# ---------------------------------------------------------------------------
def emit_positions() -> None:
    eth_end = end_price("ETH")
    btc_end = end_price("BTC")
    positions = [
        {
            "account_name": "Hyperliquid",
            "exchange": "hyperliquid",
            "coin": "ETH",
            "side": "long",
            "status": "open",
            "entry_price": fmt(eth_end * Decimal("0.985"), 2),
            "size": "0.40",
            "margin_currency": "USDC",
            "total_fees": "1.20",
            "opened_at": at("2026-06-15", "T14:00:00"),
        },
        {
            "account_name": "Hyperliquid",
            "exchange": "hyperliquid",
            "coin": "BTC",
            "side": "short",
            "status": "open",
            "entry_price": fmt(btc_end * Decimal("1.01"), 2),
            "size": "0.03",
            "margin_currency": "USDC",
            "total_fees": "1.50",
            "opened_at": at("2026-05-20", "T09:30:00"),
        },
    ]
    _dump(
        "positions.yaml",
        {"positions": positions},
        header=(
            "# Product Demo Scenario — Derivative Positions\n"
            "# ================================================\n"
            "# Small, near-even open perps (negligible ROI impact). Generated by _gen_demo.py.\n"
        ),
    )


def _dump(name: str, data: dict, header: str = "") -> None:
    import yaml

    body = yaml.safe_dump(
        data, sort_keys=False, default_flow_style=False, allow_unicode=True, width=120
    )
    (HERE / name).write_text(header + body)
    print(f"  wrote {name}")


if __name__ == "__main__":
    estimate()
    print()
    emit_prices()
    emit_transactions()
    emit_positions()
