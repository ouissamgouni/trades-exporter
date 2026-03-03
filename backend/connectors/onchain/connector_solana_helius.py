"""
Solana connector using Helius API.
Fetches transactions for a Solana wallet address and normalizes transfers.
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("solana_helius")


class ConnectorSolanaHelius(BaseConnector):
    """Helius API connector for Solana blockchain transactions."""

    # Solana native token has 9 decimals (lamports)
    SOL_DECIMALS = 9
    SOL_DIVISOR = Decimal(10 ** SOL_DECIMALS)
    
    # Wrapped SOL mint address — used to detect native<>token double-counting
    WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112"
    
    # Minimum lamport threshold for native transfers — skip dust/spam below this
    # 1000 lamports = 0.000001 SOL ≈ $0.0002 at $200/SOL
    DUST_THRESHOLD_LAMPORTS = 1000
    
    # Default decimals for unknown tokens
    DEFAULT_TOKEN_DECIMALS = 8
    
    # Max signatures to fetch from RPC for gap-fill
    RPC_GAP_FILL_LIMIT = 1000
    
    # Max transactions per Helius parse batch
    PARSE_BATCH_SIZE = 100

    @property
    def connector_name(self) -> str:
        return "solana_helius"

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
        Initialize Solana Helius connector.

        Args:
            wallet_address: The Solana wallet address to scan
            account_id: Optional account ID for database linking
            connector_id: Optional connector ID for database linking
            config: Optional connector configuration dict
            progress_callback: Optional callback for reporting progress
            **kwargs: Additional configuration parameters
        """
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

        # Token metadata cache (mint address -> {symbol, decimals})
        self._token_cache: Dict[str, Dict[str, Any]] = {}

        # Set default values
        self.request_delay = 0.2  # Helius rate limits
        self.max_retries = 5

        # In test/renormalize mode, skip API-related configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Live mode: API configuration
        self.base_url = "https://api.helius.xyz/v0"
        self.rpc_url = f"https://mainnet.helius-rpc.com"
        
        # Load API key from environment or config
        self.api_key = config.get("api_key") if config else None
        if not self.api_key:
            self.api_key = os.getenv("HELIUS_API_KEY")
        if not self.api_key:
            raise ValueError("HELIUS_API_KEY environment variable or config not set")

    def _get_default_test_file(self) -> str:
        """Get the default test fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "helius_api_fixtures", "solana_transactions.json"
        )

    def _get_asset_fixture_file(self) -> str:
        """Get the asset metadata fixture file path."""
        connector_dir = os.path.dirname(__file__)
        return os.path.join(
            connector_dir, "helius_api_fixtures", "solana_assets.json"
        )

    def safe_request(self, endpoint: str, params: Dict = None, method: str = "GET", json_body: Dict = None) -> Any:
        """
        Perform API request with retry, backoff, and rate limiting for Helius API.

        Args:
            endpoint: API endpoint path
            params: Optional query parameters
            method: HTTP method (GET or POST)
            json_body: Optional JSON body for POST requests

        Returns:
            JSON response data

        Raises:
            RuntimeError: If all retries fail
        """
        delay = self.request_delay
        url = f"{self.base_url}{endpoint}"
        if params is None:
            params = {}
        
        # Add API key to params
        params["api-key"] = self.api_key

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                
                if method == "POST":
                    response = requests.post(url, params=params, json=json_body, timeout=30)
                else:
                    response = requests.get(url, params=params, timeout=30)

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

    def _get_token_metadata(self, mint_address: str) -> Dict[str, Any]:
        """
        Get token metadata from Helius DAS API.
        
        Args:
            mint_address: The SPL token mint address
            
        Returns:
            Dict with 'symbol' and 'decimals' keys
        """
        # Check cache first
        if mint_address in self._token_cache:
            return self._token_cache[mint_address]
        
        # In test mode, load from fixture file
        if self.test_mode:
            try:
                fixture_file = self._get_asset_fixture_file()
                if os.path.exists(fixture_file):
                    with open(fixture_file, "r") as f:
                        assets_data = json.load(f)
                        if mint_address in assets_data:
                            metadata = assets_data[mint_address]
                            self._token_cache[mint_address] = metadata
                            return metadata
            except Exception as e:
                log.warning(f"Failed to load asset fixture: {e}")
        
        # Try to fetch from API (only in live mode)
        if not self.test_mode:
            try:
                # Call Helius RPC endpoint for DAS API
                rpc_body = {
                    "jsonrpc": "2.0",
                    "id": "get-asset",
                    "method": "getAsset",
                    "params": {
                        "id": mint_address,
                        "options": {
                            "showUnverifiedCollections": False,
                            "showCollectionMetadata": False,
                            "showFungible": True,
                            "showInscription": False
                        }
                    }
                }
                
                # Make RPC request directly (not using safe_request since URL structure is different)
                url = f"{self.rpc_url}/?api-key={self.api_key}"
                time.sleep(self.request_delay)
                response = requests.post(url, json=rpc_body, timeout=30)
                
                if response.status_code != 200:
                    raise RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}")
                
                rpc_response = response.json()
                
                # Check for JSON-RPC errors
                if "error" in rpc_response:
                    raise RuntimeError(f"RPC error: {rpc_response['error']}")
                
                result = rpc_response.get("result", {})
                
                # Extract symbol and decimals from response
                symbol = None
                decimals = self.DEFAULT_TOKEN_DECIMALS
                
                # Try to get symbol from metadata
                if "content" in result and "metadata" in result["content"]:
                    metadata = result["content"]["metadata"]
                    symbol = metadata.get("symbol")
                
                # Try to get decimals from token_info
                if "token_info" in result:
                    token_info = result["token_info"]
                    if "decimals" in token_info:
                        decimals = token_info["decimals"]
                
                # Fallback to mint address if no symbol found
                if not symbol:
                    symbol = mint_address
                
                result = {"symbol": symbol, "decimals": decimals}
                self._token_cache[mint_address] = result
                return result
                
            except Exception as e:
                log.warning(f"Failed to fetch metadata for {mint_address}: {e}")
        
        # Fallback: use mint address as symbol and default decimals
        result = {"symbol": mint_address, "decimals": self.DEFAULT_TOKEN_DECIMALS}
        self._token_cache[mint_address] = result
        return result

    def _rpc_request(self, method: str, params: list) -> Any:
        """
        Perform a Solana JSON-RPC call via the Helius RPC endpoint.

        Args:
            method: RPC method name (e.g. "getSignaturesForAddress")
            params: RPC positional params list

        Returns:
            The "result" field from the JSON-RPC response.

        Raises:
            RuntimeError: on HTTP or RPC errors after retries.
        """
        url = f"{self.rpc_url}/?api-key={self.api_key}"
        body = {
            "jsonrpc": "2.0",
            "id": f"rpc-{method}",
            "method": method,
            "params": params,
        }
        delay = self.request_delay

        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.post(url, json=body, timeout=30)

                if response.status_code == 429:
                    log.warning(f"⚠️ RPC rate limited (attempt {attempt})")
                    delay *= 2
                    continue
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"RPC HTTP {response.status_code}: {response.text[:200]}"
                    )

                rpc_resp = response.json()
                if "error" in rpc_resp:
                    raise RuntimeError(f"RPC error: {rpc_resp['error']}")

                return rpc_resp.get("result")

            except requests.exceptions.RequestException as e:
                log.warning(f"⚠️ RPC network error (attempt {attempt}): {e}")
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"RPC network error after {self.max_retries} retries: {e}"
                )
            except Exception as e:
                if attempt < self.max_retries:
                    delay *= 2
                    continue
                raise RuntimeError(
                    f"RPC error after {self.max_retries} retries: {e}"
                )

        raise RuntimeError(f"RPC {method} failed after {self.max_retries} retries")

    def _get_wallet_token_accounts(self) -> list[str]:
        """
        Fetch the wallet's SPL token accounts (ATAs) via RPC.

        ``getSignaturesForAddress`` for the wallet address only returns
        transactions where the wallet is a direct account key.  SPL token
        transfers to the wallet go through the Associated Token Account
        (ATA) instead, so we must also query each ATA.

        Returns:
            List of ATA public-key strings owned by the wallet.
        """
        result = self._rpc_request(
            "getTokenAccountsByOwner",
            [
                self.wallet_address,
                {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
                {"encoding": "jsonParsed"},
            ],
        )
        if not result or "value" not in result:
            return []

        return [
            acct["pubkey"]
            for acct in result["value"]
            if acct.get("pubkey")
        ]

    def _fetch_missing_via_rpc(
        self, seen_signatures: set
    ) -> Generator[Dict[str, Any], None, None]:
        """
        Gap-fill: discover recent on-chain signatures via Solana RPC and
        fetch parsed data for any that the Helius enhanced endpoint missed.

        The Helius ``/v0/addresses/{address}/transactions`` endpoint can have
        indexing lag for very recent transactions.  The standard Solana RPC
        ``getSignaturesForAddress`` is always up-to-date, so we use it as a
        cross-check and parse any missing signatures through the Helius
        ``POST /v0/transactions`` parse endpoint.

        Because SPL token transfers reference the Associated Token Account
        (ATA) rather than the wallet address, this method also queries
        ``getSignaturesForAddress`` for each of the wallet's ATAs.

        Args:
            seen_signatures: Set of signatures already yielded by the main loop.

        Yields:
            Parsed transaction dicts for any signatures found on-chain but
            missing from the enhanced endpoint.
        """
        try:
            # Step 1: Collect signatures from the wallet address AND its ATAs
            all_rpc_sigs: set = set()

            # 1a. Wallet address itself (catches native SOL transfers)
            addresses_to_query = [self.wallet_address]

            # 1b. Discover token ATAs owned by this wallet
            try:
                atas = self._get_wallet_token_accounts()
                if atas:
                    log.info(
                        f"   RPC gap-fill: found {len(atas)} token account(s) to scan"
                    )
                    addresses_to_query.extend(atas)
            except Exception as e:
                log.warning(f"   RPC gap-fill: failed to fetch ATAs (non-fatal): {e}")

            # 1c. Query getSignaturesForAddress for each address
            for addr in addresses_to_query:
                rpc_sigs_result = self._rpc_request(
                    "getSignaturesForAddress",
                    [addr, {"limit": self.RPC_GAP_FILL_LIMIT}],
                )
                if not rpc_sigs_result:
                    continue
                for entry in rpc_sigs_result:
                    sig = entry.get("signature")
                    if sig and entry.get("err") is None:
                        all_rpc_sigs.add(sig)

            # Step 2: Find missing signatures
            missing = [sig for sig in all_rpc_sigs if sig not in seen_signatures]

            if not missing:
                log.info("   RPC gap-fill: no missing transactions found")
                return

            log.info(
                f"   RPC gap-fill: {len(missing)} transaction(s) not in enhanced API, fetching..."
            )

            # Step 3: Batch-parse missing signatures via Helius parse endpoint
            for batch_start in range(0, len(missing), self.PARSE_BATCH_SIZE):
                batch = missing[batch_start : batch_start + self.PARSE_BATCH_SIZE]
                parsed = self.safe_request(
                    "/transactions", method="POST", json_body={"transactions": batch}
                )

                if not parsed or not isinstance(parsed, list):
                    log.warning(
                        f"   RPC gap-fill: empty/invalid parse response for batch "
                        f"{batch_start // self.PARSE_BATCH_SIZE + 1}"
                    )
                    continue

                for tx in parsed:
                    sig = tx.get("signature", "")
                    if sig:
                        yield tx

            log.info(
                f"   ✅ RPC gap-fill: recovered {len(missing)} transaction(s)"
            )

        except Exception as e:
            # Gap-fill is best-effort — log and continue without raising
            log.warning(f"   ⚠️ RPC gap-fill failed (non-fatal): {e}")

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Fetch and yield raw transactions with cursor-based pagination.

        After the main Helius enhanced-API pagination, a supplementary
        RPC gap-fill checks ``getSignaturesForAddress`` for any recent
        transactions that have not yet been indexed by the enhanced endpoint,
        and parses them via ``POST /v0/transactions``.
        """
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
                items = data if isinstance(data, list) else data.get("transactions", [])
                for item in items:
                    yield item
                
                log.info(f"🧪 [TEST MODE] Loaded {len(items)} test transactions")
                return
            
            # Live mode: Fetch from API
            self.update_progress(
                operation="Fetching Solana transactions",
                current=0,
                total=1,
                log_message=f"Fetching transactions for {self.wallet_address[:10]}... on Solana"
            )
            
            endpoint = "/addresses/{address}/transactions"
            endpoint = endpoint.replace("{address}", self.wallet_address)
            before_signature = None
            total_items = 0
            page = 0
            seen_signatures: set = set()
            
            while True:
                page += 1
                params = {}
                
                if before_signature:
                    params["before"] = before_signature
                
                result = self.safe_request(endpoint, params)

                # Helius returns an array of transactions
                items = result if isinstance(result, list) else []
                
                if not items:
                    break
                
                # Yield items from this page immediately
                for item in items:
                    sig = item.get("signature")
                    if sig:
                        seen_signatures.add(sig)
                    total_items += 1
                    yield item
                
                log.info(f"   Page {page}: yielded {len(items)} transactions")
                
                # Get the last signature for pagination
                if items:
                    last_tx = items[-1]
                    before_signature = last_tx.get("signature")
                    if not before_signature:
                        break
                else:
                    break

            log.info(
                f"   ✅ Found {total_items} transactions from enhanced API"
            )

            # --- RPC gap-fill: catch recent txs the enhanced API missed ---
            gap_count = 0
            for tx in self._fetch_missing_via_rpc(seen_signatures):
                gap_count += 1
                total_items += 1
                yield tx

            if gap_count:
                log.info(
                    f"   ✅ Total after gap-fill: {total_items} transactions"
                )
            
            self.update_progress(
                operation="Completed",
                current=1,
                total=1,
                log_message=f"✅ Found {total_items} transactions on Solana"
            )
        except Exception as e:
            log.error(f"   ⚠️ Error fetching Solana transactions: {e}")
            self.update_progress(
                operation="Failed",
                current=1,
                total=1,
                log_message=f"❌ Error: {str(e)[:100]}"
            )
            raise

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        """
        Map raw Helius API transaction to standardized format.
        
        One transaction can contain multiple transfers (native SOL, SPL tokens).
        This yields multiple NormalizedTransaction objects per raw transaction.

        Args:
            tx: Raw transaction from Helius API

        Yields:
            NormalizedTransaction: One or more standardized transaction objects
        """
        try:
            # Extract signature (unique transaction ID)
            signature = tx.get("signature")
            if not signature:
                log.warning(f"Missing signature in transaction: {tx}")
                return
            
            # Parse timestamp
            timestamp = tx.get("timestamp")
            if timestamp:
                # Helius returns Unix timestamp
                date_time = datetime.fromtimestamp(timestamp, tz=timezone.utc)
            else:
                log.warning(f"Missing timestamp for tx {signature}")
                date_time = datetime.now(timezone.utc)
            
            # Get transaction type
            tx_type = tx.get("type", "UNKNOWN")
            
            # Get fee information
            fee_lamports = tx.get("fee", 0)
            fee_payer = tx.get("feePayer", "")
            fee_sol = Decimal(fee_lamports) / self.SOL_DIVISOR
            
            # Determine if this wallet paid the fee
            wallet_paid_fee = fee_payer.lower() == self.wallet_address.lower()
            
            # Build set of token account addresses involved in Wrapped SOL
            # (wSOL) transfers. Native SOL transfers to/from these accounts are
            # the funding/defunding of temporary wSOL token accounts and represent
            # the SAME economic flow as the corresponding tokenTransfer — emitting
            # both would double-count the SOL movement.
            token_transfers = tx.get("tokenTransfers", [])
            wsol_token_accounts: set = set()
            for tt in token_transfers:
                if tt.get("mint") == self.WRAPPED_SOL_MINT:
                    from_tok = tt.get("fromTokenAccount", "")
                    to_tok = tt.get("toTokenAccount", "")
                    if from_tok:
                        wsol_token_accounts.add(from_tok)
                    if to_tok:
                        wsol_token_accounts.add(to_tok)

            # Process native transfers
            native_transfers = tx.get("nativeTransfers", [])
            for idx, transfer in enumerate(native_transfers):
                from_address = transfer.get("fromUserAccount", "")
                to_address = transfer.get("toUserAccount", "")
                amount_lamports = transfer.get("amount", 0)
                
                # Filter: only include transfers where wallet is sender or receiver
                if (from_address.lower() != self.wallet_address.lower() and 
                    to_address.lower() != self.wallet_address.lower()):
                    continue
                
                # Skip native transfers to/from Wrapped SOL token accounts.
                # These are SOL funding/defunding temporary wSOL accounts and
                # the actual value movement is already captured in tokenTransfers.
                if wsol_token_accounts and (
                    to_address in wsol_token_accounts or
                    from_address in wsol_token_accounts
                ):
                    log.debug(
                        f"Skipping native transfer {idx} (wSOL account): "
                        f"{from_address[:10]}→{to_address[:10]} {amount_lamports} lamports"
                    )
                    continue
                
                # Skip dust/spam transfers below the threshold.
                # Common spam pattern: 1-lamport transfers from known spam programs.
                if amount_lamports < self.DUST_THRESHOLD_LAMPORTS:
                    log.debug(
                        f"Skipping dust native transfer {idx}: "
                        f"{from_address[:10]}→{to_address[:10]} {amount_lamports} lamports "
                        f"(below threshold {self.DUST_THRESHOLD_LAMPORTS})"
                    )
                    continue
                
                # Determine direction
                direction = self._determine_direction(from_address, to_address)
                
                # Convert lamports to SOL
                amount_sol = Decimal(amount_lamports) / self.SOL_DIVISOR
                
                # Create source_transaction_id
                source_tx_id = f"{signature}_native_{idx}"
                
                yield NormalizedTransaction(
                    # Source identification
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=source_tx_id,
                    network_transaction_id=signature,
                    
                    # Core transaction data
                    date_time=date_time,
                    direction=direction,
                    transaction_type="transfer",
                    source_transaction_type=tx_type,
                    
                    # Asset and amounts
                    source_asset_symbol="SOL",
                    quantity=amount_sol,
                    
                    # No fee on individual transfers
                    fee=Decimal(0),
                    source_fee_quote_asset_symbol="SOL",
                    include_fee=False,
                    
                    # Addresses
                    source_from_account=from_address,
                    source_to_account=to_address,
                    network=normalize_network("solana"),
                    token_contract_address=None,
                )
            
            # Process token transfers (token_transfers already read above for wSOL detection)
            for idx, transfer in enumerate(token_transfers):
                from_address = transfer.get("fromUserAccount", "")
                to_address = transfer.get("toUserAccount", "")
                mint = transfer.get("mint", "")
                token_amount = transfer.get("tokenAmount", 0)
                
                # Filter: only include transfers where wallet is sender or receiver
                if (from_address.lower() != self.wallet_address.lower() and 
                    to_address.lower() != self.wallet_address.lower()):
                    continue
                
                # Determine direction
                direction = self._determine_direction(from_address, to_address)
                
                # Get token metadata (symbol)
                token_metadata = self._get_token_metadata(mint)
                token_symbol = token_metadata["symbol"]
                
                # tokenAmount from Helius is already human-readable (not raw)
                # Use str() to avoid float precision issues with Decimal
                amount = Decimal(str(token_amount))
                
                # Create source_transaction_id
                source_tx_id = f"{signature}_token_{idx}"
                
                yield NormalizedTransaction(
                    # Source identification
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=source_tx_id,
                    network_transaction_id=signature,
                    
                    # Core transaction data
                    date_time=date_time,
                    direction=direction,
                    transaction_type="transfer",
                    source_transaction_type=tx_type,
                    
                    # Asset and amounts
                    source_asset_symbol=token_symbol,
                    quantity=amount,
                    
                    # No fee on individual transfers
                    fee=Decimal(0),
                    source_fee_quote_asset_symbol="SOL",
                    include_fee=False,
                    
                    # Addresses
                    source_from_account=from_address,
                    source_to_account=to_address,
                    network=normalize_network("solana"),
                    token_contract_address=mint,
                )
            
            # Create dedicated fee transaction if this wallet paid the fee
            if wallet_paid_fee and fee_sol > 0:
                yield NormalizedTransaction(
                    # Source identification
                    source=self.connector_name,
                    account_id=self.account_id,
                    source_account=self.wallet_address,
                    source_transaction_id=f"{signature}_fee",
                    network_transaction_id=signature,
                    
                    # Core transaction data
                    date_time=date_time,
                    direction="outflow",
                    transaction_type="technical",
                    source_transaction_type=tx_type,
                    
                    # Asset and amounts (quantity=0 for fee transaction)
                    source_asset_symbol="SOL",
                    quantity=Decimal(0),
                    
                    # Fee information
                    fee=fee_sol,
                    source_fee_quote_asset_symbol="SOL",
                    include_fee=True,
                    
                    # Addresses
                    source_from_account=self.wallet_address,
                    source_to_account=None,
                    network=normalize_network("solana"),
                    token_contract_address=None,
                )
            
        except Exception as e:
            log.error(f"Error normalizing transaction {tx.get('signature', 'unknown')}: {e}")
            raise

    def _determine_direction(self, from_address: str, to_address: str) -> str:
        """
        Determine transaction direction based on addresses.
        
        Args:
            from_address: Sender address
            to_address: Receiver address
            
        Returns:
            Direction: "inflow", "outflow", or "neutral"
        """
        wallet = self.wallet_address.lower()
        from_addr = from_address.lower() if from_address else ""
        to_addr = to_address.lower() if to_address else ""
        
        if from_addr == wallet and to_addr == wallet:
            return "neutral"  # Self-transfer
        elif from_addr == wallet:
            return "outflow"
        elif to_addr == wallet:
            return "inflow"
        else:
            return "neutral"

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address) and bool(self.api_key)

    def get_balance(self):
        import requests
        from decimal import Decimal
        from backend.connectors.base.base_connector import BalanceEntry

        rpc_url = f"https://mainnet.helius-rpc.com/?api-key={self.api_key}"
        entries = []

        # Native SOL balance via RPC
        try:
            resp = requests.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0", "id": 1,
                    "method": "getBalance",
                    "params": [self.wallet_address],
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            lamports = data.get("result", {}).get("value", 0)
            if lamports > 0:
                total = Decimal(lamports) / Decimal(10 ** 9)
                entries.append(BalanceEntry(
                    asset_symbol="SOL",
                    total=total,
                    available=total,
                    chain="solana",
                    raw=data,
                ))
        except Exception as e:
            log.warning(f"Failed to fetch SOL native balance: {e}")

        # SPL token balances via DAS
        try:
            resp = requests.post(
                rpc_url,
                json={
                    "jsonrpc": "2.0", "id": 2,
                    "method": "getAssetsByOwner",
                    "params": {
                        "ownerAddress": self.wallet_address,
                        "displayOptions": {"showFungible": True},
                    },
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            items = data.get("result", {}).get("items", [])
            for item in items:
                token_info = item.get("token_info") or {}
                balance = token_info.get("balance")
                decimals = token_info.get("decimals", 0)
                symbol = token_info.get("symbol") or (
                    item.get("content", {}).get("metadata", {}).get("symbol")
                )
                if balance and int(balance) > 0 and symbol:
                    total = Decimal(balance) / Decimal(10 ** int(decimals))
                    entries.append(BalanceEntry(
                        asset_symbol=symbol,
                        total=total,
                        available=total,
                        chain="solana",
                        raw=item,
                    ))
        except Exception as e:
            log.warning(f"Failed to fetch Solana token balances: {e}")

        return entries
