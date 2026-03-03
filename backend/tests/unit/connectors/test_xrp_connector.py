"""
Unit tests for XRP Ledger Connector.
"""

import json
from datetime import datetime
from pathlib import Path

import pytest

from backend.connectors.onchain.connector_xrp_ledger import ConnectorXRPLedger
from backend.db.models import NormalizedTransaction


@pytest.fixture
def xrp_connector():
    """Create an XRP connector instance in test mode."""
    connector = ConnectorXRPLedger(
        account_id=1,
        connector_id=1,
        wallet_address="rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6",
        config={"test_mode": True},  # Pass test_mode in config dict
    )
    return connector


@pytest.fixture
def sample_transactions():
    """Load sample transaction data from fixtures."""
    fixture_path = Path(__file__).parents[2] / "fixtures" / "xrp" / "xrp_ledger_transactions.json"
    with open(fixture_path, "r") as f:
        data = json.load(f)
    return data["transactions"]


class TestConnectorXRPLedger:
    """Test suite for XRP Ledger connector."""

    def test_connector_initialization(self, xrp_connector):
        """Test that connector initializes correctly."""
        assert xrp_connector.wallet_address == "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6"
        assert xrp_connector.chain_name == "xrp"
        assert xrp_connector.account_id == 1
        assert xrp_connector.connector_id == 1
        assert xrp_connector.test_mode is True
        assert xrp_connector.native_token == "XRP"
        assert xrp_connector.native_token_decimals == 6

    def test_connector_name_property(self, xrp_connector):
        """Test connector_name property returns correct value."""
        assert xrp_connector.connector_name == "xrp_ledger"

    def test_yield_raws_in_test_mode(self, xrp_connector, sample_transactions):
        """Test that yield_raws returns sample data in test mode."""
        raws = list(xrp_connector.yield_raws())
        assert len(raws) == 3
        assert raws[0]["hash"] == "D54105B3D7CADE03910E90646514B0CDB98A052D97A60BF82C80EA6A2692BA12"
        assert raws[1]["hash"] == "2A4D075E891011A444470BCB51629104732048926E760C0D292546B1F8A51DA7"
        assert raws[2]["hash"] == "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666AAAA7777BBBB8888"

    def test_raw_to_normalized_inflow_payment(self, xrp_connector, sample_transactions):
        """Test transformation of inflow Payment transaction (receive XRP)."""
        tx = sample_transactions[1]  # Kraken -> Test wallet
        normalized = list(xrp_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction for the Payment
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check basic fields
        assert ntx.source == "xrp_ledger"
        assert ntx.account_id == 1
        assert ntx.source_transaction_id == "2A4D075E891011A444470BCB51629104732048926E760C0D292546B1F8A51DA7"
        assert ntx.network_transaction_id == "2A4D075E891011A444470BCB51629104732048926E760C0D292546B1F8A51DA7"
        
        # Check transaction details
        assert ntx.direction == "inflow"
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "Payment"
        
        # Check asset and amount (568741841 drops = 568.741841 XRP)
        assert ntx.source_asset_symbol == "XRP"
        assert ntx.quantity == pytest.approx(568.741841, rel=1e-6)
        
        # Check fee (12 drops = 0.000012 XRP)
        assert ntx.fee == pytest.approx(0.000012, rel=1e-6)
        assert ntx.source_fee_quote_asset_symbol == "XRP"
        assert ntx.include_fee is False  # Inflow doesn't include fee
        
        # Check network info
        assert ntx.network == "xrp"
        assert ntx.source_from_account == "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh"
        assert ntx.source_to_account == "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6"
        
        # Check timestamp
        assert isinstance(ntx.date_time, datetime)
        assert ntx.date_time.year == 2023
        assert ntx.date_time.month == 7
        assert ntx.date_time.day == 30
        
        # Check tags contain destination tag and account names
        assert ntx.tags is not None
        assert len(ntx.tags) == 4
        assert {"destination_tag": 94827736} in ntx.tags
        assert {"from_name": "Kraken"} in ntx.tags
        assert {"to_name": "Test Wallet"} in ntx.tags
        assert {"ledger_index": 81505653} in ntx.tags

    def test_raw_to_normalized_outflow_payment(self, xrp_connector, sample_transactions):
        """Test transformation of outflow Payment transaction (send XRP)."""
        tx = sample_transactions[2]  # Test wallet -> another address
        normalized = list(xrp_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction for the Payment
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check basic fields
        assert ntx.source_transaction_id == "AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555FFFF6666AAAA7777BBBB8888"
        
        # Check transaction details
        assert ntx.direction == "outflow"
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "Payment"
        
        # Check asset and amount (25000000 drops = 25 XRP)
        assert ntx.source_asset_symbol == "XRP"
        assert ntx.quantity == pytest.approx(25.0, rel=1e-6)
        
        # Check fee (15 drops = 0.000015 XRP)
        assert ntx.fee == pytest.approx(0.000015, rel=1e-6)
        assert ntx.include_fee is True  # Outflow includes fee in P&L
        
        # Check network info
        assert ntx.source_from_account == "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6"
        assert ntx.source_to_account == "rN7n7otQDd6FczFgLdlqtyMVrn3HMbhDyt"
        
        # Check tags contain destination tag and ledger index
        assert ntx.tags is not None
        assert {"destination_tag": 12345} in ntx.tags
        assert {"ledger_index": 81505300} in ntx.tags

    def test_raw_to_normalized_neutral_transaction(self, xrp_connector, sample_transactions):
        """Test transformation of neutral Payment transaction (not involving wallet)."""
        tx = sample_transactions[0]  # Bitstamp -> Indodax (not our wallet)
        normalized = list(xrp_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check direction is neutral (neither from nor to our wallet)
        assert ntx.direction == "neutral"
        
        # Check asset and amount (109100000000 drops = 109100 XRP)
        assert ntx.quantity == pytest.approx(109100.0, rel=1e-6)
        
        # Check tags contain destination tag and account names
        assert ntx.tags is not None
        assert {"destination_tag": 2223795} in ntx.tags
        assert {"from_name": "Bitstamp"} in ntx.tags
        assert {"to_name": "Indodax"} in ntx.tags

    def test_drops_to_xrp_conversion(self, xrp_connector):
        """Test that drops are correctly converted to XRP."""
        # 1 XRP = 1,000,000 drops
        # 568741841 drops = 568.741841 XRP
        tx = {
            "meta": {"TransactionResult": "tesSUCCESS"},
            "TransactionType": "Payment",
            "Account": "rLHzPsX6oXkzU2qL12kHCH8G8cnZv1rBJh",
            "Destination": "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6",
            "Amount": "568741841",
            "Fee": "12",
            "hash": "TEST123",
            "date": "2023-07-30T19:50:21.000Z",
        }
        
        normalized = list(xrp_connector.raw_to_normalized(tx))
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Verify drops to XRP conversion
        assert ntx.quantity == pytest.approx(568.741841, rel=1e-9)
        assert ntx.fee == pytest.approx(0.000012, rel=1e-9)

    def test_direction_determination(self, xrp_connector):
        """Test direction detection for different transaction scenarios."""
        wallet = "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6"
        
        # Test inflow
        assert xrp_connector._determine_direction("rOther123", wallet) == "inflow"
        
        # Test outflow
        assert xrp_connector._determine_direction(wallet, "rOther123") == "outflow"
        
        # Test self-transfer
        assert xrp_connector._determine_direction(wallet, wallet) == "neutral"
        
        # Test neutral (neither from nor to wallet)
        assert xrp_connector._determine_direction("rOther1", "rOther2") == "neutral"

    def test_skips_non_payment_transactions(self, xrp_connector):
        """Test that non-Payment transactions are skipped."""
        tx = {
            "meta": {"TransactionResult": "tesSUCCESS"},
            "TransactionType": "OfferCreate",  # Not a Payment
            "Account": "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6",
            "hash": "TEST123",
            "date": "2023-07-30T19:50:21.000Z",
        }
        
        normalized = list(xrp_connector.raw_to_normalized(tx))
        assert len(normalized) == 0

    def test_skips_failed_transactions(self, xrp_connector):
        """Test that failed transactions are skipped."""
        tx = {
            "meta": {"TransactionResult": "tecUNFUNDED_PAYMENT"},  # Failed
            "TransactionType": "Payment",
            "Account": "rG3umtUXot3Tojru2XKkuXoreXDoFrPTU6",
            "Destination": "rOther123",
            "Amount": "1000000",
            "Fee": "12",
            "hash": "TEST123",
            "date": "2023-07-30T19:50:21.000Z",
        }
        
        normalized = list(xrp_connector.raw_to_normalized(tx))
        assert len(normalized) == 0
