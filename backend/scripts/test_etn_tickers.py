#!/usr/bin/env python3
"""Try various Yahoo ticker formats for the 4 failed crypto ETNs."""

import requests
import time

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
})

BASE_URL = "https://query2.finance.yahoo.com/v8/finance/chart"

# The 4 failed crypto ETNs and their underlying
ETNS = {
    "CSDA": "21Shares Cardano ETP",
    "SLNC": "21Shares Solana ETP",
    "WBIT": "ETC Group Physical Bitcoin",
    "WETH": "ETC Group Physical Ethereum",
}

# All German exchange suffixes to try
SUFFIXES = [".DE", ".F", ".DU", ".MU", ".SG", ".HM", ".BE", ".HA", ".XETRA", ""]

def test_ticker(ticker):
    """Try a single ticker, return (success, price_or_error)."""
    try:
        resp = session.get(f"{BASE_URL}/{ticker}", params={"range": "5d", "interval": "1d"}, timeout=10)
        data = resp.json()
        if "chart" in data and data["chart"].get("result"):
            meta = data["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice", 0)
            currency = meta.get("currency", "?")
            return True, f"{price} {currency}"
        error = data.get("chart", {}).get("error", {}).get("description", "unknown")
        return False, error
    except Exception as e:
        return False, str(e)

print("Testing Yahoo ticker formats for the 4 failed crypto ETNs\n")
for base, name in ETNS.items():
    print(f"=== {base} ({name}) ===")
    for suffix in SUFFIXES:
        ticker = f"{base}{suffix}"
        ok, result = test_ticker(ticker)
        status = "OK" if ok else "FAIL"
        print(f"  {ticker:20s} {status:4s}  {result}")
        time.sleep(0.3)
    print()

# Also try search API to find valid tickers
print("\n=== Yahoo Search API ===")
SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
for base, name in ETNS.items():
    try:
        resp = session.get(SEARCH_URL, params={"q": base, "quotesCount": 10, "newsCount": 0}, timeout=10)
        data = resp.json()
        quotes = data.get("quotes", [])
        print(f"\n{base} search results ({len(quotes)}):")
        for q in quotes:
            sym = q.get("symbol", "?")
            exch = q.get("exchange", "?")
            name_q = q.get("shortname", q.get("longname", "?"))
            qtype = q.get("quoteType", "?")
            print(f"  {sym:25s} {exch:10s} {qtype:10s} {name_q}")
    except Exception as e:
        print(f"  {base}: search failed: {e}")
    time.sleep(0.5)
