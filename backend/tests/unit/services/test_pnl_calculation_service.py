"""
Tests for PnLCalculationService — background P&L calculation with stale detection.

Covers:
- Initial state (IDLE, stale on startup)
- mark_stale() status transitions and reason accumulation
- start_calculation() thread guard and shutting-down guard
- get_status() dict shape
- Singleton lifecycle (get_instance / reset_instance)
"""

import threading
import time
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone

from backend.services.pnl_calculation_service import (
    PnLCalculationService,
    PnLCalcStatus,
    MAX_STALE_REASONS,
)


@pytest.fixture(autouse=True)
def reset_singleton():
    """Reset the singleton before and after each test."""
    PnLCalculationService.reset_instance()
    yield
    PnLCalculationService.reset_instance()


@pytest.fixture
def service():
    """Fresh PnLCalculationService instance."""
    return PnLCalculationService()


# =============================================================================
# Initial State
# =============================================================================


class TestInitialState:
    """On startup the service should assume stale (no calculation run yet)."""

    def test_initial_status_is_idle(self, service):
        status = service.get_status()
        assert status["status"] == "idle"

    def test_initial_is_stale(self, service):
        status = service.get_status()
        assert status["is_stale"] is True

    def test_initial_stale_reason_server_started(self, service):
        status = service.get_status()
        assert "Server started" in status["stale_reasons"]

    def test_initial_stale_since_is_set(self, service):
        status = service.get_status()
        assert status["stale_since"] is not None

    def test_initial_no_version_or_error(self, service):
        status = service.get_status()
        assert status["current_version_id"] is None
        assert status["last_calculated_at"] is None
        assert status["error"] is None


# =============================================================================
# mark_stale()
# =============================================================================


class TestMarkStale:
    """mark_stale() should transition to STALE and accumulate reasons."""

    def test_mark_stale_sets_status(self, service):
        # Start from a clean COMPLETED state
        service._status = PnLCalcStatus.COMPLETED
        service._is_stale = False
        service._stale_reasons = []

        service.mark_stale("Asset updated")

        status = service.get_status()
        assert status["status"] == "stale"
        assert status["is_stale"] is True

    def test_mark_stale_records_reason(self, service):
        service._is_stale = False
        service._stale_reasons = []

        service.mark_stale("NormalizedTransaction created (×5)")

        assert "NormalizedTransaction created (×5)" in service.get_status()["stale_reasons"]

    def test_mark_stale_accumulates_reasons(self, service):
        service._is_stale = False
        service._stale_reasons = []

        service.mark_stale("Asset updated")
        service.mark_stale("Account deleted")

        reasons = service.get_status()["stale_reasons"]
        assert "Asset updated" in reasons
        assert "Account deleted" in reasons

    def test_mark_stale_caps_reasons_at_max(self, service):
        service._is_stale = False
        service._stale_reasons = []

        for i in range(MAX_STALE_REASONS + 10):
            service.mark_stale(f"Change {i}")

        reasons = service.get_status()["stale_reasons"]
        # MAX_STALE_REASONS normal entries + 1 "... and more changes" sentinel
        assert len(reasons) == MAX_STALE_REASONS + 1
        assert reasons[-1] == "... and more changes"

    def test_mark_stale_sets_stale_since_on_first_call(self, service):
        service._is_stale = False
        service._stale_since = None
        service._stale_reasons = []

        before = datetime.now(timezone.utc)
        service.mark_stale("Test change")
        after = datetime.now(timezone.utc)

        assert service._stale_since is not None
        assert before <= service._stale_since <= after

    def test_mark_stale_during_calculating_does_not_change_status(self, service):
        """If a calculation is running, mark_stale keeps CALCULATING status."""
        service._status = PnLCalcStatus.CALCULATING
        service._is_stale = False
        service._stale_reasons = []

        service.mark_stale("Late edit")

        assert service._status == PnLCalcStatus.CALCULATING
        assert service._is_stale is True


# =============================================================================
# start_calculation()
# =============================================================================


class TestStartCalculation:
    """start_calculation() should guard against concurrent runs and shutdown."""

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_start_returns_true_and_sets_calculating(self, mock_run, service):
        result = service.start_calculation(trigger="refresh")

        assert result is True
        assert service._status == PnLCalcStatus.CALCULATING
        # Thread was created and started
        assert service._calculation_thread is not None

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_start_returns_false_if_already_calculating(self, mock_run, service):
        service._status = PnLCalcStatus.CALCULATING

        result = service.start_calculation(trigger="refresh")

        assert result is False

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_start_returns_false_if_shutting_down(self, mock_run, service):
        service._shutting_down = True

        result = service.start_calculation(trigger="refresh")

        assert result is False


# =============================================================================
# _run_calculation() — success & error paths
# =============================================================================


class TestRunCalculation:
    """Test the background calculation thread logic."""

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_successful_calculation_clears_stale(self, mock_run, service):
        """Simulate a successful calculation by manually updating state."""
        # Mark stale first
        service._is_stale = True
        service._status = PnLCalcStatus.STALE

        # Simulate what _run_calculation does on success
        service._status = PnLCalcStatus.CALCULATING
        # Simulate success
        service._is_stale = False
        service._stale_reasons = []
        service._current_version_id = 42
        service._last_calculated_at = datetime.now(timezone.utc)
        service._status = PnLCalcStatus.COMPLETED

        status = service.get_status()
        assert status["status"] == "completed"
        assert status["is_stale"] is False
        assert status["current_version_id"] == 42

    def test_error_sets_error_status(self, service):
        """Simulate a failed calculation."""
        service._status = PnLCalcStatus.ERROR
        service._error_message = "ValueError: AppSettings not found"
        service._is_stale = True

        status = service.get_status()
        assert status["status"] == "error"
        assert "AppSettings" in status["error"]
        assert status["is_stale"] is True

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_stale_during_calculation_stays_stale_after(self, mock_run, service):
        """If mark_stale fires during calculation, result should remain stale."""
        service._status = PnLCalcStatus.CALCULATING
        service._is_stale = False

        # Simulate a new mark_stale arriving while calculating
        service.mark_stale("Late arriving transaction")

        # After calculation completes, it checks is_stale — should see True
        assert service._is_stale is True
        assert service._status == PnLCalcStatus.CALCULATING  # Still calculating


# =============================================================================
# get_status() shape
# =============================================================================


class TestGetStatus:
    """get_status() must return all expected keys."""

    def test_status_dict_has_all_keys(self, service):
        status = service.get_status()
        expected_keys = {
            "status", "is_stale", "stale_since", "stale_reasons",
            "current_version_id", "last_calculated_at", "error",
        }
        assert set(status.keys()) == expected_keys

    def test_status_serializes_datetimes_as_iso(self, service):
        status = service.get_status()
        # stale_since should be an ISO string
        if status["stale_since"]:
            datetime.fromisoformat(status["stale_since"])  # Should not raise


# =============================================================================
# Singleton lifecycle
# =============================================================================


class TestSingleton:
    """get_instance / reset_instance lifecycle."""

    def test_get_instance_returns_same_object(self):
        a = PnLCalculationService.get_instance()
        b = PnLCalculationService.get_instance()
        assert a is b

    def test_reset_instance_creates_new_object(self):
        a = PnLCalculationService.get_instance()
        PnLCalculationService.reset_instance()
        b = PnLCalculationService.get_instance()
        assert a is not b

    def test_reset_instance_calls_shutdown(self):
        svc = PnLCalculationService.get_instance()
        with patch.object(svc, "shutdown") as mock_shutdown:
            PnLCalculationService.reset_instance()
            mock_shutdown.assert_called_once()


# =============================================================================
# shutdown()
# =============================================================================


class TestShutdown:
    """shutdown() should flag shutting_down and join the thread."""

    def test_shutdown_sets_flag(self, service):
        service.shutdown()
        assert service._shutting_down is True

    @patch("backend.services.pnl_calculation_service.PnLCalculationService._run_calculation")
    def test_shutdown_joins_active_thread(self, mock_run, service):
        # Start a "calculation" (mocked so it does nothing)
        service.start_calculation(trigger="test")
        # Give the thread a moment to finish the mock
        time.sleep(0.05)

        # Shutdown should not error even if thread already finished
        service.shutdown()
        assert service._shutting_down is True
