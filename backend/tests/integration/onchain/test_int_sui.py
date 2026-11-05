"""
Integration tests for SUI connector (live API).
Moved from tests/unit/connectors/test_sui_integration.py.
Uses the public Sui GraphQL endpoint (override with SUI_GRAPHQL_URL); no API key needed.
"""

import pytest
from decimal import Decimal
from backend.connectors.onchain.connector_sui import ConnectorSui


@pytest.mark.integration
@pytest.mark.timeout(60)
class TestSuiIntegration:
    """Integration tests using the real Sui GraphQL API."""

    WALLET_ADDRESS = (
        "0xe1c3e2e854f4cc06e15e168acd38e3a2b61a050c2f622894ed00350de6b8c039"
    )

    @pytest.fixture
    def connector(self):
        return ConnectorSui(
            wallet_address=self.WALLET_ADDRESS,
            account_id=1,
            connector_id=1,
            config={"test_mode": False},
        )

    def test_real_api_fetch_transactions(self, connector):
        """Test fetching real transactions from SUI RPC API."""
        transactions = []
        for tx in connector.yield_raws():
            transactions.append(tx)
            if len(transactions) >= 5:
                break

        assert len(transactions) > 0, "Should fetch at least one transaction"
        for tx in transactions:
            assert "digest" in tx
            assert "timestampMs" in tx
            assert "effects" in tx

    def test_real_api_normalization(self, connector):
        """Test normalization of real transactions."""
        raw_tx = None
        for tx in connector.yield_raws():
            status = tx.get("effects", {}).get("status", {}).get("status", "")
            if status == "success" and tx.get("balanceChanges"):
                raw_tx = tx
                break

        assert raw_tx is not None, "Should fetch at least one successful transaction"
        normalized = list(connector.raw_to_normalized(raw_tx))
        assert len(normalized) > 0

        for norm_tx in normalized:
            assert norm_tx.source == "sui"
            assert norm_tx.network == "sui"
            assert norm_tx.network_transaction_id == raw_tx["digest"]
            assert norm_tx.direction in ["inflow", "outflow", "neutral"]
            assert isinstance(norm_tx.quantity, Decimal)
            assert isinstance(norm_tx.fee, Decimal)

    def test_real_api_fee_handling(self, connector):
        """Test fee transaction handling with real data."""
        wallet_lower = connector.wallet_address.lower()
        fee_tx_raw = None

        for tx in connector.yield_raws():
            sender = tx.get("transaction", {}).get("data", {}).get("sender", "").lower()
            status = tx.get("effects", {}).get("status", {}).get("status", "")
            if sender == wallet_lower and status == "success":
                fee_tx_raw = tx
                break

        if fee_tx_raw is None:
            pytest.skip("No transactions where wallet is sender found")

        normalized = list(connector.raw_to_normalized(fee_tx_raw))
        fee_transactions = [t for t in normalized if t.transaction_type == "cost"]

        assert len(fee_transactions) == 1
        fee_tx = fee_transactions[0]
        assert fee_tx.direction == "outflow"
        assert fee_tx.quantity > 0
        assert fee_tx.price == Decimal(1)
        assert fee_tx.source_asset_symbol == "SUI"

    def test_real_api_coin_metadata(self, connector):
        """Test coin metadata resolution with real API."""
        symbol, decimals = connector._resolve_coin_metadata("0x2::sui::SUI")
        assert symbol == "SUI"
        assert decimals == 9
