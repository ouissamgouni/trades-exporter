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

from backend.services.pnl_calculation_service import PnLCalculationService

from fastapi.testclient import TestClient

from backend.api.schemas import AppliedFilters
from backend.api.routes.pnl_filter_depends import PnLTransactionFilters


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
    version.trigger = None
    version.allow_negative_balances = True
    version.residual_tolerance_pct = Decimal("0.05")
    version.tax_jurisdiction = "standard"
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
    lot.asset.label = "Bitcoin"
    lot.account = MagicMock()
    lot.account.name = "Binance"

    # Mock unit relationship
    lot.unit = MagicMock()
    lot.unit.label = "Buy BTC with EUR"
    lot.unit_id = 1  # Add unit_id for the origin_unit_id mapping

    # Mock computed properties
    lot.qty_consumed = Decimal("2")
    lot.remaining_cost_in_base = Decimal("800")

    # Cost provenance fields
    lot.cost_source = "fmv"
    lot.cost_fmv_price = Decimal("50000.00")
    lot.cost_fmv_source = "coingecko"
    lot.cost_fmv_timestamp = datetime.utcnow()
    lot.cost_fmv_stale = False

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
    balance.asset.label = "Bitcoin"

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

    # Derivative/attributed asset
    entry.attributed_asset = None

    # Mock asset relationship
    entry.asset = MagicMock()
    entry.asset.asset_id = 2
    entry.asset.symbol = "BTC"
    entry.asset.label = "Bitcoin"

    # Mock transaction relationship (for account_id/account_name)
    entry.transaction = MagicMock()
    entry.transaction.account_id = 1
    entry.transaction.account_rel = MagicMock()
    entry.transaction.account_rel.name = "TestAccount"
    entry.transaction.account_rel.envelope = None

    return entry


class TestGetVersionLots:
    """Tests for GET /pnl/versions/{id}/lots endpoint."""

    def test_get_lots_returns_empty_for_new_version(
        self, mock_session, mock_version, no_filters
    ):
        """Test getting lots for a version with no lots."""
        from backend.api.routes.pnl import get_version_lots

        # Setup: version exists but has no lots
        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = []
        mock_exec_result.one.return_value = 0  # total count
        mock_session.exec.return_value = mock_exec_result

        result = get_version_lots(
            version_id=1, tx_filters=no_filters, session=mock_session
        )

        assert result["items"] == []
        assert result["total"] == 0

    def test_get_lots_returns_formatted_lots(
        self, mock_session, mock_version, mock_cost_lot, no_filters
    ):
        """Test getting lots returns properly formatted response."""
        from backend.api.routes.pnl import get_version_lots

        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_cost_lot]
        mock_exec_result.one.return_value = 1  # total count
        mock_session.exec.return_value = mock_exec_result

        result = get_version_lots(
            version_id=1, tx_filters=no_filters, session=mock_session
        )

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

    def test_get_lots_filters_by_asset_id(
        self, mock_session, mock_version, mock_cost_lot, no_filters
    ):
        """Test getting lots with asset_id filter."""
        from backend.api.routes.pnl import get_version_lots

        mock_session.get.return_value = mock_version
        mock_exec_result = MagicMock()
        mock_exec_result.all.return_value = [mock_cost_lot]
        mock_exec_result.one.return_value = 1  # total count
        mock_session.exec.return_value = mock_exec_result

        result = get_version_lots(
            version_id=1, asset_id=2, tx_filters=no_filters, session=mock_session
        )

        # Verify the query was built with asset_id filter
        mock_session.exec.assert_called()

        assert len(result["items"]) == 1
        lot = result["items"][0]
        assert lot.asset.id == 2


class TestGetVersionBalances:
    """Tests for GET /pnl/versions/{id}/balances endpoint."""

    def test_get_balances_returns_formatted_balances(
        self, mock_session, mock_version, mock_cost_lot, no_filters
    ):
        """Test getting balances returns properly formatted response."""
        from backend.api.routes.pnl import get_version_balances

        mock_session.get.return_value = mock_version
        lots_result = MagicMock()
        lots_result.all.return_value = [mock_cost_lot]
        empty_result = MagicMock()
        empty_result.all.return_value = []
        mock_session.exec.side_effect = [lots_result, empty_result]

        result = get_version_balances(
            version_id=1, tx_filters=no_filters, session=mock_session
        )

        assert len(result) == 1
        balance = result[0]
        assert balance.asset.id == 2
        assert balance.asset.symbol == "BTC"
        # Qty should be lot's qty_remaining (8)
        assert balance.qty == 8.0
        # Cost should be qty_remaining * unit_cost = 8 * 100 = 800
        assert balance.cost_basis_in_base == 800.0
        assert balance.lot_count == 1

    def test_grouped_balances_include_realized_only_assets_without_total_invested_key_error(
        self, mock_session, mock_version, no_filters
    ):
        """Test realized-only grouped assets serialize with zero total invested."""
        from backend.api.routes.pnl import get_version_balances

        mock_session.get.return_value = mock_version

        realized_row = MagicMock()
        realized_row.effective_asset_id = 7
        realized_row.total_pnl = Decimal("12.34")
        realized_row.event_count = 1

        realized_asset = MagicMock()
        realized_asset.asset_id = 7
        realized_asset.symbol = "YES"
        realized_asset.label = "Prediction Market YES"

        lots_result = MagicMock()
        lots_result.all.return_value = []
        realized_result = MagicMock()
        realized_result.all.return_value = [realized_row]
        empty_result = MagicMock()
        empty_result.all.return_value = []
        missing_assets_result = MagicMock()
        missing_assets_result.all.return_value = [realized_asset]

        mock_session.exec.side_effect = [
            lots_result,
            realized_result,
            empty_result,
            empty_result,
            empty_result,
            empty_result,
            missing_assets_result,
            empty_result,
            empty_result,
        ]

        result = get_version_balances(
            version_id=1,
            group_by_asset=True,
            tx_filters=no_filters,
            session=mock_session,
        )

        assert len(result) == 1
        balance = result[0]
        assert balance.asset.id == 7
        assert balance.qty == 0.0
        assert balance.cost_basis_in_base == 0.0
        assert balance.total_invested_in_base == 0.0
        assert balance.realized_pnl_in_base == 12.34
        assert balance.realized_event_count == 1


class TestGetVersionRealizedPnl:
    """Tests for GET /pnl/versions/{id}/realized-pnl endpoint."""

    def test_get_realized_pnl_returns_formatted_entries(
        self, mock_session, mock_version, mock_realized_pnl, no_filters
    ):
        """Test getting realized P&L returns properly formatted response."""
        from backend.api.routes.pnl import get_version_realized_pnl

        mock_session.get.return_value = mock_version

        # session.exec() is called 4 times: count, entries, fee-linked ids, FR overrides
        count_result = MagicMock()
        count_result.one.return_value = 1
        entries_result = MagicMock()
        entries_result.all.return_value = [mock_realized_pnl]
        empty_result = MagicMock()
        empty_result.all.return_value = []
        mock_session.exec.side_effect = [
            count_result,
            entries_result,
            empty_result,
            empty_result,
        ]

        result = get_version_realized_pnl(
            version_id=1, tx_filters=no_filters, session=mock_session
        )

        assert len(result["items"]) == 1
        entry = result["items"][0]
        assert entry.asset.id == 2
        assert entry.asset.symbol == "BTC"
        assert entry.qty == 1.0
        assert entry.pnl_in_base == 1000.0
        assert entry.taxable is True
        assert entry.holding_period_days == 400

    @pytest.mark.parametrize("category", ["crypto", "securities", None])
    def test_get_realized_pnl_accepts_fr_tax_category(
        self, mock_session, mock_version, mock_realized_pnl, no_filters, category
    ):
        """Test that fr_tax_category param is accepted for all valid values."""
        from backend.api.routes.pnl import get_version_realized_pnl

        mock_session.get.return_value = mock_version

        count_result = MagicMock()
        count_result.one.return_value = 1
        entries_result = MagicMock()
        entries_result.all.return_value = [mock_realized_pnl]
        empty_result_1 = MagicMock()
        empty_result_1.all.return_value = []
        empty_result_2 = MagicMock()
        empty_result_2.all.return_value = []
        mock_session.exec.side_effect = [
            count_result,
            entries_result,
            empty_result_1,
            empty_result_2,
        ]

        result = get_version_realized_pnl(
            version_id=1,
            fr_tax_category=category,
            tx_filters=no_filters,
            session=mock_session,
        )

        assert "items" in result
        assert "total" in result


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

    def test_list_versions_returns_formatted_list(
        self, mock_session, mock_version, mock_base_currency
    ):
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


# =============================================================================
# Background Calculation Status & Refresh Endpoints
# =============================================================================


# The endpoints do lazy imports:
#   from backend.services.pnl_calculation_service import PnLCalculationService
# So we must patch at the source module.
_SVC_PATCH = "backend.services.pnl_calculation_service.PnLCalculationService"


class TestGetCalculationStatus:
    """Tests for GET /pnl/calculation-status endpoint."""

    def test_returns_service_status(self):
        """GET /calculation-status delegates to PnLCalculationService.get_status()."""
        from backend.api.routes.pnl import get_calculation_status

        mock_service = MagicMock()
        mock_service.get_status.return_value = {
            "status": "stale",
            "is_stale": True,
            "stale_since": "2026-03-06T12:00:00+00:00",
            "stale_reasons": ["Asset updated"],
            "current_version_id": 5,
            "last_calculated_at": "2026-03-06T11:30:00+00:00",
            "error": None,
        }

        with patch(_SVC_PATCH) as mock_cls:
            mock_cls.get_instance.return_value = mock_service
            result = get_calculation_status()

        mock_cls.get_instance.assert_called_once()
        mock_service.get_status.assert_called_once()
        assert result["status"] == "stale"
        assert result["is_stale"] is True
        assert result["current_version_id"] == 5

    def test_returns_idle_when_no_calculation(self):
        """GET /calculation-status with fresh service returns idle."""
        from backend.api.routes.pnl import get_calculation_status

        mock_service = MagicMock()
        mock_service.get_status.return_value = {
            "status": "idle",
            "is_stale": True,
            "stale_since": "2026-03-06T12:00:00+00:00",
            "stale_reasons": ["Server started"],
            "current_version_id": None,
            "last_calculated_at": None,
            "error": None,
        }

        with patch(_SVC_PATCH) as mock_cls:
            mock_cls.get_instance.return_value = mock_service
            result = get_calculation_status()

        assert result["status"] == "idle"
        assert result["current_version_id"] is None


class TestRefreshPnl:
    """Tests for POST /pnl/refresh endpoint."""

    def test_refresh_starts_calculation(self):
        """POST /refresh starts calculation and returns started=True."""
        from backend.api.routes.pnl import refresh_pnl

        mock_service = MagicMock()
        mock_service.start_calculation.return_value = True

        with patch(_SVC_PATCH) as mock_cls:
            mock_cls.get_instance.return_value = mock_service
            result = refresh_pnl()

        mock_service.start_calculation.assert_called_once_with(trigger="refresh")
        assert result == {"started": True}

    def test_refresh_returns_false_when_already_calculating(self):
        """POST /refresh when calculation already running returns started=False."""
        from backend.api.routes.pnl import refresh_pnl

        mock_service = MagicMock()
        mock_service.start_calculation.return_value = False

        with patch(_SVC_PATCH) as mock_cls:
            mock_cls.get_instance.return_value = mock_service
            result = refresh_pnl()

        assert result == {"started": False, "reason": "already_calculating"}

    def test_refresh_passes_refresh_trigger(self):
        """POST /refresh passes trigger='refresh' to the service."""
        from backend.api.routes.pnl import refresh_pnl

        mock_service = MagicMock()
        mock_service.start_calculation.return_value = True

        with patch(_SVC_PATCH) as mock_cls:
            mock_cls.get_instance.return_value = mock_service
            refresh_pnl()

        mock_service.start_calculation.assert_called_once_with(trigger="refresh")


# Note: TestPersistResultsSavesBalances was removed because AssetBalance is no longer
# a separate persisted entity. Balances are now calculated on-the-fly by aggregating
# CostLot records in the get_version_balances endpoint.


# =============================================================================
# TransactionTaxOverride — PATCH endpoint
# =============================================================================


class TestOverrideFrTax:
    """Tests for PATCH /versions/{id}/realized-pnl/{id}/fr-tax-override."""

    @pytest.fixture
    def mock_rpnl(self):
        """Minimal realized P&L mock for override tests."""
        rpnl = MagicMock()
        rpnl.pnl_id = 10
        rpnl.origin_unit_id = 1
        rpnl.transaction_id = 100
        rpnl.disposal_taxable = True
        return rpnl

    @pytest.fixture
    def mock_unit(self):
        unit = MagicMock()
        unit.version_id = 1
        return unit

    def _make_body(self, is_taxable):
        from backend.api.routes.pnl import FrTaxOverrideRequest

        return FrTaxOverrideRequest(is_taxable=is_taxable)

    # --- SET override (true / false) ---

    def test_set_override_creates_new_row(self, mock_session, mock_rpnl, mock_unit):
        """Setting is_taxable=False on a taxable entry creates a TransactionTaxOverride row."""
        from backend.api.routes.pnl import override_fr_tax

        # exec().first() call 1: find rpnl  →  call 2: find existing override (none)
        first_results = iter([mock_rpnl, None])
        mock_exec = MagicMock()
        mock_exec.first.side_effect = lambda: next(first_results)
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = mock_unit

        result = override_fr_tax(
            version_id=1,
            pnl_id=10,
            body=self._make_body(is_taxable=False),
            session=mock_session,
        )

        assert result.pnl_id == 10
        assert result.fr_tax_effective is False
        mock_session.add.assert_called_once()
        added = mock_session.add.call_args[0][0]
        assert added.transaction_id == 100
        assert added.jurisdiction == "fr"
        assert added.is_taxable is False
        mock_session.commit.assert_called_once()

    def test_set_override_updates_existing_row(
        self, mock_session, mock_rpnl, mock_unit
    ):
        """Changing override updates the existing TransactionTaxOverride row in place."""
        from backend.api.routes.pnl import override_fr_tax

        existing_override = MagicMock()
        existing_override.is_taxable = False

        first_results = iter([mock_rpnl, existing_override])
        mock_exec = MagicMock()
        mock_exec.first.side_effect = lambda: next(first_results)
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = mock_unit

        result = override_fr_tax(
            version_id=1,
            pnl_id=10,
            body=self._make_body(is_taxable=True),
            session=mock_session,
        )

        assert result.fr_tax_effective is True
        assert existing_override.is_taxable is True
        mock_session.add.assert_not_called()  # updated in-place, not added
        mock_session.commit.assert_called_once()

    # --- CLEAR override (null) ---

    def test_clear_override_deletes_existing_row(
        self, mock_session, mock_rpnl, mock_unit
    ):
        """Sending is_taxable=null deletes the override row and returns computed default."""
        from backend.api.routes.pnl import override_fr_tax

        existing_override = MagicMock()

        first_results = iter([mock_rpnl, existing_override])
        mock_exec = MagicMock()
        mock_exec.first.side_effect = lambda: next(first_results)
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = mock_unit

        result = override_fr_tax(
            version_id=1,
            pnl_id=10,
            body=self._make_body(is_taxable=None),
            session=mock_session,
        )

        assert result.fr_tax_effective is True  # falls back to disposal_taxable
        mock_session.delete.assert_called_once_with(existing_override)
        mock_session.commit.assert_called_once()

    def test_clear_override_noop_when_no_existing(
        self, mock_session, mock_rpnl, mock_unit
    ):
        """Clearing when no override exists is a no-op (no error, no delete)."""
        from backend.api.routes.pnl import override_fr_tax

        first_results = iter([mock_rpnl, None])
        mock_exec = MagicMock()
        mock_exec.first.side_effect = lambda: next(first_results)
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = mock_unit

        result = override_fr_tax(
            version_id=1,
            pnl_id=10,
            body=self._make_body(is_taxable=None),
            session=mock_session,
        )

        assert result.fr_tax_effective is True
        mock_session.delete.assert_not_called()
        mock_session.commit.assert_called_once()

    # --- Error cases ---

    def test_override_rpnl_not_found_returns_404(self, mock_session):
        """PATCH returns 404 when pnl_id doesn't exist."""
        from backend.api.routes.pnl import override_fr_tax
        from fastapi import HTTPException

        mock_exec = MagicMock()
        mock_exec.first.return_value = None
        mock_session.exec.return_value = mock_exec

        with pytest.raises(HTTPException) as exc:
            override_fr_tax(
                version_id=1,
                pnl_id=999,
                body=self._make_body(is_taxable=False),
                session=mock_session,
            )
        assert exc.value.status_code == 404

    def test_override_wrong_version_returns_404(self, mock_session, mock_rpnl):
        """PATCH returns 404 when pnl_id belongs to a different version."""
        from backend.api.routes.pnl import override_fr_tax
        from fastapi import HTTPException

        mock_exec = MagicMock()
        mock_exec.first.return_value = mock_rpnl
        mock_session.exec.return_value = mock_exec

        wrong_unit = MagicMock()
        wrong_unit.version_id = 999  # different version
        mock_session.get.return_value = wrong_unit

        with pytest.raises(HTTPException) as exc:
            override_fr_tax(
                version_id=1,
                pnl_id=10,
                body=self._make_body(is_taxable=False),
                session=mock_session,
            )
        assert exc.value.status_code == 404

    def test_override_no_transaction_returns_400(self, mock_session, mock_unit):
        """PATCH returns 400 when rpnl has no linked transaction."""
        from backend.api.routes.pnl import override_fr_tax
        from fastapi import HTTPException

        rpnl_no_tx = MagicMock()
        rpnl_no_tx.pnl_id = 10
        rpnl_no_tx.origin_unit_id = 1
        rpnl_no_tx.transaction_id = None

        mock_exec = MagicMock()
        mock_exec.first.return_value = rpnl_no_tx
        mock_session.exec.return_value = mock_exec
        mock_session.get.return_value = mock_unit

        with pytest.raises(HTTPException) as exc:
            override_fr_tax(
                version_id=1,
                pnl_id=10,
                body=self._make_body(is_taxable=True),
                session=mock_session,
            )
        assert exc.value.status_code == 400
        assert "no transaction" in str(exc.value.detail).lower()


# =============================================================================
# FR Tax effective taxability in response mapping
# =============================================================================


class TestFrTaxEffectiveInResponse:
    """Verify fr_tax_effective resolves from override > disposal_taxable."""

    def test_no_override_uses_disposal_taxable(
        self, mock_session, mock_version, mock_realized_pnl, no_filters
    ):
        """When no FR override exists, fr_tax_effective == disposal_taxable."""
        from backend.api.routes.pnl import get_version_realized_pnl

        mock_realized_pnl.disposal_taxable = True
        mock_session.get.return_value = mock_version

        count_r = MagicMock()
        count_r.one.return_value = 1
        entries_r = MagicMock()
        entries_r.all.return_value = [mock_realized_pnl]
        fee_r = MagicMock()
        fee_r.all.return_value = []
        override_r = MagicMock()
        override_r.all.return_value = []  # no overrides
        mock_session.exec.side_effect = [count_r, entries_r, fee_r, override_r]

        result = get_version_realized_pnl(
            version_id=1, tx_filters=no_filters, session=mock_session
        )
        entry = result["items"][0]
        assert entry.fr_tax_effective is True
        assert entry.taxable is True

    def test_override_false_overrides_taxable(
        self, mock_session, mock_version, mock_realized_pnl, no_filters
    ):
        """FR override is_taxable=False overrides disposal_taxable=True."""
        from backend.api.routes.pnl import get_version_realized_pnl

        mock_realized_pnl.disposal_taxable = True
        mock_realized_pnl.transaction_id = 100
        mock_session.get.return_value = mock_version

        count_r = MagicMock()
        count_r.one.return_value = 1
        entries_r = MagicMock()
        entries_r.all.return_value = [mock_realized_pnl]
        fee_r = MagicMock()
        fee_r.all.return_value = []
        # Override: tx 100 → not taxable for FR
        override_r = MagicMock()
        override_r.all.return_value = [(100, False)]
        mock_session.exec.side_effect = [count_r, entries_r, fee_r, override_r]

        result = get_version_realized_pnl(
            version_id=1, tx_filters=no_filters, session=mock_session
        )
        entry = result["items"][0]
        assert entry.taxable is True  # raw disposal_taxable unchanged
        assert entry.fr_tax_effective is False  # overridden for FR

    def test_override_true_overrides_non_taxable(
        self, mock_session, mock_version, mock_realized_pnl, no_filters
    ):
        """FR override is_taxable=True overrides disposal_taxable=False."""
        from backend.api.routes.pnl import get_version_realized_pnl

        mock_realized_pnl.disposal_taxable = False
        mock_realized_pnl.transaction_id = 100
        mock_session.get.return_value = mock_version

        count_r = MagicMock()
        count_r.one.return_value = 1
        entries_r = MagicMock()
        entries_r.all.return_value = [mock_realized_pnl]
        fee_r = MagicMock()
        fee_r.all.return_value = []
        override_r = MagicMock()
        override_r.all.return_value = [(100, True)]
        mock_session.exec.side_effect = [count_r, entries_r, fee_r, override_r]

        result = get_version_realized_pnl(
            version_id=1, tx_filters=no_filters, session=mock_session
        )
        entry = result["items"][0]
        assert entry.taxable is False  # raw unchanged
        assert entry.fr_tax_effective is True  # overridden

    def test_override_only_applies_to_matching_transaction(
        self, mock_session, mock_version, no_filters
    ):
        """Override for tx 200 doesn't affect tx 100."""
        from backend.api.routes.pnl import get_version_realized_pnl

        entry1 = MagicMock()
        entry1.pnl_id = 1
        entry1.asset_id = 2
        entry1.transaction_id = 100
        entry1.qty = Decimal("1")
        entry1.proceeds_in_base = Decimal("2000")
        entry1.cost_basis_in_base = Decimal("1000")
        entry1.pnl_in_base = Decimal("1000")
        entry1.disposal_taxable = True
        entry1.origin_unit_id = 1
        entry1.realized_at = datetime.utcnow()
        entry1.holding_period_days = 10
        entry1.proceeds_source = None
        entry1.proceeds_price = None
        entry1.proceeds_price_source = None
        entry1.proceeds_price_timestamp = None
        entry1.related_asset_symbol = None
        entry1.attributed_asset = None
        entry1.asset = MagicMock()
        entry1.asset.asset_id = 2
        entry1.asset.symbol = "BTC"
        entry1.asset.label = "Bitcoin"
        entry1.transaction = MagicMock()
        entry1.transaction.account_id = 1
        entry1.transaction.account_rel = MagicMock()
        entry1.transaction.account_rel.name = "Acc"

        entry2 = MagicMock()
        entry2.pnl_id = 2
        entry2.asset_id = 2
        entry2.transaction_id = 200
        entry2.qty = Decimal("2")
        entry2.proceeds_in_base = Decimal("4000")
        entry2.cost_basis_in_base = Decimal("2000")
        entry2.pnl_in_base = Decimal("2000")
        entry2.disposal_taxable = True
        entry2.origin_unit_id = 1
        entry2.realized_at = datetime.utcnow()
        entry2.holding_period_days = 20
        entry2.proceeds_source = None
        entry2.proceeds_price = None
        entry2.proceeds_price_source = None
        entry2.proceeds_price_timestamp = None
        entry2.related_asset_symbol = None
        entry2.attributed_asset = None
        entry2.asset = MagicMock()
        entry2.asset.asset_id = 2
        entry2.asset.symbol = "BTC"
        entry2.asset.label = "Bitcoin"
        entry2.transaction = MagicMock()
        entry2.transaction.account_id = 1
        entry2.transaction.account_rel = MagicMock()
        entry2.transaction.account_rel.name = "Acc"

        mock_session.get.return_value = mock_version

        count_r = MagicMock()
        count_r.one.return_value = 2
        entries_r = MagicMock()
        entries_r.all.return_value = [entry1, entry2]
        fee_r = MagicMock()
        fee_r.all.return_value = []
        # Only tx 200 has an override
        override_r = MagicMock()
        override_r.all.return_value = [(200, False)]
        mock_session.exec.side_effect = [count_r, entries_r, fee_r, override_r]

        result = get_version_realized_pnl(
            version_id=1, tx_filters=no_filters, session=mock_session
        )
        items = result["items"]

        # entry1 (tx 100): no override → fr_tax_effective = disposal_taxable = True
        assert items[0].fr_tax_effective is True
        # entry2 (tx 200): override False → fr_tax_effective = False
        assert items[1].fr_tax_effective is False
