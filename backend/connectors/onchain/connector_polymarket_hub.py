"""
Polymarket Hub connector: Aggregates Polymarket Data API activity (trades + redemptions)
with Polygon Blockscout on-chain data (deposits + withdrawals) for a single proxy wallet.

The Polymarket Data API only returns TRADE and REDEEM events.
USDC deposits/withdrawals to the proxy wallet are standard ERC-20 transfers on Polygon,
captured by the Blockscout child connector.
"""

from typing import Optional, Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging

log = configure_logging("polymarket_hub")


class ConnectorPolymarketHub(BaseHubConnector):
    """Polymarket Hub connector that aggregates Data API activity + Polygon on-chain transfers."""

    @property
    def connector_name(self) -> str:
        return "polymarket_hub"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Optional[Dict[str, Any]] = None,
        **kwargs,
    ):
        """
        Initialize Polymarket Hub connector.

        Args:
            wallet_address: The Polymarket proxy wallet address on Polygon
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Configuration dict (may include parent_output_path, test_mode)
        """
        self.wallet_address = wallet_address

        from .connector_polymarket import ConnectorPolymarket
        from .connector_polymarket_polygon import ConnectorPolymarketPolygon

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        test_mode = (config or {}).get("test_mode", False)
        renormalize_mode = (config or {}).get("renormalize_mode", False)

        # Validate Blockscout Polygon config for live mode
        if not test_mode and not renormalize_mode:
            registry = get_connector_registry()
            chain_config = registry.get_chain_config("blockscout", "polygon")
            if not chain_config or not chain_config.base_url:
                log.warning("Blockscout Polygon API not configured — deposits/withdrawals won't be captured")

        # Initialize parent first to get output_path
        super().__init__(
            child_connectors=[],
            parallel_strategy="queue",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

        # Build child config
        child_config = {"parent_output_path": self.output_path}
        if config:
            for key in ("test_mode", "renormalize_mode", "since_datetime"):
                if key in config:
                    child_config[key] = config[key]

        # Child 1: Polymarket Data API (trades + redemptions)
        polymarket_connector = ConnectorPolymarket(
            wallet_address=self.wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        # Child 2: Filtered Polygon token transfers (external USDC deposits/withdrawals)
        polygon_connector = ConnectorPolymarketPolygon(
            wallet_address=self.wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        self.child_connectors = [
            ("polymarket activity", polymarket_connector),
            ("polymarket polygon transfers", polygon_connector),
        ]

    # ------------------------------------------------------------------
    # Balance API — positions value + on-chain USDC cash balance
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        """
        Combined Polymarket balance: positions value + on-chain USDC cash.

        The Polymarket Data API /positions endpoint only reports the value
        of open prediction-market positions.  USDC cash sitting in the proxy
        wallet (from deposits, redeemed winnings, etc.) is NOT included
        there — it lives on-chain as a standard ERC-20 balance on Polygon.

        This method queries both sources and returns separate BalanceEntry
        items so the caller can see the breakdown.
        """
        import requests
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        entries = []

        # 1) Positions value from Polymarket Data API child
        for _, connector in self.child_connectors:
            if hasattr(connector, "get_balance") and hasattr(connector, "supports_balance"):
                if connector.supports_balance:
                    entries.extend(connector.get_balance())
                    break

        # 2) On-chain USDC cash balance via Blockscout Polygon
        try:
            registry = get_connector_registry()
            chain_config = registry.get_chain_config("blockscout", "polygon")
            if chain_config and chain_config.base_url:
                base_url = chain_config.base_url
                resp = requests.get(
                    f"{base_url}/addresses/{self.wallet_address}/token-balances",
                    timeout=15,
                )
                resp.raise_for_status()
                tokens = resp.json()

                for tok in tokens:
                    value = tok.get("value")
                    token_info = tok.get("token", {})
                    symbol = (token_info.get("symbol") or "").upper()
                    if symbol not in ("USDC", "USDC.E"):
                        continue
                    decimals = int(token_info.get("decimals", 6))
                    if value and int(value) > 0:
                        total = Decimal(value) / Decimal(10 ** decimals)
                        entries.append(BalanceEntry(
                            asset_symbol="USDC",
                            total=total,
                            available=total,
                            chain="polygon",
                            raw={"source": "wallet_cash", **tok},
                        ))
            else:
                log.warning("Blockscout Polygon not configured — cannot fetch wallet USDC balance")
        except Exception as e:
            log.warning(f"Failed to fetch on-chain USDC balance: {e}")

        return entries
