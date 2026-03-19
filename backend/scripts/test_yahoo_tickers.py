"""Test Yahoo tickers that might need alternate IDs."""
import requests, time

BASE = "https://query2.finance.yahoo.com/v8/finance/chart"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}

# Crypto ETNs - try different suffixes
TICKERS = [
    # CSDA (Cardano ETN) - various suffixes
    "CSDA.DE", "CSDA.F", "CSDA.DU", "CSDA.MU", "CSDA.SG",
    # WBIT (Bitcoin ETN)
    "WBIT.DE", "WBIT.F", "WBIT.DU", "WBIT.MU", "WBIT.SG",
    # WETH (Ethereum ETN)
    "WETH.DE", "WETH.F", "WETH.DU", "WETH.MU", "WETH.SG",
    # SLNC (Solana ETN)
    "SLNC.DE", "SLNC.F", "SLNC.DU", "SLNC.MU", "SLNC.SG",
    # Other problematic ones
    "500.PA", "SP5.PA", "ENRG.PA", "LOGS.DE",
    # Funds
    "0P00007YD4",  # Pictet Water
    "LU0124384867",  # as ISIN
]

print(f"{'Ticker':<18s} {'Status':<8s} {'Price':>10s} {'Currency':<6s}")
print("-" * 50)

for ticker in TICKERS:
    try:
        r = requests.get(f"{BASE}/{ticker}?interval=1d&range=5d", headers=HEADERS, timeout=10)
        if r.status_code == 200:
            d = r.json()
            result = d.get("chart", {}).get("result")
            if result:
                meta = result[0]["meta"]
                price = meta.get("regularMarketPrice", 0)
                currency = meta.get("currency", "?")
                print(f"{ticker:<18s} {'OK':<8s} {price:>10.4f} {currency:<6s}")
            else:
                err_desc = d.get("chart", {}).get("error", {}).get("description", "no result")
                print(f"{ticker:<18s} {'NODATA':<8s} {'':>10s} {'':6s} {err_desc[:40]}")
        elif r.status_code == 404:
            print(f"{ticker:<18s} {'404':<8s}")
        else:
            print(f"{ticker:<18s} {str(r.status_code):<8s}")
    except Exception as e:
        print(f"{ticker:<18s} {'ERROR':<8s} {str(e)[:40]}")
    time.sleep(1)
