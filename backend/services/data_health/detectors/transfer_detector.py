"""Transfer issue detector for missing/unlinked transfer accounts."""

from typing import List, Optional, Tuple
from sqlmodel import Session, select
from sqlalchemy import func, union_all, literal, type_coerce
from sqlalchemy.dialects.postgresql import JSONB as PG_JSONB

from backend.db.models import (
    NormalizedTransaction,
    ReviewStatus,
    Account,
    SyncJobConnectorRun,
)
from backend.api.schemas import TransactionIssue, IssueType
from .base import IssueDetector


class TransferIssueDetector(IssueDetector):
    """Detector for transfer issues (missing/unlinked from/to accounts)."""
    
    # Bundled transfers are excluded: the bundle already pairs them with their counterpart
    # (broken bundles are reported separately by BundleHealthService).
    # Dismiss tag format: {"sys_transfer_dismissed": "<field>"}
    # Field is "source_from_account" or "source_to_account"
    DISMISS_TAG_KEY = "sys_transfer_dismissed"

    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        dismissed_only: bool = False,
    ) -> int:
        """Count all transfer issues.
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed transfer issues
            
        Returns:
            Total count of transfer issues
        """
        issues_union = self._build_issues_union(account_ids, include_dismissed, dismissed_only)
        total_query = select(func.count()).select_from(issues_union)
        return self.session.exec(total_query).one()
    
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        dismissed_only: bool = False,
    ) -> Tuple[List[TransactionIssue], int]:
        """Fetch paginated transfer issues with account and connector info.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Include dismissed transfer issues
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        # Get total count
        total_count = self.count(account_ids, include_dismissed, dismissed_only)
        
        # Build issues union
        issues_union = self._build_issues_union(account_ids, include_dismissed, dismissed_only)
        
        # Fetch paginated issues with transaction details
        offset = (page - 1) * per_page
        issues_query = (
            select(
                NormalizedTransaction.id,
                NormalizedTransaction.date_time,
                NormalizedTransaction.direction,
                NormalizedTransaction.quantity,
                NormalizedTransaction.source_asset_symbol,
                NormalizedTransaction.source,
                issues_union.c.issue_type,
                issues_union.c.raw_value,
                NormalizedTransaction.account_id,
                NormalizedTransaction.source_account,
                NormalizedTransaction.sync_connector_run_id,
            )
            .join(issues_union, NormalizedTransaction.id == issues_union.c.tx_id)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(per_page)
        )
        issues_rows = self.session.exec(issues_query).all()
        
        # Build TransactionIssue objects with account and connector info
        issues_list = []
        for row in issues_rows:
            (
                tx_id, date_time, direction, quantity, source_asset_symbol, source,
                issue_type, raw_value, account_id, source_account, sync_connector_run_id
            ) = row
            
            # Resolve account name if account_id is present
            account_name = None
            if account_id:
                account = self.session.get(Account, account_id)
                account_name = account.name if account else None
            
            # Resolve connector info if sync_connector_run_id is present
            connector_name = None
            run_datetime = None
            if sync_connector_run_id:
                run = self.session.get(SyncJobConnectorRun, sync_connector_run_id)
                if run:
                    connector_name = run.connector_type
                    run_datetime = run.started_at.isoformat() if run.started_at else None
            
            issues_list.append(TransactionIssue(
                transaction_id=tx_id,
                date_time=date_time.isoformat() if date_time else "",
                direction=direction or "unknown",
                quantity=float(quantity) if quantity else 0.0,
                source_asset_symbol=source_asset_symbol or "",
                source=source or "",
                issue_type=IssueType(issue_type),
                raw_value=raw_value or "",
                suggestion=None,  # No fuzzy matching for transfer issues
                account_id=account_id,
                account_name=account_name,
                source_account=source_account,
                connector_name=connector_name,
                sync_connector_run_id=sync_connector_run_id,
                run_datetime=run_datetime,
            ))
        
        return issues_list, total_count
    
    @classmethod
    def _apply_dismissed_filter(cls, query, field: str, include_dismissed: bool, dismissed_only: bool):
        dismissed = NormalizedTransaction.tags.op('@>')(
            type_coerce([{cls.DISMISS_TAG_KEY: field}], PG_JSONB)
        )
        if dismissed_only:
            return query.where(NormalizedTransaction.tags.isnot(None) & dismissed)
        if include_dismissed:
            return query
        return query.where(NormalizedTransaction.tags.is_(None) | ~dismissed)

    def _build_issues_union(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        dismissed_only: bool = False,
    ):
        """Build the SQL UNION query for all transfer issue types.
        
        Args:
            account_ids: Optional account ID filter
            include_dismissed: Include dismissed issues
            
        Returns:
            SQLAlchemy subquery with union of all transfer issues
        """
        # Subquery 1: Transfers with empty source_from_account (inflows - missing source data)
        # Only flag if from_account_id is also not set (otherwise it's already resolved)
        missing_transfer_from_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.MISSING_TRANSFER_FROM_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_from_account.label('raw_value'),
            )
            .where(NormalizedTransaction.transaction_type == 'transfer')
            .where(NormalizedTransaction.direction == 'inflow')
            .where(
                NormalizedTransaction.source_from_account.is_(None) | 
                (NormalizedTransaction.source_from_account == '')
            )
            .where(NormalizedTransaction.from_account_id.is_(None))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
        )
        missing_transfer_from_subq = self._apply_dismissed_filter(
            missing_transfer_from_subq, "source_from_account", include_dismissed, dismissed_only
        )
        if account_ids:
            missing_transfer_from_subq = missing_transfer_from_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery 2: Transfers with source_from_account but no from_account_id (inflows - needs linking)
        unlinked_transfer_from_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_TRANSFER_FROM_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_from_account.label('raw_value'),
            )
            .where(NormalizedTransaction.transaction_type == 'transfer')
            .where(NormalizedTransaction.direction == 'inflow')
            .where(NormalizedTransaction.source_from_account.isnot(None))
            .where(NormalizedTransaction.source_from_account != '')
            .where(NormalizedTransaction.from_account_id.is_(None))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
        )
        unlinked_transfer_from_subq = self._apply_dismissed_filter(
            unlinked_transfer_from_subq, "source_from_account", include_dismissed, dismissed_only
        )
        if account_ids:
            unlinked_transfer_from_subq = unlinked_transfer_from_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery 3: Transfers with empty source_to_account (outflows - missing source data)
        # Only flag if to_account_id is also not set (otherwise it's already resolved)
        missing_transfer_to_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.MISSING_TRANSFER_TO_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_to_account.label('raw_value'),
            )
            .where(NormalizedTransaction.transaction_type == 'transfer')
            .where(NormalizedTransaction.direction == 'outflow')
            .where(
                NormalizedTransaction.source_to_account.is_(None) | 
                (NormalizedTransaction.source_to_account == '')
            )
            .where(NormalizedTransaction.to_account_id.is_(None))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
        )
        missing_transfer_to_subq = self._apply_dismissed_filter(
            missing_transfer_to_subq, "source_to_account", include_dismissed, dismissed_only
        )
        if account_ids:
            missing_transfer_to_subq = missing_transfer_to_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery 4: Transfers with source_to_account but no to_account_id (outflows - needs linking)
        unlinked_transfer_to_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_TRANSFER_TO_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_to_account.label('raw_value'),
            )
            .where(NormalizedTransaction.transaction_type == 'transfer')
            .where(NormalizedTransaction.direction == 'outflow')
            .where(NormalizedTransaction.source_to_account.isnot(None))
            .where(NormalizedTransaction.source_to_account != '')
            .where(NormalizedTransaction.to_account_id.is_(None))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
        )
        unlinked_transfer_to_subq = self._apply_dismissed_filter(
            unlinked_transfer_to_subq, "source_to_account", include_dismissed, dismissed_only
        )
        if account_ids:
            unlinked_transfer_to_subq = unlinked_transfer_to_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Union all transfer issues (4 subqueries)
        return union_all(
            missing_transfer_from_subq,
            unlinked_transfer_from_subq,
            missing_transfer_to_subq,
            unlinked_transfer_to_subq,
        ).subquery()
