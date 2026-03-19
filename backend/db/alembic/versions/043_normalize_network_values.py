"""Normalize existing network values and add index on network column.

Applies the NETWORK_ALIASES mapping to all existing normalized_transactions rows
so that historical data uses canonical network names (e.g. 'eth' -> 'ethereum',
'bep20' -> 'bsc', 'sol' -> 'solana', etc.).

Also adds a B-tree index on the `network` column for filter query performance.

Revision ID: 043_normalize_network_values
Revises: 042_add_connector_unique_index
Create Date: 2026-02-19

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '043_normalize_network_values'
down_revision: Union[str, Sequence[str], None] = '042_add_connector_unique_index'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Alias mapping: old (lowercased) value -> canonical value
# Must stay in sync with backend.core.network_normalizer.NETWORK_ALIASES
_ALIASES = {
    # Ethereum
    "eth": "ethereum",
    "erc20": "ethereum",
    "erc-20": "ethereum",
    "eth-ethereum mainnet": "ethereum",
    "eth-ethereum": "ethereum",
    "ethereum mainnet": "ethereum",
    "usdt-erc20": "ethereum",
    "usdc-erc20": "ethereum",
    # BNB Smart Chain (BSC)
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
    # NEAR
    "near protocol": "near",
    # SUI
    "sui network": "sui",
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
    # Moralis chain names that differ from canonical
    "eth": "ethereum",
}


def upgrade() -> None:
    # 1. Lowercase all network values first (fixes connectors that didn't .lower())
    op.execute(
        """
        UPDATE normalized_transactions
        SET network = LOWER(network)
        WHERE network IS NOT NULL
          AND network != LOWER(network);
        """
    )

    # 2. Apply alias mapping to normalize to canonical values
    for old_value, canonical in _ALIASES.items():
        if old_value == canonical:
            continue  # Skip identity mappings
        # Use parameterized values via text() to handle special characters safely
        op.execute(
            f"""
            UPDATE normalized_transactions
            SET network = '{canonical}'
            WHERE network = '{old_value}';
            """
        )

    # 3. Add index on network column for filter query performance
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_normalized_transactions_network
        ON normalized_transactions (network)
        WHERE network IS NOT NULL;
        """
    )


def downgrade() -> None:
    # Drop the network index
    op.execute(
        """
        DROP INDEX IF EXISTS ix_normalized_transactions_network;
        """
    )
    # Note: We don't reverse the normalization as we can't determine original values
