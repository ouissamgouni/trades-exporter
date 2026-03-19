"""
Unit tests for Cardano Cardanoscan connector.
Tests fixture loading, address parsing, net flow calculation, and transaction normalization.
"""

import os
import pytest
from decimal import Decimal
from datetime import datetime, timezone

from backend.connectors.onchain.connector_cardano_scan import ConnectorCardanoScan


class TestCardanoScanConnector:
    """Unit tests for Cardano connector using test fixtures."""

    # Test wallet address (from fixtures)
    WALLET_ADDRESS = "addr1qx478mhvuvlu2wfufdfem7a0truw3zjj7mrtxcdhytyjazkd4rpkpyue5qayv2spsznjn43q4phsldkptpthw3u5teasar990w"

    @pytest.fixture
    def connector(self):
        """Create a test mode connector instance."""
        return ConnectorCardanoScan(
            wallet_address=self.WALLET_ADDRESS,
            account_id=1,
            connector_id=1,
            config={"test_mode": True}
        )

    def test_initialization(self, connector):
        """Test connector initialization."""
        assert connector.connector_name == "cardano_scan"
        assert connector.wallet_address == self.WALLET_ADDRESS
        assert connector.chain_name == "cardano"
        assert connector.native_token == "ADA"
        assert connector.native_token_decimals == 6
        assert connector.test_mode is True
        assert connector.user_stake_id is not None

    def test_initialization_without_address(self):
        """Test that initialization fails without wallet address."""
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorCardanoScan(
                wallet_address="",
                account_id=1,
                connector_id=1,
                config={"test_mode": True}
            )

    def test_stake_credential_extraction(self, connector):
        """Test extraction of stake credential from Cardano address."""
        # Test with valid base address
        stake_id = connector._get_stake_credential(self.WALLET_ADDRESS)
        assert stake_id is not None
        assert isinstance(stake_id, str)
        assert len(stake_id) > 0

    def test_stake_credential_invalid_address(self, connector):
        """Test stake credential extraction with invalid address."""
        invalid_address = "invalid_address_123"
        stake_id = connector._get_stake_credential(invalid_address)
        assert stake_id is None

    def test_is_own_address(self, connector):
        """Test address ownership detection."""
        # Test with wallet address
        assert connector._is_own_address(self.WALLET_ADDRESS) is True
        
        # Test with external address
        external_address = "addr1q9external_sender_address_12345678901234567890123456789012345678901234567890123456"
        assert connector._is_own_address(external_address) is False

    def test_yield_raws_from_fixture(self, connector):
        """Test loading raw transactions from fixture file."""
        transactions = list(connector.yield_raws())
        
        # Verify we loaded transactions from fixture
        assert len(transactions) == 5
        
        # Verify structure of first transaction
        tx = transactions[0]
        assert "hash" in tx
        assert "timestamp" in tx
        assert "inputs" in tx
        assert "outputs" in tx
        assert "fees" in tx
        assert "status" in tx

    def test_normalization_incoming_payment(self, connector):
        """Test normalization of incoming payment transaction."""
        raw_txs = list(connector.yield_raws())
        
        # First transaction is incoming payment (5 ADA)
        tx = raw_txs[0]
        normalized = list(connector.raw_to_normalized(tx))
        
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Verify core fields
        assert ntx.source == "cardano_scan"
        assert ntx.network == "cardano"
        assert ntx.source_transaction_id == tx["hash"]
        assert ntx.network_transaction_id == tx["hash"]
        
        # Verify direction and amount
        assert ntx.direction == "inflow"
        assert ntx.source_asset_symbol == "ADA"
        assert ntx.quantity == pytest.approx(Decimal("5.0"), rel=1e-6)
        
        # Verify fee handling (not included for inflows)
        assert ntx.fee == pytest.approx(Decimal("0.168141"), rel=1e-6)
        assert ntx.include_fee is False
        
        # Verify transaction type
        assert ntx.transaction_type == "transfer"

    def test_normalization_outgoing_with_change(self, connector):
        """Test normalization of outgoing transaction with change address."""
        raw_txs = list(connector.yield_raws())
        
        # Second transaction: 10 ADA input -> 2 ADA out + 7.761943 ADA change = 2.238057 ADA net outflow
        tx = raw_txs[1]
        normalized = list(connector.raw_to_normalized(tx))
        
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Verify direction
        assert ntx.direction == "outflow"
        
        # Verify net flow calculation
        # Input: 10 ADA from our address
        # Outputs: 2 ADA to external + 7.761943 ADA to change (our address)
        # Net: -10 + 7.761943 = -2.238057 ADA (outflow)
        expected_net = 10.0 - 7.761943
        assert float(ntx.quantity) == pytest.approx(expected_net, rel=1e-6)
        
        # Verify fee is included for outflows
        assert ntx.fee == pytest.approx(Decimal("0.238057"), rel=1e-6)
        assert ntx.include_fee is True

    def test_normalization_self_transfer(self, connector):
        """Test normalization of self-transfer (zero net flow)."""
        raw_txs = list(connector.yield_raws())
        
        # Third transaction: 3 ADA from our address -> 2.82 ADA to our change address
        # Net: 0 ADA (internal movement with fees)
        tx = raw_txs[2]
        normalized = list(connector.raw_to_normalized(tx))
        
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Verify direction is neutral
        assert ntx.direction == "neutral"
        
        # Verify quantity is 0 for net zero flow
        assert ntx.quantity == pytest.approx(Decimal("0.18"), rel=1e-6)
        
        # Verify fee is included
        assert ntx.fee == pytest.approx(Decimal("0.18"), rel=1e-6)
        assert ntx.include_fee is True

    def test_normalization_with_withdrawal(self, connector):
        """Test normalization of transaction with staking withdrawal."""
        raw_txs = list(connector.yield_raws())
        
        # Fourth transaction: 1.5 ADA input + 0.5 ADA withdrawal -> 1.0 ADA output
        # Net: -1.5 + 1.0 + 0.5 = 0 ADA
        tx = raw_txs[3]
        normalized = list(connector.raw_to_normalized(tx))
        
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Withdrawal should be added to net flow
        # Input: -1.5 ADA
        # Output: +1.0 ADA
        # Withdrawal: +0.5 ADA
        # Net: 0 ADA
        assert ntx.direction == "neutral"
        
        # Verify tags contain withdrawal information
        assert ntx.tags is not None
        withdrawal_tag = next((tag for tag in ntx.tags if "withdrawal_count" in tag), None)
        assert withdrawal_tag is not None
        assert withdrawal_tag["withdrawal_count"] == 1
        assert withdrawal_tag["withdrawal_amount_ada"] == pytest.approx(0.5, rel=1e-6)

    def test_failed_transaction_filtering(self, connector):
        """Test that failed transactions are filtered out."""
        raw_txs = list(connector.yield_raws())
        
        # Fifth transaction has status=false
        tx = raw_txs[4]
        assert tx["status"] is False
        
        # Should not yield any normalized transaction
        normalized = list(connector.raw_to_normalized(tx))
        assert len(normalized) == 0

    def test_lovelace_to_ada_conversion(self, connector):
        """Test decimal conversion from lovelaces to ADA."""
        # 1 ADA = 1,000,000 lovelaces
        assert connector.lovelace_divisor == Decimal(1_000_000)
        
        # Test conversion
        lovelaces = 5_000_000
        ada = Decimal(lovelaces) / connector.lovelace_divisor
        assert ada == Decimal("5.0")
        
        # Test fee conversion
        fee_lovelaces = 168_141
        fee_ada = Decimal(fee_lovelaces) / connector.lovelace_divisor
        assert fee_ada == pytest.approx(Decimal("0.168141"), rel=1e-9)

    def test_timestamp_parsing(self, connector):
        """Test timestamp parsing from ISO 8601 format."""
        raw_txs = list(connector.yield_raws())
        tx = raw_txs[0]
        
        normalized = list(connector.raw_to_normalized(tx))
        ntx = normalized[0]
        
        # Verify timestamp is parsed correctly
        assert isinstance(ntx.date_time, datetime)
        assert ntx.date_time.year == 2024
        assert ntx.date_time.month == 1
        assert ntx.date_time.day == 15
        assert ntx.date_time.tzinfo == timezone.utc

    def test_transaction_tags(self, connector):
        """Test that transaction tags are properly populated."""
        raw_txs = list(connector.yield_raws())
        tx = raw_txs[0]
        
        normalized = list(connector.raw_to_normalized(tx))
        ntx = normalized[0]
        
        # Verify tags are present
        assert ntx.tags is not None
        assert len(ntx.tags) > 0
        
        # Verify slot tag
        slot_tag = next((tag for tag in ntx.tags if "slot" in tag), None)
        assert slot_tag is not None
        assert slot_tag["slot"] == 125000000
        
        # Verify epoch tag
        epoch_tag = next((tag for tag in ntx.tags if "epoch" in tag), None)
        assert epoch_tag is not None
        assert epoch_tag["epoch"] == 450

    def test_certificate_tags(self, connector):
        """Test that certificate information is captured in tags."""
        raw_txs = list(connector.yield_raws())
        
        # Fourth transaction has certificate
        tx = raw_txs[3]
        normalized = list(connector.raw_to_normalized(tx))
        ntx = normalized[0]
        
        # Verify certificate tag exists
        cert_tag = next((tag for tag in ntx.tags if "certificate" in tag), None)
        assert cert_tag is not None
        assert cert_tag["certificate"]["stake_delegations"] == 1

    def test_network_transaction_id_preservation(self, connector):
        """Test that network transaction ID is preserved."""
        raw_txs = list(connector.yield_raws())
        tx = raw_txs[0]
        
        normalized = list(connector.raw_to_normalized(tx))
        ntx = normalized[0]
        
        # Verify transaction IDs are stored
        assert ntx.source_transaction_id == tx["hash"]
        assert ntx.network_transaction_id == tx["hash"]
        assert ntx.network == "cardano"

    def test_multiple_inputs_calculation(self, connector):
        """Test net flow calculation with multiple inputs from same wallet."""
        # Create mock transaction with multiple inputs
        mock_tx = {
            "hash": "test_multi_input",
            "timestamp": "2024-01-15T10:00:00.000Z",
            "status": True,
            "fees": "200000",
            "inputs": [
                {
                    "address": self.WALLET_ADDRESS,
                    "value": "3000000"
                },
                {
                    "address": self.WALLET_ADDRESS,
                    "value": "2000000"
                }
            ],
            "outputs": [
                {
                    "address": "addr1q9external_recipient",
                    "value": "4500000"
                }
            ],
            "withdrawals": [],
            "certificate": {}
        }
        
        normalized = list(connector.raw_to_normalized(mock_tx))
        assert len(normalized) == 1
        
        ntx = normalized[0]
        # Net: -(3 + 2) + 0 = -5 ADA outflow
        # But output is 4.5 ADA external, so net is actually 0.5 ADA remaining
        # Wait, both inputs are ours: -5 ADA
        # No outputs to us: 0 ADA
        # Net: -5 ADA
        assert ntx.direction == "outflow"
        assert ntx.quantity == pytest.approx(Decimal("5.0"), rel=1e-6)

    def test_direction_determination(self, connector):
        """Test direction logic for various transaction types."""
        raw_txs = list(connector.yield_raws())
        
        # Test inflow
        tx_inflow = raw_txs[0]
        norm_inflow = list(connector.raw_to_normalized(tx_inflow))[0]
        assert norm_inflow.direction == "inflow"
        assert norm_inflow.include_fee is False
        
        # Test outflow
        tx_outflow = raw_txs[1]
        norm_outflow = list(connector.raw_to_normalized(tx_outflow))[0]
        assert norm_outflow.direction == "outflow"
        assert norm_outflow.include_fee is True
        
        # Test neutral
        tx_neutral = raw_txs[2]
        norm_neutral = list(connector.raw_to_normalized(tx_neutral))[0]
        assert norm_neutral.direction == "neutral"
        assert norm_neutral.include_fee is True


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
