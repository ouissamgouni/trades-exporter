"""
XRP Ledger connector: Fetch transactions for an XRP wallet address.
Uses XRPScan API v1. Supports Payment transactions.
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

log = configure_logging("xrp_ledger")


class ConnectorXRPLedger(BaseConnector):
    """XRP Ledger connector for wallet transactions (Payment type only)."""

    @property
    def connector_name(self) -> str:
        return "xrp_ledger"

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
        Initialize XRP Ledger connector.

        Args:
            wallet_address: The XRP wallet address to scan
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = "xrp"
        self.wallet_address = wallet_address

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

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("xrp", "xrp")
        self.native_token_decimals = registry.get_native_token_decimals("xrp", "xrp")
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError(f"Chain configuration not found for xrp")
        self.request_delay = 0.5  # XRPScan rate limits
        self.max_retries = 7

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        self.base_url = "https://api.xrpscan.com/api/v1"
        
        # XRPScan API key is optional (has rate limits without key)
        self.api_key = os.getenv("XRPSCAN_API_KEY")
        if self.api_key:
            log.info("Using XRPScan API key")
        else:
            log.warning("No XRPScan API key - rate limits may apply")

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for XRPScan API.

        Args:
            endpoint: API endpoint path (e.g., "/account/{address}/transactions")
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
        
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, headers=headers, timeout=30)

                # Check HTTP status
                if response.status_code == 429:
                    log.warning(f"⚠️ Rate limited (attempt {attempt}): HTTP 429")
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
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(f"Network error after {self.max_retries} retries: {e}")
            except Exception as e:
                log.error(f"⚠️ API error: {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(f"API error after {self.max_retries} retries: {e}")

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API request failed"
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw transactions with marker-based pagination."""
        try:
            # Test mode: Load from fixture file
            if self.test_mode:
                test_file = self.config.get("test_file_path") or self._get_default_test_file()
                log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")
                
                if not os.path.exists(test_file):
                    log.warning(f"Test file not found: {test_file}")
                    return
                
                with open(test_file, "r") as f:
                    data = json.load(f)
                
                # Return the transactions array from the fixture
                items = data.get("transactions", [])
                for item in items:
                    yield item
                
                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
                return
            
            # Live mode: Fetch from API
            self.update_progress(
                operation="Fetching XRP transactions",
                current=0,
                total=1,
                log_message=f"Fetching transactions for {self.wallet_address[:10]}..."
            )
            
            endpoint = f"/account/{self.wallet_address}/transactions"
            marker = None
            total_items = 0
            page = 0
            
            while True:
                page += 1
                params = {
                    "limit": 100,  # XRPScan supports up to 100 per page
                }
                
                if marker:
                    params["marker"] = marker
                
                result = self.safe_request(endpoint, params)

                # XRPScan returns {"transactions": [...], "marker": "..."}
                items = result.get("transactions", [])
                if not isinstance(items, list):
                    log.warning(f"Unexpected response format: {type(items)}")
                    break
                
                # Yield items from this page immediately
                for item in items:
                    total_items += 1
                    yield item
                
                log.info(f"   Page {page}: yielded {len(items)} transactions")
                
                # Check for more pages
                marker = result.get("marker")
                if not marker or len(items) == 0:
                    break

            log.info(
                f"   ✅ Found {total_items} transactions on XRP Ledger"
            )
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} transactions on XRP Ledger"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching XRP transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
            raise

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw XRPScan API transaction to standardized format.
        
        Only processes Payment transactions. Other transaction types are skipped.

        Args:
            tx: Raw transaction from XRPScan API

        Yields:
            NormalizedTransaction: Standardized transaction object (or None if not Payment)
        """
        try:
            # Filter: Only process Payment transactions
            tx_type = tx.get("TransactionType")
            if tx_type != "Payment":
                # Skip non-Payment transactions (OfferCreate, TrustSet, etc.)
                return
            
            # Extract common transaction data
            tx_hash = tx.get("hash")
            if not tx_hash:
                raise ValueError(f"Cannot determine transaction hash from '{tx}'")
            
            # Parse timestamp from date field
            timestamp_str = tx.get("date")
            if timestamp_str:
                # XRPScan returns ISO 8601 format: "2023-07-30T19:51:20.000Z"
                dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            else:
                dt = datetime.now(timezone.utc)
            
            # Extract account addresses
            from_address = tx.get("Account", "")
            to_address = tx.get("Destination", "")
            
            # Determine direction
            direction = self._determine_direction(from_address, to_address)
            
            # Parse amount (in drops)
            amount_data = tx.get("Amount", {})
            if isinstance(amount_data, dict):
                # Token transfer (has currency field)
                # For now, skip token transfers - focus on native XRP only
                currency = amount_data.get("currency", "XRP")
                if currency != "XRP":
                    log.debug(f"Skipping non-XRP token transfer: {currency}")
                    return
                amount_drops = float(amount_data.get("value", 0))
            else:
                # Native XRP transfer (amount in drops as string)
                amount_drops = float(amount_data)
            
            # Convert drops to XRP (1 XRP = 1,000,000 drops)
            amount_xrp = amount_drops / (10 ** self.native_token_decimals)
            
            # Parse fee (in drops)
            fee_drops = float(tx.get("Fee", "0"))
            fee_xrp = fee_drops / (10 ** self.native_token_decimals)
            
            # Build tags with destination tag if present
            tags = []
            destination_tag = tx.get("DestinationTag")
            if destination_tag:
                tags.append({"destination_tag": destination_tag})
            
            # Add account/destination names if present
            account_name = tx.get("AccountName", {})
            if account_name:
                tags.append({"from_name": account_name.get("name")})
            
            destination_name = tx.get("DestinationName", {})
            if destination_name:
                tags.append({"to_name": destination_name.get("name")})
            
            # Get transaction result
            meta = tx.get("meta", {})
            tx_result = meta.get("TransactionResult", "unknown")
            
            # Only process successful transactions
            if tx_result != "tesSUCCESS":
                log.debug(f"Skipping failed transaction: {tx_hash} ({tx_result})")
                return
            
            # Get ledger index for additional context
            ledger_index = tx.get("ledger_index")
            if ledger_index:
                tags.append({"ledger_index": ledger_index})
            
            yield NormalizedTransaction(
                source="xrp_ledger",
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=tx_hash,
                network_transaction_id=tx_hash,
                date_time=dt,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type="Payment",
                source_asset_symbol=self.native_token,
                quantity=abs(amount_xrp),
                fee=fee_xrp,
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" and fee_xrp > 0 else False,
                source_from_account=from_address,
                source_to_account=to_address,
                network=normalize_network(self.chain_name),
                tags=tags if tags else None,
            )
                
        except Exception as e:
            log.error(f"   ⚠️ Error mapping transaction {tx.get('hash', 'unknown')}: {e}")
            raise

    def _determine_direction(self, from_address: str, to_address: str) -> str:
        """
        Determine transaction direction based on wallet address.

        Args:
            from_address: Sender address
            to_address: Recipient address

        Returns:
            "inflow", "outflow", or "neutral"
        """
        wallet = self.wallet_address.lower()
        from_addr = from_address.lower()
        to_addr = to_address.lower()
        
        if from_addr == wallet and to_addr == wallet:
            return "neutral"  # Self-transfer
        elif from_addr == wallet:
            return "outflow"
        elif to_addr == wallet:
            return "inflow"
        else:
            return "neutral"  # Shouldn't happen for wallet transactions

    def _get_default_test_file(self) -> str:
        """Get default test fixture file path."""
        return os.path.join(
            os.path.dirname(__file__),
            "..",
            "..",
            "tests",
            "fixtures",
            "xrp",
            "xrp_ledger_transactions.json"
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
            data = self.safe_request(f"/account/{self.wallet_address}")
            xrp_balance = data.get("xrpBalance", "0")
            if float(xrp_balance) > 0:
                return [BalanceEntry(
                    asset_symbol="XRP",
                    total=Decimal(xrp_balance),
                    available=Decimal(xrp_balance),
                    chain="xrp",
                    raw=data,
                )]
        except Exception as e:
            log.warning(f"Failed to fetch XRP balance: {e}")
        return []
