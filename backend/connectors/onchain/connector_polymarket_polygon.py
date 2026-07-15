"""
Polymarket Polygon connector: Captures external USDC.E deposits/withdrawals
to/from the Polymarket proxy wallet on Polygon.

Uses Blockscout Polygon token transfers, filtering at yield_raws() level to
exclude Polymarket-internal transfers (trades, redemptions, CTF token burns).
Only external USDC.E movements pass through.
"""

from typing import Dict, Any, Generator

from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
    ConnectorBlockscoutTokenTransfers,
)
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("polymarket_polygon")

# Known Polymarket contract addresses on Polygon.
# Transfers involving these are Polymarket-internal (trade settlement,
# redemption payouts, CTF token minting/burning) — already captured
# by the Polymarket Data API connector.
POLYMARKET_CONTRACTS = {
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",  # CTF Exchange
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",  # Neg Risk CTF Exchange
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",  # Conditional Tokens Framework
    "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2",  # Conditional Tokens Framework
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",  # UMA CTF Adapter
    "0x0000000000000000000000000000000000000000",  # Zero / burn address
}


class ConnectorPolymarketPolygon(ConnectorBlockscoutTokenTransfers):
    """
    Blockscout Polygon token transfers filtered to external USDC.E deposits/withdrawals.

    Filtering happens in yield_raws() — NOT raw_to_normalized() — because
    returning None from raw_to_normalized() crashes the hub pipeline
    (BaseHubConnector.raw_to_normalized raises ValueError on None).
    """

    @property
    def connector_name(self) -> str:
        return "polymarket_polygon"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        super().__init__(
            wallet_address=wallet_address,
            chain_name="polygon",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield only external USDC.E transfers, filtering out Polymarket-internal ones.

        Skips:
        - Transfers where from or to is a known Polymarket contract
        - Non-USDC.E tokens (conditional tokens, spam, etc.)
        """
        for raw in super().yield_raws():
            # Extract addresses
            tx_from = (raw.get("from", {}).get("hash", "") or "").lower()
            tx_to = (raw.get("to", {}).get("hash", "") or "").lower()

            # Skip Polymarket-internal transfers
            if tx_from in POLYMARKET_CONTRACTS or tx_to in POLYMARKET_CONTRACTS:
                continue

            # Skip non-USDC tokens
            token_info = raw.get("token", {})
            token_symbol = (token_info.get("symbol") or "").upper()
            if token_symbol not in ("USDC", "USDC.E"):
                continue

            yield raw

    def raw_to_normalized(self, tx: Dict) -> NormalizedTransaction:
        """Normalize as standard Blockscout transfer, override source and type."""
        normalized = super().raw_to_normalized(tx)

        if normalized:
            normalized.source = "polymarket_polygon"
            normalized.source_transaction_type = (
                "deposit" if normalized.direction == "inflow" else "withdrawal"
            )

        return normalized
