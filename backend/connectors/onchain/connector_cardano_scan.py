"""
Cardano connector using Cardanoscan API.
Fetches transactions for a Cardano wallet address and normalizes transfers.

Uses pycardano for address parsing to extract stake credentials, enabling proper
identification of all addresses belonging to the same wallet (handling change addresses).
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, Optional

from pycardano import Address

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("cardano_scan")


class ConnectorCardanoScan(BaseConnector):
    """Cardanoscan API connector for Cardano blockchain transactions."""

    @property
    def connector_name(self) -> str:
        return "cardano_scan"

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
        Initialize Cardano Cardanoscan connector.

        Args:
            wallet_address: The Cardano wallet address to scan
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = "cardano"
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

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("cardano_scan", "cardano")
        self.native_token_decimals = registry.get_native_token_decimals("cardano_scan", "cardano")
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError(f"Chain configuration not found for cardano")
        self.lovelace_divisor = Decimal(10 ** self.native_token_decimals)
        self.request_delay = 0.5  # Cardanoscan rate limits
        self.max_retries = 5

        # Extract and cache stake credential from provided wallet address
        self.user_stake_id = self._get_stake_credential(self.wallet_address)
        if not self.user_stake_id:
            log.warning(
                f"Unable to extract stake credential from address: {self.wallet_address[:20]}..."
            )

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        self.base_url = "https://api.cardanoscan.io/api/v1"

        # Load API key from config or environment
        self.api_key = config.get("api_key") if config else None
        if not self.api_key:
            self.api_key = os.getenv("CARDANOSCAN_API_KEY")
        if not self.api_key:
            log.warning("CARDANOSCAN_API_KEY not set - API requests may be limited")

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "..", "..", "tests", "fixtures", "cardano", "cardanoscan_transactions.json"
        )

    def _bech32_to_hex(self, bech32_address: str) -> str:
        """
        Convert Bech32 address to hexadecimal format for API requests.
        
        The Cardanoscan API requires addresses in hex format.
        
        Args:
            bech32_address: Cardano address in Bech32 format (addr1...)
            
        Returns:
            Hexadecimal representation of the address
        """
        try:
            # Decode the Bech32 address to get the raw bytes
            addr = Address.from_primitive(bech32_address)
            # Convert to bytes and then to hex string
            addr_bytes = addr.to_primitive()
            return addr_bytes.hex()
        except Exception as e:
            log.error(f"Failed to convert Bech32 address to hex: {e}")
            # Return the original address as fallback (will likely fail but provides better error)
            return bech32_address

    def _get_stake_credential(self, address_str: str) -> Optional[str]:
        """
        Extract stake credential hash from Cardano address.

        Uses pycardano to parse addresses (Bech32 or hex) and extract the stake key hash.
        This allows identifying all addresses belonging to the same wallet.

        Args:
            address_str: Cardano address in Bech32 format (addr1...) or hex format

        Returns:
            Hex string of stake credential, or None if extraction fails
        """
        try:
            # Handle both Bech32 (addr1...) and hex formats
            # API responses use hex, but user-provided addresses are Bech32
            if address_str.startswith('addr') or address_str.startswith('stake'):
                # Bech32 format - parse directly
                addr = Address.from_primitive(address_str)
            else:
                # Hex format - convert bytes to Address
                addr_bytes = bytes.fromhex(address_str)
                addr = Address.from_primitive(addr_bytes)

            # Check if it has a stake part (Base Address)
            # Most user addresses are Base Addresses with both payment and staking parts
            if hasattr(addr, "staking_part") and addr.staking_part:
                # Return the hex string of the stake credential
                return addr.staking_part.to_primitive().hex()
            else:
                # Enterprise addresses (exchanges) don't have stake keys
                # Fallback to the payment credential hash
                if hasattr(addr, "payment_part") and addr.payment_part:
                    return addr.payment_part.to_primitive().hex()
                return None

        except Exception as e:
            log.debug(f"Error parsing address {address_str[:20]}...: {e}")
            return None

    def _is_own_address(self, address_str: str) -> bool:
        """
        Check if an address belongs to the user's wallet.

        Compares stake credentials to handle change addresses and multiple
        addresses derived from the same wallet. Supports both Bech32 and hex formats.

        Args:
            address_str: Cardano address in Bech32 (addr1...) or hex format

        Returns:
            True if address belongs to user's wallet
        """
        if not address_str or not self.user_stake_id:
            return False

        stake_id = self._get_stake_credential(address_str)
        return stake_id == self.user_stake_id

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Cardanoscan API.

        Args:
            endpoint: API endpoint path
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
            headers["apiKey"] = self.api_key

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
        """Fetch and yield raw transactions with pageNo-based pagination."""
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
                operation="Fetching Cardano transactions",
                current=0,
                total=1,
                log_message=f"Fetching transactions for {self.wallet_address[:10]}... on Cardano"
            )

            # Convert Bech32 address to hexadecimal for API request
            hex_address = self._bech32_to_hex(self.wallet_address)
            log.info(f"Using hex address for API: {hex_address[:20]}...")

            endpoint = "/transaction/list"
            page_no = 1
            total_items = 0

            while True:
                params = {
                    "address": hex_address,
                    "pageNo": page_no,
                }

                result = self.safe_request(endpoint, params)

                # Cardanoscan returns {"pageNo": 1, "limit": 10, "transactions": [...], "count": 1}
                items = result.get("transactions", [])
                if not isinstance(items, list):
                    log.warning(f"Unexpected response format: {type(items)}")
                    break

                # Yield items from this page immediately
                for item in items:
                    total_items += 1
                    yield item

                if items:
                    log.info(f"   Page {page_no}: yielded {len(items)} transactions")

                # Check for more pages - if empty or less than expected, we're done
                if len(items) == 0:
                    break

                page_no += 1

            log.info(
                f"   ✅ Found {total_items} transactions on Cardano"
            )

            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} transactions on Cardano"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching Cardano transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
            raise

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw Cardanoscan API transaction to standardized format.

        Uses stake credential matching to calculate net flow across all wallet addresses,
        properly handling change addresses and internal movements.

        Args:
            tx: Raw transaction from Cardanoscan API

        Yields:
            NormalizedTransaction: Standardized transaction object
        """
        try:
            # Filter: Only process successful transactions
            status = tx.get("status")
            if status is False:
                # Skip failed transactions
                return

            # Extract transaction hash
            tx_hash = tx.get("hash")
            if not tx_hash:
                log.warning(f"Missing hash in transaction: {tx}")
                return

            # Parse timestamp
            timestamp_str = tx.get("timestamp")
            if timestamp_str:
                # Cardanoscan returns ISO 8601 format: "2023-06-15T00:31:00.000Z"
                dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            else:
                log.warning(f"Missing timestamp for tx {tx_hash}")
                dt = datetime.now(timezone.utc)

            # Calculate net flow using stake credential matching
            net_value_lovelace = 0

            # Process inputs (money leaving)
            inputs = tx.get("inputs", [])
            has_own_inputs = False
            has_external_inputs = False
            for inp in inputs:
                inp_address = inp.get("address", "")
                if self._is_own_address(inp_address):
                    value_str = inp.get("value", "0")
                    net_value_lovelace -= int(value_str)
                    has_own_inputs = True
                else:
                    has_external_inputs = True

            # Process outputs (money entering)
            outputs = tx.get("outputs", [])
            has_own_outputs = False
            has_external_outputs = False
            for out in outputs:
                out_address = out.get("address", "")
                if self._is_own_address(out_address):
                    value_str = out.get("value", "0")
                    net_value_lovelace += int(value_str)
                    has_own_outputs = True
                else:
                    has_external_outputs = True

            # Process withdrawals (staking rewards as additional inflows)
            withdrawals = tx.get("withdrawals", [])
            for withdrawal in withdrawals:
                # Withdrawals are always inflows
                value_str = withdrawal.get("amount", "0")
                net_value_lovelace += int(value_str)

            # Convert lovelaces to ADA
            net_value_ada = Decimal(net_value_lovelace) / self.lovelace_divisor

            # Determine direction:
            # - Self-transfer: all inputs and outputs are own addresses
            # - Inflow: has external inputs (money coming from outside)
            # - Outflow: has external outputs (money going outside)
            is_self_transfer = has_own_inputs and has_own_outputs and not has_external_inputs and not has_external_outputs
            
            if is_self_transfer:
                direction = "neutral"
            elif net_value_ada > 0:
                direction = "inflow"
            elif net_value_ada < 0:
                direction = "outflow"
            else:
                direction = "neutral"

            # Parse fee
            fee_lovelace = int(tx.get("fees", "0"))
            fee_ada = Decimal(fee_lovelace) / self.lovelace_divisor

            # For outflows and neutral (self-transfers), include the fee
            # For inflows, fee was paid by sender
            include_fee = direction in ["outflow", "neutral"] and fee_ada > 0

            # Determine from/to addresses for display
            # For outflows: show first non-own output address
            # For inflows: show first non-own input address
            from_address = None
            to_address = None

            if direction == "outflow" or direction == "neutral":
                # Find first output that's not ours
                for out in outputs:
                    out_addr = out.get("address", "")
                    if not self._is_own_address(out_addr):
                        to_address = out_addr
                        break
                from_address = self.wallet_address

            elif direction == "inflow":
                # Find first input that's not ours
                for inp in inputs:
                    inp_addr = inp.get("address", "")
                    if not self._is_own_address(inp_addr):
                        from_address = inp_addr
                        break
                to_address = self.wallet_address

            # Build tags with additional transaction context
            tags = []

            # Add slot information
            slot = tx.get("slot")
            if slot:
                tags.append({"slot": slot})

            # Add epoch information
            epoch = tx.get("epoch")
            if epoch is not None:
                tags.append({"epoch": epoch})

            # Add block information
            block_height = tx.get("blockHeight")
            if block_height:
                tags.append({"block_height": block_height})

            # Add withdrawal information if present
            if withdrawals:
                withdrawal_amount = sum(int(w.get("amount", "0")) for w in withdrawals)
                withdrawal_ada = Decimal(withdrawal_amount) / self.lovelace_divisor
                tags.append({
                    "withdrawal_count": len(withdrawals),
                    "withdrawal_amount_ada": float(withdrawal_ada)
                })

            # Add certificate information if present
            certificate = tx.get("certificate", {})
            if certificate:
                cert_info = {}
                if certificate.get("stakeDelegations"):
                    cert_info["stake_delegations"] = len(certificate["stakeDelegations"])
                if certificate.get("poolRegistrations"):
                    cert_info["pool_registrations"] = len(certificate["poolRegistrations"])
                if certificate.get("stakeRegistrations"):
                    cert_info["stake_registrations"] = len(certificate["stakeRegistrations"])
                if cert_info:
                    tags.append({"certificate": cert_info})

            yield NormalizedTransaction(
                # Source identification
                source=self.connector_name,
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=tx_hash,
                network_transaction_id=tx_hash,

                # Core transaction data
                date_time=dt,
                direction=direction,
                transaction_type="transfer",
                source_transaction_type=tx.get("TransactionType", "Payment"),

                # Asset and amounts
                source_asset_symbol=self.native_token,
                quantity=abs(net_value_ada),

                # Fee information
                fee=fee_ada,
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=include_fee,

                # Addresses
                source_from_account=from_address,
                source_to_account=to_address,
                network=normalize_network(self.chain_name),
                token_contract_address=None,

                # Additional metadata
                tags=tags if tags else None,
            )

        except Exception as e:
            log.error(f"Error normalizing transaction {tx.get('hash', 'unknown')}: {e}")
            raise

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
            data = self.safe_request("/address/balance", params={"address": self.wallet_address})
            if data:
                lovelace = int(data.get("balance", 0))
                if lovelace > 0:
                    total = Decimal(lovelace) / Decimal(10 ** 6)
                    return [BalanceEntry(
                        asset_symbol="ADA",
                        total=total,
                        available=total,
                        chain="cardano",
                        raw=data,
                    )]
        except Exception as e:
            log.warning(f"Failed to fetch Cardano balance: {e}")
        return []
