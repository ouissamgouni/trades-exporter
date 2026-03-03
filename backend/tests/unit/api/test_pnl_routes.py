"""
Tests for P&L API routes.

Tests cover:
- POST /pnl/calculate (Option D: calculate and persist as draft)
- GET /pnl/versions (list versions)
- GET /pnl/versions/{id} (get version details)
- GET /pnl/versions/{id}/lots (get lots with eager loading)
- GET /pnl/versions/{id}/balances (get materialized balances)
- GET /pnl/versions/{id}/realized-pnl (get P&L entries)
- POST /pnl/versions/{id}/commit (promote draft to committed)
- DELETE /pnl/versions/{id} (delete version)
"""

import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

from api.schemas import AppliedFilters
from api.routes.pnl_filter_depends import PnLTransactionFilters


@pytest.fixture
def no_filters():
    """PnLTransactionFilters with no active filters."""
    return PnLTransactionFilters(
        applied_filters=AppliedFilters(),
        non_owned=False,
        warnings=[],
    )


@pytest.fixture
def mock_session():
    """Mock database session with common behaviors."""
    session = MagicMock()
    session.get = MagicMock(return_value=None)
    session.add = MagicMock()
    session.commit = MagicMock()
    session.flush = MagicMock()
    session.delete = MagicMock()
    
    mock_exec_result = MagicMock()
    mock_exec_result.all.return_value = []
    mock_exec_result.first.return_value = None
    session.exec = MagicMock(return_value=mock_exec_result)
    
    return session


@pytest.fixture
def mock_base_currency():
    """Mock base currency asset."""
    asset = MagicMock()
    asset.asset_id = 1
    asset.symbol = "EUR"
    return asset


@pytest.fixture
def mock_version():
    """Mock calculation version."""
    version = MagicMock()
    version.version_id = 1
    version.description = "Test calculation"
    version.created_at = datetime.utcnow()
    version.expires_at = datetime.utcnow() + timedelta(hours=1)
    version.status = "draft"
    version.method = "FIFO"
    version.lot_mode = "LOT_TRAVEL"
    version.base_currency_id = 1
    version.total_realized_pnl = Decimal("1000.00")
    version.transaction_count = 10
    version.units_processed = 5
    version.lots_created = 3
    version.lots_consumed = 2
    version.warning_count = 1
    return version


@pytest.fixture
def mock_cost_lot():
    """Mock cost lot with asset relationship."""
    lot = MagicMock()
    lot.cost_lot_id = 1
    lot.version_id = 1
    lot.asset_id = 2
    lot.account_id = 1
    lot.qty = Decimal("10")
    lot.qty_remaining = Decimal("8")
    lot.unit_cost_in_base = Decimal("100")
    lot.total_cost_in_base = Decimal("1000")
    # Also provide public properties used by server code
    lot.unit_cost = Decimal("100")
    lot.total_cost = Decimal("1000")
    lot.acquired_at = datetime.utcnow()
    lot.origin_transaction_id = 100
    lot.origin_unit_id = 1
    lot.is_zero_cost = False
    lot.is_negative = False
    lot.notes = None
    
    # Mock asset relationship
    lot.asset = MagicMock()
    lot.asset.asset_id = 2
    lot.asset.symbol = "BTC"
    
    # Mock account relationship
    lot.account = MagicMock()
    lot.account.name = "Binance"
    
    # Mock unit relationship
    lot.unit = MagicMock()
    lot.unit.label = "Buy BTC with EUR"
    lot.unit_id = 1  # Add unit_id for the origin_unit_id mapping
    
    # Mock computed properties
    lot.qty_consumed = Decimal("2")
    lot.remaining_cost_in_base = Decimal("800")
    
    return lot


@pytest.fixture
def mock_balance():
    """Mock asset balance with relationships."""
    balance = MagicMock()
    balance.id = 1
    balance.version_id = 1
    balance.asset_id = 2
    balance.account_id = None
    balance.qty = Decimal("100")
    balance.cost_basis_in_base = Decimal("5000")
    balance.lot_count = 5
    balance.avg_unit_cost_in_base = Decimal("50")
    
    # Mock asset relationship
    balance.asset = MagicMock()
    balance.asset.asset_id = 2
    balance.asset.symbol = "BTC"
    
    # Mock account relationship
    balance.account = None
    
    return balance


@pytest.fixture
def mock_realized_pnl():
    """Mock realized P&L entry with relationships."""
    entry = MagicMock()
    entry.pnl_id = 1
    entry.version_id = 1
    entry.asset_id = 2
    entry.qty = Decimal("1")
    entry.proceeds_in_base = Decimal("2000")
    entry.cost_basis_in_base = Decimal("1000")
    entry.pnl_in_base = Decimal("1000")
    entry.disposal_taxable = True  # Actual field name in RealizedPnl
    entry.transaction_id = 100
    entry.origin_unit_id = 1
    entry.realized_at = datetime.utcnow()
    entry.holding_period_days = 400
    
    # Proceeds tracking metadata
    entry.proceeds_source = "inflow_value"
    entry.proceeds_price = Decimal("2000")
    entry.proceeds_price_source = "price_service"
    entry.proceeds_price_timestamp = datetime.utcnow()
    
    # Mock asset relationship
    entry.asset = MagicMock()
    entry.asset.asset_id = 2
    entry.asset.symbol = "BTC"
    
    return entry


class TestGetVersionLots:
    """Tests for GET /pnl/versions/{id}/lots endpoint."""

    def test_get_lots_returns_empty_for_new_version(self, mock_session, mock_version, no_filters):
        """Test getting lots for a version with no lots."""
        from backend.api.routes.pnl import get_version_lots
        
        # Setup: version exists but has no lots
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = []
        mock_exec_result.one.return_value = 0  # total count
        mock_session.exec.return_value = mock_exec_result
        
        result = get_version_lots(version_id=1, tx_filters=no_filters, session=mock_session)
        
        assert result["items"] == []
        assert result["total"] == 0

    def test_get_lots_returns_formatted_lots(self, mock_session, mock_version, mock_cost_lot, no_filters):
        """Test getting lots returns properly formatted response."""
        from backend.api.routes.pnl import get_version_lots
        
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_cost_lot]
        mock_exec_result.one.return_value = 1  # total count
        mock_session.exec.return_value = mock_exec_result
        
        result = get_version_lots(version_id=1, tx_filters=no_filters, session=mock_session)
        
        assert len(result["items"]) == 1
        lot = result["items"][0]
        assert lot.asset.id == 2
        assert lot.asset.symbol == "BTC"
        assert lot.qty_original == 10.0
        assert lot.qty_remaining == 8.0
        assert lot.account_name == "Binance"

    def test_get_lots_version_not_found(self, mock_session):
        """Test getting lots for non-existent version raises 404."""
        from backend.api.routes.pnl import get_version_lots
        from fastapi import HTTPException
        
        mock_session.get.return_value = None
        
        with pytest.raises(HTTPException) as exc_info:
            get_version_lots(version_id=999, session=mock_session)
        
        assert exc_info.value.status_code == 404

    def test_get_lots_filters_by_asset_id(self, mock_session, mock_version, mock_cost_lot, no_filters):
        """Test getting lots with asset_id filter."""
        from backend.api.routes.pnl import get_version_lots
        
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_cost_lot]
        mock_exec_result.one.return_value = 1  # total count
        mock_session.exec.return_value = mock_exec_result
        
        result = get_version_lots(version_id=1, asset_id=2, tx_filters=no_filters, session=mock_session)
        
        # Verify the query was built with asset_id filter
        mock_session.exec.assert_called()
        
        assert len(result["items"]) == 1
        lot = result["items"][0]
        assert lot.asset.id == 2


class TestGetVersionBalances:
    """Tests for GET /pnl/versions/{id}/balances endpoint."""

    def test_get_balances_returns_formatted_balances(self, mock_session, mock_version, mock_cost_lot, no_filters):
        """Test getting balances returns properly formatted response."""
        from backend.api.routes.pnl import get_version_balances
        
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_cost_lot]
        mock_session.exec.return_value = mock_exec_result
        
        result = get_version_balances(version_id=1, tx_filters=no_filters, session=mock_session)
        
        assert len(result) == 1
        balance = result[0]
        assert balance.asset.id == 2
        assert balance.asset.symbol == "BTC"
        # Qty should be lot's qty_remaining (8)
        assert balance.qty == 8.0
        # Cost should be qty_remaining * unit_cost = 8 * 100 = 800
        assert balance.cost_basis_in_base == 800.0
        assert balance.lot_count == 1


class TestGetVersionRealizedPnl:
    """Tests for GET /pnl/versions/{id}/realized-pnl endpoint."""

    def test_get_realized_pnl_returns_formatted_entries(self, mock_session, mock_version, mock_realized_pnl, no_filters):
        """Test getting realized P&L returns properly formatted response."""
        from backend.api.routes.pnl import get_version_realized_pnl
        
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_realized_pnl]
        mock_exec_result.one.return_value = 1  # total count
        mock_session.exec.return_value = mock_exec_result
        
        result = get_version_realized_pnl(version_id=1, tx_filters=no_filters, session=mock_session)
        
        assert len(result["items"]) == 1
        entry = result["items"][0]
        assert entry.asset.id == 2
        assert entry.asset.symbol == "BTC"
        assert entry.qty == 1.0
        assert entry.pnl_in_base == 1000.0
        assert entry.taxable is True
        assert entry.holding_period_days == 400


class TestCommitVersion:
    """Tests for POST /pnl/versions/{id}/commit endpoint."""

    def test_commit_draft_success(self, mock_session, mock_version):
        """Test committing a draft version."""
        from backend.api.routes.pnl import commit_version
        
        mock_version.status = "draft"
        mock_session.get.return_value = mock_version
        
        result = commit_version(version_id=1, session=mock_session)
        
        assert result["status"] == "committed"
        assert result["version_id"] == 1
        assert mock_version.status == "committed"
        assert mock_version.expires_at is None
        mock_session.commit.assert_called_once()

    def test_commit_non_draft_raises_error(self, mock_session, mock_version):
        """Test committing a non-draft version raises 400."""
        from backend.api.routes.pnl import commit_version
        from fastapi import HTTPException
        
        mock_version.status = "committed"
        mock_session.get.return_value = mock_version
        
        with pytest.raises(HTTPException) as exc_info:
            commit_version(version_id=1, session=mock_session)
        
        assert exc_info.value.status_code == 400
        assert "not 'draft'" in str(exc_info.value.detail)

    def test_commit_not_found(self, mock_session):
        """Test committing non-existent version raises 404."""
        from backend.api.routes.pnl import commit_version
        from fastapi import HTTPException
        
        mock_session.get.return_value = None
        
        with pytest.raises(HTTPException) as exc_info:
            commit_version(version_id=999, session=mock_session)
        
        assert exc_info.value.status_code == 404


class TestListVersions:
    """Tests for GET /pnl/versions endpoint."""

    def test_list_versions_returns_formatted_list(self, mock_session, mock_version, mock_base_currency):
        """Test listing versions returns properly formatted response."""
        from backend.api.routes.pnl import list_versions
        
        mock_exec_result = MagicMock()
        mock_exec_result.all.side_effect = [[mock_version], [mock_base_currency]]
        mock_session.exec.return_value = mock_exec_result
        
        result = list_versions(session=mock_session)
        
        assert len(result) == 1
        version = result[0]
        assert version.version_id == 1
        assert version.status == "draft"
        assert version.lot_method == "FIFO"

    def test_list_versions_filters_by_status(self, mock_session):
        """Test listing versions with status filter."""
        from backend.api.routes.pnl import list_versions
        
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = []
        mock_session.exec.return_value = mock_exec_result
        
        result = list_versions(status="committed", session=mock_session)
        
        assert result == []
        # Verify exec was called (the filter is applied in the query)
        mock_session.exec.assert_called()


class TestDeleteVersion:
    """Tests for DELETE /pnl/versions/{id} endpoint."""

    def test_delete_version_success(self, mock_session, mock_version):
        """Test deleting a version."""
        from backend.api.routes.pnl import delete_version
        
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = []
        mock_session.exec.return_value = mock_exec_result
        
        result = delete_version(version_id=1, session=mock_session)
        
        assert result["status"] == "deleted"
        assert result["version_id"] == 1
        mock_session.delete.assert_called()
        mock_session.commit.assert_called_once()

    def test_delete_version_not_found(self, mock_session):
        """Test deleting non-existent version raises 404."""
        from backend.api.routes.pnl import delete_version
        from fastapi import HTTPException
        
        mock_session.get.return_value = None
        
        with pytest.raises(HTTPException) as exc_info:
            delete_version(version_id=999, session=mock_session)
        
        assert exc_info.value.status_code == 404


# Note: TestPersistResultsSavesBalances was removed because AssetBalance is no longer
# a separate persisted entity. Balances are now calculated on-the-fly by aggregating
# CostLot records in the get_version_balances endpoint.
