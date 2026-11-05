"""
OnChainAddressLookupService - Look up missing from/to addresses via Ankr JSON-RPC.

Resolves transaction sender/receiver from a tx hash (eth_getTransactionByHash)
when CEX APIs don't provide them.
"""

import os
import time
from typing import Any, Dict, Optional, Tuple

import requests

from backend.config.loader import configure_logging

log = configure_logging("onchain_address_lookup")

ANKR_RPC_BASE_URL = "https://rpc.ankr.com"

# Network name aliases → Ankr RPC chain path
NETWORK_TO_ANKR_CHAIN: Dict[str, str] = {
    "bsc": "bsc",
    "bep20": "bsc",
    "bnb": "bsc",
    "bnb smart chain": "bsc",
    "binance smart chain": "bsc",
    "bsc-bep20": "bsc",
    "arbitrum": "arbitrum",
    "arb": "arbitrum",
    "arb1": "arbitrum",
    "arbitrum one": "arbitrum",
}


class OnChainAddressLookupService:
    """
    Service to look up transaction sender/receiver addresses via Ankr RPC.

    - In-memory cache to avoid duplicate calls for the same tx hash
    - Retry with exponential backoff
    - Graceful degradation (returns None on failure, never raises)
    """

    def __init__(
        self,
        request_delay: float = 0.2,
        max_retries: int = 3,
    ):
        self.request_delay = request_delay
        self.max_retries = max_retries
        self.api_key = os.getenv("ANKR_API_KEY")
        # Cache: tx_hash → (from_address, to_address)
        self._cache: Dict[str, Tuple[Optional[str], Optional[str]]] = {}

    def lookup_address(
        self,
        network: str,
        tx_hash: str,
        direction: str,
    ) -> Optional[str]:
        """
        Return the sender (inflow) or recipient (outflow) of an on-chain tx,
        or None if the lookup fails or the network is unsupported.
        """
        if not tx_hash or not network:
            return None

        if not self.api_key:
            log.warning("ANKR_API_KEY not configured — skipping address lookup")
            return None

        chain = NETWORK_TO_ANKR_CHAIN.get(network.lower().strip())
        if not chain:
            log.debug(f"Unsupported network for address lookup: {network}")
            return None

        if tx_hash not in self._cache:
            # Cached even when None, to avoid re-querying failed lookups
            self._cache[tx_hash] = self._lookup_tx(chain, tx_hash)

        from_addr, to_addr = self._cache[tx_hash]
        return from_addr if direction == "inflow" else to_addr

    def _lookup_tx(self, chain: str, tx_hash: str) -> Tuple[Optional[str], Optional[str]]:
        url = f"{ANKR_RPC_BASE_URL}/{chain}/{self.api_key}"
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getTransactionByHash",
            "params": [tx_hash],
        }
        data = self._safe_request(url, payload)
        tx = (data or {}).get("result")
        if not isinstance(tx, dict):
            return None, None

        from_addr = (tx.get("from") or "").lower() or None
        to_addr = (tx.get("to") or "").lower() or None
        log.debug(f"Ankr tx {tx_hash[:16]}… ({chain}) → from={from_addr}, to={to_addr}")
        return from_addr, to_addr

    def _safe_request(self, url: str, payload: Dict[str, Any]) -> Optional[Dict]:
        """POST with retry/backoff; returns parsed JSON or None on failure."""
        delay = self.request_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.post(url, json=payload, timeout=30)

                if response.status_code == 429 or response.status_code >= 400:
                    log.warning(
                        f"HTTP {response.status_code} on attempt {attempt}/{self.max_retries}: "
                        f"{response.text[:200]}"
                    )
                    delay *= 2
                    continue

                data = response.json()
                if isinstance(data, dict) and data.get("error"):
                    log.warning(f"RPC error on attempt {attempt}: {data['error']}")
                    delay *= 2
                    continue
                return data

            except Exception as e:
                log.warning(f"Lookup error (attempt {attempt}/{self.max_retries}): {e}")
                delay *= 2
                continue

        log.warning(f"Address lookup failed after {self.max_retries} retries")
        return None
