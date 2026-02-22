"""
Unit tests for Moralis Wallet History Connector.
"""

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Generator

import pytest

from backend.connectors.onchain.connector_moralis_wallet_history import (
    ConnectorMoralisWalletHistory,
)
from backend.db.models import NormalizedTransaction


@pytest.fixture
def moralis_connector():
    """Create a Moralis connector instance in test mode."""
    connector = ConnectorMoralisWalletHistory(
        account_id=1,
        connector_id=1,
        wallet_address="0x347681ec529f767dafb3703486570bc3da136993",
        chain_name="bsc",
        config={"test_mode": True},  # Pass test_mode in config dict
    )
    return connector


@pytest.fixture
def sample_transactions():
    """Load sample transaction data from fixtures."""
    fixture_path = Path(__file__).parent / "fixtures" / "moralis" / "wallet_history_bsc.json"
    with open(fixture_path, "r") as f:
        data = json.load(f)
    return data["result"]


class TestConnectorMoralisWalletHistory:
    """Test suite for Moralis Wallet History connector."""

    def test_connector_initialization(self, moralis_connector):
        """Test that connector initializes correctly."""
        assert moralis_connector.wallet_address == "0x347681ec529f767dafb3703486570bc3da136993"
        assert moralis_connector.chain_name == "bsc"
        assert moralis_connector.account_id == 1
        assert moralis_connector.connector_id == 1
        assert moralis_connector.test_mode is True

    def test_connector_id_property(self, moralis_connector):
        """Test connector_name property returns correct value."""
        assert moralis_connector.connector_name == "moralis_wallet_history_bsc"

    def test_yield_raws_in_test_mode(self, moralis_connector, sample_transactions):
        """Test that yield_raws returns sample data in test mode."""
        raws = list(moralis_connector.yield_raws())
        assert len(raws) == 3
        assert raws[0]["hash"] == "0x55d468b436d5c8620f0a19fc9daa5975470ee338b0f0775e8d8721435ecb7b30"
        assert raws[1]["hash"] == "0xa95f346c848ba93def5dcd918add4f47dec13552c6f967a558b8585191e68045"
        assert raws[2]["hash"] == "0xb5b3e30982090352dfb81f86e29e04ef0477245cd51d861c9b6dcf6ef7c19606"

    def test_raw_to_normalized_erc20_transfer(self, moralis_connector, sample_transactions):
        """Test transformation of ERC20 token transfer (with spam flag)."""
        tx = sample_transactions[0]  # Token receive with spam
        normalized = list(moralis_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction for the ERC20 transfer
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check basic fields
        assert ntx.source == "moralis_wallet_history_bsc"
        assert ntx.account_id == 1
        assert ntx.source_transaction_id == "0x55d468b436d5c8620f0a19fc9daa5975470ee338b0f0775e8d8721435ecb7b30_erc20_509"
        assert ntx.network_transaction_id == "0x55d468b436d5c8620f0a19fc9daa5975470ee338b0f0775e8d8721435ecb7b30"
        
        # Check transaction details
        assert ntx.direction == "inflow"
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "token receive"
        
        # Check asset and amount (KPER with 18 decimals)
        assert ntx.source_asset_symbol == "KPER"
        assert ntx.quantity == pytest.approx(1370.75, rel=1e-6)
        assert ntx.token_contract_address == "0xc89b4a8a121dd3e726fe7515e703936cf83e3350"
        
        # Check fee
        assert ntx.fee == pytest.approx(0.0009333107, rel=1e-6)
        assert ntx.source_fee_quote_asset_symbol == "BNB"
        
        # Check network info
        assert ntx.network == "bsc"
        assert ntx.source_from_account == "0x86ef9beb5f82da51b437120fd085f8c1f44f6b42"
        assert ntx.source_to_account == "0x347681ec529f767dafb3703486570bc3da136993"
        
        # Check spam flag in tags
        assert ntx.tags == [{"spam": True}]
        
        # Check timestamp
        assert isinstance(ntx.date_time, datetime)
        assert ntx.date_time.year == 2026

    def test_raw_to_normalized_approve_transaction(self, moralis_connector, sample_transactions):
        """Test transformation of approve transaction (no transfers)."""
        tx = sample_transactions[1]  # Approve transaction
        normalized = list(moralis_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction for the approve
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check basic fields
        assert ntx.source_transaction_id == "0xa95f346c848ba93def5dcd918add4f47dec13552c6f967a558b8585191e68045"
        assert ntx.network_transaction_id == "0xa95f346c848ba93def5dcd918add4f47dec13552c6f967a558b8585191e68045"
        
        # Check transaction details
        assert ntx.direction == "outflow"  # Wallet pays gas fee
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "approve"
        
        # Check zero quantity for approve
        assert ntx.quantity == 0.0
        assert ntx.source_asset_symbol == "BNB"  # Native token for BSC chain
        
        # Check fee exists (gas cost)
        assert ntx.fee == pytest.approx(0.000009976906273334, rel=1e-6)
        
        # Check tags contain approve details and method label
        assert len(ntx.tags) == 2
        assert any(tag.get("approve") is True for tag in ntx.tags)
        assert any(tag.get("token_symbol") == "USDC" for tag in ntx.tags)
        assert any(tag.get("spender") == "0x000000000022d473030f116ddee9f6b43ac78ba3" for tag in ntx.tags)
        assert any(tag.get("method") == "approve" for tag in ntx.tags)

    def test_raw_to_normalized_native_transfer(self, moralis_connector, sample_transactions):
        """Test transformation of native token transfer (ETH/BNB)."""
        tx = sample_transactions[2]  # Native ETH receive
        normalized = list(moralis_connector.raw_to_normalized(tx))
        
        # Should create 1 normalized transaction for the native transfer
        assert len(normalized) == 1
        ntx = normalized[0]
        
        # Check basic fields
        assert ntx.source_transaction_id == "0xb5b3e30982090352dfb81f86e29e04ef0477245cd51d861c9b6dcf6ef7c19606_native_0"
        assert ntx.network_transaction_id == "0xb5b3e30982090352dfb81f86e29e04ef0477245cd51d861c9b6dcf6ef7c19606"
        
        # Check transaction details
        assert ntx.direction == "inflow"
        assert ntx.transaction_type == "transfer"
        assert ntx.source_transaction_type == "receive"
        
        # Check native token (ETH on BSC shown as ETH, but should be BNB based on chain)
        assert ntx.source_asset_symbol == "ETH"  # As returned by Moralis
        assert ntx.quantity == pytest.approx(0.13157279, rel=1e-6)
        
        # Check fee
        assert ntx.fee == pytest.approx(0.000024597977418, rel=1e-6)
        
        # Check from/to addresses
        assert ntx.source_from_account == "0x21a31ee1afc51d94c2efccaa2092ad1028285549"
        assert ntx.source_to_account == "0x347681ec529f767dafb3703486570bc3da136993"
        
        # Check spam flag not added for non-spam transactions (empty tags)
        assert ntx.tags == []

    def test_multiple_transfers_create_multiple_records(self, moralis_connector):
        """Test that a transaction with multiple transfers creates multiple normalized records."""
        # Create a mock transaction with both ERC20 and native transfers
        tx = {
            "hash": "0xtest123",
            "block_timestamp": "2026-02-01T12:00:00.000Z",
            "transaction_fee": "0.001",
            "from_address": "0xabc",
            "to_address": "0xdef",
            "category": "swap",
            "possible_spam": False,
            "erc20_transfers": [
                {
                    "token_symbol": "USDT",
                    "token_decimals": "6",
                    "value": "1000000",
                    "direction": "send",
                    "from_address": "0x347681ec529f767dafb3703486570bc3da136993",
                    "to_address": "0xother",
                    "address": "0xtoken1",
                    "log_index": 1,
                }
            ],
            "native_transfers": [
                {
                    "token_symbol": "BNB",
                    "value": "1000000000000000000",
                    "direction": "receive",
                    "from_address": "0xother",
                    "to_address": "0x347681ec529f767dafb3703486570bc3da136993",
                }
            ],
            "nft_transfers": [],
        }
        
        normalized = list(moralis_connector.raw_to_normalized(tx))
        
        # Should create 2 records: 1 for ERC20, 1 for native
        assert len(normalized) == 2
        
        # Check ERC20 transfer
        erc20_tx = normalized[0]
        assert erc20_tx.source_transaction_id == "0xtest123_erc20_1"
        assert erc20_tx.source_asset_symbol == "USDT"
        assert erc20_tx.quantity == 1.0  # 1000000 / 10^6
        assert erc20_tx.direction == "outflow"
        
        # Check native transfer
        native_tx = normalized[1]
        assert native_tx.source_transaction_id == "0xtest123_native_0"
        assert native_tx.source_asset_symbol == "BNB"
        assert native_tx.quantity == 1.0  # 1 BNB
        assert native_tx.direction == "inflow"
        
        # Both should share same network_transaction_id
        assert erc20_tx.network_transaction_id == native_tx.network_transaction_id

    def test_decimal_handling_various_decimals(self, moralis_connector):
        """Test correct decimal conversion for tokens with different decimal places."""
        test_cases = [
            ("USDT", "6", "1000000", 1.0),  # 6 decimals
            ("USDC", "6", "5000000000", 5000.0),  # 6 decimals
            ("WETH", "18", "1000000000000000000", 1.0),  # 18 decimals
            ("SHIB", "18", "1000000000000000000000", 1000.0),  # 18 decimals, large amount
        ]
        
        for symbol, decimals, raw_value, expected in test_cases:
            tx = {
                "hash": f"0x{symbol.lower()}",
                "block_timestamp": "2026-02-01T12:00:00.000Z",
                "transaction_fee": "0.001",
                "from_address": "0xabc",
                "to_address": "0xdef",
                "category": "transfer",
                "possible_spam": False,
                "erc20_transfers": [
                    {
                        "token_symbol": symbol,
                        "token_decimals": decimals,
                        "value": raw_value,
                        "direction": "receive",
                        "from_address": "0xother",
                        "to_address": "0x347681ec529f767dafb3703486570bc3da136993",
                        "address": "0xtoken",
                        "log_index": 0,
                    }
                ],
                "native_transfers": [],
                "nft_transfers": [],
            }
            
            normalized = list(moralis_connector.raw_to_normalized(tx))
            assert len(normalized) == 1
            assert normalized[0].quantity == pytest.approx(expected, rel=1e-6)

    def test_direction_mapping(self, moralis_connector):
        """Test that Moralis direction field maps correctly to our direction field."""
        direction_tests = [
            ("receive", "inflow"),
            ("send", "outflow"),
        ]
        
        for moralis_dir, expected_dir in direction_tests:
            tx = {
                "hash": f"0x{moralis_dir}",
                "block_timestamp": "2026-02-01T12:00:00.000Z",
                "transaction_fee": "0.001",
                "from_address": "0xabc",
                "to_address": "0xdef",
                "category": "transfer",
                "possible_spam": False,
                "erc20_transfers": [
                    {
                        "token_symbol": "TEST",
                        "token_decimals": "18",
                        "value": "1000000000000000000",
                        "direction": moralis_dir,
                        "from_address": "0xabc",
                        "to_address": "0xdef",
                        "address": "0xtoken",
                        "log_index": 0,
                    }
                ],
                "native_transfers": [],
                "nft_transfers": [],
            }
            
            normalized = list(moralis_connector.raw_to_normalized(tx))
            assert len(normalized) == 1
            assert normalized[0].direction == expected_dir
