"""
Base Blockscout connector: Common functionality for all Blockscout API connectors.
Provides shared request handling, configuration, and utility methods.
"""

import time
import requests
from abc import abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.onchain.chain_config import (
    get_blockscout_api_url,
    get_native_token,
    get_native_token_decimals,
)
from backend.config.loader import configure_logging, load_settings

log = configure_logging("blockscout_base")


class BlockscoutConnectorBase(BaseConnector):
    """
    Base class for Blockscout API connectors.
    Provides common functionality for API requests, configuration, and utilities.
    """

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "base",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize base Blockscout connector.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "base", "ethereum", "arbitrum")
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name.lower()
        self.wallet_address = wallet_address

        # Set native_token and decimals early (needed for both test and live mode)
        self.native_token = get_native_token(self.chain_name)
        self.native_token_decimals = get_native_token_decimals(self.chain_name)

        # Initialize base (sets self.test_mode and logs)
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        # Validate wallet configuration (required in both test and live mode)
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # In test mode, skip API-related configuration only
        if self.test_mode:
            return

        # Live mode: API configuration and validation
        blockscout_url = get_blockscout_api_url(self.chain_name)
        if not blockscout_url:
            raise ValueError(f"Blockscout API not available for chain '{chain_name}'")

        self.base_url = blockscout_url

        # Load configuration
        settings = load_settings()
        web3_config = settings.get("web3_wallets", {})
        self.request_delay = web3_config.get("request_delay", 1.25)
        self.max_retries = web3_config.get("max_retries", 7)

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Blockscout API.

        Args:
            endpoint: API endpoint path (e.g., "/addresses/{addr}/transactions")
            params: Optional query parameters

        Returns:
            JSON response data

        Raises:
            RuntimeError: If all retries fail
        """
        delay = self.request_delay
        url = f"{self.base_url}{endpoint}"
        if params is None:
            params = {}

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, timeout=15)

                # Check HTTP status
                if response.status_code == 429:
                    log.warning(f"⚠️ Rate limited (attempt {attempt}): HTTP 429")
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    raise RuntimeError(
                        f"HTTP {response.status_code}: {response.text[:100]}"
                    )

                data = response.json()
                return data

            except requests.exceptions.RequestException as e:
                log.error(f"⚠️ Network error: {e}")
                delay *= 2
                continue
            except Exception as e:
                log.error(f"⚠️ API error: {e}")
                delay *= 2
                continue

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def parse_timestamp(self, timestamp_str: str) -> datetime:
        """
        Parse Blockscout timestamp to datetime.

        Args:
            timestamp_str: ISO format timestamp string

        Returns:
            datetime object (timezone-aware UTC)
        """
        if timestamp_str:
            try:
                return datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            except ValueError:
                pass
        return datetime.now(timezone.utc)

    def determine_direction(self, tx_from: str, tx_to: str) -> tuple[str, str]:
        """
        Determine transaction direction based on wallet address.

        Args:
            tx_from: Transaction sender address
            tx_to: Transaction receiver address

        Returns:
            Tuple of (direction, to_address)

        Raises:
            ValueError: If wallet is neither sender nor receiver
        """
        wallet_lower = self.wallet_address.lower()
        tx_from_lower = tx_from.lower()
        tx_to_lower = tx_to.lower()

        if tx_from_lower == wallet_lower:
            return "outflow", tx_to
        elif tx_to_lower == wallet_lower:
            return "inflow", tx_to
        else:
            raise ValueError(
                f"Wallet not involved in transaction: from={tx_from} to={tx_to}"
            )

    @abstractmethod
    def get_raws(self) -> List[Dict[str, Any]]:
        """Get raw transactions. Must be implemented by subclasses."""
