"""
Ankr connector: wallet history for EVM chains via Ankr's Advanced API.

Combines two Advanced API feeds:
  - ankr_getTransactionsByAddress  → native value transfers + gas fees
  - ankr_getTokenTransfers         → ERC-20 transfers

Internal (contract-initiated) native transfers are not exposed by these endpoints.
Docs: https://www.ankr.com/docs/advanced-api/
"""

import json
import os
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Generator, Optional

import requests

from backend.config.loader import configure_logging
from backend.connectors.base.base_connector import BaseConnector
from backend.core.network_normalizer import normalize_network
from backend.core.spam_detection import (
    _looks_like_phishing_name,
    apply_spam_markers,
    has_suspicious_unicode,
)
from backend.db.models import NormalizedTransaction

log = configure_logging("ankr")

ANKR_MULTICHAIN_URL = "https://rpc.ankr.com/multichain"
PAGE_SIZE = 100

# Our chain name → Ankr "blockchain" identifier
ANKR_CHAINS: Dict[str, str] = {
    "bsc": "bsc",
    "arbitrum": "arbitrum",
    "ethereum": "eth",
    "polygon": "polygon",
    "base": "base",
    "optimism": "optimism",
    "avalanche": "avalanche",
}

NATIVE_TOKENS: Dict[str, str] = {
    "bsc": "BNB",
    "arbitrum": "ETH",
    "ethereum": "ETH",
    "polygon": "POL",
    "base": "ETH",
    "optimism": "ETH",
    "avalanche": "AVAX",
}


def _hex_to_int(value: Any) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, int):
        return value
    return int(str(value), 16) if str(value).startswith("0x") else int(value)


class ConnectorAnkr(BaseConnector):
    """Ankr Advanced API connector (native + ERC-20 history) for EVM chains."""

    @property
    def connector_name(self) -> str:
        return f"ankr_{self.chain_name}"

    def __init__(
        self,
        wallet_address: str = "",
        chain_name: str = "bsc",
        api_key: Optional[str] = None,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        self.chain_name = (chain_name or "").lower()
        self.wallet_address = (wallet_address or "").lower()

        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        if not self.wallet_address:
            raise ValueError("Missing wallet address")
        if self.chain_name not in ANKR_CHAINS:
            raise ValueError(f"Unsupported chain for Ankr: {self.chain_name!r}")

        self.ankr_chain = ANKR_CHAINS[self.chain_name]
        self.request_delay = 0.3
        self.max_retries = 6
        self.api_key = api_key or os.getenv("ANKR_API_KEY")

        if self.test_mode or self.renormalize_mode:
            return

        if not self.api_key:
            raise ValueError("ANKR_API_KEY environment variable not set")
        self.url = f"{ANKR_MULTICHAIN_URL}/{self.api_key}"

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def _rpc(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        delay = self.request_delay
        payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        last_error = None
        for attempt in range(1, self.max_retries + 1):
            try:
                time.sleep(delay)
                response = requests.post(self.url, json=payload, timeout=60)
                if response.status_code == 429 or response.status_code >= 500:
                    last_error = f"HTTP {response.status_code}"
                    log.warning(f"⚠️ Ankr {method} {last_error} (attempt {attempt})")
                    delay *= 2
                    continue
                if response.status_code >= 400:
                    raise RuntimeError(
                        f"Ankr HTTP {response.status_code}: {response.text[:200]}"
                    )
                data = response.json()
                if data.get("error"):
                    raise RuntimeError(f"Ankr {method} error: {data['error']}")
                return data.get("result") or {}
            except requests.exceptions.RequestException as e:
                last_error = str(e)
                log.warning(f"⚠️ Ankr network error (attempt {attempt}): {e}")
                delay *= 2
        raise RuntimeError(
            f"Ankr {method} failed after {self.max_retries} retries: {last_error}"
        )

    def _paginate(self, method: str, params: Dict[str, Any], items_key: str):
        page_token = None
        while True:
            page_params = dict(params, pageSize=PAGE_SIZE)
            if page_token:
                page_params["pageToken"] = page_token
            result = self._rpc(method, page_params)
            for item in result.get(items_key) or []:
                yield item
            page_token = result.get("nextPageToken")
            if not page_token:
                return

    # ------------------------------------------------------------------
    # Fetch
    # ------------------------------------------------------------------

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        if self.test_mode:
            test_file = (
                self.config.get("test_file_path") or self._get_default_test_file()
            )
            log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")
            if not os.path.exists(test_file):
                log.warning(f"Test file not found: {test_file}")
                return
            with open(test_file, "r") as f:
                data = json.load(f)
            yield from self._tag_raws(
                data.get("transactions", []), data.get("transfers", [])
            )
            return

        self.update_progress(
            operation="Fetching wallet history",
            current=0,
            total=2,
            log_message=f"Fetching Ankr history for {self.wallet_address[:10]}... on {self.chain_name}",
        )
        base_params: Dict[str, Any] = {
            "blockchain": self.ankr_chain,
            "descOrder": False,
        }
        if self.since_datetime:
            base_params["fromTimestamp"] = int(self.since_datetime.timestamp())

        txs = list(
            self._paginate(
                "ankr_getTransactionsByAddress",
                dict(base_params, address=self.wallet_address, includeLogs=False),
                "transactions",
            )
        )
        self.update_progress(operation="Fetching token transfers", current=1, total=2)
        transfers = list(
            self._paginate(
                "ankr_getTokenTransfers",
                dict(base_params, address=self.wallet_address),
                "transfers",
            )
        )
        log.info(
            f"   ✅ Ankr {self.chain_name}: {len(txs)} transactions, {len(transfers)} token transfers"
        )
        self.update_progress(
            operation="Completed",
            current=2,
            total=2,
            log_message=f"✅ {len(txs)} transactions, {len(transfers)} token transfers on {self.chain_name}",
        )
        yield from self._tag_raws(txs, transfers)

    def _tag_raws(self, txs, transfers) -> Generator[Dict[str, Any], None, None]:
        # Stored on the raw so spoofed-sender detection still works when renormalizing.
        sent_hashes = {
            (tx.get("hash") or "").lower()
            for tx in txs
            if (tx.get("from") or "").lower() == self.wallet_address
        }
        for tx in txs:
            yield dict(tx, _kind="transaction")
        for tr in transfers:
            yield dict(
                tr,
                _kind="token_transfer",
                _wallet_sent_tx=(tr.get("transactionHash") or "").lower()
                in sent_hashes,
            )

    # ------------------------------------------------------------------
    # Normalize
    # ------------------------------------------------------------------

    def raw_to_normalized(
        self, raw: Dict
    ) -> Generator[NormalizedTransaction, None, None]:
        kind = raw.get("_kind")
        if kind == "transaction":
            yield self._map_transaction(raw)
        elif kind == "token_transfer":
            yield self._map_token_transfer(raw)
        else:
            raise ValueError(f"Unknown Ankr raw kind: {kind!r}")

    def _direction(self, from_addr: str, to_addr: str) -> str:
        if from_addr == self.wallet_address:
            return "outflow"
        if to_addr == self.wallet_address:
            return "inflow"
        return "neutral"

    def _map_transaction(self, tx: Dict) -> NormalizedTransaction:
        tx_hash = (tx.get("hash") or "").lower()
        if not tx_hash:
            raise ValueError(f"Cannot determine transaction hash from '{tx}'")
        native = self._get_native_token()
        from_addr = (tx.get("from") or "").lower()
        to_addr = (tx.get("to") or "").lower() or None
        dt = datetime.fromtimestamp(_hex_to_int(tx.get("timestamp")), tz=timezone.utc)
        succeeded = _hex_to_int(tx.get("status", "0x1")) == 1

        value = (
            Decimal(_hex_to_int(tx.get("value"))) / Decimal(10**18)
            if succeeded
            else Decimal(0)
        )
        gas_price = _hex_to_int(tx.get("effectiveGasPrice") or tx.get("gasPrice"))
        fee = Decimal(_hex_to_int(tx.get("gasUsed")) * gas_price) / Decimal(10**18)

        direction = self._direction(from_addr, to_addr or "")
        paid_fee = fee if from_addr == self.wallet_address else Decimal(0)
        tags = [] if succeeded else [{"failed": True}]

        return NormalizedTransaction(
            source=self.connector_name,
            account_id=self.account_id,
            source_account=self.wallet_address,
            # Value-carrying txs use the _native_ suffix so they never collide with ERC-20 rows.
            source_transaction_id=f"{tx_hash}_native_0" if value > 0 else tx_hash,
            network_transaction_id=tx_hash,
            date_time=dt,
            direction=direction,
            transaction_type="transfer",
            source_transaction_type="native" if value > 0 else "contract_interaction",
            source_asset_symbol=native,
            quantity=float(value),
            fee=float(paid_fee),
            source_fee_quote_asset_symbol=native,
            include_fee=direction == "outflow" and paid_fee > 0,
            source_from_account=from_addr,
            source_to_account=to_addr,
            network=normalize_network(self.chain_name),
            tags=tags,
        )

    def _map_token_transfer(self, tr: Dict) -> NormalizedTransaction:
        tx_hash = (tr.get("transactionHash") or "").lower()
        if not tx_hash:
            raise ValueError(f"Cannot determine transaction hash from '{tr}'")
        from_addr = (tr.get("fromAddress") or "").lower()
        to_addr = (tr.get("toAddress") or "").lower()
        symbol = tr.get("tokenSymbol") or "UNKNOWN"
        name = tr.get("tokenName") or ""
        decimals = int(tr.get("tokenDecimals") or 18)
        raw_int = tr.get("valueRawInteger")
        quantity = (
            Decimal(raw_int) / Decimal(10**decimals)
            if raw_int not in (None, "")
            else Decimal(tr.get("value") or 0)
        )
        source_transaction_id = f"{tx_hash}_erc20_{tr.get('logIndex', 0)}"
        tags: list = []

        normalized = NormalizedTransaction(
            source=self.connector_name,
            account_id=self.account_id,
            source_account=self.wallet_address,
            source_transaction_id=source_transaction_id,
            network_transaction_id=tx_hash,
            date_time=datetime.fromtimestamp(
                int(tr.get("timestamp") or 0), tz=timezone.utc
            ),
            direction=self._direction(from_addr, to_addr),
            transaction_type="transfer",
            source_transaction_type="erc20",
            source_asset_symbol=symbol,
            quantity=float(quantity),
            fee=0.0,
            source_fee_quote_asset_symbol=self._get_native_token(),
            include_fee=False,
            source_from_account=from_addr,
            source_to_account=to_addr,
            token_contract_address=(tr.get("contractAddress") or "").lower(),
            network=normalize_network(self.chain_name),
            tags=tags,
        )

        reasons = []
        if has_suspicious_unicode(symbol) or has_suspicious_unicode(name):
            reasons.append("confusable_unicode")
        if _looks_like_phishing_name(name) or _looks_like_phishing_name(symbol):
            reasons.append("phishing_contract_name")
        if from_addr == self.wallet_address and not tr.get("_wallet_sent_tx", True):
            reasons.append("spoofed_sender")
        if reasons:
            apply_spam_markers(
                normalized, reasons=reasons, tags=tags, tx_id=source_transaction_id
            )
        return normalized

    def _get_native_token(self) -> str:
        return NATIVE_TOKENS.get(self.chain_name, "ETH")

    def _get_default_test_file(self) -> str:
        backend_dir = os.path.dirname(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        )
        return os.path.join(
            backend_dir,
            "tests",
            "fixtures",
            "ankr",
            f"wallet_history_{self.chain_name}.json",
        )

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address) and bool(self.api_key)

    def get_balance(self):
        from backend.connectors.base.base_connector import BalanceEntry

        result = self._rpc(
            "ankr_getAccountBalance",
            {
                "blockchain": self.ankr_chain,
                "walletAddress": self.wallet_address,
                "onlyWhitelisted": False,
            },
        )
        entries = []
        for asset in result.get("assets") or []:
            total = Decimal(str(asset.get("balance") or "0"))
            if total <= 0:
                continue
            entries.append(
                BalanceEntry(
                    asset_symbol=asset.get("tokenSymbol") or "UNKNOWN",
                    total=total,
                    available=total,
                    chain=self.chain_name,
                    raw=asset,
                )
            )
        return entries
