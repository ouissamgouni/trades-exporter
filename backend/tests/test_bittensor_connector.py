"""
Unit tests for Bittensor (TAO) Connector.
"""

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from backend.connectors.onchain.connector_bittensor import ConnectorBittensor
from backend.db.models import NormalizedTransaction


WALLET_ADDRESS = "5FE7xRXFJWQbep1JrS8JyjmZJRycdskeVummEWp525LxBKud"


@pytest.fixture
def bittensor_connector():
    """Create a Bittensor connector instance in test mode."""
    connector = ConnectorBittensor(
        account_id=1,
        connector_id=1,
        wallet_address=WALLET_ADDRESS,
        config={"test_mode": True},
    )
    return connector


@pytest.fixture
def sample_transfers():
    """Load sample transfer data from fixtures."""
    fixture_path = (
        Path(__file__).parent
        / "fixtures"
        / "bittensor"
        / "bittensor_transactions.json"
    )
    with open(fixture_path, "r") as f:
        data = json.load(f)
    return data["transfers"]


class TestConnectorBittensor:
    """Test suite for Bittensor (TAO) connector."""

    def test_connector_initialization(self, bittensor_connector):
        """Test that connector initializes correctly."""
        assert bittensor_connector.wallet_address == WALLET_ADDRESS
        assert bittensor_connector.chain_name == "bittensor"
        assert bittensor_connector.account_id == 1
        assert bittensor_connector.connector_id == 1
        assert bittensor_connector.test_mode is True
        assert bittensor_connector.native_token == "TAO"
        assert bittensor_connector.native_token_decimals == 9

    def test_connector_name_property(self, bittensor_connector):
        """Test connector_name property returns correct value."""
        assert bittensor_connector.connector_name == "bittensor"

    def test_yield_raws_in_test_mode(self, bittensor_connector, sample_transfers):
        """Test that yield_raws returns sample data in test mode."""
        raws = list(bittensor_connector.yield_raws())
        assert len(raws) == 3
        assert (
            raws[0]["transaction_hash"]
            == "0x20c70d9f8205ae781e482166ab9e07ecb5579931f680bf839c483b49c6ad3bcf"
        )
        assert (
            raws[1]["transaction_hash"]
            == "0xaabb1122ccdd3344eeff5566778899001122334455667788aabbccddeeff0011"
        )
        assert (
            raws[2]["transaction_hash"]
            == "0x1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff"
        )

    def test_raw_to_normalized_inflow(self, bittensor_connector, sample_transfers):
        """Test transformation of inflow transfer (receive TAO)."""
        tx = sample_transfers[0]  # External -> wallet
        normalized = list(bittensor_connector.raw_to_normalized(tx))

        assert len(normalized) == 1
        ntx = normalized[0]

        # Check basic fields
        assert ntx.source == "bittensor"
        assert ntx.account_id == 1
        assert (
            ntx.source_transaction_id
            == "0x20c70d9f8205ae781e482166ab9e07ecb5579931f680bf839c483b49c6ad3bcf"
        )
        assert ntx.network_transaction_id == ntx.source_transaction_id

        # Check transaction details
        assert ntx.direction == "inflow"
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "transfer"

        # Check asset and amount (6500000000 rao = 6.5 TAO)
        assert ntx.source_asset_symbol == "TAO"
        assert ntx.quantity == Decimal("6.5")

        # Check fee (135263 rao = 0.000135263 TAO)
        assert ntx.fee == Decimal("0.000135263")
        assert ntx.source_fee_quote_asset_symbol == "TAO"
        assert ntx.include_fee is False  # Inflow doesn't include fee

        # Check network info
        assert ntx.network == "bittensor"
        assert (
            ntx.source_from_account
            == "5GGe5VYiBBNYL2rHA77wviRkWDCrV2FubZr81QqxA27qn4Ch"
        )
        assert ntx.source_to_account == WALLET_ADDRESS

        # Check timestamp
        assert isinstance(ntx.date_time, datetime)
        assert ntx.date_time.year == 2025
        assert ntx.date_time.month == 4
        assert ntx.date_time.day == 28

        # Check tags
        assert ntx.tags is not None
        assert len(ntx.tags) == 3
        assert {"block_number": 5452109} in ntx.tags
        assert {"extrinsic_id": "5452109-0013"} in ntx.tags
        assert {"transfer_id": "finney-5452109-0041"} in ntx.tags

    def test_raw_to_normalized_outflow(self, bittensor_connector, sample_transfers):
        """Test transformation of outflow transfer (send TAO)."""
        tx = sample_transfers[1]  # Wallet -> external
        normalized = list(bittensor_connector.raw_to_normalized(tx))

        assert len(normalized) == 1
        ntx = normalized[0]

        # Check basic fields
        assert (
            ntx.source_transaction_id
            == "0xaabb1122ccdd3344eeff5566778899001122334455667788aabbccddeeff0011"
        )

        # Check transaction details
        assert ntx.direction == "outflow"
        assert ntx.transaction_type == "transfer"

        # Check asset and amount (2000000000 rao = 2.0 TAO)
        assert ntx.source_asset_symbol == "TAO"
        assert ntx.quantity == Decimal("2")

        # Check fee (125000 rao = 0.000125 TAO)
        assert ntx.fee == Decimal("0.000125")
        assert ntx.include_fee is True  # Outflow includes fee

        # Check addresses
        assert ntx.source_from_account == WALLET_ADDRESS
        assert (
            ntx.source_to_account
            == "5D8J4g7A1j2LHBMbBoB6aseaUnYLY6T1qUHhXKTP5My6FbKx"
        )

        # Check tags
        assert ntx.tags is not None
        assert {"block_number": 5500200} in ntx.tags
        assert {"extrinsic_id": "5500200-0007"} in ntx.tags

    def test_raw_to_normalized_self_transfer(
        self, bittensor_connector, sample_transfers
    ):
        """Test transformation of self-transfer (neutral)."""
        tx = sample_transfers[2]  # Wallet -> wallet
        normalized = list(bittensor_connector.raw_to_normalized(tx))

        assert len(normalized) == 1
        ntx = normalized[0]

        # Check direction is neutral (self-transfer)
        assert ntx.direction == "neutral"

        # Check amount (1000000000 rao = 1.0 TAO)
        assert ntx.quantity == Decimal("1")

        # Both addresses should be our wallet
        assert ntx.source_from_account == WALLET_ADDRESS
        assert ntx.source_to_account == WALLET_ADDRESS

    def test_rao_to_tao_conversion(self, bittensor_connector):
        """Test that rao are correctly converted to TAO."""
        # 1 TAO = 1,000,000,000 rao
        tx = {
            "from": {
                "ss58": "5GGe5VYiBBNYL2rHA77wviRkWDCrV2FubZr81QqxA27qn4Ch",
                "hex": "0xba0b286434937862",
            },
            "to": {"ss58": WALLET_ADDRESS, "hex": "0x8c2b3abcd1234567"},
            "amount": "6500000000",
            "fee": "135263",
            "transaction_hash": "0xTEST123",
            "timestamp": "2025-04-28T18:15:24Z",
            "block_number": 5452109,
            "extrinsic_id": "5452109-0013",
            "id": "finney-5452109-0041",
            "network": "finney",
        }

        normalized = list(bittensor_connector.raw_to_normalized(tx))
        assert len(normalized) == 1
        ntx = normalized[0]

        # Verify rao to TAO conversion
        assert ntx.quantity == Decimal("6.5")
        assert ntx.fee == Decimal("0.000135263")

    def test_direction_determination(self, bittensor_connector):
        """Test direction detection for different transaction scenarios."""
        wallet = WALLET_ADDRESS
        other = "5GGe5VYiBBNYL2rHA77wviRkWDCrV2FubZr81QqxA27qn4Ch"

        # Test inflow
        assert bittensor_connector._determine_direction(other, wallet) == "inflow"

        # Test outflow
        assert bittensor_connector._determine_direction(wallet, other) == "outflow"

        # Test self-transfer
        assert bittensor_connector._determine_direction(wallet, wallet) == "neutral"

        # Test neutral (neither from nor to wallet)
        assert (
            bittensor_connector._determine_direction(
                "5D8J4g7A1j2LHBMbBoB6aseaUnYLY6T1qUHhXKTP5My6FbKx", other
            )
            == "neutral"
        )

    def test_invalid_address_raises_error(self):
        """Test that an invalid address raises ValueError."""
        with pytest.raises(ValueError, match="Invalid Bittensor SS58 address"):
            ConnectorBittensor(
                account_id=1,
                connector_id=1,
                wallet_address="invalid_address",
                config={"test_mode": True},
            )

    def test_missing_address_raises_error(self):
        """Test that a missing address raises ValueError."""
        with pytest.raises(ValueError, match="Missing wallet address"):
            ConnectorBittensor(
                account_id=1,
                connector_id=1,
                wallet_address="",
                config={"test_mode": True},
            )
