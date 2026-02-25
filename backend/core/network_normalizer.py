"""
Centralized network/chain name normalization.

Provides a single source of truth for mapping raw network identifiers
(from exchange APIs, on-chain connectors, etc.) to canonical lowercase names,
and from canonical names to human-readable display labels.

Usage:
    from backend.core.network_normalizer import normalize_network, get_network_display_name

    canonical = normalize_network("BNB Smart Chain(BEP20)")  # -> "bsc"
    label = get_network_display_name("bsc")                  # -> "BNB Smart Chain"
"""

from typing import Optional


# ---------------------------------------------------------------------------
# Alias mapping: raw (lowercased) -> canonical name
# ---------------------------------------------------------------------------

NETWORK_ALIASES: dict[str, str] = {
    # Ethereum
    "eth": "ethereum",
    "erc20": "ethereum",
    "erc-20": "ethereum",
    "eth-erc20": "ethereum",
    "eth-ethereum mainnet": "ethereum",
    "eth-ethereum": "ethereum",
    "ethereum mainnet": "ethereum",
    "ethereum(erc20)": "ethereum",
    "usdt-erc20": "ethereum",
    "usdc-erc20": "ethereum",
    # BNB Smart Chain (BSC)
    "bsc": "bsc",
    "bep20": "bsc",
    "bep-20": "bsc",
    "bsc-bep20": "bsc",
    "bnb": "bsc",
    "bnb smart chain": "bsc",
    "bnb smart chain(bep20)": "bsc",
    "binance smart chain": "bsc",
    "binance smart chain(bep20)": "bsc",
    # Solana
    "sol": "solana",
    "sol-solana": "solana",
    "solana(sol)": "solana",
    # Bitcoin
    "btc": "bitcoin",
    "btc-bitcoin": "bitcoin",
    # Tron
    "trc20": "tron",
    "trc-20": "tron",
    "trx": "tron",
    "trx-tron": "tron",
    "usdt-trc20": "tron",
    "usdc-trc20": "tron",
    # Polygon
    "matic": "polygon",
    "polygon-pos": "polygon",
    # Arbitrum
    "arb": "arbitrum",
    "arb1": "arbitrum",
    "arbitrum one": "arbitrum",
    "arb-arbitrum one": "arbitrum",
    # Avalanche
    "avax": "avalanche",
    "avaxc": "avalanche",
    "avax c-chain": "avalanche",
    "avalanche c-chain": "avalanche",
    # Optimism
    "op": "optimism",
    "optimism mainnet": "optimism",
    # XRP
    "xrpl": "xrp",
    "xrp ledger": "xrp",
    "ripple": "xrp",
    # Cardano
    "ada": "cardano",
    "ada-cardano": "cardano",
    # NEAR
    "near protocol": "near",
    # SUI
    "sui network": "sui",
    "sui-sui": "sui",
    "usdc-sui": "sui",
    # Bittensor
    "tao": "bittensor",
    "bittensor network": "bittensor",
    "finney": "bittensor",
    # Base
    "base mainnet": "base",
    # SEI
    "sei network": "sei",
    # Cosmos
    "atom": "cosmos",
    # Litecoin
    "ltc": "litecoin",
    # Dogecoin
    "doge": "dogecoin",
    # HyperEVM (Hyperliquid)
    "hyperevm": "hyperevm",
    "hyper evm": "hyperevm",
    "hyperliquid": "hyperevm",
    "hyperliquid evm": "hyperevm",
    # Sonic
    "s": "sonic",
    "sonic network": "sonic",
}

# Identity mappings (canonical -> canonical) are implied by the lookup logic.

# ---------------------------------------------------------------------------
# Display names: canonical -> human-readable label
# ---------------------------------------------------------------------------

NETWORK_DISPLAY_NAMES: dict[str, str] = {
    "ethereum": "Ethereum",
    "bsc": "BNB Smart Chain",
    "solana": "Solana",
    "bitcoin": "Bitcoin",
    "tron": "Tron",
    "polygon": "Polygon",
    "arbitrum": "Arbitrum",
    "avalanche": "Avalanche",
    "optimism": "Optimism",
    "xrp": "XRP Ledger",
    "cardano": "Cardano",
    "near": "NEAR",
    "sui": "SUI",
    "bittensor": "Bittensor",
    "base": "Base",
    "sei": "SEI",
    "cosmos": "Cosmos",
    "litecoin": "Litecoin",
    "dogecoin": "Dogecoin",
    "hyperevm": "HyperEVM",
    "sonic": "Sonic",
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def normalize_network(raw: Optional[str]) -> Optional[str]:
    """
    Normalize a raw network string to its canonical form.

    1. Returns None for None/empty input.
    2. Lowercases and strips the value.
    3. Looks up the alias map; returns the canonical name if found.
    4. Falls back to the lowercased value (no data loss for unknown networks).
    """
    if not raw or not raw.strip():
        return None
    key = raw.strip().lower()
    return NETWORK_ALIASES.get(key, key)


def get_network_display_name(canonical: str) -> str:
    """
    Return a human-readable display name for a canonical network identifier.

    Falls back to title-cased canonical name if no explicit mapping exists.
    """
    return NETWORK_DISPLAY_NAMES.get(canonical, canonical.title())
