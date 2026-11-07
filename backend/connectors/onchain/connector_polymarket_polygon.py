"""
Polymarket Polygon connector: Captures external USDC deposits/withdrawals
to/from the Polymarket proxy wallet on Polygon.

Uses Ankr's Advanced API token transfers, filtering at yield_raws() level to
exclude Polymarket-internal transfers (trades, redemptions, CTF token burns).
Only external USDC movements pass through.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, Generator

from backend.config.loader import configure_logging
from backend.connectors.onchain.connector_ankr import ConnectorAnkr
from backend.core.network_normalizer import normalize_network
from backend.db.models import NormalizedTransaction, ensure_utc

log = configure_logging("polymarket_polygon")

# Known Polymarket contract addresses on Polygon.
# Transfers involving these are Polymarket-internal (trade settlement,
# redemption payouts, CTF token minting/burning) — already captured
# by the Polymarket Data API connector.
POLYMARKET_CONTRACTS = {
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",  # CTF Exchange
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",  # Neg Risk CTF Exchange
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",  # Conditional Tokens Framework
    "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2",  # Conditional Tokens Framework
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",  # UMA CTF Adapter
    "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",  # pUSD wrapper (USDC.e -> pUSD 1:1 collateral migration)
    "0x0000000000000000000000000000000000000000",  # Zero / burn address
}

# Contract → symbol, matching the symbols stored by the former Blockscout source.
USDC_CONTRACTS = {
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": "USDC.E",  # Bridged USDC (Polymarket collateral)
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",  # Native USDC
    # Polymarket USD: 1:1 USDC.e-backed collateral; same symbol so lots continue across the wrap.
    "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb": "USDC.E",
}


class ConnectorPolymarketPolygon(ConnectorAnkr):
    """
    Ankr Polygon token transfers filtered to external USDC deposits/withdrawals.

    Filtering happens in yield_raws() — NOT raw_to_normalized() — because
    returning None from raw_to_normalized() crashes the hub pipeline
    (BaseHubConnector.raw_to_normalized raises ValueError on None).
    """

    @property
    def connector_name(self) -> str:
        return "polymarket_polygon"

    def __init__(
        self,
        wallet_address: str = "",
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        **kwargs,
    ):
        self.source_account = wallet_address
        super().__init__(
            wallet_address=wallet_address,
            chain_name="polygon",
            account_id=account_id,
            connector_id=connector_id,
            config=config,
        )

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        if self.test_mode:
            return

        params: Dict[str, Any] = {
            "blockchain": self.ankr_chain,
            "address": self.wallet_address,
            "descOrder": False,
        }
        if self.since_datetime:
            params["fromTimestamp"] = int(ensure_utc(self.since_datetime).timestamp())

        kept = 0
        for transfer in self._paginate("ankr_getTokenTransfers", params, "transfers"):
            if self._is_external_usdc(transfer):
                kept += 1
                yield dict(transfer, _kind="token_transfer")
        log.info(f"   ✅ Polymarket Polygon: {kept} external USDC transfers")

    @staticmethod
    def _is_external_usdc(transfer: Dict[str, Any]) -> bool:
        tx_from = (transfer.get("fromAddress") or "").lower()
        tx_to = (transfer.get("toAddress") or "").lower()
        if tx_from in POLYMARKET_CONTRACTS or tx_to in POLYMARKET_CONTRACTS:
            return False
        return (transfer.get("contractAddress") or "").lower() in USDC_CONTRACTS

    def raw_to_normalized(self, raw: Dict) -> NormalizedTransaction:
        if raw.get("_kind") == "token_transfer":
            return self._map_usdc_transfer(raw)
        if "token" in raw and "total" in raw:
            # Legacy Blockscout raws stored before the move to Ankr (renormalize).
            return self._legacy_blockscout_mapper().raw_to_normalized(raw)
        raise ValueError(f"Unknown Polymarket Polygon raw: {list(raw)[:5]}")

    def _map_usdc_transfer(self, tr: Dict[str, Any]) -> NormalizedTransaction:
        tx_hash = tr.get("transactionHash") or ""
        tx_from = tr.get("fromAddress") or ""
        tx_to = tr.get("toAddress") or ""
        contract = tr.get("contractAddress") or ""
        symbol = USDC_CONTRACTS.get(
            contract.lower(), (tr.get("tokenSymbol") or "USDC").upper()
        )
        decimals = int(tr.get("tokenDecimals") or 6)
        quantity = Decimal(str(tr.get("valueRawInteger") or 0)) / Decimal(10**decimals)
        direction = "outflow" if tx_from.lower() == self.wallet_address else "inflow"

        # Same id/field layout as the former Blockscout source so existing rows are upserted, not duplicated.
        return NormalizedTransaction(
            source="polymarket_polygon",
            account_id=self.account_id,
            source_account=self.source_account,
            source_transaction_id=f"{tx_hash}_{tr.get('logIndex', '')}",
            network_transaction_id=tx_hash,
            date_time=datetime.fromtimestamp(
                int(tr.get("timestamp") or 0), tz=timezone.utc
            ),
            direction=direction,
            transaction_type="transfer",
            source_transaction_type="deposit"
            if direction == "inflow"
            else "withdrawal",
            source_asset_symbol=symbol,
            quantity=float(quantity),
            fee=0.0,
            source_fee_quote_asset_symbol="POL",
            include_fee=direction == "outflow",
            source_from_account=tx_from,
            source_to_account=tx_to,
            network=normalize_network("polygon"),
            token_contract_address=contract,
            tags={
                "contract_address": contract,
                "token_symbol": symbol,
                "token_name": tr.get("tokenName") or "",
            },
        )

    def _legacy_blockscout_mapper(self):
        if not hasattr(self, "_blockscout_mapper"):
            from backend.connectors.onchain.blockscout.connector_blockscout_token_transfers import (
                ConnectorBlockscoutTokenTransfers,
            )

            mapper = ConnectorBlockscoutTokenTransfers(
                wallet_address=self.source_account,
                chain_name="polygon",
                account_id=self.account_id,
                connector_id=self.connector_id,
                config={"renormalize_mode": True, "disable_file_output": True},
            )
            original = mapper.raw_to_normalized

            def mapped(raw):
                normalized = original(raw)
                normalized.source = "polymarket_polygon"
                normalized.source_transaction_type = (
                    "deposit" if normalized.direction == "inflow" else "withdrawal"
                )
                return normalized

            mapper.raw_to_normalized = mapped
            self._blockscout_mapper = mapper
        return self._blockscout_mapper

    def get_balance(self):
        entries = [
            entry
            for entry in super().get_balance()
            if (entry.raw.get("contractAddress") or "").lower() in USDC_CONTRACTS
        ]
        for entry in entries:
            entry.asset_symbol = "USDC"
            entry.raw = {"source": "wallet_cash", **entry.raw}
        return entries
