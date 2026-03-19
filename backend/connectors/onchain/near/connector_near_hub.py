"""
NEAR Hub connector: Aggregates native transactions and FT token transfers
for a single NEAR wallet address.
Uses NearBlocks API v1.
"""

from typing import Optional, Dict, Any

from backend.connectors.base.base_hub_connector import BaseHubConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging

log = configure_logging("near_hub")


class ConnectorNearHub(BaseHubConnector):
    """NEAR Hub connector that aggregates native transactions and FT transfers."""

    @property
    def connector_name(self) -> str:
        return "near_hub"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Optional[Dict[str, Any]] = None,
        **kwargs,
    ):
        """
        Initialize NEAR Hub connector that aggregates both transaction types.

        Args:
            wallet_address: The NEAR wallet address to scan
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Configuration dict (may include parent_output_path, api_key)
        """
        self.wallet_address = wallet_address

        from .connector_near_txns import ConnectorNearTxns
        from .connector_near_ft_txns import ConnectorNearFtTxns

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate chain is supported
        registry = get_connector_registry()
        chain_config = registry.get_chain_config("near", "near")

        test_mode = (config or {}).get("test_mode", False)
        renormalize_mode = (config or {}).get("renormalize_mode", False)
        if not test_mode and not renormalize_mode:
            if not chain_config or not chain_config.base_url:
                raise ValueError("NearBlocks API not available for NEAR")

        # Initialize parent first to get output_path
        super().__init__(
            child_connectors=[],  # Will populate after creating children
            parallel_strategy="queue",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

        # Create specialized connectors with parent output path
        child_config = {"parent_output_path": self.output_path}
        # Pass through api_key, test_mode, and renormalize_mode if present
        if config:
            if "api_key" in config:
                child_config["api_key"] = config["api_key"]
            if "test_mode" in config:
                child_config["test_mode"] = config["test_mode"]
            if "renormalize_mode" in config:
                child_config["renormalize_mode"] = config["renormalize_mode"]

        txns_connector = ConnectorNearTxns(
            wallet_address=self.wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        ft_txns_connector = ConnectorNearFtTxns(
            wallet_address=self.wallet_address,
            account_id=account_id,
            connector_id=connector_id,
            config=child_config,
        )

        self.child_connectors = [
            ("native transactions", txns_connector),
            ("FT token transfers", ft_txns_connector),
        ]

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        import os
        import requests
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        registry = get_connector_registry()
        chain_config = registry.get_chain_config("near", "near")
        base_url = chain_config.base_url if chain_config else "https://api.nearblocks.io/v1"
        api_key = (self.config or {}).get("api_key") or os.getenv("NEARBLOCKS_API_KEY", "")
        headers = {"Accept": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        entries = []

        # Native NEAR balance
        try:
            resp = requests.get(
                f"{base_url}/account/{self.wallet_address}",
                headers=headers, timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            accounts = data.get("account", [])
            if accounts:
                amount = accounts[0].get("amount", "0")
                if int(amount) > 0:
                    total = Decimal(amount) / Decimal(10 ** 24)
                    entries.append(BalanceEntry(
                        asset_symbol="NEAR",
                        total=total,
                        available=total,
                        chain="near",
                        raw=accounts[0],
                    ))
        except Exception as e:
            log.warning(f"Failed to fetch native NEAR balance: {e}")

        # FT token balances
        try:
            resp = requests.get(
                f"{base_url}/account/{self.wallet_address}/inventory",
                headers=headers, timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            tokens = data.get("inventory", {}).get("fts", [])
            for tok in tokens:
                amount = tok.get("amount", "0")
                decimals = int(tok.get("ft_meta", {}).get("decimals", 0))
                symbol = tok.get("ft_meta", {}).get("symbol", "UNKNOWN")
                if int(amount) > 0 and decimals > 0:
                    total = Decimal(amount) / Decimal(10 ** decimals)
                    entries.append(BalanceEntry(
                        asset_symbol=symbol,
                        total=total,
                        available=total,
                        chain="near",
                        raw=tok,
                    ))
        except Exception as e:
            log.warning(f"Failed to fetch NEAR FT balances: {e}")

        return entries
