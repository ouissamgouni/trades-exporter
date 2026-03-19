"""
Tests for the P&L invalidation after_flush listener.

Covers:
- Detects P&L-relevant models (NormalizedTransaction, Asset, Account, etc.)
- Ignores P&L output models (CalculationVersion, CostLot, etc.)
- Ignores unrelated models
- Formats reasons with operation and count
- Gracefully handles PnLCalculationService import errors
"""

import pytest
from unittest.mock import MagicMock, patch

from backend.db.database import _pnl_after_flush, _get_pnl_model_sets


# The listener does a lazy import inside try/except, so we patch at the source module.
SVC_PATCH = "backend.services.pnl_calculation_service.PnLCalculationService"
MODELS_PATCH = "backend.db.database._get_pnl_model_sets"


# =============================================================================
# Fake model classes (simple Python classes whose instances pass type() checks)
# =============================================================================


class FakeTransaction:
    __name__ = "NormalizedTransaction"


class FakeAsset:
    __name__ = "Asset"


class FakeAccount:
    __name__ = "Account"


class FakeCalcVersion:
    __name__ = "CalculationVersion"


class FakeCostLot:
    __name__ = "CostLot"


class FakeUnrelated:
    __name__ = "SyncJob"


# Pre-built sets that mirror the real configuration
_FAKE_RELEVANT = {FakeTransaction, FakeAsset, FakeAccount}
_FAKE_OUTPUT = {FakeCalcVersion, FakeCostLot}


# =============================================================================
# Helpers
# =============================================================================


def _make_session(new=None, dirty=None, deleted=None):
    """Create a mock session with new/dirty/deleted sets."""
    session = MagicMock()
    session.new = set(new or [])
    session.dirty = set(dirty or [])
    session.deleted = set(deleted or [])
    return session


# =============================================================================
# Model Set Verification (uses real model classes)
# =============================================================================


class TestModelSets:
    """Verify the model sets are correctly configured."""

    def test_relevant_models_include_key_input_tables(self):
        from backend.db.models import (
            NormalizedTransaction, Asset, Account, AppSettings, AssetPriceGetter,
        )
        relevant, _ = _get_pnl_model_sets()
        assert NormalizedTransaction in relevant
        assert Asset in relevant
        assert Account in relevant
        assert AppSettings in relevant
        assert AssetPriceGetter in relevant

    def test_output_models_include_pnl_result_tables(self):
        from backend.db.models import (
            CalculationVersion, CalculationUnit, CostLot,
            RealizedPnl, FeeEntry, PnlWarning,
        )
        _, output = _get_pnl_model_sets()
        assert CalculationVersion in output
        assert CalculationUnit in output
        assert CostLot in output
        assert RealizedPnl in output
        assert FeeEntry in output
        assert PnlWarning in output

    def test_no_overlap_between_relevant_and_output(self):
        relevant, output = _get_pnl_model_sets()
        assert relevant.isdisjoint(output), "Relevant and output model sets must not overlap"


# =============================================================================
# After-Flush Listener Behavior (uses fake model classes to avoid SQLModel issues)
# =============================================================================


class TestPnlAfterFlush:
    """_pnl_after_flush detects relevant changes and calls mark_stale."""

    def _run(self, session, mock_svc):
        """Run _pnl_after_flush with fake model sets and a mock service."""
        with patch(MODELS_PATCH, return_value=(_FAKE_RELEVANT, _FAKE_OUTPUT)):
            with patch(SVC_PATCH) as mock_cls:
                mock_cls.get_instance.return_value = mock_svc
                _pnl_after_flush(session, MagicMock())
        return mock_svc

    def test_detects_new_transaction(self):
        """New relevant model should trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session(new=[FakeTransaction()])

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_called_once()
        reason = mock_svc.mark_stale.call_args[0][0]
        assert "FakeTransaction" in reason
        assert "created" in reason

    def test_detects_dirty_asset(self):
        """Modified relevant model should trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session(dirty=[FakeAsset()])

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_called_once()
        reason = mock_svc.mark_stale.call_args[0][0]
        assert "Asset" in reason
        assert "updated" in reason

    def test_detects_deleted_account(self):
        """Deleted relevant model should trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session(deleted=[FakeAccount()])

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_called_once()
        reason = mock_svc.mark_stale.call_args[0][0]
        assert "Account" in reason
        assert "deleted" in reason

    def test_ignores_pnl_output_models(self):
        """Changes to output models should NOT trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session(new=[FakeCalcVersion(), FakeCostLot()])

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_not_called()

    def test_ignores_unrelated_models(self):
        """Changes to models not in either set should NOT trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session(new=[FakeUnrelated()])

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_not_called()

    def test_ignores_empty_flush(self):
        """No changes at all should not trigger mark_stale."""
        mock_svc = MagicMock()
        session = _make_session()

        self._run(session, mock_svc)

        mock_svc.mark_stale.assert_not_called()

    def test_reason_includes_count_for_multiples(self):
        """Multiple instances should produce count in reason."""
        mock_svc = MagicMock()
        txs = [FakeTransaction() for _ in range(3)]
        session = _make_session(new=txs)

        self._run(session, mock_svc)

        reason = mock_svc.mark_stale.call_args[0][0]
        assert "×3" in reason

    def test_mixed_operations_produce_combined_reason(self):
        """Mixed create/update should produce a reason listing both."""
        mock_svc = MagicMock()
        session = _make_session(new=[FakeTransaction()], dirty=[FakeAsset()])

        self._run(session, mock_svc)

        reason = mock_svc.mark_stale.call_args[0][0]
        assert "FakeTransaction created" in reason
        assert "FakeAsset updated" in reason

    def test_listener_error_does_not_propagate(self):
        """If PnLCalculationService.get_instance() raises, flush should not break."""
        session = _make_session(new=[FakeTransaction()])

        with patch(MODELS_PATCH, return_value=(_FAKE_RELEVANT, _FAKE_OUTPUT)):
            with patch(SVC_PATCH) as mock_cls:
                mock_cls.get_instance.side_effect = RuntimeError("import failed")
                # Should not raise
                _pnl_after_flush(session, MagicMock())
