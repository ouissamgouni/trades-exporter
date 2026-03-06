"""Quick test of Yahoo Chart API v8 (direct HTTP, bypasses yfinance crumb)."""
import sys, os, time, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

import requests

BASE = "https://query2.finance.yahoo.com/v8/finance/chart"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

TICKERS = [
    ("PE500.PA", "Euronext Paris ETF"),
    ("AAPL", "US Stock"),
    ("21XJ.DE", "German Exchange ETN"),
    ("AGGU.L", "London Exchange ETF"),
    ("MWRD.PA", "MSCI World PA"),
    ("BTC-USD", "Crypto"),
    ("ERDK.F", "Fund"),
    ("0P0001IMHW.F", "Fund ISIN"),
    ("GUARD.PA", "Defense PA"),
    ("FTNT", "US Stock"),
    ("CSDA.DE", "Crypto ETN DE"),
    ("WBIT.DU", "Crypto ETN DU"),
    ("OKTA", "US Stock"),
]

print("=== Yahoo Chart API v8 (direct HTTP) ===\n")
print(f"{'Ticker':<18s} {'Type':<22s} {'Status':<8s} {'Price':>10s} {'Currency':<6s} {'Hist?'}")
print("-" * 80)

for ticker, desc in TICKERS:
    # Current price
    try:
        r = requests.get(f"{BASE}/{ticker}?interval=1d&range=5d", headers=HEADERS, timeout=10)
        if r.status_code == 200:
            d = r.json()
            result = d.get("chart", {}).get("result")
            if result:
                meta = result[0]["meta"]
                price = meta.get("regularMarketPrice", "N/A")
                currency = meta.get("currency", "?")
                closes = result[0]["indicators"]["quote"][0]["close"]
                has_hist = len([c for c in closes if c is not None]) > 0
                print(f"{ticker:<18s} {desc:<22s} {'OK':<8s} {price:>10.4f} {currency:<6s} {'yes' if has_hist else 'no'}")
            else:
                err = d.get("chart", {}).get("error", {})
                print(f"{ticker:<18s} {desc:<22s} {'NO DATA':<8s} {'':>10s} {'':6s} {err.get('description', '?')[:40]}")
        elif r.status_code == 429:
            print(f"{ticker:<18s} {desc:<22s} {'429':<8s} rate limited, waiting 5s...")
            time.sleep(5)
        else:
            print(f"{ticker:<18s} {desc:<22s} {str(r.status_code):<8s}")
    except Exception as e:
        print(f"{ticker:<18s} {desc:<22s} {'ERROR':<8s} {str(e)[:50]}")

    time.sleep(1.5)

# Test historical with period1/period2 (Jan 15, 2026)
print("\n=== Historical Test (2026-01-15) ===\n")
import datetime
dt = datetime.datetime(2026, 1, 15)
p1 = int((dt - datetime.timedelta(days=5)).timestamp())
p2 = int((dt + datetime.timedelta(days=1)).timestamp())

for ticker, desc in [("PE500.PA", "PA ETF"), ("AAPL", "US"), ("21XJ.DE", "DE"), ("AGGU.L", "L"), ("BTC-USD", "Crypto")]:
    try:
        r = requests.get(f"{BASE}/{ticker}?interval=1d&period1={p1}&period2={p2}", headers=HEADERS, timeout=10)
        if r.status_code == 200:
            d = r.json()
            result = d.get("chart", {}).get("result")
            if result:
                closes = result[0]["indicators"]["quote"][0]["close"]
                valid = [c for c in closes if c is not None]
                if valid:
                    print(f"{ticker:<18s} {desc:<10s} OK  close={valid[-1]:.4f}  points={len(valid)}")
                else:
                    print(f"{ticker:<18s} {desc:<10s} NO VALID CLOSES")
            else:
                print(f"{ticker:<18s} {desc:<10s} NO RESULT")
        else:
            print(f"{ticker:<18s} {desc:<10s} HTTP {r.status_code}")
    except Exception as e:
        print(f"{ticker:<18s} {desc:<10s} ERROR: {e}")
    time.sleep(1.5)

print("\nDone!")
