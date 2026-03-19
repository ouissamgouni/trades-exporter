#!/usr/bin/env python3
"""
Backfill missing historical prices for assets with transactions.

For each asset with transactions, identifies missing daily prices
and fetches them using the best available price getter.

Strategy:
1. Yahoo Direct: Bulk fetch via chart API (single request per asset for full range)
2. CoinGecko: market_chart/range endpoint for crypto (rate limited to 10-30 req/min)
3. Marketstack: eod endpoint with date range
4. Alphavantage: TIME_SERIES_DAILY (25 req/day free)

Usage:
    PYTHONPATH=/path/to/trades-exporter \\
    ALPHAVANTAGE_API_KEY=xxx MARKETSTACK_API_KEY=xxx \\
    .venv/bin/python scripts/backfill_prices.py [--dry-run] [--asset SYMBOL]
"""

import os
import sys
import time
import json
import requests
from datetime import datetime, timedelta, date
from collections import defaultdict
from sqlalchemy import create_engine, text

DRY_RUN = "--dry-run" in sys.argv
SINGLE_ASSET = None
for i, arg in enumerate(sys.argv):
    if arg == "--asset" and i + 1 < len(sys.argv):
        SINGLE_ASSET = sys.argv[i + 1]

DB_URL = "postgresql://trades_user:trades_password@localhost:5432/trades_db_dev"
TODAY = date(2026, 3, 6)
SOURCE = "backfill"

# API configs
YAHOO_CHART_BASE = "https://query2.finance.yahoo.com/v8/finance/chart"
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
COINGECKO_BASE = "https://api.coingecko.com/api/v3"
MARKETSTACK_BASE = "http://api.marketstack.com/v1"
ALPHAVANTAGE_BASE = "https://www.alphavantage.co/query"

MARKETSTACK_KEY = os.environ.get("MARKETSTACK_API_KEY", "***REMOVED_MARKETSTACK_KEY***")
ALPHAVANTAGE_KEY = os.environ.get("ALPHAVANTAGE_API_KEY", "***REMOVED_ALPHAVANTAGE_KEY***")

session = requests.Session()
session.headers.update(YAHOO_HEADERS)


def fetch_yahoo_range(ticker, start_date, end_date):
    """Fetch daily prices from Yahoo Chart API for a date range. Returns {date: price}."""
    period1 = int(datetime.combine(start_date, datetime.min.time()).timestamp())
    period2 = int(datetime.combine(end_date + timedelta(days=1), datetime.min.time()).timestamp())
    
    try:
        resp = session.get(
            f"{YAHOO_CHART_BASE}/{ticker}",
            params={"interval": "1d", "period1": period1, "period2": period2},
            timeout=15
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
        result = data.get("chart", {}).get("result", [])
        if not result:
            return {}
        
        timestamps = result[0].get("timestamp", [])
        quotes = result[0].get("indicators", {}).get("quote", [{}])[0]
        closes = quotes.get("close", [])
        currency = result[0].get("meta", {}).get("currency", "USD")
        
        prices = {}
        for ts, close in zip(timestamps, closes):
            if close is not None and close > 0:
                d = datetime.fromtimestamp(ts).date()
                prices[d] = (float(close), currency)
        return prices
    except Exception as e:
        print(f"    Yahoo error for {ticker}: {e}")
        return {}


coingecko_rate_limit_until = 0  # global timestamp

def fetch_coingecko_range(coin_id, start_date, end_date, vs_currency="eur", _retries=0):
    """Fetch daily prices from CoinGecko market_chart/range. Returns {date: price}."""
    global coingecko_rate_limit_until
    
    # Respect cooldown from prior rate limit
    now = time.time()
    if now < coingecko_rate_limit_until:
        wait = coingecko_rate_limit_until - now
        if wait > 0:
            print(f"    CoinGecko cooldown: {wait:.0f}s remaining...")
            time.sleep(wait)
    
    from_ts = int(datetime.combine(start_date, datetime.min.time()).timestamp())
    to_ts = int(datetime.combine(end_date + timedelta(days=1), datetime.min.time()).timestamp())
    
    try:
        resp = session.get(
            f"{COINGECKO_BASE}/coins/{coin_id}/market_chart/range",
            params={"vs_currency": vs_currency, "from": from_ts, "to": to_ts},
            timeout=15
        )
        if resp.status_code == 429:
            if _retries >= 2:
                print(f"    CoinGecko rate limited for {coin_id}, max retries reached")
                return {}
            wait = 35
            print(f"    CoinGecko rate limited for {coin_id}, waiting {wait}s (retry {_retries+1}/2)...")
            coingecko_rate_limit_until = time.time() + wait
            time.sleep(wait)
            return fetch_coingecko_range(coin_id, start_date, end_date, vs_currency, _retries + 1)
        if resp.status_code != 200:
            return {}
        data = resp.json()
        price_points = data.get("prices", [])
        
        # CoinGecko returns [timestamp_ms, price] pairs
        prices = {}
        for ts_ms, price in price_points:
            d = datetime.fromtimestamp(ts_ms / 1000).date()
            if price and price > 0:
                prices[d] = (float(price), vs_currency.upper())
        return prices
    except Exception as e:
        print(f"    CoinGecko error for {coin_id}: {e}")
        return {}


def fetch_marketstack_range(ticker, start_date, end_date):
    """Fetch daily prices from Marketstack eod. Returns {date: price}."""
    try:
        resp = session.get(
            f"{MARKETSTACK_BASE}/eod",
            params={
                "access_key": MARKETSTACK_KEY,
                "symbols": ticker,
                "date_from": start_date.isoformat(),
                "date_to": end_date.isoformat(),
                "limit": 1000,
            },
            timeout=15
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
        
        prices = {}
        for item in data.get("data", []):
            d = datetime.strptime(item["date"][:10], "%Y-%m-%d").date()
            close = item.get("close")
            if close and close > 0:
                prices[d] = (float(close), "USD")
        return prices
    except Exception as e:
        print(f"    Marketstack error for {ticker}: {e}")
        return {}


def fetch_alphavantage_daily(ticker):
    """Fetch full daily history from Alphavantage. Returns {date: price}."""
    try:
        resp = session.get(
            ALPHAVANTAGE_BASE,
            params={
                "function": "TIME_SERIES_DAILY",
                "symbol": ticker,
                "outputsize": "full",
                "apikey": ALPHAVANTAGE_KEY,
            },
            timeout=15
        )
        if resp.status_code != 200:
            return {}
        data = resp.json()
        
        ts = data.get("Time Series (Daily)", {})
        prices = {}
        for date_str, vals in ts.items():
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
            close = float(vals.get("4. close", 0))
            if close > 0:
                prices[d] = (close, "USD")
        return prices
    except Exception as e:
        print(f"    Alphavantage error for {ticker}: {e}")
        return {}


def main():
    engine = create_engine(DB_URL)

    with engine.connect() as conn:
        print("=" * 80)
        print("  PRICE BACKFILL")
        print("=" * 80)
        if DRY_RUN:
            print("  *** DRY RUN — no data will be inserted ***")

        # 1. Get assets with transactions and their missing price dates
        asset_filter = ""
        if SINGLE_ASSET:
            asset_filter = f"AND a.symbol = '{SINGLE_ASSET}'"
        
        # Get oldest tx per asset
        oldest = conn.execute(text(f"""
            SELECT a.asset_id, a.symbol, a.price_type,
                   MIN(nt.date_time)::date as oldest_tx
            FROM normalized_transactions nt
            JOIN assets a ON a.asset_id = nt.asset_id
            {asset_filter}
            GROUP BY a.asset_id, a.symbol, a.price_type
            ORDER BY a.symbol
        """)).fetchall()

        print(f"\n  Assets with transactions: {len(oldest)}")

        # Get existing price dates per asset
        existing = conn.execute(text("""
            SELECT asset_id, DATE(snapshot_time) as d
            FROM price_snapshots
        """)).fetchall()
        existing_dates = defaultdict(set)
        for row in existing:
            existing_dates[row[0]].add(row[1])

        # Get price getters per asset (ordered by priority)
        getters = conn.execute(text(f"""
            SELECT a.asset_id, a.symbol, apg.price_getter, apg.external_id, 
                   apg.priority, apg.params
            FROM assets a
            JOIN asset_price_getters apg ON apg.asset_id = a.asset_id
            WHERE apg.enabled = true
            {asset_filter}
            ORDER BY a.symbol, apg.priority
        """)).fetchall()
        
        getter_map = defaultdict(list)
        for row in getters:
            getter_map[row[0]].append({
                "getter": row[2],
                "external_id": row[3],
                "priority": row[4],
                "params": row[5],
            })

        # Get EUR asset_id for quote
        eur_id = conn.execute(text("SELECT asset_id FROM assets WHERE symbol='EUR'")).scalar()
        
        # Get USD asset_id if exists
        usd_id = conn.execute(text("SELECT asset_id FROM assets WHERE symbol='USD'")).scalar()

        print(f"  EUR asset_id: {eur_id}, USD asset_id: {usd_id}")
        print()

        # 2. For each asset, find missing dates and fetch
        total_inserted = 0
        total_skipped = 0
        total_failed = 0
        asset_results = []

        coingecko_requests = 0
        alphavantage_requests = 0

        for asset_id, symbol, price_type, oldest_tx in oldest:
            is_crypto = price_type == "crypto"
            is_fiat = price_type == "fiat"
            
            if is_fiat:
                print(f"  ⊘ {symbol}: fiat — skipping")
                continue

            start_date = oldest_tx
            end_date = TODAY

            # Find missing dates
            all_dates = set()
            d = start_date
            while d <= end_date:
                if is_crypto or d.weekday() < 5:  # Business days for stocks
                    all_dates.add(d)
                d += timedelta(days=1)

            have_dates = existing_dates.get(asset_id, set())
            missing = sorted(all_dates - have_dates)

            if not missing:
                print(f"  ✓ {symbol}: no missing prices")
                asset_results.append((symbol, 0, 0, 0, "complete"))
                continue

            print(f"\n  → {symbol} ({price_type}): {len(missing)} missing days "
                  f"({missing[0]} to {missing[-1]})")

            # Get the best getter for this asset
            asset_getters = getter_map.get(asset_id, [])
            if not asset_getters:
                print(f"    ✗ No price getters configured!")
                asset_results.append((symbol, len(missing), 0, len(missing), "no_getter"))
                total_failed += len(missing)
                continue

            # Try each getter — prefer yahoo_direct first (fastest, no rate limit)
            # then coingecko, then marketstack, then alphavantage
            GETTER_ORDER = ["yahoo_direct", "coingecko", "marketstack", "alphavantage", "forex", "datareader"]
            sorted_getters = sorted(asset_getters, key=lambda g: (
                GETTER_ORDER.index(g["getter"]) if g["getter"] in GETTER_ORDER else 99
            ))
            fetched_prices = {}
            getter_used = None

            for g in sorted_getters:
                gname = g["getter"]
                ext_id = g["external_id"]
                params = g["params"] or {}

                if isinstance(params, str):
                    try:
                        params = json.loads(params)
                    except:
                        params = {}

                if gname == "yahoo_direct":
                    ticker = ext_id or symbol
                    print(f"    Trying yahoo_direct ({ticker})...")
                    fetched_prices = fetch_yahoo_range(ticker, missing[0], missing[-1])
                    if fetched_prices:
                        getter_used = "yahoo_direct"
                        break

                elif gname == "coingecko":
                    coin_id = ext_id or symbol.lower()
                    print(f"    Trying coingecko ({coin_id})...")
                    fetched_prices = fetch_coingecko_range(coin_id, missing[0], missing[-1])
                    coingecko_requests += 1
                    if fetched_prices:
                        getter_used = "coingecko"
                        break

                elif gname == "marketstack":
                    ticker = ext_id or symbol
                    print(f"    Trying marketstack ({ticker})...")
                    fetched_prices = fetch_marketstack_range(ticker, missing[0], missing[-1])
                    if fetched_prices:
                        getter_used = "marketstack"
                        break

                elif gname == "alphavantage":
                    ticker = ext_id or symbol
                    print(f"    Trying alphavantage ({ticker})...")
                    # Very limited: 25 req/day
                    if alphavantage_requests >= 24:
                        print(f"    Alphavantage daily limit reached, skipping")
                        continue
                    fetched_prices = fetch_alphavantage_daily(ticker)
                    alphavantage_requests += 1
                    if fetched_prices:
                        getter_used = "alphavantage"
                        break

                elif gname == "forex":
                    # Forex usually just needs 1.0 for EUR/EUR
                    print(f"    Forex getter — skipping for backfill")
                    continue
                    
                elif gname == "datareader":
                    # Datareader (Stooq) is dead — skip
                    continue

            if not fetched_prices:
                print(f"    ✗ All getters failed!")
                asset_results.append((symbol, len(missing), 0, len(missing), "all_failed"))
                total_failed += len(missing)
                continue

            # Filter to only missing dates
            insertable = []
            for d in missing:
                if d in fetched_prices:
                    price, currency = fetched_prices[d]
                    # Determine quote_asset_id (EUR or USD based on source)
                    quote_id = eur_id if currency == "EUR" else (usd_id if currency == "USD" else eur_id)
                    insertable.append({
                        "asset_id": asset_id,
                        "quote_asset_id": quote_id or eur_id,
                        "price": price,
                        "snapshot_time": datetime.combine(d, datetime.min.time()),
                        "source": f"backfill_{getter_used}",
                    })

            filled = len(insertable)
            still_missing = len(missing) - filled
            print(f"    ✓ {getter_used}: fetched {len(fetched_prices)} prices, "
                  f"{filled} fill missing days, {still_missing} still missing")

            if not DRY_RUN and insertable:
                batch_size = 200
                for i in range(0, len(insertable), batch_size):
                    batch = insertable[i:i + batch_size]
                    for rec in batch:
                        try:
                            conn.execute(text("""
                                INSERT INTO price_snapshots 
                                    (asset_id, quote_asset_id, price, snapshot_time, source, created_at)
                                VALUES (:asset_id, :quote_asset_id, :price, :snapshot_time, :source, NOW())
                                ON CONFLICT (asset_id, quote_asset_id, snapshot_time, source) DO NOTHING
                            """), rec)
                        except Exception as e:
                            conn.rollback()
                            # Try without ON CONFLICT (check exists first)
                            try:
                                exists = conn.execute(text("""
                                    SELECT 1 FROM price_snapshots 
                                    WHERE asset_id = :asset_id 
                                    AND DATE(snapshot_time) = DATE(:snapshot_time)
                                """), rec).fetchone()
                                if not exists:
                                    conn.execute(text("""
                                        INSERT INTO price_snapshots 
                                            (asset_id, quote_asset_id, price, snapshot_time, source, created_at)
                                        VALUES (:asset_id, :quote_asset_id, :price, :snapshot_time, :source, NOW())
                                    """), rec)
                            except Exception as e2:
                                conn.rollback()
                                still_missing += 1
                                filled -= 1
                    conn.commit()

            total_inserted += filled
            total_skipped += still_missing
            asset_results.append((symbol, len(missing), filled, still_missing, getter_used))

        # 3. Summary
        print("\n" + "=" * 80)
        print("  BACKFILL SUMMARY")
        print("=" * 80)
        print(f"\n  {'Asset':<20} {'Needed':>8} {'Filled':>8} {'Missing':>8} {'Getter':<15}")
        print("  " + "─" * 70)
        
        for sym, needed, filled, still_miss, getter in sorted(asset_results, key=lambda x: -x[3]):
            indicator = "✓" if still_miss == 0 else ("⚠" if filled > 0 else "✗")
            print(f"  {indicator} {sym:<18} {needed:>8} {filled:>8} {still_miss:>8} {getter:<15}")

        print(f"\n  Total days filled:   {total_inserted:,}")
        print(f"  Total days missing:  {total_skipped + total_failed:,}")
        
        if DRY_RUN:
            print("\n  *** DRY RUN — nothing was inserted ***")
        else:
            final_count = conn.execute(text("SELECT COUNT(*) FROM price_snapshots")).scalar()
            print(f"  price_snapshots total: {final_count:,}")


if __name__ == "__main__":
    main()
