"""
Chain configuration for on-chain connectors.
Centralized configuration for supported blockchain networks.
"""

from typing import Dict, Any, Optional

# Chain configurations indexed by chain_name (lowercase)
# Note: chain_id is only used by Etherscan API connectors
CHAIN_CONFIG: Dict[str, Dict[str, Any]] = {
    # Ethereum Mainnet
    "ethereum": {
        "chain_id": 1,  # Used by Etherscan API
        "native_token": "ETH",
        "native_token_decimals": 18,
        "blockscout_api_url": "https://eth.blockscout.com/api/v2",
    },
    # Base (Coinbase L2)
    "base": {
        "chain_id": 8453,
        "native_token": "ETH",
        "native_token_decimals": 18,
        "blockscout_api_url": "https://base.blockscout.com/api/v2",
    },
    # Arbitrum One
    "arbitrum": {
        "chain_id": 42161,
        "native_token": "ETH",
        "native_token_decimals": 18,
        "blockscout_api_url": "https://arbitrum.blockscout.com/api/v2",
    },
    # Optimism
    "optimism": {
        "chain_id": 10,
        "native_token": "ETH",
        "native_token_decimals": 18,
        "blockscout_api_url": "https://optimism.blockscout.com/api/v2",
    },
    # Polygon (MATIC)
    "polygon": {
        "chain_id": 137,
        "native_token": "MATIC",
        "native_token_decimals": 18,
        "blockscout_api_url": "https://polygon.blockscout.com/api/v2",
    },
    # BNB Smart Chain
    "bsc": {
        "chain_id": 56,
        "native_token": "BNB",
        "native_token_decimals": 18,
        "blockscout_api_url": None,  # BSC uses BscScan, not Blockscout
    },
    # Avalanche C-Chain
    "avalanche": {
        "chain_id": 43114,
        "native_token": "AVAX",
        "native_token_decimals": 18,
        "blockscout_api_url": None,  # Avalanche uses SnowTrace
    },
}


def get_chain_config(chain_name: str) -> Optional[Dict[str, Any]]:
    """
    Get chain configuration by chain name.

    Args:
        chain_name: Chain identifier (case-insensitive)

    Returns:
        Chain configuration dict or None if not found
    """
    return CHAIN_CONFIG.get(chain_name.lower())


def get_native_token(chain_name: str) -> str:
    """
    Get native token symbol for a chain.

    Args:
        chain_name: Chain identifier (case-insensitive)

    Returns:
        Native token symbol (e.g., "ETH", "MATIC")

    Raises:
        ValueError: If chain is not configured
    """
    config = get_chain_config(chain_name)
    if not config:
        raise ValueError(
            f"Unknown chain '{chain_name}'. Available: {list(CHAIN_CONFIG.keys())}"
        )
    return config["native_token"]


def get_native_token_decimals(chain_name: str) -> int:
    """
    Get native token decimals for a chain.

    Args:
        chain_name: Chain identifier (case-insensitive)

    Returns:
        Native token decimals (typically 18)

    Raises:
        ValueError: If chain is not configured
    """
    config = get_chain_config(chain_name)
    if not config:
        raise ValueError(
            f"Unknown chain '{chain_name}'. Available: {list(CHAIN_CONFIG.keys())}"
        )
    return config["native_token_decimals"]


def get_chain_id(chain_name: str) -> int:
    """
    Get chain ID for a chain.

    Args:
        chain_name: Chain identifier (case-insensitive)

    Returns:
        Chain ID (e.g., 1 for Ethereum)

    Raises:
        ValueError: If chain is not configured
    """
    config = get_chain_config(chain_name)
    if not config:
        raise ValueError(
            f"Unknown chain '{chain_name}'. Available: {list(CHAIN_CONFIG.keys())}"
        )
    return config["chain_id"]


def get_blockscout_api_url(chain_name: str) -> Optional[str]:
    """
    Get Blockscout API URL for a chain.

    Args:
        chain_name: Chain identifier (case-insensitive)

    Returns:
        Blockscout API URL or None if not available

    Raises:
        ValueError: If chain is not configured
    """
    config = get_chain_config(chain_name)
    if not config:
        raise ValueError(
            f"Unknown chain '{chain_name}'. Available: {list(CHAIN_CONFIG.keys())}"
        )
    return config.get("blockscout_api_url")
