"""
Unit tests for DataCleanupService.

These are PROPER UNIT TESTS - they use mocked database sessions and do not
touch any real database. All SQL execution is mocked and verified.

Tests:
- preview_connector_cleanup counts
- execute_connector_cleanup cascade ordering
- execute_account_cleanup delegates + handles orphans
- execute_account_delete full lifecycle
- empty connector_ids edge case
"""

import pytest
from unittest.mock import MagicMock, call, patch
from dataclasses import dataclass

from backend.services.data_cleanup_service import DataCleanupService, CleanupPreview, CleanupResult
from backend.db.models import Account, AccountConnector


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture
def mock_session():
    """Create a mock database session for unit tests."""
    return MagicMock()


@pytest.fixture
def service(mock_session):
    """Create a DataCleanupService with a mock session."""
    return DataCleanupService(mock_session)


def _make_connector(cid: int, account_id: int = 1, connector_type: str = "test-connector"):
    """Create a mock AccountConnector."""
    conn = MagicMock(spec=AccountConnector)
    conn.id = cid
    conn.account_id = account_id
    conn.connector_type = connector_type
    return conn


def _make_account(aid: int, name: str = "Test Account"):
    """Create a mock Account."""
    acc = MagicMock(spec=Account)
    acc.id = aid
    acc.name = name
    return acc


# =============================================================================
# Preview Tests
# =============================================================================


class TestPreviewConnectorCleanup:
    """Tests for preview_connector_cleanup."""

    def test_empty_connector_ids_returns_empty_preview(self, service):
        result = service.preview_connector_cleanup([])
        assert result.connector_ids == []
        assert result.connector_names == []
        assert result.transactions == 0

    def test_resolves_connector_names(self, service, mock_session):
        connector = _make_connector(10, account_id=1, connector_type="binance-transactions")
        account = _make_account(1, name="My Binance")

        def get_side_effect(model, pk):
            if model is AccountConnector and pk == 10:
                return connector
            if model is Account and pk == 1:
                return account
            return None

        mock_session.get.side_effect = get_side_effect

        # Mock all COUNT queries to return 0
        mock_result = MagicMock()
        mock_result.one.return_value = (0,)
        mock_session.exec.return_value = mock_result

        result = service.preview_connector_cleanup([10])

        assert result.connector_ids == [10]
        assert result.connector_names == ["My Binance / binance-transactions"]

    def test_counts_all_dependency_types(self, service, mock_session):
        connector = _make_connector(10)
        account = _make_account(1)
        mock_session.get.side_effect = lambda model, pk: (
            connector if model is AccountConnector else account
        )

        # Return different counts for each query
        counts = [42, 100, 5, 3, 7, 12, 8, 2]
        call_idx = [0]

        def exec_side_effect(*args, **kwargs):
            result = MagicMock()
            idx = call_idx[0]
            if idx < len(counts):
                result.one.return_value = (counts[idx],)
            else:
                result.one.return_value = (0,)
            call_idx[0] += 1
            return result

        mock_session.exec.side_effect = exec_side_effect

        result = service.preview_connector_cleanup([10])

        assert result.transactions == 42
        assert result.raw_transactions == 100
        assert result.sync_runs == 5
        assert result.file_imports == 3
        assert result.transfer_references == 7
        assert result.cost_lots == 12
        assert result.derivative_positions == 8
        assert result.pnl_legs_affected == 2

    def test_multiple_connectors(self, service, mock_session):
        conn1 = _make_connector(10, account_id=1, connector_type="binance-transactions")
        conn2 = _make_connector(20, account_id=2, connector_type="blockscout")
        acc1 = _make_account(1, name="Binance")
        acc2 = _make_account(2, name="ETH Wallet")

        def get_side_effect(model, pk):
            if model is AccountConnector:
                return {10: conn1, 20: conn2}.get(pk)
            if model is Account:
                return {1: acc1, 2: acc2}.get(pk)
            return None

        mock_session.get.side_effect = get_side_effect

        mock_result = MagicMock()
        mock_result.one.return_value = (0,)
        mock_session.exec.return_value = mock_result

        result = service.preview_connector_cleanup([10, 20])

        assert result.connector_ids == [10, 20]
        assert len(result.connector_names) == 2
        assert "Binance / binance-transactions" in result.connector_names
        assert "ETH Wallet / blockscout" in result.connector_names


# =============================================================================
# Execute Tests
# =============================================================================


class TestExecuteConnectorCleanup:
    """Tests for execute_connector_cleanup."""

    def test_empty_connector_ids_returns_empty_result(self, service):
        result = service.execute_connector_cleanup([])
        assert result.connectors_deleted == 0
        assert result.transactions_deleted == 0

    def test_cascade_order_detaches_pnl_before_deleting_txs(self, service, mock_session):
        """Verify that derivative positions and P&L children are detached before transactions are deleted."""
        mock_result = MagicMock()
        mock_result.rowcount = 0
        mock_session.exec.return_value = mock_result

        service.execute_connector_cleanup([10], delete_connectors=True)

        # Collect all SQL strings executed
        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        # Find indices of key operations
        def find_idx(substring):
            for i, s in enumerate(sql_calls):
                if substring in s:
                    return i
            return -1

        dp_delete = find_idx("DELETE FROM derivative_positions WHERE connector_id")
        pnl_detach = find_idx("DELETE FROM calculation_unit_legs")
        raw_fk_null = find_idx("UPDATE normalized_transactions SET raw_transaction_id = NULL")
        raw_delete = find_idx("DELETE FROM raw_transactions")
        tx_delete = find_idx("DELETE FROM normalized_transactions WHERE connector_id")
        connector_delete = find_idx("DELETE FROM account_connectors")

        assert dp_delete >= 0, "Derivative positions delete should happen"
        assert pnl_detach >= 0, "P&L legs detach should happen"
        assert raw_fk_null >= 0, "raw_transaction_id nullification should happen"
        assert raw_delete >= 0, "Raw transactions delete should happen"
        assert tx_delete >= 0, "Transaction delete should happen"
        assert connector_delete >= 0, "Connector delete should happen"
        assert dp_delete < pnl_detach, "Derivative delete must come before P&L detach"
        assert pnl_detach < tx_delete, "P&L detach must come before tx delete"
        assert raw_fk_null < raw_delete, "raw_transaction_id FK must be nullified before raw delete"
        assert raw_delete < tx_delete, "Raw delete must come before tx delete"
        assert tx_delete < connector_delete, "Tx delete must come before connector delete"

    def test_detaches_cost_lot_children_before_deleting_lots(self, service, mock_session):
        mock_result = MagicMock()
        mock_result.rowcount = 0
        mock_session.exec.return_value = mock_result

        service.execute_connector_cleanup([10], delete_connectors=False)

        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        def find_idx(substring):
            for i, s in enumerate(sql_calls):
                if substring in s:
                    return i
            return -1

        lot_settled_by_null = find_idx("UPDATE cost_lots SET settled_by_lot_id = NULL")
        lot_slices_del = find_idx("DELETE FROM consumed_lot_slices")
        lot_delete = find_idx("DELETE FROM cost_lots WHERE cost_lot_id")

        assert lot_settled_by_null >= 0
        assert lot_slices_del >= 0
        assert lot_delete >= 0
        assert lot_settled_by_null < lot_delete
        assert lot_slices_del < lot_delete

    def test_deletes_file_imports_and_sync_runs(self, service, mock_session):
        mock_result = MagicMock()
        mock_result.rowcount = 5
        mock_session.exec.return_value = mock_result

        result = service.execute_connector_cleanup([10], delete_connectors=True)

        # file_imports and sync_runs should be cleaned
        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        assert any("DELETE FROM file_imports" in s for s in sql_calls)
        assert any("DELETE FROM sync_job_connector_runs" in s for s in sql_calls)
        assert any("DELETE FROM raw_transactions" in s for s in sql_calls)

    def test_delete_connectors_true_deletes_rows(self, service, mock_session):
        mock_result = MagicMock()
        mock_result.rowcount = 1
        mock_session.exec.return_value = mock_result

        result = service.execute_connector_cleanup([10], delete_connectors=True)

        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        assert any("DELETE FROM account_connectors WHERE id IN" in s for s in sql_calls)
        assert result.connectors_deleted == 1

    def test_delete_connectors_false_resets_status(self, service, mock_session):
        mock_result = MagicMock()
        mock_result.rowcount = 1
        mock_session.exec.return_value = mock_result

        result = service.execute_connector_cleanup([10], delete_connectors=False)

        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        assert any("UPDATE account_connectors SET last_sync_at = NULL" in s for s in sql_calls)
        assert not any("DELETE FROM account_connectors" in s for s in sql_calls)
        assert result.connectors_reset == 1
        assert result.connectors_deleted == 0

    def test_returns_correct_counts(self, service, mock_session):
        """Verify that rowcounts from key delete operations are captured."""
        call_idx = [0]
        # Map specific operations to rowcounts
        rowcount_map = {
            "DELETE FROM derivative_positions WHERE connector_id": 6,
            "DELETE FROM cost_lots WHERE cost_lot_id": 3,
            "DELETE FROM file_imports": 2,
            "DELETE FROM sync_job_connector_runs": 4,
            "DELETE FROM raw_transactions": 10,
            "DELETE FROM normalized_transactions WHERE connector_id": 7,
            "DELETE FROM account_connectors": 1,
        }

        def exec_side_effect(stmt, *args, **kwargs):
            result = MagicMock()
            sql_str = str(stmt.text) if hasattr(stmt, 'text') else str(stmt)
            for key, count in rowcount_map.items():
                if key in sql_str:
                    result.rowcount = count
                    return result
            result.rowcount = 0
            return result

        mock_session.exec.side_effect = exec_side_effect

        result = service.execute_connector_cleanup([10], delete_connectors=True)

        assert result.cost_lots_deleted == 3
        assert result.file_imports_deleted == 2
        assert result.sync_runs_deleted == 4
        assert result.raw_transactions_deleted == 10
        assert result.transactions_deleted == 7
        assert result.connectors_deleted == 1
        assert result.derivative_positions_deleted == 6


# =============================================================================
# Account Cleanup Tests
# =============================================================================


class TestExecuteAccountCleanup:
    """Tests for execute_account_cleanup."""

    def test_resolves_connector_ids_from_account(self, service, mock_session):
        # Mock the connector IDs query
        call_idx = [0]

        def exec_side_effect(stmt, *args, **kwargs):
            result = MagicMock()
            sql_str = str(stmt.text) if hasattr(stmt, 'text') else str(stmt)
            if "SELECT id FROM account_connectors WHERE account_id" in sql_str:
                result.all.return_value = [(10,), (20,)]
                return result
            result.rowcount = 0
            result.one.return_value = (0,)
            return result

        mock_session.exec.side_effect = exec_side_effect

        result = service.execute_account_cleanup(1, delete_connectors=False)

        # Should have queried for connector IDs
        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]
        assert any("SELECT id FROM account_connectors WHERE account_id" in s for s in sql_calls)

    def test_handles_orphan_transactions(self, service, mock_session):
        """Verify it cleans transactions not tied to any connector."""
        def exec_side_effect(stmt, *args, **kwargs):
            result = MagicMock()
            sql_str = str(stmt.text) if hasattr(stmt, 'text') else str(stmt)
            if "SELECT id FROM account_connectors WHERE account_id" in sql_str:
                result.all.return_value = []
                return result
            result.rowcount = 0
            result.one.return_value = (0,)
            return result

        mock_session.exec.side_effect = exec_side_effect

        service.execute_account_cleanup(1, delete_connectors=False)

        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        # Should handle orphan transactions
        assert any("connector_id IS NULL" in s for s in sql_calls)
        # Should handle account-level cost lots
        assert any("DELETE FROM cost_lots WHERE account_id" in s for s in sql_calls)
        # Should handle derivative positions
        assert any("DELETE FROM derivative_positions WHERE account_id" in s for s in sql_calls)
        # Should nullify raw accounts
        assert any("UPDATE raw_accounts SET account_id = NULL" in s for s in sql_calls)


# =============================================================================
# Account Delete Tests
# =============================================================================


class TestExecuteAccountDelete:
    """Tests for execute_account_delete."""

    def test_raises_if_account_not_found(self, service, mock_session):
        mock_session.get.return_value = None

        with pytest.raises(ValueError, match="Account 999 not found"):
            service.execute_account_delete(999)

    def test_nullifies_transfer_refs_before_cleanup(self, service, mock_session):
        account = _make_account(1)
        mock_session.get.return_value = account

        def exec_side_effect(stmt, *args, **kwargs):
            result = MagicMock()
            sql_str = str(stmt.text) if hasattr(stmt, 'text') else str(stmt)
            if "SELECT id FROM account_connectors WHERE account_id" in sql_str:
                result.all.return_value = []
                return result
            result.rowcount = 0
            result.one.return_value = (0,)
            return result

        mock_session.exec.side_effect = exec_side_effect

        service.execute_account_delete(1)

        sql_calls = [
            str(c.args[0].text) if hasattr(c.args[0], 'text') else str(c.args[0])
            for c in mock_session.exec.call_args_list
        ]

        # Transfer refs should be nullified
        assert any("UPDATE normalized_transactions SET from_account_id = NULL" in s for s in sql_calls)
        assert any("UPDATE normalized_transactions SET to_account_id = NULL" in s for s in sql_calls)

        # Transfer ref nullification should come before connector cleanup
        from_idx = next(i for i, s in enumerate(sql_calls) if "from_account_id = NULL" in s)
        to_idx = next(i for i, s in enumerate(sql_calls) if "to_account_id = NULL" in s)

        # They should be early in the sequence
        assert from_idx < 5
        assert to_idx < 5

    def test_deletes_account_object(self, service, mock_session):
        account = _make_account(1)
        mock_session.get.return_value = account

        def exec_side_effect(stmt, *args, **kwargs):
            result = MagicMock()
            sql_str = str(stmt.text) if hasattr(stmt, 'text') else str(stmt)
            if "SELECT id FROM account_connectors WHERE account_id" in sql_str:
                result.all.return_value = []
                return result
            result.rowcount = 0
            result.one.return_value = (0,)
            return result

        mock_session.exec.side_effect = exec_side_effect

        service.execute_account_delete(1)

        mock_session.delete.assert_called_once_with(account)


# =============================================================================
# Edge Cases
# =============================================================================


class TestEdgeCases:
    """Edge case tests."""

    def test_preview_with_missing_connector(self, service, mock_session):
        """Preview should handle missing connectors gracefully."""
        mock_session.get.return_value = None
        mock_result = MagicMock()
        mock_result.one.return_value = (0,)
        mock_session.exec.return_value = mock_result

        result = service.preview_connector_cleanup([999])

        # Should not crash, just have empty name
        assert result.connector_ids == [999]
        assert result.connector_names == []

    def test_single_connector_id_tuple_handling(self, service, mock_session):
        """Verify single-element tuple is handled correctly (SQLAlchemy edge case)."""
        mock_result = MagicMock()
        mock_result.rowcount = 0
        mock_session.exec.return_value = mock_result

        # Should not raise - the tuple (10,) is valid SQL IN clause
        result = service.execute_connector_cleanup([10], delete_connectors=False)
        assert isinstance(result, CleanupResult)
