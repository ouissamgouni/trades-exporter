"""
Integration tests for IssueService counts — the single source of truth.

These tests verify that every detector produces correct counts against a real
PostgreSQL database.  They catch bugs like the JSONB ``cast()`` issue that unit
tests cannot detect because unit tests mock all detectors.

Run with: task test:int:local
Database: trades_db_integ (set up with: task db:setup:integ)
"""

import pytest
from datetime import datetime, timezone

from backend.db.models import (
    Account,
    Asset,
    NormalizedTransaction,
    RawAccount,
    ReviewStatus,
)
from backend.services.data_health import IssueService
from backend.services.data_health.detectors import (
    TransferIssueDetector,
    UnmappedAccountDetector,
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


def _make_raw_account(session, source, label, account_id=None, dismissed=False):
    ra = RawAccount(
        source=source,
        label=label,
        account_id=account_id,
        dismissed=dismissed,
    )
    session.add(ra)
    session.commit()
    session.refresh(ra)
    return ra


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
            pg_session, acct,
            transaction_type="transfer", direction="inflow",
            source_from_account=None, from_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_dismissed_to_is_excluded_from_count(self, pg_session):
        acct = _make_account(pg_session)
        _make_tx(
            pg_session, acct,
            transaction_type="transfer", direction="outflow",
            source_to_account=None, to_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_to_account"}],
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_non_dismissed_still_counted(self, pg_session):
        acct = _make_account(pg_session)
        _make_tx(
            pg_session, acct,
            transaction_type="transfer", direction="inflow",
            source_from_account=None, from_account_id=None,
            tags=None,
        )
        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 1


# ===========================================================================
# Unmapped account detector
# ===========================================================================


@pytest.mark.integration
class TestUnmappedAccountDetector:
    """Verify UnmappedAccountDetector counts correctly against real SQL."""

    def test_unmapped_raw_account_matches_tx(self, pg_session):
        """A TX whose source+source_account matches an unmapped RawAccount is counted."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1")
        _make_tx(pg_session, acct, source="binance", source_account="acct1")

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 1

    def test_mapped_raw_account_not_counted(self, pg_session):
        """A RawAccount with account_id set is NOT unmapped — its TXs shouldn't count."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1", account_id=acct.id)
        _make_tx(pg_session, acct, source="binance", source_account="acct1")

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 0

    def test_dismissed_raw_account_not_counted(self, pg_session):
        """Dismissed raw accounts are excluded by default."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1", dismissed=True)
        _make_tx(pg_session, acct, source="binance", source_account="acct1")

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_invalid_tx_not_counted(self, pg_session):
        """Transactions with INVALID review_status are excluded."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1")
        _make_tx(
            pg_session, acct,
            source="binance", source_account="acct1",
            review_status=ReviewStatus.INVALID,
        )

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 0

    def test_matches_source_from_account(self, pg_session):
        """Unmapped raw account matching source_from_account is also counted."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1")
        _make_tx(
            pg_session, acct,
            source="binance", source_from_account="acct1",
            source_account="other",
            transaction_type="transfer", direction="inflow",
        )

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 1

    def test_matches_source_to_account(self, pg_session):
        """Unmapped raw account matching source_to_account is also counted."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1")
        _make_tx(
            pg_session, acct,
            source="binance", source_to_account="acct1",
            source_account="other",
            transaction_type="transfer", direction="outflow",
        )

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 1

    def test_distinct_tx_counted_once(self, pg_session):
        """A single TX matching multiple unmapped accounts counts only once."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1")
        _make_raw_account(pg_session, source="binance", label="acct2")
        _make_tx(
            pg_session, acct,
            source="binance",
            source_account="acct1",
            source_from_account="acct2",
            transaction_type="transfer", direction="inflow",
        )

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 1

    def test_no_unmapped_accounts_returns_zero(self, pg_session):
        """When all raw accounts are mapped, count is 0."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="binance", label="acct1", account_id=acct.id)
        _make_tx(pg_session, acct, source="binance", source_account="acct1")

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 0

    def test_account_ids_filter(self, pg_session):
        """Filtering by account_ids restricts which TXs are counted."""
        acct1 = _make_account(pg_session, name="Acct1")
        acct2 = _make_account(pg_session, name="Acct2")
        _make_raw_account(pg_session, source="binance", label="unmapped1")
        _make_tx(pg_session, acct1, source="binance", source_account="unmapped1")
        _make_tx(pg_session, acct2, source="binance", source_account="unmapped1")

        detector = UnmappedAccountDetector(pg_session)
        assert detector.count() == 2
        assert detector.count(account_ids=[acct1.id]) == 1


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
            pg_session, acct,
            transaction_type="transfer", direction="inflow",
            source_from_account=None, from_account_id=None,
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        _make_tx(
            pg_session, acct,
            transaction_type="transfer", direction="inflow",
            source_from_account=None, from_account_id=None,
            tags=None,
        )

        svc = IssueService(pg_session)
        counts = svc.get_counts(include_dismissed=False)
        assert counts.transfer_issues == 1

        counts_all = svc.get_counts(include_dismissed=True)
        assert counts_all.transfer_issues == 2

    def test_unmapped_accounts_reflected_in_counts(self, pg_session):
        """IssueService.unmapped_accounts should use the detector."""
        acct = _make_account(pg_session)
        _make_raw_account(pg_session, source="src", label="lbl")
        _make_tx(pg_session, acct, source="src", source_account="lbl")

        svc = IssueService(pg_session)
        counts = svc.get_counts()
        assert counts.unmapped_accounts == 1
