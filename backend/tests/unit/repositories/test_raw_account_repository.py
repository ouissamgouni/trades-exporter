"""
Unit tests for RawAccountRepository.
"""

import pytest
from unittest.mock import MagicMock
from datetime import datetime

from backend.db.models import RawAccount
from backend.db.repositories.raw_account_repository import RawAccountRepository


# ============================================================================
# Test Fixtures
# ============================================================================


@pytest.fixture
def mock_session():
    """Create a mock database session."""
    return MagicMock()


@pytest.fixture
def mock_raw_account():
    """Create a mock raw account."""
    return RawAccount(
        id=1,
        source="blockscout_base",
        label="0x1234567890abcdef1234567890abcdef12345678",
        account_id=None,
        created_at=datetime(2024, 1, 1, 12, 0, 0),
    )


@pytest.fixture
def mock_raw_account_linked():
    """Create a mock raw account that is linked to an account."""
    return RawAccount(
        id=2,
        source="binance",
        label="spot_account",
        account_id=1,
        created_at=datetime(2024, 1, 1, 12, 0, 0),
    )


# ============================================================================
# Test Repository Initialization
# ============================================================================


class TestRawAccountRepositoryInit:
    """Test RawAccountRepository initialization."""

    def test_repository_init(self, mock_session):
        """Repository should be initialized with a session."""
        repo = RawAccountRepository(mock_session)
        assert repo.session == mock_session


# ============================================================================
# Test Get Methods
# ============================================================================


class TestRawAccountRepositoryGet:
    """Test RawAccountRepository get methods."""

    def test_get_by_source_and_label(self, mock_session, mock_raw_account):
        """get() should find a raw account by source and label."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.get(
            "blockscout_base", "0x1234567890abcdef1234567890abcdef12345678"
        )

        assert result == mock_raw_account
        mock_session.exec.assert_called_once()

    def test_get_returns_none_when_not_found(self, mock_session):
        """get() should return None when raw account is not found."""
        mock_session.exec.return_value.first.return_value = None

        repo = RawAccountRepository(mock_session)
        result = repo.get("nonexistent", "nonexistent")

        assert result is None

    def test_get_by_id(self, mock_session, mock_raw_account):
        """get_by_id() should find a raw account by ID."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.get_by_id(1)

        assert result == mock_raw_account

    def test_get_account_id(self, mock_session, mock_raw_account_linked):
        """get_account_id() should return the account_id for a source/label pair."""
        mock_session.exec.return_value.first.return_value = mock_raw_account_linked

        repo = RawAccountRepository(mock_session)
        result = repo.get_account_id("binance", "spot_account")

        assert result == 1

    def test_get_account_id_returns_none_when_not_linked(
        self, mock_session, mock_raw_account
    ):
        """get_account_id() should return None when raw account has no account_id."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.get_account_id("blockscout_base", "0x1234...")

        assert result is None


# ============================================================================
# Test Create Methods
# ============================================================================


class TestRawAccountRepositoryCreate:
    """Test RawAccountRepository create methods."""

    def test_create(self, mock_session, mock_raw_account):
        """create() should add and commit a new raw account."""
        repo = RawAccountRepository(mock_session)
        result = repo.create(mock_raw_account)

        mock_session.add.assert_called_once_with(mock_raw_account)
        mock_session.flush.assert_called_once()
        mock_session.refresh.assert_called_once_with(mock_raw_account)
        mock_session.commit.assert_called_once()

    def test_get_or_create_returns_existing(self, mock_session, mock_raw_account):
        """get_or_create() should return existing raw account if found."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.get_or_create("blockscout_base", "0x1234...")

        assert result == mock_raw_account
        mock_session.add.assert_not_called()

    def test_get_or_create_creates_new(self, mock_session):
        """get_or_create() should create a new raw account if not found."""
        mock_session.exec.return_value.first.return_value = None

        repo = RawAccountRepository(mock_session)
        result = repo.get_or_create("new_source", "new_label")

        mock_session.add.assert_called_once()
        mock_session.commit.assert_called_once()


# ============================================================================
# Test Update Methods
# ============================================================================


class TestRawAccountRepositoryUpdate:
    """Test RawAccountRepository update methods."""

    def test_update(self, mock_session, mock_raw_account):
        """update() should add and commit an updated raw account."""
        repo = RawAccountRepository(mock_session)
        repo.update(mock_raw_account)

        mock_session.add.assert_called_once_with(mock_raw_account)
        mock_session.commit.assert_called_once()

    def test_update_account_id(self, mock_session, mock_raw_account):
        """update_account_id() should update the account_id."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.update_account_id("blockscout_base", "0x1234...", 5)

        assert result is True
        assert mock_raw_account.account_id == 5
        mock_session.commit.assert_called_once()

    def test_update_account_id_returns_false_when_not_found(self, mock_session):
        """update_account_id() should return False when raw account not found."""
        mock_session.exec.return_value.first.return_value = None

        repo = RawAccountRepository(mock_session)
        result = repo.update_account_id("nonexistent", "nonexistent", 5)

        assert result is False

    def test_clear_account_id(self, mock_session, mock_raw_account_linked):
        """clear_account_id() should set account_id to None."""
        mock_session.exec.return_value.first.return_value = mock_raw_account_linked

        repo = RawAccountRepository(mock_session)
        result = repo.clear_account_id("binance", "spot_account")

        assert result is True
        assert mock_raw_account_linked.account_id is None


# ============================================================================
# Test Delete Method
# ============================================================================


class TestRawAccountRepositoryDelete:
    """Test RawAccountRepository delete method."""

    def test_delete(self, mock_session, mock_raw_account):
        """delete() should delete the raw account."""
        mock_session.exec.return_value.first.return_value = mock_raw_account

        repo = RawAccountRepository(mock_session)
        result = repo.delete("blockscout_base", "0x1234...")

        assert result is True
        mock_session.delete.assert_called_once_with(mock_raw_account)
        mock_session.commit.assert_called_once()

    def test_delete_returns_false_when_not_found(self, mock_session):
        """delete() should return False when raw account not found."""
        mock_session.exec.return_value.first.return_value = None

        repo = RawAccountRepository(mock_session)
        result = repo.delete("nonexistent", "nonexistent")

        assert result is False
        mock_session.delete.assert_not_called()


# ============================================================================
# Test List Methods
# ============================================================================


class TestRawAccountRepositoryList:
    """Test RawAccountRepository list methods."""

    def test_list_all(self, mock_session, mock_raw_account, mock_raw_account_linked):
        """list_all() should return all raw accounts."""
        mock_session.exec.return_value.all.return_value = [
            mock_raw_account,
            mock_raw_account_linked,
        ]

        repo = RawAccountRepository(mock_session)
        result = repo.list_all()

        assert len(result) == 2

    def test_find_by_account_id(self, mock_session, mock_raw_account_linked):
        """find_by_account_id() should find all raw accounts for an account."""
        mock_session.exec.return_value.all.return_value = [mock_raw_account_linked]

        repo = RawAccountRepository(mock_session)
        result = repo.find_by_account_id(1)

        assert len(result) == 1
        assert result[0] == mock_raw_account_linked
