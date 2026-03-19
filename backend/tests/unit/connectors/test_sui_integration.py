"""
Integration tests for SUI connector.

Includes:
- Unit tests using fixture data (always run)
- Live API integration tests (require SUI_RPC_URL or ANKR_API_KEY env var)
"""

import os
import json
import pytest
from decimal import Decimal
from backend.connectors.onchain.connector_sui import ConnectorSui


# ==================== Fixture-Based Unit Tests ====================

FIXTURE_WALLET = "0xaa79c13bdb08ae78e4db1fc04227fe0b5bfcab4c39ef078b4ea77b048c55caeb"

# Expected counterparty addresses from fixture data
FIXTURE_SENDER_TX1 = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
FIXTURE_RECIPIENT_TX2 = "0xbbbb567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
FIXTURE_DEX_USDC_TX3 = "0xdddd567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"


class TestSuiFixture:
    """Unit tests using fixture data — always run, no API key needed."""

    @pytest.fixture
    def connector(self):
        """Create a test-mode connector instance."""
        return ConnectorSui(
            wallet_address=FIXTURE_WALLET,
            account_id=1,
            connector_id=1,
            config={"test_mode": True},
        )

    def test_yield_raws_loads_fixture(self, connector):
        """Test that yield_raws loads all transactions from the fixture file."""
        transactions = list(connector.yield_raws())

        assert len(transactions) == 5, "Fixture should contain 5 transactions"

        # Verify each transaction has a digest and timestampMs
        for tx in transactions:
            assert "digest" in tx, "Transaction should have digest"
            assert "timestampMs" in tx, "Transaction should have timestampMs"
            assert "effects" in tx, "Transaction should have effects"
            assert "balanceChanges" in tx, "Transaction should have balanceChanges"

    def test_normalize_inflow(self, connector):
        """Test normalization of an inflow transaction (wallet receives SUI)."""
        transactions = list(connector.yield_raws())
        # First tx: inflow of 5 SUI
        inflow_tx = transactions[0]
        assert inflow_tx["digest"] == "3GYRx3KMhBsfDqm3CBEZpiMbSjKHD3GEpHTDhFxU7GQp"

        normalized = list(connector.raw_to_normalized(inflow_tx))

        # Should yield exactly 1 transfer (inflow) — no fee tx since wallet didn't pay gas
        transfer_txs = [t for t in normalized if t.transaction_type == "transfer"]
        fee_txs = [t for t in normalized if t.transaction_type == "cost"]

        assert len(transfer_txs) == 1, "Should have 1 transfer record"
        assert len(fee_txs) == 0, "Wallet didn't pay gas, no fee tx"

        tx = transfer_txs[0]
        assert tx.direction == "inflow"
        assert tx.source_asset_symbol == "SUI"
        assert tx.quantity == Decimal("5")  # 5_000_000_000 MIST = 5 SUI
        assert tx.source == "sui"
        assert tx.network == "sui"
        assert tx.network_transaction_id == inflow_tx["digest"]
        assert tx.fee == Decimal(0)
        assert tx.include_fee is False

        # From/to: sender is external address, wallet is recipient
        assert tx.source_from_account == FIXTURE_SENDER_TX1
        assert tx.source_to_account == FIXTURE_WALLET

    def test_normalize_outflow(self, connector):
        """Test normalization of an outflow transaction (wallet sends SUI)."""
        transactions = list(connector.yield_raws())
        # Second tx: outflow of 2 SUI (wallet is sender, pays gas)
        outflow_tx = transactions[1]
        assert outflow_tx["digest"] == "8HNRx4KMhBsfDqm3CBEZpiMbSjKHD3GEpHTDhFxU7ABC"

        normalized = list(connector.raw_to_normalized(outflow_tx))

        transfer_txs = [t for t in normalized if t.transaction_type == "transfer"]
        fee_txs = [t for t in normalized if t.transaction_type == "cost"]

        assert len(transfer_txs) == 1, "Should have 1 transfer record"
        assert len(fee_txs) == 1, "Should have 1 fee record"

        # Verify transfer: balance change is -2_003_200_000 MIST.
        # Gas = 1_500_000 + 2_500_000 - 800_000 = 3_200_000 MIST.
        # After gas adjustment: -2_003_200_000 + 3_200_000 = -2_000_000_000 MIST = 2 SUI outflow.
        tx = transfer_txs[0]
        assert tx.direction == "outflow"
        assert tx.source_asset_symbol == "SUI"
        assert tx.quantity == Decimal("2")  # 2 SUI
        assert tx.fee == Decimal(0)  # Fee is on the dedicated fee tx
        assert tx.include_fee is False

        # From/to: wallet is sender, recipient found in balanceChanges
        assert tx.source_from_account == FIXTURE_WALLET
        assert tx.source_to_account == FIXTURE_RECIPIENT_TX2

        # Verify fee transaction
        fee = fee_txs[0]
        assert fee.direction == "outflow"
        assert fee.transaction_type == "cost"
        assert fee.quantity == Decimal(0)
        assert fee.fee == Decimal("0.0032")  # 3_200_000 MIST = 0.0032 SUI
        assert fee.include_fee is True
        assert fee.source_asset_symbol == "SUI"
        assert fee.source_fee_quote_asset_symbol == "SUI"
        assert fee.source_transaction_id.endswith("_fee")

        # Fee from/to: wallet pays fee, no specific recipient
        assert fee.source_from_account == FIXTURE_WALLET
        assert fee.source_to_account is None

    def test_normalize_multi_coin(self, connector):
        """Test normalization of a multi-coin transaction (swap SUI for USDC)."""
        transactions = list(connector.yield_raws())
        # Third tx: wallet swaps SUI for USDC token
        multi_tx = transactions[2]
        assert multi_tx["digest"] == "5XPQw7LMhCsfEqm4DBFZqjNcTkLID4HFqIUEiFyV8DEF"

        normalized = list(connector.raw_to_normalized(multi_tx))

        transfer_txs = [t for t in normalized if t.transaction_type == "transfer"]
        fee_txs = [t for t in normalized if t.transaction_type == "cost"]

        # Gas = 2_000_000 + 3_000_000 - 1_000_000 = 4_000_000 MIST
        # SUI balance change: -4_000_000. After gas adj: -4_000_000 + 4_000_000 = 0 → skipped
        # USDC balance change: +50_000_000_000 → inflow of 50 USDC (9 decimals fallback)
        assert len(transfer_txs) == 1, "Should have 1 transfer (USDC inflow, SUI net is 0)"
        assert len(fee_txs) == 1, "Should have 1 fee record"

        usdc_tx = transfer_txs[0]
        assert usdc_tx.direction == "inflow"
        assert usdc_tx.source_asset_symbol == "USDC"
        assert usdc_tx.quantity == Decimal("50")  # 50_000_000_000 / 10^9 = 50
        assert usdc_tx.token_contract_address is not None
        assert "usdc" in usdc_tx.token_contract_address.lower()

        # USDC inflow from/to: DEX pool is USDC counterparty (negative USDC in balanceChanges)
        # But sender is the wallet itself (wallet initiated the swap), so fallback to
        # balanceChanges counterparty for the USDC coin type
        assert usdc_tx.source_from_account == FIXTURE_DEX_USDC_TX3
        assert usdc_tx.source_to_account == FIXTURE_WALLET

        # Fee
        fee = fee_txs[0]
        assert fee.fee == Decimal("0.004")  # 4_000_000 MIST = 0.004 SUI

        # Fee from/to
        assert fee.source_from_account == FIXTURE_WALLET
        assert fee.source_to_account is None

    def test_normalize_gas_only(self, connector):
        """Test normalization of a gas-only transaction (self-transfer/contract call)."""
        transactions = list(connector.yield_raws())
        # Fourth tx: only gas deducted, no actual transfer
        gas_only_tx = transactions[3]
        assert gas_only_tx["digest"] == "9ZTUy2NNiDtgGrn5ECGArkOdUlMJE5IGrJVFjGzW9GHI"

        normalized = list(connector.raw_to_normalized(gas_only_tx))

        transfer_txs = [t for t in normalized if t.transaction_type == "transfer"]
        fee_txs = [t for t in normalized if t.transaction_type == "cost"]

        # Gas = 800_000 + 1_200_000 - 400_000 = 1_600_000 MIST
        # SUI balance change: -1_600_000. After gas adj: -1_600_000 + 1_600_000 = 0 → skipped
        assert len(transfer_txs) == 0, "No actual transfers"
        assert len(fee_txs) == 1, "Should have 1 fee record"

        fee = fee_txs[0]
        assert fee.fee == Decimal("0.0016")  # 1_600_000 MIST = 0.0016 SUI
        assert fee.quantity == Decimal(0)
        assert fee.include_fee is True

        # Fee from/to: wallet pays fee, no recipient
        assert fee.source_from_account == FIXTURE_WALLET
        assert fee.source_to_account is None

    def test_normalize_failed_tx_skipped(self, connector):
        """Test that failed transactions are skipped entirely."""
        transactions = list(connector.yield_raws())
        # Fifth tx: failed transaction
        failed_tx = transactions[4]
        assert failed_tx["digest"] == "2ABCx5OOjEuhHso6FDHBslPeVmNKF6JHsKWGkH0X0JKL"

        normalized = list(connector.raw_to_normalized(failed_tx))

        assert len(normalized) == 0, "Failed transactions should yield nothing"

    def test_source_transaction_id_format(self, connector):
        """Test that source_transaction_id follows the expected format."""
        transactions = list(connector.yield_raws())

        for tx in transactions:
            normalized = list(connector.raw_to_normalized(tx))
            for norm in normalized:
                digest = tx["digest"]
                assert norm.source_transaction_id.startswith(
                    digest
                ), f"source_tx_id should start with digest: {norm.source_transaction_id}"

                # Should be either a transfer ID or _fee
                if norm.transaction_type == "cost":
                    assert norm.source_transaction_id == f"{digest}_fee"
                else:
                    # Transfer IDs have format: {digest}_{coinType}_{index}
                    parts = norm.source_transaction_id[len(digest) + 1 :]
                    assert len(parts) > 0, "Should have coin type and index suffix"

    def test_coin_metadata_fallback(self, connector):
        """Test coin metadata resolution fallback (extracts symbol from coin type)."""
        symbol, decimals = connector._resolve_coin_metadata(
            "0xdba34672e30cb4b08d3f6903b45be3bfb0e8b8c2c3d4e5f6a7b8c9d0e1f2a3b4::usdc::USDC"
        )
        assert symbol == "USDC"
        assert decimals == 9  # fallback decimals

    def test_coin_metadata_cache(self, connector):
        """Test that native SUI is pre-cached and coin metadata is cached after lookup."""
        # SUI should be pre-cached
        assert "0x2::sui::SUI" in connector._coin_cache
        symbol, decimals = connector._coin_cache["0x2::sui::SUI"]
        assert symbol == "SUI"
        assert decimals == 9

        # After resolving a new coin type, it should be cached
        connector._resolve_coin_metadata(
            "0xabc::test::TEST"
        )
        assert "0xabc::test::TEST" in connector._coin_cache

    def test_all_normalized_have_required_fields(self, connector):
        """Verify all normalized transactions have required fields set."""
        transactions = list(connector.yield_raws())

        for tx in transactions:
            normalized = list(connector.raw_to_normalized(tx))
            for norm in normalized:
                assert norm.source == "sui"
                assert norm.network == "sui"
                assert norm.account_id == 1
                assert norm.source_account == FIXTURE_WALLET
                assert norm.network_transaction_id == tx["digest"]
                assert norm.direction in ["inflow", "outflow", "neutral"]
                assert norm.date_time is not None
                assert isinstance(norm.quantity, Decimal)
                assert isinstance(norm.fee, Decimal)
                assert norm.source_fee_quote_asset_symbol == "SUI"

    def test_from_to_addresses(self, connector):
        """Verify source_from_account and source_to_account across all fixture transactions."""
        transactions = list(connector.yield_raws())

        for tx in transactions:
            normalized = list(connector.raw_to_normalized(tx))
            for norm in normalized:
                if norm.transaction_type == "cost":
                    # Fee transactions: wallet pays, no recipient
                    assert norm.source_from_account == FIXTURE_WALLET, (
                        f"Fee tx {norm.source_transaction_id}: "
                        f"source_from_account should be wallet"
                    )
                    assert norm.source_to_account is None, (
                        f"Fee tx {norm.source_transaction_id}: "
                        f"source_to_account should be None"
                    )
                elif norm.direction == "outflow":
                    # Outflow transfers: wallet is sender
                    assert norm.source_from_account == FIXTURE_WALLET, (
                        f"Outflow {norm.source_transaction_id}: "
                        f"source_from_account should be wallet"
                    )
                elif norm.direction == "inflow":
                    # Inflow transfers: wallet is recipient
                    assert norm.source_to_account == FIXTURE_WALLET, (
                        f"Inflow {norm.source_transaction_id}: "
                        f"source_to_account should be wallet"
                    )
                    assert norm.source_from_account is not None, (
                        f"Inflow {norm.source_transaction_id}: "
                        f"source_from_account should be resolved"
                    )

                # Every normalized tx should have the wallet on at least one side
                assert (
                    norm.source_from_account == FIXTURE_WALLET
                    or norm.source_to_account == FIXTURE_WALLET
                ), (
                    f"Tx {norm.source_transaction_id}: wallet should appear "
                    f"on at least one side of from/to"
                )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
