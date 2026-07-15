"""
Base NEAR connector: Common functionality for all NearBlocks API connectors.
Provides shared request handling, configuration, and utility methods.
"""

import os
import time
import requests
from datetime import datetime, timezone
from typing import Dict, Any

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging

log = configure_logging("near_base")

# NEAR native token: 1 NEAR = 10^24 yoctoNEAR
NEAR_DECIMALS = 24
NEAR_DIVISOR = 10**NEAR_DECIMALS


class NearConnectorBase(BaseConnector):
    """
    Base class for NearBlocks API connectors.
    Provides common functionality for API requests, configuration, and utilities.
    """

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        # Set variables needed for connector_name BEFORE super().__init__()
        self.wallet_address = wallet_address

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("near", "near")
        self.native_token_decimals = registry.get_native_token_decimals("near", "near")
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError("Chain configuration not found for near")

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

        # Rate limiting / retry
        self.request_delay = 0.5
        self.max_retries = 7
        self.per_page = 25  # NearBlocks default, max 250

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        chain_config = registry.get_chain_config("near", "near")
        if not chain_config or not chain_config.base_url:
            raise ValueError("NearBlocks API not available for NEAR")

        self.base_url = chain_config.base_url

        # Load API key from config or environment
        self.api_key = config.get("api_key") if config else None
        if not self.api_key:
            self.api_key = os.getenv("NEARBLOCKS_API_KEY")
        if not self.api_key:
            raise ValueError(
                "NEARBLOCKS_API_KEY environment variable or config not set"
            )

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for NearBlocks API.

        Args:
            endpoint: API endpoint path (e.g., "/account/{account}/txns-only")
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

        headers = {"Accept": "application/json"}

        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(
                    url, params=params, headers=headers, timeout=30
                )

                if response.status_code == 429:
                    log.warning(
                        f"⚠️ Rate limited (attempt {attempt}): HTTP 429"
                    )
                    delay *= 2
                    continue
                elif response.status_code >= 400:
                    error_text = response.text[:200]
                    log.error(f"HTTP {response.status_code}: {error_text}")
                    raise RuntimeError(
                        f"HTTP {response.status_code}: {error_text}"
                    )

                data = response.json()
                return data

            except requests.exceptions.RequestException as e:
                log.error(f"⚠️ Network error (attempt {attempt}): {e}")
                delay *= 2
                continue
            except RuntimeError:
                raise
            except Exception as e:
                log.error(f"⚠️ API error (attempt {attempt}): {e}")
                delay *= 2
                continue

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def parse_block_timestamp(self, block_timestamp: str) -> datetime:
        """
        Parse NearBlocks block_timestamp (nanoseconds since epoch) to datetime.

        Args:
            block_timestamp: Nanosecond timestamp string (e.g., "1760477782937287155")

        Returns:
            datetime: Timezone-aware UTC datetime
        """
        if block_timestamp:
            try:
                ns = int(block_timestamp)
                seconds = ns / 1_000_000_000
                return datetime.fromtimestamp(seconds, tz=timezone.utc)
            except (ValueError, OverflowError):
                pass
        return datetime.now(timezone.utc)

    def determine_direction(self, from_account: str, to_account: str) -> str:
        """
        Determine transaction direction based on wallet address.

        Args:
            from_account: Signer/sender account ID
            to_account: Receiver account ID

        Returns:
            "inflow", "outflow", or "neutral"
        """
        wallet = self.wallet_address.lower()
        from_addr = from_account.lower() if from_account else ""
        to_addr = to_account.lower() if to_account else ""

        if from_addr == wallet and to_addr == wallet:
            return "neutral"
        elif from_addr == wallet:
            return "outflow"
        elif to_addr == wallet:
            return "inflow"
        else:
            return "neutral"
