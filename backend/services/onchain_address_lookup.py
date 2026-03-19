"""
OnChainAddressLookupService - Look up missing from/to addresses using Moralis EVM API.

Uses the Moralis Transaction API to resolve addresses from transaction hashes
when CEX APIs don't provide them. Supports all EVM chains via a single endpoint.
"""

import os
import time
from typing import Dict, Optional, Tuple

import requests

from backend.config.loader import configure_logging

log = configure_logging("onchain_address_lookup")

# Moralis API base URL (same as connector_moralis_wallet_history)
MORALIS_BASE_URL = "https://deep-index.moralis.io/api/v2.2"

# Network name aliases → Moralis chain identifier
# See: https://docs.moralis.io/web3-data-api/evm/reference#supported-chains
NETWORK_TO_MORALIS_CHAIN: Dict[str, str] = {
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
    Service to look up transaction sender/receiver addresses via Moralis EVM API.

    Features:
    - In-memory cache to avoid duplicate API calls for the same tx hash
    - Rate limiting to respect Moralis API limits
    - Retry with exponential backoff
    - Graceful degradation (returns None on failure, never raises)
    - Multi-chain support via Moralis chain parameter
    """

    def __init__(
        self,
        request_delay: float = 0.5,
        max_retries: int = 3,
    ):
        self.request_delay = request_delay
        self.max_retries = max_retries
        self.api_key = os.getenv("MORALIS_API_KEY")
        # Cache: tx_hash → (from_address, to_address)
        self._cache: Dict[str, Tuple[Optional[str], Optional[str]]] = {}

    def lookup_address(
        self,
        network: str,
        tx_hash: str,
        direction: str,
    ) -> Optional[str]:
        """
        Look up the missing address for a transaction.

        For inflow (deposits): returns the sender (from) address.
        For outflow (withdrawals): returns the recipient (to) address.

        Args:
            network: Network identifier (e.g., "bsc", "bep20", "bnb")
            tx_hash: On-chain transaction hash
            direction: "inflow" or "outflow"

        Returns:
            The resolved address, or None if lookup fails or network is unsupported.
        """
        if not tx_hash or not network:
            return None

        if not self.api_key:
            log.warning("MORALIS_API_KEY not configured — skipping address lookup")
            return None

        # Normalize network to Moralis chain identifier
        moralis_chain = NETWORK_TO_MORALIS_CHAIN.get(network.lower().strip())
        if not moralis_chain:
            log.debug(f"Unsupported network for address lookup: {network}")
            return None

        # Check cache first
        if tx_hash in self._cache:
            from_addr, to_addr = self._cache[tx_hash]
            return from_addr if direction == "inflow" else to_addr

        # Fetch from Moralis
        from_addr, to_addr = self._lookup_moralis(moralis_chain, tx_hash)

        # Cache result (even if None, to avoid re-querying failed lookups)
        self._cache[tx_hash] = (from_addr, to_addr)

        return from_addr if direction == "inflow" else to_addr

    def _lookup_moralis(
        self, chain: str, tx_hash: str
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        Look up transaction from/to addresses via Moralis Transaction API.

        Endpoint: GET /transaction/{tx_hash}?chain={chain}

        Returns:
            Tuple of (from_address, to_address), either may be None.
        """
        endpoint = f"{MORALIS_BASE_URL}/transaction/{tx_hash}"
        params = {"chain": chain}
        headers = {
            "Accept": "application/json",
            "X-API-Key": self.api_key,
        }

        data = self._safe_request(endpoint, params, headers)
        if not data or not isinstance(data, dict):
            return None, None

        from_addr = data.get("from_address", "").lower() or None
        to_addr = data.get("to_address", "").lower() or None

        log.debug(
            f"Moralis tx {tx_hash[:16]}… ({chain}) → from={from_addr}, to={to_addr}"
        )
        return from_addr, to_addr

    def _safe_request(
        self, url: str, params: Dict, headers: Dict
    ) -> Optional[Dict]:
        """
        Perform HTTP GET with retry, backoff, and rate limiting.

        Args:
            url: Full API URL
            params: Query parameters
            headers: Request headers (including API key)

        Returns:
            Parsed JSON response, or None on failure.
        """
        delay = self.request_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(
                    url, params=params, headers=headers, timeout=30
                )

                if response.status_code == 429:
                    log.warning(
                        f"Rate limited (attempt {attempt}/{self.max_retries}): HTTP 429"
                    )
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    log.warning(
                        f"HTTP {response.status_code} on attempt {attempt}: "
                        f"{response.text[:200]}"
                    )
                    delay *= 2
                    continue

                return response.json()

            except requests.exceptions.RequestException as e:
                log.warning(
                    f"Network error (attempt {attempt}/{self.max_retries}): {e}"
                )
                delay *= 2
                continue
            except Exception as e:
                log.warning(
                    f"Unexpected error (attempt {attempt}/{self.max_retries}): {e}"
                )
                delay *= 2
                continue

        log.warning(
            f"Address lookup failed after {self.max_retries} retries for {url}"
        )
        return None
