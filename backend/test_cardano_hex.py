#!/usr/bin/env python3
"""Test Cardano address hex conversion."""

from pycardano import Address

# Test address from the seeded data
bech32_address = "addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w"

print(f"Bech32 address: {bech32_address}")

try:
    addr = Address.from_primitive(bech32_address)
    hex_address = addr.to_primitive().hex()
    print(f"Hex address: {hex_address}")
    print(f"Length: {len(hex_address)}")
except Exception as e:
    print(f"Error: {e}")
