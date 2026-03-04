"""Detector for transactions with unmapped raw accounts."""

from typing import List, Optional
from sqlmodel import Session, select
from sqlalchemy import func, or_

from backend.db.models import NormalizedTransaction, ReviewStatus, RawAccount
from .base import IssueDetector


class UnmappedAccountDetector(IssueDetector):
    """Detect transactions referencing raw accounts that aren't mapped to any account."""

    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> int:
        """Count distinct transactions that reference unmapped (and non-dismissed) raw accounts.

        Args:
            account_ids: Filter transactions by account IDs
            include_dismissed: If True, also count dismissed raw accounts (not implemented yet)

        Returns:
            Count of distinct transactions with unmapped raw accounts
        """
        unmapped_raw_accounts = self._get_unmapped_raw_accounts(include_dismissed)
        if not unmapped_raw_accounts:
            return 0

        query = self._build_tx_count_query(unmapped_raw_accounts, account_ids)
        return self.session.exec(query).one()

    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
    ) -> tuple:
        """Fetch is not implemented for unmapped accounts (not needed yet)."""
        return ([], 0)

    def _get_unmapped_raw_accounts(self, include_dismissed: bool = False):
        """Get raw accounts that aren't mapped to any account."""
        stmt = select(RawAccount).where(RawAccount.account_id == None)
        if not include_dismissed:
            stmt = stmt.where(RawAccount.dismissed == False)
        return self.session.exec(stmt).all()

    def _build_tx_count_query(
        self,
        unmapped_raw_accounts,
        account_ids: Optional[List[int]] = None,
    ):
        """Build the query to count distinct transactions matching unmapped raw accounts."""
        conditions = []
        for ra in unmapped_raw_accounts:
            conditions.extend([
                (NormalizedTransaction.source == ra.source) & (NormalizedTransaction.source_account == ra.label),
                (NormalizedTransaction.source == ra.source) & (NormalizedTransaction.source_from_account == ra.label),
                (NormalizedTransaction.source == ra.source) & (NormalizedTransaction.source_to_account == ra.label),
            ])

        query = (
            select(func.count(func.distinct(NormalizedTransaction.id)))
            .where(or_(*conditions))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )

        if account_ids:
            query = query.where(NormalizedTransaction.account_id.in_(account_ids))

        return query
