"""
Integration tests for IssueService counts — the single source of truth.

These tests verify that every detector produces correct counts against a real
PostgreSQL database.  They catch bugs like the JSONB ``cast()`` issue that unit
tests cannot detect because unit tests mock all detectors.

Run with: task test:backend:int
Database: dedicated scenario DB, self-provisioned by: task test:backend:int
"""

import pytest
from datetime import datetime, timezone

from backend.db.models import (
    Account,
    Asset,
    NormalizedTransaction,
    ReviewStatus,
)
from backend.services.data_health import IssueService
from backend.services.data_health.detectors import (
    TransferIssueDetector,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_account(session, name="TestAcct", **kw):
    defaults = dict(name=name, account_type="cex", owned=True)
    defaults.update(kw)
    acct = Account(**defaults)
    session.add(acct)
    session.commit()
    session.refresh(acct)
    return acct


def _make_tx(session, account, **kw):
    defaults = dict(
        account_id=account.id,
        date_time=datetime(2024, 1, 15, tzinfo=timezone.utc),
        transaction_type="buy",
        direction="inflow",
        quantity=1.0,
        source_asset_symbol="BTC",
        source="test_source",
        source_account="test_label",
        review_status=ReviewStatus.VALID,
        tags=None,
    )
    defaults.update(kw)
    tx = NormalizedTransaction(**defaults)
    session.add(tx)
    session.commit()
    session.refresh(tx)
    return tx


# ===========================================================================
# Transfer detector: dismiss filter actually works
# ===========================================================================


@pytest.mark.integration
class TestTransferDismissFilterSQL:
    """Verify that the JSONB @> filter produces real SQL that PostgreSQL accepts.

    This is the test that would have caught the ``cast()`` vs ``type_coerce()``
    bug — a unit test with mocks cannot.
    """

    def test_dismissed_from_is_excluded_from_count(self, pg_session):
        acct = _make_account(pg_session)
        _make_tx(
            pg_session,
            acct,
            transaction_type="transfer",
            direction="inflow",
            source_from_account=None,
            from_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_dismissed_to_is_excluded_from_count(self, pg_session):
        acct = _make_account(pg_session)
        _make_tx(
            pg_session,
            acct,
            transaction_type="transfer",
            direction="outflow",
            source_to_account=None,
            to_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_to_account"}],
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_non_dismissed_still_counted(self, pg_session):
        acct = _make_account(pg_session)
        _make_tx(
            pg_session,
            acct,
            transaction_type="transfer",
            direction="inflow",
            source_from_account=None,
            from_account_id=None,
            tags=None,
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 1


# ===========================================================================
# IssueService.get_counts() end-to-end
# ===========================================================================


@pytest.mark.integration
class TestIssueServiceGetCountsEndToEnd:
    """End-to-end test: IssueService.get_counts() with controlled seed data.

    Verifies that the centralized counts match what each detector reports
    individually — catches wiring bugs in IssueService and in the
    underlying SQL.
    """

    def test_transfer_issues_reflects_dismiss(self, pg_session):
        """IssueService.transfer_issues should exclude dismissed items."""
        acct = _make_account(pg_session)
        # 1 dismissed, 1 not
        _make_tx(
            pg_session,
            acct,
            transaction_type="transfer",
            direction="inflow",
            source_from_account=None,
            from_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        _make_tx(
            pg_session,
            acct,
            transaction_type="transfer",
            direction="inflow",
            source_from_account=None,
            from_account_id=None,
            tags=None,
        )

        svc = IssueService(pg_session)
        counts = svc.get_counts(include_dismissed=False)
        assert counts.transfer_issues == 1

        counts_all = svc.get_counts(include_dismissed=True)
        assert counts_all.transfer_issues == 2
