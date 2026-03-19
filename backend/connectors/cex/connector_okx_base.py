"""
OKX Base connector: Common functionality for all OKX connectors.
Uses CCXT library for API access.
"""

import ccxt
import time
from abc import abstractmethod
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.connectors.base.connector_exceptions import (
    ConnectorAPIError,
    ErrorReason,
)
from backend.config.loader import configure_logging, load_credentials


class OKXBaseConnector(BaseConnector):
    """
    Base class for all OKX connectors (deposits, withdrawals, transactions).
    
    Provides common functionality including:
    - CCXT exchange initialization with rate limiting
    - Credentials loading from settings.yaml
    - Balance fetching to identify user's currencies
    - Pagination using 'after' parameter (billId-based)
    - Common error handling
    
    OKX API Rate Limits:
    - REST API: 20 requests/2s per endpoint (10 req/s)
    - CCXT enableRateLimit handles automatic throttling
    """

    def __init__(
        self,
        api_key: str = None,
        api_secret: str = None,
        api_passphrase: str = None,
        account_id: int = None,
        connector_id: int = None,
        currencies: List[str] = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """Initialize OKX connector with API credentials from settings.yaml if not provided."""
        super().__init__(account_id=account_id, connector_id=connector_id, config=config, progress_callback=progress_callback)

        # Store filters - from parameter or config (for override support)
        self._currencies_filter = currencies or (config.get("currencies") if config else None)

        # In test/renormalize mode, skip all API configuration
        if self.test_mode or self.renormalize_mode:
            return

        # Load credentials from settings.yaml if not provided
        if api_key is None or api_secret is None or api_passphrase is None:
            creds = load_credentials("okx")
            api_key = creds.get("api_key")
            api_secret = creds.get("api_secret")
            api_passphrase = creds.get("api_passphrase")

        self.api_key = api_key
        self.api_secret = api_secret
        self.api_passphrase = api_passphrase

        # Validate configuration
        if not self.api_key or not self.api_secret or not self.api_passphrase:
            raise ValueError("Missing API credentials for OKX")

        # Initialize CCXT exchange
        try:
            self.exchange = ccxt.myokx(
                {
                    "apiKey": self.api_key,
                    "secret": self.api_secret,
                    "password": self.api_passphrase,
                    "enableRateLimit": True,
                }
            )
            self.exchange.load_markets()
            self._get_logger().info(f"✅ OKX exchange initialized successfully for {self.connector_name}")
        except Exception as e:
            self._get_logger().error(f"❌ Failed to initialize OKX exchange: {e}")
            raise

    @abstractmethod
    def _get_logger(self):
        """Return the logger instance for this connector."""
        pass

    def _get_transaction_type(self) -> str:
        """Return the transaction type ('withdrawal', 'deposit', or 'transaction'). Can be overridden."""
        return "transaction"

    @abstractmethod
    def _fetch_transactions(self, code: str, since: int, limit: int, params: Dict) -> List[Dict[str, Any]]:
        """Fetch transactions from OKX API. Must be implemented by subclasses."""
        pass

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Fetch transactions from OKX and yield them as they are fetched.
        Uses OKX 'after' parameter (billId) for pagination.
        
        Yields:
            Dict[str, Any]: Transaction objects as they are fetched
        """
        log = self._get_logger()
        transaction_type = self._get_transaction_type()
        
        log.info(f"🔄 Fetching {transaction_type}s from OKX API using CCXT...")
        
        since_ms = self.since_timestamp_ms
        after = None
        limit = None#100
        total_count = 0
        seen_ids = set()
        
        self.update_progress(
            operation=f"Fetching {transaction_type}s",
            current=0,
            total=1,
            log_message=f"Fetching {transaction_type}s from OKX...",
            fetched_count=0,
        )
        
        while True:
            # Check for abort
            if self.is_abort_requested():
                log.info(f"⚠️ Abort requested, stopping OKX {transaction_type} fetching")
                break
            
            try:
                params = {}
                if after:
                    params["after"] = after
                
                # Fetch transactions (currency is optional for deposits/withdrawals)
                transactions = self._fetch_transactions(
                    code=None, 
                    since=since_ms, 
                    limit=limit, 
                    params=params
                )
                
                # Handle None or empty result
                if not transactions:
                    log.debug(f"No more {transaction_type}s to fetch")
                    break
                
                first_trx = transactions[0]
                last_trx = transactions[-1]
                
                # Update 'after' parameter for next page using billId from first transaction
                after = first_trx.get("info", {}).get("billId")
                
                # Yield new transactions
                fetched_new_trxs = False
                for trx in transactions:
                    trx_id = trx.get("id")
                    trx_timestamp = trx.get("timestamp")
                    
                    # Skip transactions before since timestamp if incremental sync
                    if since_ms and trx_timestamp and trx_timestamp < since_ms:
                        continue
                    
                    # Skip duplicates
                    if trx_id and trx_id not in seen_ids:
                        fetched_new_trxs = True
                        seen_ids.add(trx_id)
                        total_count += 1
                        yield trx
                
                # If all transactions in batch are before since timestamp, we can stop
                if since_ms and last_trx.get("timestamp", 0) < since_ms:
                    log.debug(f"Reached {transaction_type}s before since datetime, stopping pagination")
                    break
                
                if not fetched_new_trxs:
                    log.debug(f"No new {transaction_type}s found")
                    break
                    
            except Exception as e:
                error_str = str(e).lower()
                
                # Legitimate empty result
                if "no data" in error_str or "empty" in error_str:
                    log.debug(f"ℹ️ No {transaction_type}s found (legitimate empty result)")
                    break
                
                # Authentication errors - non-retryable
                if "401" in error_str or "unauthorized" in error_str or "invalid api key" in error_str:
                    log.error(f"❌ Authentication failed for OKX {transaction_type}s: {e}")
                    raise ConnectorAPIError(
                        message="Authentication failed - check API credentials",
                        connector_name=self.connector_name,
                        operation=f"fetch_{transaction_type}s",
                        reason=ErrorReason.AUTHENTICATION_FAILED,
                        http_status_code=401,
                        retryable=False,
                        original_error=e,
                    )
                
                if "403" in error_str or "forbidden" in error_str or "permission" in error_str:
                    log.error(f"❌ Permission denied for OKX {transaction_type}s: {e}")
                    raise ConnectorAPIError(
                        message="Permission denied - insufficient API key permissions",
                        connector_name=self.connector_name,
                        operation=f"fetch_{transaction_type}s",
                        reason=ErrorReason.PERMISSION_DENIED,
                        http_status_code=403,
                        retryable=False,
                        original_error=e,
                    )
                
                # Rate limiting
                if "429" in error_str or "rate limit" in error_str or "too many requests" in error_str:
                    log.error(f"❌ Rate limited on OKX {transaction_type}s: {e}")
                    raise ConnectorAPIError(
                        message="Rate limited by OKX API",
                        connector_name=self.connector_name,
                        operation=f"fetch_{transaction_type}s",
                        reason=ErrorReason.RATE_LIMITED,
                        http_status_code=429,
                        retryable=True,
                        original_error=e,
                    )
                
                # Network/timeout errors
                if "timeout" in error_str or "timed out" in error_str:
                    log.error(f"❌ Timeout fetching OKX {transaction_type}s: {e}")
                    raise ConnectorAPIError(
                        message="Request timeout",
                        connector_name=self.connector_name,
                        operation=f"fetch_{transaction_type}s",
                        reason=ErrorReason.TIMEOUT,
                        retryable=True,
                        original_error=e,
                    )
                
                if "connection" in error_str or "network" in error_str:
                    log.error(f"❌ Network error fetching OKX {transaction_type}s: {e}")
                    raise ConnectorAPIError(
                        message="Network connection error",
                        connector_name=self.connector_name,
                        operation=f"fetch_{transaction_type}s",
                        reason=ErrorReason.NETWORK_ERROR,
                        retryable=True,
                        original_error=e,
                    )
                
                # Generic API error
                log.error(f"❌ API error fetching OKX {transaction_type}s: {e}")
                raise ConnectorAPIError(
                    message="API request failed",
                    connector_name=self.connector_name,
                    operation=f"fetch_{transaction_type}s",
                    reason=ErrorReason.API_ERROR,
                    retryable=False,
                    original_error=e,
                    details=str(e),
                )
        
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Fetched {total_count} {transaction_type}s from OKX",
            fetched_count=total_count,
        )

    # Inherits yield_normalized from BaseConnector
