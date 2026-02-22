#!/usr/bin/env python3
"""Test the Cardano connector with live API to debug the 400 error."""

import os
import sys

# Add backend to path
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from backend.connectors.onchain.connector_cardano_scan import ConnectorCardanoScan

# Test address
wallet_address = "addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w"
api_key = os.getenv("CARDANOSCAN_API_KEY", "1ca801b8-33d1-43b3-b512-74b377b0820a")

print(f"Testing Cardano connector...")
print(f"Wallet: {wallet_address[:20]}...")
print(f"API Key: {api_key[:10]}...")

# Create connector
connector = ConnectorCardanoScan(
    wallet_address=wallet_address,
    account_id=1,
    connector_id=1,
    config={"api_key": api_key}
)

# Test hex conversion
hex_address = connector._bech32_to_hex(wallet_address)
print(f"\nBech32: {wallet_address}")
print(f"Hex: {hex_address}")
print(f"Hex length: {len(hex_address)}")

# Try to fetch one transaction
print(f"\nFetching transactions...")
try:
    count = 0
    for tx in connector.yield_raws():
        print(f"✅ Got transaction: {tx.get('hash', 'N/A')[:20]}...")
        count += 1
        if count >= 1:
            break
    print(f"Success! Fetched {count} transaction(s)")
except Exception as e:
    print(f"❌ Error: {e}")
    import traceback
    traceback.print_exc()
