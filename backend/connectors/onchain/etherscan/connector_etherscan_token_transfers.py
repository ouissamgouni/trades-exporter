"""
Etherscan API connector for token transfers only: Fetch blockchain token transfers for a single wallet address on a single chain.
Supports EVM chains through Etherscan API v2.
Object-oriented design implementing BaseConnector interface.
"""

import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging, load_settings
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging(__name__)


# ===== Etherscan Token Transfers Connector Class =====


class ConnectorEtherscanTokenTransfers(BaseConnector):
    """Etherscan API connector for token transfers only."""

    @property
    def connector_name(self) -> str:
        return f"etherscan_token_transfers_{self.chain_name.lower()}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "ethereum",
        api_key: str = None,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize Etherscan API connector for token transfers.

        Args:
            wallet_address: The wallet address to scan
            chain_name: The chain name (e.g., "ethereum", "bsc")
            api_key: Etherscan API key (loaded from settings if not provided)
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name.lower()
        self.wallet_address = wallet_address

        # Get chain configuration from registry
        registry = get_connector_registry()
        self.native_token = registry.get_native_token("etherscan", self.chain_name)
        self.native_token_decimals = registry.get_native_token_decimals("etherscan", self.chain_name)
        self.chain_id = registry.get_chain_id("etherscan", self.chain_name)
        if not self.native_token or self.native_token_decimals is None:
            raise ValueError(f"Chain configuration not found for {chain_name}")

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

        # In test/renormalize mode, skip API-related configuration only
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        web3_config = load_settings().get("web3_wallets", {})
        self.api_key = api_key or web3_config.get("etherscan_api_key", "")

        if not self.api_key:
            raise ValueError("Missing API KEY")

        self.request_delay = web3_config.get("request_delay", 1.25)
        self.max_retries = web3_config.get("max_retries", 7)

    def safe_request(self, params: Dict) -> Any:
        """Perform API request with retry, backoff, and rate limiting for Etherscan API."""
        delay = self.request_delay
        url = "https://api.etherscan.io/v2/api"
        params["apikey"] = self.api_key

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.get(url, params=params, timeout=10)
                data = response.json()

                # Check status code first
                status = data.get("status", "1")
                if status == "0":
                    # This is an error response
                    msg = data.get("result", data.get("message", "Unknown error"))
                    # Ensure msg is a string (could be a list from API)
                    if not isinstance(msg, str):
                        msg = str(msg)
                    if (
                        "rate limit" in msg.lower()
                        or "temporarily unavailable" in msg.lower()
                    ):
                        log.warning(
                            f"⚠️ Rate limited (attempt {attempt}): {msg[:80]}..."
                        )
                        delay *= 2
                        continue
                    else:
                        raise RuntimeError(f"API error: {msg}")

                # Success case - return the result
                if "result" in data:
                    result = data["result"]

                    # Validate result format
                    if isinstance(result, str):
                        if result.isdigit() or result == "" or result.lower() == "ok":
                            return result
                        else:
                            raise RuntimeError(f"Unexpected result: {result[:80]}")

                    return result

                raise RuntimeError("No result field in response")

            except RuntimeError as e:
                if "Rate limited" not in str(e):
                    raise
                delay *= 2
                continue
            except Exception as e:
                log.error(f"⚠️ Network error: {e}")
                delay *= 2
                continue

        raise RuntimeError(
            f"Failed after {self.max_retries} retries - API rate limit exceeded"
        )

    def yield_raws(self) -> "Generator[Dict[str, Any], None, None]":
        """Fetch and yield raw token transfers."""
        
        try:
            self.update_progress(
                operation="Fetching token transfers",
                current=0,
                total=1,
                log_message=f"Fetching token transfers for {self.wallet_address[:10]}..."
            )
            
            result = self.safe_request(
                {
                    "module": "account",
                    "action": "tokentx",
                    "chainid": self.chain_id,
                    "address": self.wallet_address,
                    "sort": "desc",
                }
            )
            
            transfers = result if isinstance(result, list) else []
            
            # Yield transfers as they come
            for transfer in transfers:
                yield transfer
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {len(transfers)} token transfers on {self.chain_name}"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching raw token transfers: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )

    def raw_to_normalized(self, tx: Dict) -> NormalizedTransaction:
        """
        Map raw API transaction to standardized trade_sync format for token transfers.

        Args:
            tx: Raw token transfer from Etherscan API

        Returns:
            NormalizedTransaction: Standardized transaction_sync object matching trade_sync table schema
        """
        try:
            # Etherscan API format for token transfers
            tx_hash = tx.get("hash")
            method_id = tx.get("methodId", "")
            tx_from = tx.get("from", "")
            tx_to = tx.get("to", "")
            transaction_id = f"{tx_hash}_{tx_from}_{tx_to}"
            token_symbol = tx.get("tokenSymbol", "").upper()
            contract_address = tx.get("contractAddress", "")
            value_raw = int(tx.get("value", 0))
            token_decimal = int(tx.get("tokenDecimal", 18))
            value = Decimal(value_raw) / Decimal(10**token_decimal)
            gas_used = int(tx.get("gasUsed", 0))
            gas_price = int(tx.get("gasPrice", 0))
            fee_wei = gas_used * gas_price
            fee = Decimal(fee_wei) / Decimal(10**18)
            timestamp = int(tx.get("timeStamp", 0))
            dt = (
                datetime.fromtimestamp(timestamp, tz=timezone.utc)
                if timestamp
                else None
            )

            # Common processing
            wallet_lower = self.wallet_address.lower()
            tx_from_lower = tx_from.lower()
            tx_to_lower = tx_to.lower()
            if tx_from_lower == wallet_lower:
                direction = "outflow"
                to_addr = tx_to
            elif tx_to_lower == wallet_lower:
                direction = "inflow"
                to_addr = tx_to
            else:
                raise ValueError(
                    f"Unexpected direction '{tx_from_lower}' to {tx_to_lower}"
                )

            tags = []

            return NormalizedTransaction(
                source=f"etherscan_token_transfers_{self.chain_name.lower()}",
                account_id=self.account_id,
                source_account=self.wallet_address,  # Raw account identifier for mapping
                source_transaction_id=transaction_id,
                date_time=dt,
                direction=direction,
                source_transaction_type="token-transfer",
                transaction_type="transfer",
                source_asset_symbol=f"{token_symbol}_{contract_address}",
                quantity=float(value),
                fee=float(fee),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" else False,
                source_from_account=tx_from,
                source_to_account=to_addr,
                network=normalize_network(self.chain_name),
                token_contract_address=contract_address,
                tags=tags,
            )
        except Exception as e:
            log.error(f"   ⚠️ Error mapping token transfer: {e}")
            raise
