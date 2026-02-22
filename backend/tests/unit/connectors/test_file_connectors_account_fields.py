"""
Unit tests for file-based deposit/withdrawal connectors to verify account fields.
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
import pandas as pd

from backend.connectors.cex.connector_mexc_deposits_file import MEXCDepositsFileConnector
from backend.connectors.cex.connector_mexc_withdrawals_file import MEXCWithdrawalsFileConnector
from backend.connectors.cex.connector_okx_funding_file import OKXFundingFileConnector
from backend.db.models import NormalizedTransaction


class TestMEXCDepositsFileAccountFields:
    """Test suite for MEXC deposits file connector account fields."""

    def test_deposit_account_fields_with_identifier(self):
        """Test that deposits correctly populate source_to_account and to_account_id."""
        config = {
            "file_path": "/tmp/test.xlsx",
            "_account_id": 1,
            "_account_name": "mexc-test",
            "_account_address_or_identifier": "mexc-main-account"
        }
        connector = MEXCDepositsFileConnector(account_id=1, config=config)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-01-15 10:30:00+00:00"),
            "txid": "test_txid_123",
            "currency": "USDT",
            "amount": 100.0,
            "fee": 0.0,
            "fee_quote": "USDT",
            "network": "TRC20",
            "blockchain_hash": "0xabc123"
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.direction == "inflow"
        assert result.source_transaction_type == "deposit"
        assert result.source_to_account == "mexc-main-account"
        assert result.to_account_id == 1
        assert result.source_from_account is None
        assert result.from_account_id is None

    def test_deposit_account_fields_fallback_to_name(self):
        """Test that deposits fallback to account name when identifier is None."""
        config = {
            "file_path": "/tmp/test.xlsx",
            "_account_id": 1,
            "_account_name": "mexc-backup",
            "_account_address_or_identifier": None
        }
        connector = MEXCDepositsFileConnector(account_id=1, config=config)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-01-15 10:30:00+00:00"),
            "txid": "test_txid_456",
            "currency": "USDT",
            "amount": 50.0,
            "fee": 0.0,
            "fee_quote": "USDT",
            "network": "ERC20",
            "blockchain_hash": "0xdef456"
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert result.source_to_account == "mexc-backup"
        assert result.to_account_id == 1


class TestMEXCWithdrawalsFileAccountFields:
    """Test suite for MEXC withdrawals file connector account fields."""

    def test_withdrawal_account_fields_with_identifier(self):
        """Test that withdrawals correctly populate source_from_account and from_account_id."""
        config = {
            "file_path": "/tmp/test.xlsx",
            "_account_id": 2,
            "_account_name": "mexc-test",
            "_account_address_or_identifier": "mexc-secondary-account"
        }
        connector = MEXCWithdrawalsFileConnector(account_id=2, config=config)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-01-15 14:20:00+00:00"),
            "txid": "withdrawal_txid_789",
            "currency": "BTC",
            "amount": 0.5,
            "fee": 0.0001,
            "fee_quote": "BTC",
            "withdrawal_address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
            "network": "BTC",
            "blockchain_hash": "0xghi789"
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.direction == "outflow"
        assert result.source_transaction_type == "withdrawal"
        assert result.source_from_account == "mexc-secondary-account"
        assert result.from_account_id == 2
        assert result.source_to_account == "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
        assert result.to_account_id is None


class TestOKXFundingFileAccountFields:
    """Test suite for OKX funding file connector account fields."""

    def test_deposit_account_fields(self):
        """Test that deposits correctly populate source_to_account and to_account_id."""
        config = {
            "file_path": "/tmp/test.csv",
            "_account_id": 3,
            "_account_name": "okx-test",
            "_account_address_or_identifier": "okx-main"
        }
        connector = OKXFundingFileConnector(account_id=3, config=config)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-01-10 09:00:00+00:00"),
            "transaction_id": "deposit_001",
            "transaction_type": "deposit",
            "currency": "ETH",
            "amount": 2.0,
            "fee": 0.0
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.direction == "inflow"
        assert result.source_transaction_type == "deposit"
        assert result.source_to_account == "okx-main"
        assert result.to_account_id == 3
        assert result.source_from_account is None
        assert result.from_account_id is None

    def test_withdrawal_account_fields(self):
        """Test that withdrawals correctly populate source_from_account and from_account_id."""
        config = {
            "file_path": "/tmp/test.csv",
            "_account_id": 3,
            "_account_name": "okx-test",
            "_account_address_or_identifier": "okx-main"
        }
        connector = OKXFundingFileConnector(account_id=3, config=config)
        
        raw_row = {
            "datetime": pd.Timestamp("2025-01-11 15:30:00+00:00"),
            "transaction_id": "withdrawal_002",
            "transaction_type": "withdrawal",
            "currency": "ETH",
            "amount": 1.5,
            "fee": 0.005
        }
        
        result = connector.raw_to_normalized(raw_row)
        
        assert isinstance(result, NormalizedTransaction)
        assert result.direction == "outflow"
        assert result.source_transaction_type == "withdrawal"
        assert result.source_from_account == "okx-main"
        assert result.from_account_id == 3
        assert result.source_to_account is None
        assert result.to_account_id is None
