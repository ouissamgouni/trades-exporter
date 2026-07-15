"""
Integration tests for data health detectors.

Tests the actual SQL query logic against a real PostgreSQL database.
These tests validate:
- Complex SQL queries (UNION, JOINs, filtering)
- PostgreSQL-specific features (JSONB columns)
- Bug fixes (e.g., account_id null checks in TransferIssueDetector)
- Filtering by account_ids and include_dismissed

Run with: task test:backend:int
Full cycle (with teardown): task test:backend:int:teardown
Database: dedicated scenario DB, self-provisioned by: task test:backend:int
"""

import pytest
from datetime import datetime, timezone
from sqlmodel import select

from backend.db.models import (
    NormalizedTransaction,
    ReviewStatus,
    Asset,
    Account,
)
from backend.services.data_health.detectors import (
    MissingDataDetector,
    LinkageIssueDetector,
    TransferIssueDetector,
)
from backend.api.schemas import IssueType


@pytest.mark.integration
class TestMissingDataDetector:
    """Test MissingDataDetector SQL queries."""

    def test_detects_missing_source(self, pg_session):
        """Test detection of transactions with missing source field."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="",  # Missing source
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert len(issues) == 1
        assert issues[0].issue_type == IssueType.MISSING_SOURCE
        assert issues[0].transaction_id == tx.id

    def test_detects_missing_source_asset_symbol(self, pg_session):
        """Test detection of transactions with missing source_asset_symbol."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol=None,  # Missing asset symbol
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert issues[0].issue_type == IssueType.MISSING_SOURCE_ASSET
        assert issues[0].transaction_id == tx.id

    def test_detects_missing_source_account(self, pg_session):
        """Test detection of transfer transactions with missing source_account."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=None,  # No account_id set
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            source_account=None,  # Missing source account
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert issues[0].issue_type == IssueType.MISSING_SOURCE_ACCOUNT
        assert issues[0].transaction_id == tx.id

    def test_not_detected_when_source_account_present(self, pg_session):
        """Test that transactions WITH source_account are NOT flagged."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=None,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            source_account="Binance",  # Has source account
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count == 0

    def test_excludes_invalid_transactions(self, pg_session):
        """Test that INVALID transactions are excluded from detection."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="",  # Missing source
            review_status=ReviewStatus.INVALID,  # INVALID status
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count == 0

    def test_filters_by_account_ids(self, pg_session):
        """Test filtering by account_ids."""
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        tx1 = NormalizedTransaction(
            account_id=account1.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="",
            review_status=ReviewStatus.VALID,
        )
        tx2 = NormalizedTransaction(
            account_id=account2.id,
            date_time=datetime(2024, 1, 2, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="ETH",
            source="",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add_all([tx1, tx2])
        pg_session.commit()

        detector = MissingDataDetector(pg_session)

        count = detector.count(account_ids=[account1.id])
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10, account_ids=[account1.id])
        assert total == 1
        assert issues[0].transaction_id == tx1.id

    def test_excludes_fee_only_cost_transactions_from_missing_asset(self, pg_session):
        """Fee-only (cost) transactions legitimately have no main asset.

        They use fee_quote_asset_id instead. The detector should NOT flag
        them as MISSING_SOURCE_ASSET.
        """
        account = Account(name="Test Account", account_type="cex", owned=True)
        fee_asset = pg_session.exec(select(Asset).where(Asset.symbol == "ETH")).first()
        if fee_asset is None:
            fee_asset = Asset(symbol="ETH", name="Ethereum", asset_type="crypto")
            pg_session.add(fee_asset)
        pg_session.add(account)
        pg_session.commit()

        # Fee-only transaction: no main asset, but has fee data
        tx_fee_only = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="cost",
            direction="neutral",
            quantity=0,
            asset_id=None,
            source_asset_symbol="",
            source="etherscan",
            fee=0.001,
            fee_quote_asset_id=fee_asset.asset_id,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx_fee_only)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count(account_ids=[account.id])
        assert count == 0, "Fee-only (cost) tx should not be flagged as missing asset"

    def test_still_flags_non_cost_transactions_missing_asset(self, pg_session):
        """Non-cost transactions with no asset should still be flagged."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="trade",
            direction="inflow",
            quantity=1.0,
            asset_id=None,
            source_asset_symbol=None,
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = MissingDataDetector(pg_session)
        count = detector.count()
        assert count >= 1

        issues, total = detector.fetch(page=1, per_page=10)
        asset_issues = [
            i for i in issues if i.issue_type == IssueType.MISSING_SOURCE_ASSET
        ]
        assert len(asset_issues) == 1, (
            "Non-cost tx missing asset should still be flagged"
        )


@pytest.mark.integration
class TestTransferIssueDetector:
    """Test TransferIssueDetector SQL queries and bug fixes."""

    def test_detects_missing_transfer_from_account(self, pg_session):
        """Test detection of transfers missing from_account."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            from_account_id=None,  # Missing from_account
            source_from_account=None,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert issues[0].issue_type == IssueType.MISSING_TRANSFER_FROM_ACCOUNT
        assert issues[0].transaction_id == tx.id

    def test_NOT_detected_when_from_account_id_is_set(self, pg_session):
        """
        BUG FIX VALIDATION: Transactions with from_account_id set should NOT be flagged.

        This validates the fix: .where(NormalizedTransaction.from_account_id.is_(None))
        """
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account1.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            from_account_id=account2.id,  # ALREADY SET - should NOT be flagged
            source_from_account=None,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)
        count = detector.count()
        assert count == 0  # Should NOT be detected

    def test_detects_missing_transfer_to_account(self, pg_session):
        """Test detection of transfers missing to_account."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="outflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            to_account_id=None,  # Missing to_account
            source_to_account=None,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert issues[0].issue_type == IssueType.MISSING_TRANSFER_TO_ACCOUNT

    def test_NOT_detected_when_to_account_id_is_set(self, pg_session):
        """
        BUG FIX VALIDATION: Transactions with to_account_id set should NOT be flagged.

        This validates the fix: .where(NormalizedTransaction.to_account_id.is_(None))
        """
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account1.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="outflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            to_account_id=account2.id,  # ALREADY SET - should NOT be flagged
            source_to_account=None,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)
        count = detector.count()
        assert count == 0  # Should NOT be detected

    def test_detects_unlinked_transfer_accounts(self, pg_session):
        """Test detection of transfers with unlinked from/to accounts."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            from_account_id=None,  # Not linked
            source_from_account="Binance",  # Has source data
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert issues[0].issue_type == IssueType.UNLINKED_TRANSFER_FROM_ACCOUNT

    def test_dismissal_mechanism(self, pg_session):
        """Test that dismissed issues can be filtered out."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            from_account_id=None,
            source_from_account=None,
            review_status=ReviewStatus.VALID,
            tags=[{"sys_transfer_dismissed": "source_from_account"}],
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)

        count = detector.count(include_dismissed=False)
        assert count == 0  # Should be filtered out

        count_with_dismissed = detector.count(include_dismissed=True)
        assert count_with_dismissed == 1

    def test_filters_by_account_ids(self, pg_session):
        """Test filtering transfer issues by account_ids."""
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        tx1 = NormalizedTransaction(
            account_id=account1.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            source="transfer",
            from_account_id=None,
            source_from_account=None,
            review_status=ReviewStatus.VALID,
        )
        tx2 = NormalizedTransaction(
            account_id=account2.id,
            date_time=datetime(2024, 1, 2, tzinfo=timezone.utc),
            transaction_type="transfer",
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="ETH",
            source="transfer",
            from_account_id=None,
            source_from_account=None,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add_all([tx1, tx2])
        pg_session.commit()

        detector = TransferIssueDetector(pg_session)

        count = detector.count(account_ids=[account1.id])
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10, account_ids=[account1.id])
        assert total == 1
        assert issues[0].transaction_id == tx1.id


@pytest.mark.integration
class TestLinkageIssueDetector:
    """Test LinkageIssueDetector SQL queries."""

    def test_detects_unlinked_asset(self, pg_session):
        """Test detection of transactions with unlinked assets."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",  # Has symbol
            asset_id=None,  # Not linked
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert total == 1
        assert issues[0].issue_type == IssueType.UNLINKED_ASSET
        assert issues[0].transaction_id == tx.id

    def test_not_detected_when_asset_linked(self, pg_session):
        """Test that transactions with linked assets are not flagged."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        asset = Asset(symbol="TEST_COIN", label="Test Coin")
        pg_session.add_all([account, asset])
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="TEST_COIN",
            asset_id=asset.asset_id,  # Linked
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)
        count = detector.count()
        assert count == 0

    def test_detects_unlinked_account(self, pg_session):
        """Test detection of transactions with unlinked accounts."""
        # Get BTC asset from seed data to link it (avoid detecting unlinked asset issue)
        btc_asset = pg_session.exec(select(Asset).where(Asset.symbol == "BTC")).first()

        tx = NormalizedTransaction(
            account_id=None,  # Not linked
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            asset_id=btc_asset.asset_id
            if btc_asset
            else None,  # Link asset to isolate account issue
            source="binance",
            source_account="Binance",  # Has source account
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)
        count = detector.count()
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10)
        assert issues[0].issue_type == IssueType.UNLINKED_ACCOUNT

    def test_excludes_fee_only_cost_transactions_from_unlinked_asset(self, pg_session):
        """Fee-only (cost) transactions have no main asset by design.

        They should NOT be flagged as UNLINKED_ASSET even when
        source_asset_symbol is set (e.g. empty string or leftover value).
        """
        account = Account(name="Test Account", account_type="cex", owned=True)
        fee_asset = pg_session.exec(select(Asset).where(Asset.symbol == "ETH")).first()
        if fee_asset is None:
            fee_asset = Asset(symbol="ETH", name="Ethereum", asset_type="crypto")
            pg_session.add(fee_asset)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="cost",
            direction="neutral",
            quantity=0,
            asset_id=None,
            source_asset_symbol="",  # empty but not None — would pass isnot(None)
            source="etherscan",
            fee=0.001,
            fee_quote_asset_id=fee_asset.asset_id,
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)
        # Should find 0 UNLINKED_ASSET issues for this tx
        count = detector.count(
            issue_types=[IssueType.UNLINKED_ASSET.value], account_ids=[account.id]
        )
        assert count == 0, "Fee-only (cost) tx should not be flagged as unlinked asset"

    def test_still_flags_non_cost_transactions_as_unlinked_asset(self, pg_session):
        """Non-cost transactions with source_asset_symbol but no asset_id should still be flagged."""
        account = Account(name="Test Account", account_type="cex", owned=True)
        pg_session.add(account)
        pg_session.commit()

        tx = NormalizedTransaction(
            account_id=account.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            transaction_type="trade",
            direction="inflow",
            quantity=1.0,
            asset_id=None,
            source_asset_symbol="UNKNOWN_TOKEN",
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add(tx)
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)
        count = detector.count(issue_types=[IssueType.UNLINKED_ASSET.value])
        assert count == 1, "Non-cost tx with unlinked asset should still be flagged"

    def test_filters_by_account_ids(self, pg_session):
        """Test filtering linkage issues by account_ids."""
        account1 = Account(name="Account 1", account_type="cex", owned=True)
        account2 = Account(name="Account 2", account_type="cex", owned=True)
        pg_session.add_all([account1, account2])
        pg_session.commit()

        tx1 = NormalizedTransaction(
            account_id=account1.id,
            date_time=datetime(2024, 1, 1, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="BTC",
            asset_id=None,  # Unlinked
            source="binance",
            review_status=ReviewStatus.VALID,
        )
        tx2 = NormalizedTransaction(
            account_id=account2.id,
            date_time=datetime(2024, 1, 2, tzinfo=timezone.utc),
            direction="inflow",
            quantity=1.0,
            source_asset_symbol="ETH",
            asset_id=None,  # Unlinked
            source="okx",
            review_status=ReviewStatus.VALID,
        )
        pg_session.add_all([tx1, tx2])
        pg_session.commit()

        detector = LinkageIssueDetector(pg_session)

        count = detector.count(account_ids=[account1.id])
        assert count == 1

        issues, total = detector.fetch(page=1, per_page=10, account_ids=[account1.id])
        assert total == 1
        assert issues[0].transaction_id == tx1.id
