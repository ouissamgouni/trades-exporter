"""
Polymarket Hub connector: Aggregates Polymarket Data API activity (trades + redemptions)
with Polygon on-chain USDC deposits/withdrawals (via Ankr) for a single proxy wallet.

USDC deposits/withdrawals to the proxy wallet are standard ERC-20 transfers on Polygon,
captured by the Polygon child connector.
"""

from typing import Optional, Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
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

        # Initialize parent first to get output_path
        super().__init__(
            child_connectors=[],
            parallel_strategy="queue",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

        # Build child config (shared keys)
        child_config = {"parent_output_path": self.output_path}
        if config:
            for key in ("test_mode", "renormalize_mode", "since_datetime"):
                if key in config:
                    child_config[key] = config[key]

        # Polymarket activity child gets the fixture file path (not polygon child,
        # which has its own default fixture or yields nothing in test mode)
        activity_config = dict(child_config)
        if config and config.get("test_file_path"):
            activity_config["test_file_path"] = config["test_file_path"]

        # Child 1: Polymarket Data API (trades + redemptions)
        polymarket_connector = ConnectorPolymarket(
            wallet_address=self.wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=activity_config,
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

        USDC cash sitting in the proxy wallet (deposits, redeemed winnings, etc.)
        lives on-chain as an ERC-20 balance on Polygon, read via the Polygon child.
        """
        entries = []
        for _, connector in self.child_connectors:
            if not getattr(connector, "supports_balance", False):
                continue
            try:
                entries.extend(connector.get_balance())
            except Exception as e:
                log.warning(f"Failed to fetch {connector.connector_name} balance: {e}")
        return entries
