"""
Mapping suggestions for on-chain token contracts (raw assets keyed by network + contract).

Ranked:
1. known_contract       (1.0)  — the contract is already mapped to an asset from another source
2. official_deployment  (0.95) — CoinGecko lists this contract for the coin of a same-symbol asset
3. unverified_contract  (0.5)  — only the symbol matches; never auto-applied (possible spam / bridged variant)
"""

import time
from typing import Dict, Optional

import requests
from sqlmodel import Session, select
from sqlalchemy import func

from backend.api.schemas import SuggestionInfo
from backend.config.loader import configure_logging, load_settings
from backend.db.models import Asset, AssetPriceGetter
from backend.db.repositories.raw_asset_repository import (
    RawAssetRepository,
    normalize_contract,
    token_key,
)

log = configure_logging("asset_contract_suggestions")

# Our network names → CoinGecko asset-platform ids
COINGECKO_PLATFORMS: Dict[str, str] = {
    "ethereum": "ethereum",
    "base": "base",
    "arbitrum": "arbitrum-one",
    "optimism": "optimistic-ethereum",
    "polygon": "polygon-pos",
    "bsc": "binance-smart-chain",
    "avalanche": "avalanche",
    "solana": "solana",
    "sui": "sui",
    "near": "near-protocol",
    "hyperevm": "hyperevm",
}

_PLATFORMS_TTL = 24 * 3600
_FAILURE_TTL = 600
_platforms_cache: Dict[str, tuple] = {}


def coingecko_platforms(coin_id: str) -> Dict[str, str]:
    """{platform_id: contract} for a CoinGecko coin, cached; {} on failure."""
    cached = _platforms_cache.get(coin_id)
    if cached and cached[0] > time.time():
        return cached[1]
    headers = {"accept": "application/json"}
    keys = load_settings().get("coingecko_api_keys", [])
    if keys:
        headers["x-cg-demo-api-key"] = keys[0]
    try:
        resp = requests.get(
            f"https://api.coingecko.com/api/v3/coins/{coin_id}",
            params={
                "localization": "false",
                "tickers": "false",
                "market_data": "false",
                "community_data": "false",
                "developer_data": "false",
                "sparkline": "false",
            },
            headers=headers,
            timeout=5,
        )
        resp.raise_for_status()
        platforms = {
            k: v for k, v in (resp.json().get("platforms") or {}).items() if k and v
        }
        _platforms_cache[coin_id] = (time.time() + _PLATFORMS_TTL, platforms)
        return platforms
    except (requests.RequestException, ValueError) as e:
        log.warning(f"coingecko platforms lookup failed for {coin_id}: {e}")
        _platforms_cache[coin_id] = (time.time() + _FAILURE_TTL, {})
        return {}


def suggest_asset_for_contract(
    session: Session,
    symbol: str,
    network: Optional[str],
    contract_address: Optional[str],
) -> Optional[SuggestionInfo]:
    network, contract = token_key(network, contract_address)
    if not contract:
        return None

    known_id = RawAssetRepository(session).known_contract_asset_id(network, contract)
    if known_id is not None:
        asset = session.get(Asset, known_id)
        return SuggestionInfo(
            id=known_id,
            name=asset.symbol if asset else f"#{known_id}",
            confidence=1.0,
            reason="known_contract",
        )

    candidates = session.exec(
        select(Asset).where(func.upper(Asset.symbol) == (symbol or "").upper())
    ).all()
    if not candidates:
        return None

    platform = COINGECKO_PLATFORMS.get(network)
    if platform:
        for asset in candidates:
            coin_ids = session.exec(
                select(AssetPriceGetter.external_id).where(
                    AssetPriceGetter.asset_id == asset.asset_id,
                    AssetPriceGetter.price_getter == "coingecko",
                    AssetPriceGetter.external_id.isnot(None),
                )
            ).all()
            for coin_id in coin_ids:
                listed = coingecko_platforms(coin_id).get(platform)
                if listed and normalize_contract(listed) == contract:
                    return SuggestionInfo(
                        id=asset.asset_id,
                        name=asset.symbol,
                        confidence=0.95,
                        reason="official_deployment",
                    )

    asset = candidates[0]
    return SuggestionInfo(
        id=asset.asset_id,
        name=asset.symbol,
        confidence=0.5,
        reason="unverified_contract",
    )
