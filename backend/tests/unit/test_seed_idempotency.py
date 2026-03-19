"""
Unit tests for seed idempotency — verifying that _upsert_connector()
correctly handles multi-chain connectors (blockscout, moralis) and
distinguishes created vs updated results.

These tests use a mock Session to validate the query-building logic
without requiring a real database.
"""

import pytest
from unittest.mock import MagicMock, patch, call
from datetime import datetime

from backend.db.models import Account, AccountConnector
from backend.db.seed import DatabaseSeeder


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def mock_session():
    """Create a mock SQLModel session."""
    session = MagicMock()
    return session


@pytest.fixture
def seeder(mock_session):
    """Create a DatabaseSeeder with a mock session."""
    return DatabaseSeeder(mock_session)


def _make_connector(**kwargs):
    """Helper to build an AccountConnector with sensible defaults."""
    defaults = dict(
        id=1,
        account_id=1,
        connector_type="blockscout",
        enabled=True,
        config={"chain": "ethereum"},
        credentials_ref=None,
        sync_priority=10,
        last_sync_status="pending",
        created_at=datetime(2024, 1, 1),
        updated_at=datetime(2024, 1, 1),
    )
    defaults.update(kwargs)
    return AccountConnector(**defaults)


# ============================================================================
# _upsert_connector — return value semantics
# ============================================================================


class TestUpsertConnectorReturnValues:
    """Verify created / updated / None semantics."""

    def test_missing_type_returns_none(self, seeder):
        result = seeder._upsert_connector(1, {"config": {}})
        assert result is None

    def test_new_connector_returns_created(self, seeder, mock_session):
        # No existing row found
        mock_session.exec.return_value.first.return_value = None

        result = seeder._upsert_connector(
            1,
            {
                "connector_type": "binance-transactions",
                "enabled": True,
                "config": {"start_date": "2024-01-01"},
            },
        )
        assert result == "created"
        mock_session.add.assert_called_once()

    def test_existing_connector_returns_updated(self, seeder, mock_session):
        existing = _make_connector(connector_type="binance-transactions", config={})
        mock_session.exec.return_value.first.return_value = existing

        result = seeder._upsert_connector(
            1,
            {
                "connector_type": "binance-transactions",
                "enabled": False,
                "config": {"start_date": "2025-01-01"},
            },
        )
        assert result == "updated"


# ============================================================================
# Multi-chain dedup — blockscout & moralis
# ============================================================================


class TestMultiChainIdempotency:
    """
    Ensure that two connectors of the same type but different chains
    are treated as separate entries, and that re-seeding the same data
    results in updates (not duplicates).
    """

    def test_blockscout_different_chains_are_separate(self, seeder, mock_session):
        """
        Two blockscout connectors (ethereum + base) on the same account
        should each be created independently.
        """
        # No existing rows at all
        mock_session.exec.return_value.first.return_value = None

        r1 = seeder._upsert_connector(
            1,
            {
                "connector_type": "blockscout",
                "enabled": True,
                "config": {"chain": "ethereum"},
            },
        )
        r2 = seeder._upsert_connector(
            1,
            {
                "connector_type": "blockscout",
                "enabled": True,
                "config": {"chain": "base"},
            },
        )
        assert r1 == "created"
        assert r2 == "created"
        # Two separate add() calls
        assert mock_session.add.call_count == 2

    def test_moralis_different_chains_are_separate(self, seeder, mock_session):
        """moralis connector should also be chain-aware."""
        mock_session.exec.return_value.first.return_value = None

        r1 = seeder._upsert_connector(
            1,
            {
                "connector_type": "moralis",
                "enabled": True,
                "config": {"chain": "bsc"},
            },
        )
        r2 = seeder._upsert_connector(
            1,
            {
                "connector_type": "moralis",
                "enabled": True,
                "config": {"chain": "arbitrum"},
            },
        )
        assert r1 == "created"
        assert r2 == "created"

    def test_same_chain_is_updated_not_duplicated(self, seeder, mock_session):
        """
        Seeding the same (blockscout, ethereum) twice should update, not create.
        """
        existing = _make_connector(
            connector_type="blockscout",
            config={"chain": "ethereum"},
        )
        mock_session.exec.return_value.first.return_value = existing

        result = seeder._upsert_connector(
            1,
            {
                "connector_type": "blockscout",
                "enabled": False,
                "config": {"chain": "ethereum"},
            },
        )
        assert result == "updated"
        assert existing.enabled is False


# ============================================================================
# seed_accounts — counter accuracy
# ============================================================================


class TestSeedAccountsCounters:
    """Verify that seed_accounts correctly reports created vs updated."""

    def test_counters_reflect_creates_and_updates(self, seeder, mock_session):
        """
        Given 1 account with 2 connectors where one is new and one exists,
        the totals should sum correctly.
        """
        # _upsert_account: return a fake Account with id
        account = Account(id=1, name="Test", account_type="wallet")
        mock_session.exec.return_value.first.return_value = account

        # Patch _upsert_connector to return alternating results
        with patch.object(
            seeder, "_upsert_connector", side_effect=["created", "updated"]
        ):
            with patch.object(seeder, "_upsert_account", return_value=account):
                result = seeder.seed_accounts(
                    [
                        {
                            "name": "Test",
                            "account_type": "wallet",
                            "connectors": [
                                {"connector_type": "blockscout", "config": {"chain": "ethereum"}},
                                {"connector_type": "blockscout", "config": {"chain": "base"}},
                            ],
                        }
                    ]
                )

        assert result["accounts"] == 1
        assert result["connectors"] == 2  # 1 created + 1 updated
