"""
Integration tests for transfer issue dismissal.

Tests the full dismiss lifecycle:
- Dismiss tag format: {"sys_transfer_dismissed": "<field>"}
- Filter correctly excludes dismissed transactions
- Repeated dismissals don't accumulate tags
- Dismissing "from" doesn't affect "to" issues
- Transactions with NULL tags are not excluded
- include_dismissed=True shows dismissed items

Run with: task test:backend:int
Database: dedicated scenario DB, self-provisioned by: task test:backend:int
"""

import pytest
from datetime import datetime, timezone
from sqlalchemy.orm.attributes import flag_modified

from backend.db.models import (
    NormalizedTransaction,
    ReviewStatus,
    Account,
)
from backend.services.data_health.detectors import TransferIssueDetector


def _make_transfer(pg_session, account, direction="inflow", **overrides):
    """Helper to create a transfer transaction."""
    defaults = dict(
        account_id=account.id,
        date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
        transaction_type="transfer",
        direction=direction,
        quantity=1.0,
        source_asset_symbol="BTC",
        source="transfer",
        from_account_id=None,
        to_account_id=None,
        source_from_account=None,
        source_to_account=None,
        review_status=ReviewStatus.VALID,
        tags=None,
    )
    defaults.update(overrides)
    tx = NormalizedTransaction(**defaults)
    pg_session.add(tx)
    pg_session.commit()
    pg_session.refresh(tx)
    return tx


@pytest.mark.integration
class TestTransferDismissTagFormat:
    """Validate the dismiss tag format and filter behaviour."""

    def test_null_tags_not_excluded(self, pg_session):
        """Transactions with NULL tags must still show as issues."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        _make_transfer(pg_session, account, direction="inflow", tags=None)

        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 1

    def test_empty_list_tags_not_excluded(self, pg_session):
        """Transactions with empty [] tags must still show as issues."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        _make_transfer(pg_session, account, direction="inflow", tags=[])

        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 1

    def test_dismissed_from_excluded(self, pg_session):
        """A transfer dismissed for source_from_account is excluded from 'from' issues."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        _make_transfer(
            pg_session,
            account,
            direction="inflow",
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )

        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_dismissed_to_excluded(self, pg_session):
        """A transfer dismissed for source_to_account is excluded from 'to' issues."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        _make_transfer(
            pg_session,
            account,
            direction="outflow",
            tags=[{"sys_transfer_dismissed": "source_to_account"}],
        )

        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 1

    def test_dismissed_from_does_not_affect_to(self, pg_session):
        """Dismissing source_from_account does NOT hide source_to_account issues."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        # Outflow transfer missing to_account, but dismissed for from_account (wrong field)
        _make_transfer(
            pg_session,
            account,
            direction="outflow",
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )

        detector = TransferIssueDetector(pg_session)
        # Should still show because the dismiss was for the wrong field
        assert detector.count(include_dismissed=False) == 1

    def test_dismiss_idempotent_no_accumulation(self, pg_session):
        """Dismissing the same field twice must NOT accumulate tags."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = _make_transfer(pg_session, account, direction="inflow")

        # Simulate two dismiss operations (like the endpoint does)
        for _ in range(3):
            tags = [
                tag
                for tag in (tx.tags or [])
                if not (
                    isinstance(tag, dict)
                    and tag.get("sys_transfer_dismissed") == "source_from_account"
                )
            ]
            tags.append({"sys_transfer_dismissed": "source_from_account"})
            tx.tags = tags
            flag_modified(tx, "tags")
            pg_session.add(tx)
            pg_session.commit()
            pg_session.refresh(tx)

        # Should have exactly one dismiss tag, not three
        dismiss_tags = [
            t
            for t in (tx.tags or [])
            if isinstance(t, dict)
            and t.get("sys_transfer_dismissed") == "source_from_account"
        ]
        assert len(dismiss_tags) == 1
        assert len(tx.tags) == 1

    def test_both_fields_dismissed(self, pg_session):
        """Both from and to can be dismissed independently on the same transaction."""
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        # Inflow transfer: dismissed for source_from_account
        _make_transfer(
            pg_session,
            account1,
            direction="inflow",
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        # Outflow transfer: dismissed for source_to_account
        _make_transfer(
            pg_session,
            account2,
            direction="outflow",
            tags=[{"sys_transfer_dismissed": "source_to_account"}],
        )

        detector = TransferIssueDetector(pg_session)
        assert detector.count(include_dismissed=False) == 0
        assert detector.count(include_dismissed=True) == 2

    def test_unrelated_tags_preserved(self, pg_session):
        """Dismiss logic must not clobber unrelated tags."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = _make_transfer(
            pg_session,
            account,
            direction="inflow",
            tags=[{"custom": "value"}, {"another": "tag"}],
        )

        # Simulate dismiss
        tags = [
            tag
            for tag in (tx.tags or [])
            if not (
                isinstance(tag, dict)
                and tag.get("sys_transfer_dismissed") == "source_from_account"
            )
        ]
        tags.append({"sys_transfer_dismissed": "source_from_account"})
        tx.tags = tags
        flag_modified(tx, "tags")
        pg_session.add(tx)
        pg_session.commit()
        pg_session.refresh(tx)

        assert len(tx.tags) == 3  # 2 original + 1 dismiss
        assert {"custom": "value"} in tx.tags
        assert {"another": "tag"} in tx.tags
        assert {"sys_transfer_dismissed": "source_from_account"} in tx.tags

    def test_fetch_also_respects_dismiss(self, pg_session):
        """fetch() must also filter dismissed — not just count()."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        _make_transfer(
            pg_session,
            account,
            direction="inflow",
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )

        detector = TransferIssueDetector(pg_session)
        issues, total = detector.fetch(page=1, per_page=10, include_dismissed=False)
        assert total == 0
        assert len(issues) == 0

        issues_all, total_all = detector.fetch(
            page=1, per_page=10, include_dismissed=True
        )
        assert total_all == 1
        assert len(issues_all) == 1
