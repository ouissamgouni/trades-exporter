"""
Shared FastAPI dependency for P&L transaction filter parameters.

Provides a single Depends() that extracts, validates, and returns
transaction filter state for P&L endpoints. This avoids repeating
12+ query parameter declarations across 7+ endpoints.
"""

from typing import Optional, Tuple

from fastapi import Depends, Query
from sqlmodel import Session

from backend.api.schemas import AppliedFilters, ValidationWarning
from backend.api.routes.filter_validator import validate_transaction_filters
from backend.db.database import get_session_dependency


class PnLTransactionFilters:
    """
    Resolved P&L transaction filter state.

    Contains the validated AppliedFilters, the non_owned flag,
    and any validation warnings.
    """

    def __init__(
        self,
        applied_filters: AppliedFilters,
        non_owned: bool,
        warnings: list,
    ):
        self.applied_filters = applied_filters
        self.non_owned = non_owned
        self.warnings = warnings

    @property
    def has_active_filters(self) -> bool:
        from backend.services.filters.transaction_filter import has_active_filters
        return has_active_filters(self.applied_filters, non_owned=self.non_owned)


def get_pnl_transaction_filters(
    source: Optional[str] = Query(None, description="Filter by source (comma-separated)"),
    account_id: Optional[str] = Query(None, description="Filter by account IDs (comma-separated)"),
    from_account_id: Optional[str] = Query(
        None,
        description="Filter by from account IDs (comma-separated, 'undefined' for NULL)",
    ),
    to_account_id: Optional[str] = Query(
        None,
        description="Filter by to account IDs (comma-separated, 'undefined' for NULL)",
    ),
    asset_id: Optional[str] = Query(None, description="Filter by asset IDs (comma-separated)"),
    category_id: Optional[str] = Query(None, description="Filter by category IDs (comma-separated)"),
    transaction_type: Optional[str] = Query(None, description="Filter by transaction type (comma-separated)"),
    direction: Optional[str] = Query(None, description="Filter by direction (comma-separated)"),
    connector_run_id: Optional[str] = Query(None, description="Filter by connector run IDs (comma-separated)"),
    tag_key: Optional[str] = Query(None, description="Filter by tag keys (comma-separated)"),
    network: Optional[str] = Query(None, description="Filter by network (comma-separated)"),
    date_from: Optional[str] = Query(None, description="Filter from date (ISO format)"),
    date_to: Optional[str] = Query(None, description="Filter to date (ISO format)"),
    non_owned: bool = Query(False, description="Filter to units with non-owned/unmapped counterparties"),
    session: Session = Depends(get_session_dependency),
) -> PnLTransactionFilters:
    """
    FastAPI dependency that validates transaction filter query params
    and returns a PnLTransactionFilters object.

    Usage in endpoints:
        @router.get("/versions/{version_id}/balances")
        def get_balances(
            ...,
            tx_filters: PnLTransactionFilters = Depends(get_pnl_transaction_filters),
        ):
            unit_ids = resolve_filtered_unit_ids(
                session, version_id, tx_filters.applied_filters,
                non_owned=tx_filters.non_owned,
            )
    """
    applied_filters, warnings = validate_transaction_filters(
        session=session,
        source=source,
        account_id=account_id,
        from_account_id=from_account_id,
        to_account_id=to_account_id,
        asset_id=asset_id,
        category_id=category_id,
        transaction_type=transaction_type,
        direction=direction,
        connector_run_id=connector_run_id,
        tag_key=tag_key,
        network=network,
        date_from=date_from,
        date_to=date_to,
    )
    return PnLTransactionFilters(
        applied_filters=applied_filters,
        non_owned=non_owned,
        warnings=warnings,
    )
