"""Linkage issue detector for unlinked assets, accounts, and quotes."""

from typing import List, Optional, Tuple
from sqlmodel import Session, select
from sqlalchemy import func, union_all, literal

from backend.db.models import NormalizedTransaction, ReviewStatus, TransactionType, Asset, Account, AccountConnector
from backend.api.schemas import TransactionIssue, IssueType, SuggestionInfo
from backend.services.similarity_service import (
    get_best_asset_suggestion,
    get_best_account_suggestion,
)
from .base import IssueDetector


class LinkageIssueDetector(IssueDetector):
    """Detector for linkage issues (unlinked asset/account/price_quote/fee_quote)."""
    
    # Asset-related issue types (excludes unlinked_account which has its own tab)
    ASSET_ISSUE_TYPES = [
        IssueType.UNLINKED_ASSET.value,
        IssueType.UNLINKED_PRICE_QUOTE.value,
        IssueType.UNLINKED_FEE_QUOTE.value,
        IssueType.UNLINKED_ATTRIBUTED_ASSET.value,
    ]
    
    def count(
        self,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        issue_types: Optional[List[str]] = None,
    ) -> int:
        """Count linkage issues, optionally filtered by issue type.
        
        Args:
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for linkage issues (no dismissal mechanism)
            issue_types: Optional list of issue type values to include.
                         If None, includes all 4 types.
            
        Returns:
            Total count of linkage issues
        """
        issues_union = self._build_issues_union(account_ids, issue_types=issue_types)
        total_query = select(func.count(func.distinct(issues_union.c.tx_id))).select_from(issues_union)
        return self.session.exec(total_query).one()
    
    def fetch(
        self,
        page: int = 1,
        per_page: int = 50,
        account_ids: Optional[List[int]] = None,
        include_dismissed: bool = False,
        issue_types: Optional[List[str]] = None,
    ) -> Tuple[List[TransactionIssue], int]:
        """Fetch paginated linkage issues with fuzzy match suggestions.
        
        Args:
            page: Page number (1-indexed)
            per_page: Items per page
            account_ids: Filter by specific account IDs
            include_dismissed: Not applicable for linkage issues
            issue_types: Optional list of issue type values to include.
            
        Returns:
            Tuple of (issues_list, total_count)
        """
        # Get total count
        total_count = self.count(account_ids, include_dismissed, issue_types=issue_types)
        
        # Build issues union
        issues_union = self._build_issues_union(account_ids, issue_types=issue_types)
        
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
                NormalizedTransaction.account_id,
                NormalizedTransaction.source_account,
                NormalizedTransaction.sync_connector_run_id,
                issues_union.c.issue_type,
                issues_union.c.raw_value,
                NormalizedTransaction.network,
            )
            .join(issues_union, NormalizedTransaction.id == issues_union.c.tx_id)
            .order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(per_page)
        )
        issues_rows = self.session.exec(issues_query).all()
        
        # Fetch all assets and accounts for fuzzy matching
        all_assets = self.session.exec(select(Asset)).all()
        all_accounts = self.session.exec(select(Account)).all()

        # Build account_connectors_map for connector-aware disambiguation
        all_connectors = self.session.exec(select(AccountConnector)).all()
        account_connectors_map: dict = {}
        for c in all_connectors:
            account_connectors_map.setdefault(c.account_id, []).append(c)
        
        # Collect unique account IDs and connector run IDs for batch fetching
        account_ids_set = {row[6] for row in issues_rows if row[6] is not None}
        connector_run_ids_set = {row[8] for row in issues_rows if row[8] is not None}
        
        # Batch fetch accounts
        accounts_map = {}
        if account_ids_set:
            accounts_result = self.session.exec(
                select(Account).where(Account.id.in_(account_ids_set))
            ).all()
            accounts_map = {acc.id: acc for acc in accounts_result}
        
        # Batch fetch connector runs with connector info
        from backend.db.models import SyncJobConnectorRun
        connector_runs_map = {}
        if connector_run_ids_set:
            connector_runs_result = self.session.exec(
                select(SyncJobConnectorRun)
                .where(SyncJobConnectorRun.id.in_(connector_run_ids_set))
            ).all()
            for run in connector_runs_result:
                connector_runs_map[run.id] = {
                    'connector_name': f"{run.connector_type} ({run.account_name})" if run.connector_type and run.account_name else run.connector_type or 'Unknown',
                    'run_datetime': run.started_at.isoformat() if run.started_at else None,
                }
        
        # Build TransactionIssue objects with suggestions
        issues_list = []
        for row in issues_rows:
            tx_id, date_time, direction, quantity, source_asset_symbol, source, account_id, source_account, sync_connector_run_id, issue_type, raw_value, network = row
            
            # Get suggestion based on issue type
            suggestion = None
            if raw_value:
                if issue_type in (
                    IssueType.UNLINKED_ASSET.value,
                    IssueType.UNLINKED_PRICE_QUOTE.value,
                    IssueType.UNLINKED_FEE_QUOTE.value,
                    IssueType.UNLINKED_ATTRIBUTED_ASSET.value,
                ):
                    suggestion = get_best_asset_suggestion(raw_value, all_assets)
                elif issue_type == IssueType.UNLINKED_ACCOUNT.value:
                    suggestion = get_best_account_suggestion(
                        raw_value,
                        all_accounts,
                        source=source,
                        account_connectors_map=account_connectors_map,
                        network=network,
                    )
            
            # Resolve account name
            account_name = None
            if account_id and account_id in accounts_map:
                account_name = accounts_map[account_id].name
            
            # Resolve connector info
            connector_name = None
            run_datetime = None
            if sync_connector_run_id and sync_connector_run_id in connector_runs_map:
                connector_info = connector_runs_map[sync_connector_run_id]
                connector_name = connector_info['connector_name']
                run_datetime = connector_info['run_datetime']
            
            issues_list.append(TransactionIssue(
                transaction_id=tx_id,
                date_time=date_time.isoformat() if date_time else "",
                direction=direction or "unknown",
                quantity=float(quantity) if quantity else 0.0,
                source_asset_symbol=source_asset_symbol or "",
                source=source or "",
                account_id=account_id,
                account_name=account_name,
                source_account=source_account,
                connector_name=connector_name,
                sync_connector_run_id=sync_connector_run_id,
                run_datetime=run_datetime,
                issue_type=IssueType(issue_type),
                raw_value=raw_value or "",
                suggestion=suggestion,
            ))
        
        return issues_list, total_count
    
    def _build_issues_union(self, account_ids: Optional[List[int]] = None, issue_types: Optional[List[str]] = None):
        """Build the SQL UNION query for linkage issue types.
        
        Args:
            account_ids: Optional account ID filter
            issue_types: Optional list of issue type values to include.
                         If None, includes all 4 types.
            
        Returns:
            SQLAlchemy subquery with union of selected linkage issues
        """
        # Default to all types if not specified
        types_set = set(issue_types) if issue_types else None
        # Subquery for unlinked asset
        # Exclude fee-only (cost) transactions: they have no main asset by design.
        missing_asset_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_ASSET.value).label('issue_type'),
                NormalizedTransaction.source_asset_symbol.label('raw_value'),
            )
            .where(NormalizedTransaction.asset_id.is_(None))
            .where(NormalizedTransaction.source_asset_symbol.isnot(None))
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
            .where(
                NormalizedTransaction.transaction_type != TransactionType.COST.value
            )
        )
        if account_ids:
            missing_asset_subq = missing_asset_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery for unlinked account
        missing_account_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_ACCOUNT.value).label('issue_type'),
                NormalizedTransaction.source_account.label('raw_value'),
            )
            .where(NormalizedTransaction.account_id.is_(None))
            .where(NormalizedTransaction.source_account.isnot(None))
            .where(NormalizedTransaction.source_account != '')
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        # Note: account filter not applicable when account_id is None
        
        # Subquery for unlinked price quote
        missing_price_quote_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_PRICE_QUOTE.value).label('issue_type'),
                NormalizedTransaction.source_price_quote_asset_symbol.label('raw_value'),
            )
            .where(NormalizedTransaction.price.isnot(None))
            .where(NormalizedTransaction.price > 0)
            .where(NormalizedTransaction.price_quote_asset_id.is_(None))
            .where(NormalizedTransaction.source_price_quote_asset_symbol.isnot(None))
            .where(NormalizedTransaction.source_price_quote_asset_symbol != '')
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        if account_ids:
            missing_price_quote_subq = missing_price_quote_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery for unlinked fee quote
        missing_fee_quote_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_FEE_QUOTE.value).label('issue_type'),
                NormalizedTransaction.source_fee_quote_asset_symbol.label('raw_value'),
            )
            .where(NormalizedTransaction.fee.isnot(None))
            .where(NormalizedTransaction.fee > 0)
            .where(NormalizedTransaction.fee_quote_asset_id.is_(None))
            .where(NormalizedTransaction.source_fee_quote_asset_symbol.isnot(None))
            .where(NormalizedTransaction.source_fee_quote_asset_symbol != '')
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        if account_ids:
            missing_fee_quote_subq = missing_fee_quote_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Subquery for unlinked attributed asset
        missing_attributed_asset_subq = (
            select(
                NormalizedTransaction.id.label('tx_id'),
                literal(IssueType.UNLINKED_ATTRIBUTED_ASSET.value).label('issue_type'),
                NormalizedTransaction.source_attributed_asset_symbol.label('raw_value'),
            )
            .where(NormalizedTransaction.attributed_asset_id.is_(None))
            .where(NormalizedTransaction.source_attributed_asset_symbol.isnot(None))
            .where(NormalizedTransaction.source_attributed_asset_symbol != '')
            .where(NormalizedTransaction.review_status != ReviewStatus.INVALID)
        )
        if account_ids:
            missing_attributed_asset_subq = missing_attributed_asset_subq.where(
                NormalizedTransaction.account_id.in_(account_ids)
            )
        
        # Collect subqueries based on requested issue types
        subqueries = []
        if types_set is None or IssueType.UNLINKED_ASSET.value in types_set:
            subqueries.append(missing_asset_subq)
        if types_set is None or IssueType.UNLINKED_ACCOUNT.value in types_set:
            subqueries.append(missing_account_subq)
        if types_set is None or IssueType.UNLINKED_PRICE_QUOTE.value in types_set:
            subqueries.append(missing_price_quote_subq)
        if types_set is None or IssueType.UNLINKED_FEE_QUOTE.value in types_set:
            subqueries.append(missing_fee_quote_subq)
        if types_set is None or IssueType.UNLINKED_ATTRIBUTED_ASSET.value in types_set:
            subqueries.append(missing_attributed_asset_subq)
        
        if not subqueries:
            # Fallback: return all types if empty filter somehow passed
            subqueries = [missing_asset_subq, missing_account_subq, missing_price_quote_subq, missing_fee_quote_subq, missing_attributed_asset_subq]
        
        return union_all(*subqueries).subquery()
