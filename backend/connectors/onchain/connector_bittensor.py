"""
Bittensor (TAO) connector using Taostats API.
Fetches native TAO transfers for a Bittensor wallet address.

Uses the Taostats transfer endpoint:
  GET https://api.taostats.io/api/transfer/v1

Bittensor is a Substrate-based chain using SS58 addresses.
1 TAO = 10^9 rao (smallest unit).
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("bittensor")


class ConnectorBittensor(BaseConnector):
    """Taostats API connector for Bittensor (TAO) wallet transfers."""

    @property
    def connector_name(self) -> str:
        return "bittensor"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize Bittensor connector.

        Args:
            wallet_address: The Bittensor wallet address (SS58 format, starts with 5)
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = "bittensor"
        self.wallet_address = wallet_address

        # Initialize base (sets self.test_mode and logs)
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        # Validate wallet configuration
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # Validate SS58 address format (Bittensor mainnet starts with 5, 48 chars)
        if not self.wallet_address.startswith("5") or len(self.wallet_address) != 48:
            raise ValueError(
                f"Invalid Bittensor SS58 address format: "
                f"must start with '5' and be 48 characters"
            )

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("bittensor", "bittensor")
        self.native_token_decimals = registry.get_native_token_decimals(
            "bittensor", "bittensor"
        )
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError("Chain configuration not found for bittensor")
        self.rao_divisor = Decimal(10**self.native_token_decimals)
        self.request_delay = 0.5
        self.max_retries = 7

        # In test mode, skip API-related configuration
        if self.test_mode:
            return

        # Live mode: API configuration
        self.base_url = "https://api.taostats.io"

        # Taostats API key (optional but recommended for higher rate limits)
        self.api_key = config.get("api_key") if config else None
        if not self.api_key:
            self.api_key = os.getenv("TAOSTATS_API_KEY")
        if self.api_key:
            log.info("Using Taostats API key")
        else:
            log.warning("No TAOSTATS_API_KEY set - rate limits may apply")

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Taostats API.

        Args:
            endpoint: API endpoint path (e.g., "/api/transfer/v1")
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

        headers = {
            "Accept": "application/json",
        }

        # Taostats uses Authorization header (no Bearer prefix)
        if self.api_key:
            headers["Authorization"] = self.api_key

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(
                    url, params=params, headers=headers, timeout=30
                )

                # Check HTTP status
                if response.status_code == 429:
                    retry_after = response.headers.get("Retry-After")
                    wait = int(retry_after) if retry_after else delay * 2
                    log.warning(
                        f"⚠️ Rate limited (attempt {attempt}): "
                        f"HTTP 429, waiting {wait}s"
                    )
                    delay = wait
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
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"Network error after {self.max_retries} retries: {e}"
                )
            except RuntimeError:
                raise
            except Exception as e:
                log.error(f"⚠️ API error: {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"API error after {self.max_retries} retries: {e}"
                )

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw transfers with page-based pagination."""
        try:
            # Test mode: Load from fixture file
            if self.test_mode:
                test_file = self.config.get(
                    "test_file_path"
                ) or self._get_default_test_file()
                log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")

                if not os.path.exists(test_file):
                    log.warning(f"Test file not found: {test_file}")
                    return

                with open(test_file, "r") as f:
                    data = json.load(f)

                # Return the transfers array from the fixture
                items = data.get("transfers", [])
                for item in items:
                    yield item

                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transfers")
                return

            # Live mode: Fetch from Taostats API
            self.update_progress(
                operation="Fetching Bittensor transfers",
                current=0,
                total=1,
                log_message=f"Fetching transfers for {self.wallet_address[:10]}...",
            )

            endpoint = "/api/transfer/v1"
            page = 1
            total_items = 0

            while True:
                params = {
                    "address": self.wallet_address,
                    "network": "finney",
                    "limit": 200,  # Taostats max per page
                    "page": page,
                }

                result = self.safe_request(endpoint, params)

                # Taostats returns {"pagination": {...}, "data": [...]}
                items = result.get("data", [])
                if not isinstance(items, list):
                    log.warning(f"Unexpected response format: {type(items)}")
                    break

                # Yield items from this page immediately
                for item in items:
                    total_items += 1
                    yield item

                log.info(f"   Page {page}: yielded {len(items)} transfers")

                # Check for more pages
                pagination = result.get("pagination", {})
                next_page = pagination.get("next_page")
                if not next_page or len(items) == 0:
                    break

                page = next_page

            log.info(f"   ✅ Found {total_items} transfers on Bittensor")

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} transfers on Bittensor",
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching Bittensor transfers: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}",
            )
            raise

    def raw_to_normalized(
        self, tx: Dict
    ) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw Taostats transfer to standardized format.

        Args:
            tx: Raw transfer from Taostats API
                Expected format:
                {
                    "id": "finney-5452109-0041",
                    "from": {"ss58": "...", "hex": "..."},
                    "to": {"ss58": "...", "hex": "..."},
                    "amount": "6500000000",  (rao)
                    "fee": "135263",  (rao)
                    "transaction_hash": "0x...",
                    "extrinsic_id": "5452109-0013",
                    "block_number": 5452109,
                    "timestamp": "2025-04-28T18:15:24Z",
                    "network": "finney"
                }

        Yields:
            NormalizedTransaction: Standardized transaction object
        """
        try:
            # Extract transaction hash
            tx_hash = tx.get("transaction_hash")
            if not tx_hash:
                raise ValueError(
                    f"Cannot determine transaction hash from '{tx}'"
                )

            # Parse timestamp (ISO 8601: "2025-04-28T18:15:24Z")
            timestamp_str = tx.get("timestamp")
            if timestamp_str:
                dt = datetime.fromisoformat(
                    timestamp_str.replace("Z", "+00:00")
                )
            else:
                dt = datetime.now(timezone.utc)

            # Extract addresses (SS58 format)
            from_address = tx.get("from", {}).get("ss58", "")
            to_address = tx.get("to", {}).get("ss58", "")

            # Determine direction
            direction = self._determine_direction(from_address, to_address)

            # Parse amount (in rao)
            amount_rao = Decimal(tx.get("amount", "0"))
            amount_tao = amount_rao / self.rao_divisor

            # Parse fee (in rao)
            fee_rao = Decimal(tx.get("fee", "0"))
            fee_tao = fee_rao / self.rao_divisor

            # Build tags with additional context
            tags = []

            block_number = tx.get("block_number")
            if block_number:
                tags.append({"block_number": block_number})

            extrinsic_id = tx.get("extrinsic_id")
            if extrinsic_id:
                tags.append({"extrinsic_id": extrinsic_id})

            transfer_id = tx.get("id")
            if transfer_id:
                tags.append({"transfer_id": transfer_id})

            yield NormalizedTransaction(
                source=self.connector_name,
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=tx_hash,
                network_transaction_id=tx_hash,
                date_time=dt,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type="transfer",
                source_asset_symbol=self.native_token,
                quantity=abs(amount_tao),
                fee=fee_tao,
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" and fee_tao > 0 else False,
                source_from_account=from_address,
                source_to_account=to_address,
                network=normalize_network(self.chain_name),
                tags=tags if tags else None,
            )

        except Exception as e:
            log.error(
                f"   ⚠️ Error mapping transfer "
                f"{tx.get('transaction_hash', 'unknown')}: {e}"
            )
            raise

    def _determine_direction(
        self, from_address: str, to_address: str
    ) -> str:
        """
        Determine transaction direction based on wallet address.

        SS58 addresses are case-sensitive.

        Args:
            from_address: Sender SS58 address
            to_address: Recipient SS58 address

        Returns:
            "inflow", "outflow", or "neutral"
        """
        wallet = self.wallet_address

        if from_address == wallet and to_address == wallet:
            return "neutral"  # Self-transfer
        elif from_address == wallet:
            return "outflow"
        elif to_address == wallet:
            return "inflow"
        else:
            return "neutral"  # Shouldn't happen for wallet transfers

    def _get_default_test_file(self) -> str:
        """Get default test fixture file path."""
        return os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "tests",
            "fixtures",
            "bittensor",
            "bittensor_transactions.json",
        )

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self):
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        try:
            data = self.safe_request(
                "/api/account/latest/v1",
                params={"address": self.wallet_address},
            )

            # Taostats v1 API returns { pagination: {...}, data: [...] }
            if isinstance(data, dict) and "data" in data:
                items = data["data"]
                if isinstance(items, list) and items:
                    account = items[0]
                else:
                    return []
            elif isinstance(data, list) and data:
                account = data[0]
            elif isinstance(data, dict):
                account = data
            else:
                return []

            # Use balance_total (rao), fallback to balance for legacy compat
            balance_rao = int(
                account.get("balance_total")
                or account.get("balance")
                or 0
            )
            if balance_rao > 0:
                total = Decimal(balance_rao) / Decimal(10 ** 9)
                available_rao = int(account.get("balance_free") or balance_rao)
                available = Decimal(available_rao) / Decimal(10 ** 9)
                return [BalanceEntry(
                    asset_symbol="TAO",
                    total=total,
                    available=available,
                    chain="bittensor",
                    raw=account,
                )]
        except Exception as e:
            log.warning(f"Failed to fetch Bittensor balance: {e}")
        return []
