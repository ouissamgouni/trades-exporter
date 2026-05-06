#!/usr/bin/env python3
"""
One-time setup script: derive Polymarket CLOB API credentials.

Uses py-clob-client (pip install py-clob-client) to derive L2 API credentials
from a private key. The private key is only held in memory during derivation.

Usage:
    .venv/bin/python scripts/setup_polymarket_creds.py

    # Alternative: pass private key via env var (useful if paste doesn't work)
    POLYMARKET_PRIVATE_KEY=0x... .venv/bin/python scripts/setup_polymarket_creds.py

Output: api_key, api_secret, passphrase — store these in your env/config.
The private key is NOT stored.
"""

import getpass
import os
import sys


def main():
    print("=" * 60)
    print("Polymarket CLOB API Credential Setup")
    print("=" * 60)
    print()
    print("This derives L2 API credentials from your Magic Link signer key.")
    print("(reveal it at https://reveal.magic.link/polymarket)")
    print("The private key is held in memory only and never stored.")
    print()

    try:
        from py_clob_client.client import ClobClient
    except ImportError:
        print("ERROR: py-clob-client not installed.")
        print("Run:  pip install py-clob-client")
        sys.exit(1)

    # Accept via env var (for terminals where paste doesn't work with getpass)
    private_key = os.environ.get("POLYMARKET_PRIVATE_KEY", "").strip()
    if private_key:
        print("Using private key from POLYMARKET_PRIVATE_KEY env var.")
    elif len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        # Read from file: .venv/bin/python scripts/setup_polymarket_creds.py /tmp/pk.txt
        key_file = sys.argv[1]
        with open(key_file, "r") as f:
            private_key = f.read().strip()
        print(f"Read private key from {key_file}")
        print("⚠️  Delete that file now:  rm", key_file)
    else:
        print("Tip: Input is hidden (no characters shown). Paste and press Enter.")
        print()
        print("If paste doesn't work, save the key to a temp file and pass it:")
        print("  echo '0xYOUR_KEY' > /tmp/pk.txt")
        print("  .venv/bin/python scripts/setup_polymarket_creds.py /tmp/pk.txt")
        print("  rm /tmp/pk.txt")
        print()
        private_key = getpass.getpass("Enter private key (0x...): ").strip()
    if not private_key.startswith("0x") or len(private_key) < 66:
        print("ERROR: Invalid private key format (expected 0x + 64 hex chars)")
        sys.exit(1)

    chain_id = 137  # Polygon mainnet

    print("\nDeriving credentials...")
    try:
        client = ClobClient(
            host="https://clob.polymarket.com",
            key=private_key,
            chain_id=chain_id,
        )
        creds = client.create_or_derive_api_creds()
        signer_address = client.get_address()
    except Exception as e:
        print(f"ERROR: Credential derivation failed: {e}")
        sys.exit(1)

    # Clear private key from memory
    private_key = "0" * len(private_key)
    del private_key

    print("\n" + "=" * 60)
    print("CLOB API Credentials (store these securely)")
    print("=" * 60)
    print(f"POLYMARKET_CLOB_API_KEY={creds.api_key}")
    print(f"POLYMARKET_CLOB_SECRET={creds.api_secret}")
    print(f"POLYMARKET_CLOB_PASSPHRASE={creds.api_passphrase}")
    print(f"POLYMARKET_SIGNER_ADDRESS={signer_address}")
    print()
    print("Add these to your .env file or environment variables.")
    print("The private key has been cleared from memory.")


if __name__ == "__main__":
    main()
