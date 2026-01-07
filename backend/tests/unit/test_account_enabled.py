"""
Unit tests for Account enabled field functionality.
"""

import pytest
from datetime import datetime
from unittest.mock import MagicMock, patch, AsyncMock

from backend.db.models import Account, AccountConnector


# ============================================================================
# Test Account Model
# ============================================================================


class TestAccountEnabledField:
    """Tests for the Account.enabled field."""

    def test_account_enabled_default_true(self):
        """Test that new accounts have enabled=True by default."""
        account = Account(
            name="Test Account",
            account_type="cex",
        )
        
        assert account.enabled is True

    def test_account_enabled_can_be_false(self):
        """Test that enabled can be explicitly set to False."""
        account = Account(
            name="Test Account",
            account_type="cex",
            enabled=False,
        )
        
        assert account.enabled is False

    def test_account_enabled_can_be_true(self):
        """Test that enabled can be explicitly set to True."""
        account = Account(
            name="Test Account",
            account_type="wallet",
            enabled=True,
        )
        
        assert account.enabled is True


# ============================================================================
# Test AccountConnector Model
# ============================================================================


class TestAccountConnectorEnabledField:
    """Tests for the AccountConnector.enabled field."""

    def test_connector_enabled_default_true(self):
        """Test that new connectors have enabled=True by default."""
        connector = AccountConnector(
            account_id=1,
            connector_type="binance-transactions",
            config={"api_key": "test"},
        )
        
        assert connector.enabled is True

    def test_connector_enabled_can_be_false(self):
        """Test that connector enabled can be set to False."""
        connector = AccountConnector(
            account_id=1,
            connector_type="etherscan",
            config={},
            enabled=False,
        )
        
        assert connector.enabled is False


# ============================================================================
# Test Combined Account and Connector Enabled Logic
# ============================================================================


class TestEnabledFiltering:
    """Tests for filtering by enabled status."""

    def test_both_enabled_should_sync(self):
        """Test that connector syncs when both account and connector are enabled."""
        account = Account(name="Test", account_type="cex", enabled=True)
        connector = AccountConnector(
            account_id=1,
            connector_type="binance-transactions",
            config={},
            enabled=True,
        )
        
        # Both enabled - should be included in sync
        should_sync = account.enabled and connector.enabled
        assert should_sync is True

    def test_account_disabled_should_not_sync(self):
        """Test that connector doesn't sync when account is disabled."""
        account = Account(name="Test", account_type="cex", enabled=False)
        connector = AccountConnector(
            account_id=1,
            connector_type="binance-transactions",
            config={},
            enabled=True,
        )
        
        # Account disabled - should not be included
        should_sync = account.enabled and connector.enabled
        assert should_sync is False

    def test_connector_disabled_should_not_sync(self):
        """Test that connector doesn't sync when connector is disabled."""
        account = Account(name="Test", account_type="cex", enabled=True)
        connector = AccountConnector(
            account_id=1,
            connector_type="binance-transactions",
            config={},
            enabled=False,
        )
        
        # Connector disabled - should not be included
        should_sync = account.enabled and connector.enabled
        assert should_sync is False

    def test_both_disabled_should_not_sync(self):
        """Test that connector doesn't sync when both are disabled."""
        account = Account(name="Test", account_type="cex", enabled=False)
        connector = AccountConnector(
            account_id=1,
            connector_type="binance-transactions",
            config={},
            enabled=False,
        )
        
        # Both disabled - should not be included
        should_sync = account.enabled and connector.enabled
        assert should_sync is False
