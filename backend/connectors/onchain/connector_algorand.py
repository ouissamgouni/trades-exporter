"""
Algorand connector: ALGO + ASA transfers for a wallet via the public Nodely Indexer (no API key).
Inner transactions (DEX swaps, app payouts) are flattened into legs sharing the parent tx id.
"""

import json
import os
import time
import requests
from decimal import Decimal
from datetime import datetime, timezone
from typing import Dict, Any, Generator, List, Optional

from backend.connectors.base.base_connector import BaseConnector, BalanceEntry
from backend.connectors.connector_registry import get_connector_registry
from backend.config.loader import configure_logging
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction

log = configure_logging("algorand")

INDEXER_URL = "https://mainnet-idx.4160.nodely.dev/v2"
ALGOD_URL = "https://mainnet-api.4160.nodely.dev/v2"
PAGE_LIMIT = 1000


class ConnectorAlgorand(BaseConnector):
    """Algorand wallet connector (pay / axfer incl. close-outs, inner txns, rewards, fees)."""

    @property
    def connector_name(self) -> str:
        return "algorand"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        self.chain_name = "algorand"
        self.wallet_address = (wallet_address or "").strip()

        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        if not self.wallet_address:
            raise ValueError("Missing wallet address")

        registry = get_connector_registry()
        self.native_token = registry.get_native_token("algorand", "algorand")
        self.native_decimals = registry.get_native_token_decimals("algorand", "algorand")
        if not self.native_token or self.native_decimals is None:
            raise ValueError("Chain configuration not found for algorand")

        self._asset_cache: Dict[int, Dict[str, Any]] = {}
        self.request_delay = 0.1
        self.max_retries = 5
        self.indexer_url = (self.config or {}).get("indexer_url") or INDEXER_URL
        self.algod_url = (self.config or {}).get("algod_url") or ALGOD_URL

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def safe_request(self, url: str, params: Dict = None) -> Any:
        delay = self.request_delay
        for attempt in range(1, self.max_retries + 1):
            time.sleep(delay)
            try:
                response = requests.get(url, params=params or {}, timeout=30)
            except requests.exceptions.RequestException as e:
                log.warning(f"⚠️ Network error (attempt {attempt}): {e}")
                delay *= 2
                continue
            if response.status_code == 429 or response.status_code >= 500:
                log.warning(f"⚠️ HTTP {response.status_code} (attempt {attempt})")
                delay *= 2
                continue
            if response.status_code >= 400:
                raise RuntimeError(f"HTTP {response.status_code}: {response.text[:200]}")
            return response.json()
        raise RuntimeError(f"Algorand request failed after {self.max_retries} retries: {url}")

    # ------------------------------------------------------------------
    # Fixtures
    # ------------------------------------------------------------------

    def _fixture_dir(self) -> str:
        return os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "algorand")

    def _get_default_test_file(self) -> str:
        return os.path.join(self._fixture_dir(), "algorand_transactions.json")

    # ------------------------------------------------------------------
    # Asset metadata
    # ------------------------------------------------------------------

    def _get_asset(self, asset_id: int) -> Dict[str, Any]:
        if asset_id in self._asset_cache:
            return self._asset_cache[asset_id]

        params: Dict[str, Any] = {}
        if self.test_mode:
            path = os.path.join(self._fixture_dir(), "algorand_assets.json")
            if os.path.exists(path):
                with open(path) as f:
                    params = json.load(f).get(str(asset_id), {})
        else:
            try:
                params = self.safe_request(f"{self.indexer_url}/assets/{asset_id}").get("asset", {}).get("params", {})
            except RuntimeError as e:
                log.warning(f"Failed to fetch ASA {asset_id} metadata: {e}")

        meta = {
            "symbol": params.get("unit-name") or params.get("name") or str(asset_id),
            "decimals": int(params.get("decimals", 0)),
        }
        self._asset_cache[asset_id] = meta
        return meta

    # ------------------------------------------------------------------
    # Fetch
    # ------------------------------------------------------------------

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        if self.test_mode:
            test_file = self.config.get("test_file_path") or self._get_default_test_file()
            log.info(f"🧪 [TEST MODE] Loading test data from {test_file}")
            if not os.path.exists(test_file):
                log.warning(f"Test file not found: {test_file}")
                return
            with open(test_file) as f:
                data = json.load(f)
            items = data if isinstance(data, list) else data.get("transactions", [])
            yield from items
            return

        self.update_progress(
            operation="Fetching Algorand transactions",
            current=0,
            total=1,
            log_message=f"Fetching transactions for {self.wallet_address[:10]}... on Algorand",
        )
        url = f"{self.indexer_url}/accounts/{self.wallet_address}/transactions"
        next_token = None
        total = 0
        while True:
            params: Dict[str, Any] = {"limit": PAGE_LIMIT}
            if next_token:
                params["next"] = next_token
            result = self.safe_request(url, params)
            items = result.get("transactions", [])
            for item in items:
                total += 1
                yield item
            next_token = result.get("next-token")
            if not items or not next_token:
                break

        log.info(f"   ✅ Found {total} transactions on Algorand")
        self.update_progress(
            operation="Completed",
            current=1,
            total=1,
            log_message=f"✅ Found {total} transactions on Algorand",
        )

    # ------------------------------------------------------------------
    # Normalize
    # ------------------------------------------------------------------

    def raw_to_normalized(self, tx: Dict) -> Generator[NormalizedTransaction, None, None]:
        tx_id = tx.get("id")
        if not tx_id:
            raise ValueError(f"Cannot determine Algorand transaction id from '{tx}'")

        round_time = tx.get("round-time")
        date_time = (
            datetime.fromtimestamp(round_time, tz=timezone.utc) if round_time else datetime.now(timezone.utc)
        )
        tags = [{"round": tx.get("confirmed-round")}]
        if tx.get("group"):
            tags.append({"group": tx["group"]})

        legs: List[Dict[str, Any]] = []
        self._collect_legs(tx, "0", legs)

        for leg in legs:
            yield NormalizedTransaction(
                source=self.connector_name,
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=f"{tx_id}_{leg['key']}",
                network_transaction_id=tx_id,
                date_time=date_time,
                direction=leg["direction"],
                transaction_type="transfer",
                source_transaction_type=leg["type"],
                source_asset_symbol=leg["symbol"],
                quantity=leg["quantity"],
                fee=Decimal(0),
                source_fee_quote_asset_symbol=self.native_token,
                include_fee=False,
                source_from_account=leg["from"],
                source_to_account=leg["to"],
                network=normalize_network(self.chain_name),
                token_contract_address=leg["contract"],
                tags=tags,
            )

        fee = Decimal(tx.get("fee", 0)) / Decimal(10 ** self.native_decimals)
        if tx.get("sender") == self.wallet_address and fee > 0:
            yield NormalizedTransaction(
                source=self.connector_name,
                account_id=self.account_id,
                source_account=self.wallet_address,
                source_transaction_id=f"{tx_id}_fee",
                network_transaction_id=tx_id,
                date_time=date_time,
                direction="outflow",
                transaction_type="cost",
                source_transaction_type=tx.get("tx-type", "").upper(),
                source_asset_symbol=self.native_token,
                quantity=fee,
                price=Decimal(1),
                source_price_quote_asset_symbol=self.native_token,
                include_fee=False,
                source_from_account=self.wallet_address,
                source_to_account=None,
                network=normalize_network(self.chain_name),
                token_contract_address=None,
                tags=tags,
            )

    def _collect_legs(self, tx: Dict, path: str, legs: List[Dict[str, Any]]) -> None:
        if tx.get("tx-type") == "pay":
            pay = tx.get("payment-transaction", {})
            sender = tx.get("sender", "")
            close_amount = pay.get("close-amount", tx.get("closing-amount", 0))
            self._add_leg(legs, f"{path}_pay", "PAY", sender, pay.get("receiver", ""), pay.get("amount", 0), None)
            self._add_leg(legs, f"{path}_close", "PAY_CLOSE", sender, pay.get("close-remainder-to", ""), close_amount, None)
        elif tx.get("tx-type") == "axfer":
            xfer = tx.get("asset-transfer-transaction", {})
            # Clawback transfers carry the debited account in asset-transfer-transaction.sender
            sender = xfer.get("sender") or tx.get("sender", "")
            asset_id = xfer.get("asset-id")
            self._add_leg(legs, f"{path}_axfer", "AXFER", sender, xfer.get("receiver", ""), xfer.get("amount", 0), asset_id)
            self._add_leg(legs, f"{path}_aclose", "AXFER_CLOSE", sender, xfer.get("close-to", ""), xfer.get("close-amount", 0), asset_id)

        # Pre-2022 participation rewards are credited on any tx touching the account
        if tx.get("sender") == self.wallet_address:
            self._add_reward(legs, f"{path}_srew", tx.get("sender-rewards", 0))
        if tx.get("payment-transaction", {}).get("receiver") == self.wallet_address:
            self._add_reward(legs, f"{path}_rrew", tx.get("receiver-rewards", 0))
        if tx.get("payment-transaction", {}).get("close-remainder-to") == self.wallet_address:
            self._add_reward(legs, f"{path}_crew", tx.get("close-rewards", 0))

        for idx, inner in enumerate(tx.get("inner-txns") or []):
            self._collect_legs(inner, f"{path}.{idx}", legs)

    def _add_leg(self, legs, key, tx_type, sender, receiver, amount, asset_id) -> None:
        if not amount or not receiver:
            return
        outgoing = sender == self.wallet_address
        incoming = receiver == self.wallet_address
        if outgoing == incoming:
            return
        if asset_id is None:
            symbol, decimals, contract = self.native_token, self.native_decimals, None
        else:
            meta = self._get_asset(asset_id)
            symbol, decimals, contract = meta["symbol"], meta["decimals"], str(asset_id)
        legs.append({
            "key": key,
            "type": tx_type,
            "direction": "outflow" if outgoing else "inflow",
            "symbol": symbol,
            "quantity": Decimal(amount) / Decimal(10 ** decimals),
            "from": sender,
            "to": receiver,
            "contract": contract,
        })

    def _add_reward(self, legs, key, amount) -> None:
        if not amount:
            return
        legs.append({
            "key": key,
            "type": "REWARD",
            "direction": "inflow",
            "symbol": self.native_token,
            "quantity": Decimal(amount) / Decimal(10 ** self.native_decimals),
            "from": None,
            "to": self.wallet_address,
            "contract": None,
        })

    # ------------------------------------------------------------------
    # Balance API
    # ------------------------------------------------------------------

    @property
    def supports_balance(self) -> bool:
        return bool(self.wallet_address)

    def get_balance(self) -> List[BalanceEntry]:
        try:
            data = self.safe_request(f"{self.algod_url}/accounts/{self.wallet_address}")
        except RuntimeError as e:
            log.warning(f"Failed to fetch Algorand balance: {e}")
            return []

        entries: List[BalanceEntry] = []
        algo = Decimal(data.get("amount", 0)) / Decimal(10 ** self.native_decimals)
        if algo > 0:
            min_balance = Decimal(data.get("min-balance", 0)) / Decimal(10 ** self.native_decimals)
            entries.append(BalanceEntry(
                asset_symbol=self.native_token,
                total=algo,
                available=max(algo - min_balance, Decimal(0)),
                locked=min(min_balance, algo),
                chain="algorand",
                raw={k: v for k, v in data.items() if k != "assets"},
            ))
        for holding in data.get("assets") or []:
            amount = holding.get("amount", 0)
            if not amount:
                continue
            asset_id = holding.get("asset-id")
            meta = self._get_asset(asset_id)
            total = Decimal(amount) / Decimal(10 ** meta["decimals"])
            entries.append(BalanceEntry(
                asset_symbol=meta["symbol"],
                total=total,
                available=total,
                chain="algorand",
                contract_address=str(asset_id),
                raw=holding,
            ))
        return entries
