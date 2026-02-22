"""
Moralis connector for wallet history: Fetch all blockchain transactions for a wallet address.
Uses Moralis Wallet History API v2.2. Supports multiple EVM chains.
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("moralis_wallet_history")


class ConnectorMoralisWalletHistory(BaseConnector):
    """Moralis API connector for wallet history (all transaction types)."""

    @property
    def connector_name(self) -> str:
        return f"moralis_wallet_history_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "bsc",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize Moralis wallet history connector.

        Args:
            wallet_address: The wallet address to scan
            chain_name: Chain identifier (e.g., "eth", "bsc", "polygon", "arbitrum")
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
        # Set variables needed for connector_name BEFORE super().__init__()
        self.chain_name = chain_name.lower()
        self.wallet_address = wallet_address.lower()

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
        if not self.chain_name:
            raise ValueError("Missing chain name")

        # Set default values needed for both test and live mode
        self.request_delay = 0.5  # Moralis rate limits
        self.max_retries = 7

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration and validation
        self.base_url = "https://deep-index.moralis.io/api/v2.2"
        
        # Load API key from environment
        self.api_key = os.getenv("MORALIS_API_KEY")
        if not self.api_key:
            raise ValueError("MORALIS_API_KEY environment variable not set")

    def safe_request(self, endpoint: str, params: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Moralis API.

        Args:
            endpoint: API endpoint path (e.g., "/wallets/{address}/history")
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
            "X-API-Key": self.api_key,
        }

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
        """Fetch and yield raw transactions with cursor-based pagination."""
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
                
                # Return the result array from the fixture
                items = data.get("result", [])
                for item in items:
                    yield item
                
                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
                return
            
            # Live mode: Fetch from API
            self.update_progress(
                operation="Fetching wallet history",
                current=0,
                total=1,
                log_message=f"Fetching wallet history for {self.wallet_address[:10]}... on {self.chain_name}"
            )
            
            endpoint = f"/wallets/{self.wallet_address}/history"
            cursor = None
            total_items = 0
            page = 0
            
            while True:
                page += 1
                params = {
                    "chain": self.chain_name,
                    "order": "DESC",
                }
                
                if cursor:
                    params["cursor"] = cursor
                
                result = self.safe_request(endpoint, params)

                # Moralis returns {"result": [...], "cursor": "..."}
                items = result.get("result", [])
                if not isinstance(items, list):
                    log.warning(f"Unexpected response format: {type(items)}")
                    break
                
                # Yield items from this page immediately
                for item in items:
                    total_items += 1
                    yield item
                
                log.info(f"   Page {page}: yielded {len(items)} transactions")
                
                # Check for more pages
                cursor = result.get("cursor")
                if not cursor or len(items) == 0:
                    break

            log.info(
                f"   ✅ Found {total_items} transactions on {self.chain_name}"
            )
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} transactions on {self.chain_name}"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching wallet history: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
            raise

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw Moralis API transaction to standardized format.
        
        Since one transaction can contain multiple transfers (ERC20, native, NFT),
        this yields multiple NormalizedTransaction objects per raw transaction.

        Args:
            tx: Raw transaction from Moralis Wallet History API

        Yields:
            NormalizedTransaction: One or more standardized transaction objects
        """
        try:
            # Extract common transaction data
            tx_hash = tx.get("hash")
            if not tx_hash:
                raise ValueError(f"Cannot determine transaction hash from '{tx}'")
            
            # Parse timestamp
            timestamp_str = tx.get("block_timestamp", "")
            if timestamp_str:
                dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            else:
                dt = datetime.now(timezone.utc)
            
            # Parse transaction fee
            transaction_fee_str = tx.get("transaction_fee", "0")
            transaction_fee = float(transaction_fee_str) if transaction_fee_str else 0.0
            
            # Get common fields
            from_address = tx.get("from_address", "").lower()
            to_address = tx.get("to_address", "").lower() if tx.get("to_address") else None
            category = tx.get("category", "unknown")
            possible_spam = tx.get("possible_spam", False)
            
            # Build base tags
            base_tags = []
            if possible_spam:
                base_tags.append({"spam": True})
            
            # Track if we yielded any transfers
            yielded_count = 0
            
            # Process ERC20 transfers
            erc20_transfers = tx.get("erc20_transfers", [])
            for idx, transfer in enumerate(erc20_transfers):
                yielded_count += 1
                yield self._map_erc20_transfer(
                    tx_hash=tx_hash,
                    transfer=transfer,
                    transfer_index=idx,
                    dt=dt,
                    transaction_fee=transaction_fee if idx == 0 else 0.0,  # Only first transfer gets fee
                    category=category,
                    base_tags=base_tags,
                )
            
            # Process native transfers
            native_transfers = tx.get("native_transfers", [])
            for idx, transfer in enumerate(native_transfers):
                yielded_count += 1
                yield self._map_native_transfer(
                    tx_hash=tx_hash,
                    transfer=transfer,
                    transfer_index=idx,
                    dt=dt,
                    transaction_fee=transaction_fee if yielded_count == 1 else 0.0,  # Only first transfer overall gets fee
                    category=category,
                    base_tags=base_tags,
                )
            
            # Process NFT transfers
            nft_transfers = tx.get("nft_transfers", [])
            for idx, transfer in enumerate(nft_transfers):
                yielded_count += 1
                yield self._map_nft_transfer(
                    tx_hash=tx_hash,
                    transfer=transfer,
                    transfer_index=idx,
                    dt=dt,
                    transaction_fee=transaction_fee if yielded_count == 1 else 0.0,  # Only first transfer overall gets fee
                    category=category,
                    base_tags=base_tags,
                )
            
            # If no transfers at all (e.g., approve, contract interaction), create one record for the transaction
            if yielded_count == 0:
                yield self._map_empty_transaction(
                    tx_hash=tx_hash,
                    dt=dt,
                    from_address=from_address,
                    to_address=to_address,
                    transaction_fee=transaction_fee,
                    category=category,
                    tx=tx,
                    base_tags=base_tags,
                )
                
        except Exception as e:
            log.error(f"   ⚠️ Error mapping transaction {tx.get('hash', 'unknown')}: {e}")
            raise

    def _map_erc20_transfer(
        self,
        tx_hash: str,
        transfer: Dict,
        transfer_index: int,
        dt: datetime,
        transaction_fee: float,
        category: str,
        base_tags: list,
    ) -> NormalizedTransaction:
        """Map an ERC20 transfer to NormalizedTransaction."""
        
        # Extract transfer details
        token_symbol = transfer.get("token_symbol", "UNKNOWN")
        token_decimals = int(transfer.get("token_decimals", 18))
        value_raw = transfer.get("value", "0")
        value_formatted = transfer.get("value_formatted")
        contract_address = transfer.get("address", "").lower()
        log_index = transfer.get("log_index", transfer_index)
        
        # Calculate amount
        if value_formatted:
            quantity = float(value_formatted)
        else:
            quantity = float(Decimal(value_raw) / Decimal(10**token_decimals))
        
        # Determine direction
        transfer_from = transfer.get("from_address", "").lower()
        transfer_to = transfer.get("to_address", "").lower()
        direction = transfer.get("direction", "unknown")  # Moralis provides this
        
        if direction not in ["send", "receive"]:
            # Fallback to manual detection
            if transfer_from == self.wallet_address:
                direction = "outflow"
            elif transfer_to == self.wallet_address:
                direction = "inflow"
            else:
                direction = "neutral"
        else:
            direction = "outflow" if direction == "send" else "inflow"
        
        # Build tags
        tags = base_tags.copy()
        if transfer.get("possible_spam"):
            if {"spam": True} not in tags:
                tags.append({"spam": True})
        
        # Build source transaction ID
        source_transaction_id = f"{tx_hash}_erc20_{log_index}"
        
        return NormalizedTransaction(
            source=f"moralis_wallet_history_{self.chain_name}",
            account_id=self.account_id,
            source_account=self.wallet_address,
            source_transaction_id=source_transaction_id,
            network_transaction_id=tx_hash,  # For grouping transfers in same tx
            date_time=dt,
            direction=direction,
            transaction_type="transfer",
            source_transaction_type=category,
            source_asset_symbol=token_symbol,
            quantity=quantity,
            fee=transaction_fee,
            source_fee_quote_asset_symbol=self._get_native_token(),
            include_fee=True if direction == "outflow" and transaction_fee > 0 else False,
            source_from_account=transfer_from,
            source_to_account=transfer_to,
            token_contract_address=contract_address,
            network=normalize_network(self.chain_name),
            tags=tags,
        )

    def _map_native_transfer(
        self,
        tx_hash: str,
        transfer: Dict,
        transfer_index: int,
        dt: datetime,
        transaction_fee: float,
        category: str,
        base_tags: list,
    ) -> NormalizedTransaction:
        """Map a native token transfer to NormalizedTransaction."""
        
        # Extract transfer details
        value_raw = transfer.get("value", "0")
        value_formatted = transfer.get("value_formatted")
        token_symbol = transfer.get("token_symbol", self._get_native_token())
        
        # Native tokens always use 18 decimals
        if value_formatted:
            quantity = float(value_formatted)
        else:
            quantity = float(Decimal(value_raw) / Decimal(10**18))
        
        # Determine direction
        transfer_from = transfer.get("from_address", "").lower()
        transfer_to = transfer.get("to_address", "").lower()
        direction = transfer.get("direction", "unknown")
        
        if direction not in ["send", "receive"]:
            # Fallback to manual detection
            if transfer_from == self.wallet_address:
                direction = "outflow"
            elif transfer_to == self.wallet_address:
                direction = "inflow"
            else:
                direction = "neutral"
        else:
            direction = "outflow" if direction == "send" else "inflow"
        
        # Build source transaction ID
        source_transaction_id = f"{tx_hash}_native_{transfer_index}"
        
        return NormalizedTransaction(
            source=f"moralis_wallet_history_{self.chain_name}",
            account_id=self.account_id,
            source_account=self.wallet_address,
            source_transaction_id=source_transaction_id,
            network_transaction_id=tx_hash,
            date_time=dt,
            direction=direction,
            transaction_type="transfer",
            source_transaction_type=category,
            source_asset_symbol=token_symbol,
            quantity=quantity,
            fee=transaction_fee,
            source_fee_quote_asset_symbol=self._get_native_token(),
            include_fee=True if direction == "outflow" and transaction_fee > 0 else False,
            source_from_account=transfer_from,
            source_to_account=transfer_to,
            network=normalize_network(self.chain_name),
            tags=base_tags.copy(),
        )

    def _map_nft_transfer(
        self,
        tx_hash: str,
        transfer: Dict,
        transfer_index: int,
        dt: datetime,
        transaction_fee: float,
        category: str,
        base_tags: list,
    ) -> NormalizedTransaction:
        """Map an NFT transfer to NormalizedTransaction."""
        
        # Extract transfer details
        token_symbol = transfer.get("token_symbol", "NFT")
        token_name = transfer.get("token_name", "Unknown NFT")
        token_id = transfer.get("token_id", "")
        contract_address = transfer.get("address", "").lower()
        log_index = transfer.get("log_index", transfer_index)
        
        # NFT quantity (1 for ERC721, actual amount for ERC1155)
        amount = transfer.get("amount", "1")
        quantity = float(amount)
        
        # Determine direction
        transfer_from = transfer.get("from_address", "").lower()
        transfer_to = transfer.get("to_address", "").lower()
        direction = transfer.get("direction", "unknown")
        
        if direction not in ["send", "receive"]:
            if transfer_from == self.wallet_address:
                direction = "outflow"
            elif transfer_to == self.wallet_address:
                direction = "inflow"
            else:
                direction = "neutral"
        else:
            direction = "outflow" if direction == "send" else "inflow"
        
        # Build tags with NFT metadata
        tags = base_tags.copy()
        tags.append({
            "nft": True,
            "token_id": token_id,
            "token_name": token_name,
        })
        
        # Build source transaction ID
        source_transaction_id = f"{tx_hash}_nft_{log_index}"
        
        return NormalizedTransaction(
            source=f"moralis_wallet_history_{self.chain_name}",
            account_id=self.account_id,
            source_account=self.wallet_address,
            source_transaction_id=source_transaction_id,
            network_transaction_id=tx_hash,
            date_time=dt,
            direction=direction,
            transaction_type="transfer",
            source_transaction_type=category,
            source_asset_symbol=token_symbol,
            quantity=quantity,
            fee=transaction_fee,
            source_fee_quote_asset_symbol=self._get_native_token(),
            include_fee=True if direction == "outflow" and transaction_fee > 0 else False,
            source_from_account=transfer_from,
            source_to_account=transfer_to,
            token_contract_address=contract_address,
            network=normalize_network(self.chain_name),
            tags=tags,
        )

    def _map_empty_transaction(
        self,
        tx_hash: str,
        dt: datetime,
        from_address: str,
        to_address: str,
        transaction_fee: float,
        category: str,
        tx: Dict,
        base_tags: list,
    ) -> NormalizedTransaction:
        """
        Map a transaction with no transfers (e.g., approve, contract interaction).
        Creates a record to track the transaction and gas fees.
        """
        
        # Determine direction based on who paid the gas
        direction = "outflow" if from_address == self.wallet_address else "neutral"
        
        # Build tags with contract interaction details
        tags = base_tags.copy()
        
        # Add approve details if available
        contract_interactions = tx.get("contract_interactions", {})
        if contract_interactions:
            approvals = contract_interactions.get("approvals", [])
            if approvals:
                approval = approvals[0]  # Get first approval
                token_info = approval.get("token", {})
                spender_info = approval.get("spender", {})
                tags.append({
                    "approve": True,
                    "token_symbol": token_info.get("token_symbol", ""),
                    "spender": spender_info.get("address", ""),
                })
        
        # Add method label if available
        method_label = tx.get("method_label")
        if method_label:
            tags.append({"method": method_label})
        
        return NormalizedTransaction(
            source=f"moralis_wallet_history_{self.chain_name}",
            account_id=self.account_id,
            source_account=self.wallet_address,
            source_transaction_id=tx_hash,
            network_transaction_id=tx_hash,
            date_time=dt,
            direction=direction,
            transaction_type="transfer",
            source_transaction_type=category,
            source_asset_symbol=self._get_native_token(),
            quantity=0.0,  # No value transfer
            fee=transaction_fee,
            source_fee_quote_asset_symbol=self._get_native_token(),
            include_fee=True if direction == "outflow" and transaction_fee > 0 else False,
            source_from_account=from_address,
            source_to_account=to_address,
            network=normalize_network(self.chain_name),
            tags=tags,
        )

    def _get_native_token(self) -> str:
        """Get native token symbol for the chain."""
        # Map chain names to native tokens
        native_tokens = {
            "eth": "ETH",
            "bsc": "BNB",
            "polygon": "MATIC",
            "avalanche": "AVAX",
            "arbitrum": "ETH",
            "base": "ETH",
            "optimism": "ETH",
            "sei": "SEI",
        }
        return native_tokens.get(self.chain_name, "ETH")

    def _get_default_test_file(self) -> str:
        """Get default test fixture file path."""
        # Get project root (assumes connector is in backend/connectors/onchain/)
        connector_file = os.path.abspath(__file__)
        backend_dir = os.path.dirname(os.path.dirname(os.path.dirname(connector_file)))
        return os.path.join(
            backend_dir,
            "tests",
            "fixtures",
            "moralis",
            f"wallet_history_{self.chain_name}.json"
        )
