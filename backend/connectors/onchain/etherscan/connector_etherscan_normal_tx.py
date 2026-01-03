"""
Etherscan API connector for normal transactions only: Fetch blockchain normal transactions for a single wallet address on a single chain.
Supports EVM chains through Etherscan API v2.
Object-oriented design implementing BaseConnector interface.
"""

import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, List

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.onchain.chain_config import (
    get_chain_id,
    get_native_token,
    get_native_token_decimals,
)
from backend.config.loader import configure_logging, load_settings
from backend.db.models import NormalizedTransaction

log = configure_logging("etherscan_normal_tx")


# ===== Etherscan Normal Transactions Connector Class =====


class ConnectorEtherscanNormalTx(BaseConnector):
    """Etherscan API connector for normal transactions only."""

    @property
    def connector_name(self) -> str:
        return f"etherscan_normal_tx_{self.chain_name.lower()}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "ethereum",
        api_key: str = None,
        account_id: int = None,
        connector_id: int = None,
        **kwargs,
    ):
        """
        Initialize Etherscan API connector for normal transactions.

        Args:
            wallet_address: The wallet address to scan
            chain_name: The chain name (e.g., "ethereum", "bsc")
            api_key: Etherscan API key (loaded from settings if not provided)
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name.lower()
        self.wallet_address = wallet_address

        # Set native_token and decimals early (needed for both test and live mode)
        self.native_token = get_native_token(self.chain_name)
        self.native_token_decimals = get_native_token_decimals(self.chain_name)
        self.chain_id = get_chain_id(self.chain_name)

        # Initialize base (sets self.test_mode and logs)
        super().__init__(account_id=account_id, connector_id=connector_id)

        # Validate wallet configuration (required in both test and live mode)
        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        # In test mode, skip API-related configuration only
        if self.test_mode:
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

    def get_raws(self) -> List[Dict[str, Any]]:
        """Get raw normal transactions without mapping (for JSON logging)."""
        try:
            result = self.safe_request(
                {
                    "module": "account",
                    "action": "txlist",
                    "chainid": self.chain_id,
                    "address": self.wallet_address,
                    "sort": "desc",
                }
            )

            return result if isinstance(result, list) else []
        except Exception as e:
            log.error(f"   ⚠️ Error fetching raw normal transactions: {e}")
            return []

    def raw_to_normalized(self, tx: Dict) -> NormalizedTransaction:
        """
        Map raw API transaction to standardized trade_sync format for normal transactions.

        Args:
            tx: Raw normal transaction from Etherscan API

        Returns:
            NormalizedTransaction: Standardized transaction_sync object matching trade_sync table schema
        """
        try:
            # Etherscan API format
            tx_hash = tx.get("hash")
            method_id = tx.get("methodId", "")
            tx_from = tx.get("from")
            tx_to = tx.get("to")
            token_symbol = self.native_token
            value_raw = int(tx.get("value", 0))
            token_decimal = 18
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

            tags = {
                "chain_id": self.chain_id,
                "token_symbol": token_symbol,
                "token_name": f"{self.chain_name} Native Token",
                "direction": direction,
                "method_id": method_id,
            }

            return NormalizedTransaction(
                source=f"etherscan_normal_tx_{self.chain_name.lower()}",
                account_id=self.account_id,
                source_transaction_id=tx_hash,
                date_time=dt,
                direction=direction,
                transaction_type="technical" if value == 0 else None,
                source_transaction_type="normal-tx",
                source_asset_symbol=self.native_token,
                quantity=float(value),
                fee=float(fee),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=True if direction == "outflow" else False,
                source_from_account=tx_from,
                source_to_account=to_addr,
                network=self.chain_name.lower(),
                tags=tags,
            )
        except Exception as e:
            log.error(f"   ⚠️ Error mapping normal transaction: {e}")
            raise


# Tests available at:
# pytest tests/unit/connectors/web3/test_etherscan_connector.py -v
