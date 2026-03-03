"""
Shared transaction filter query builder.

Extracts the WHERE-clause building logic from the transactions API endpoint
into a reusable module. Used by both:
- backend/api/routes/transactions.py (transaction list & filter options)
- backend/services/pnl/filter_utils.py (P&L post-calculation filtering)

The core function `build_transaction_filter_predicates()` takes an AppliedFilters
object and returns a list of SQLAlchemy WHERE clauses that can be applied to any
query on the NormalizedTransaction table.
"""

from typing import List, Optional

from sqlalchemy import or_, cast, String, Column
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import select

from backend.api.schemas import AppliedFilters
from backend.db.models import NormalizedTransaction, Account, AssetCategory


def build_account_filter_condition(
    column: Column,
    id_list: list,
) -> Optional[ColumnElement]:
    """
    Build a WHERE condition for an account ID filter with sentinel support.

    Supports:
    - Numeric IDs → column.in_(ids)
    - 'unmapped' / 'undefined' → column.is_(None)
    - 'non-owned' → column.in_(select(Account.id).where(Account.owned == False)) OR column.is_(None)

    Returns None if the id_list is empty.
    """
    if not id_list:
        return None

    numeric_ids = [x for x in id_list if isinstance(x, int)]
    has_unmapped = any(x in ("unmapped", "undefined") for x in id_list if isinstance(x, str))
    has_non_owned = any(x == "non-owned" for x in id_list if isinstance(x, str))

    conditions: List[ColumnElement] = []

    if numeric_ids:
        conditions.append(column.in_(numeric_ids))

    if has_unmapped:
        conditions.append(column.is_(None))

    if has_non_owned:
        # Non-owned includes: accounts with owned=False + unmapped (NULL)
        non_owned_subquery = select(Account.id).where(Account.owned == False)  # noqa: E712
        conditions.append(column.in_(non_owned_subquery))
        # Also include NULL (unmapped) as part of non-owned
        if not has_unmapped:
            conditions.append(column.is_(None))

    if not conditions:
        return None
    if len(conditions) == 1:
        return conditions[0]
    return or_(*conditions)


def build_transaction_filter_predicates(
    filters: AppliedFilters,
    *,
    non_owned: bool = False,
) -> List[ColumnElement]:
    """
    Build a list of SQLAlchemy WHERE predicates for NormalizedTransaction
    from a validated AppliedFilters object.

    Args:
        filters: Validated filter state from filter_validator
        non_owned: If True, filter to transactions where from_account or to_account
                   is non-owned (owned=False) or unmapped (NULL)

    Returns:
        List of SQLAlchemy ColumnElement predicates to apply via .where()
    """
    predicates: List[ColumnElement] = []

    # Review status filter
    if filters.review_statuses:
        if len(filters.review_statuses) == 1:
            predicates.append(
                NormalizedTransaction.review_status == filters.review_statuses[0]
            )
        else:
            predicates.append(
                NormalizedTransaction.review_status.in_(filters.review_statuses)
            )

    # Taxability filter
    if filters.taxability:
        predicates.append(
            NormalizedTransaction.taxability_status == filters.taxability
        )

    # Source filter
    if filters.sources:
        if len(filters.sources) == 1:
            predicates.append(NormalizedTransaction.source == filters.sources[0])
        else:
            predicates.append(NormalizedTransaction.source.in_(filters.sources))

    # Account filter (primary account_id)
    if filters.account_ids:
        cond = build_account_filter_condition(
            NormalizedTransaction.account_id, filters.account_ids
        )
        if cond is not None:
            predicates.append(cond)

    # From account filter
    if filters.from_account_ids:
        cond = build_account_filter_condition(
            NormalizedTransaction.from_account_id, filters.from_account_ids
        )
        if cond is not None:
            predicates.append(cond)

    # To account filter
    if filters.to_account_ids:
        cond = build_account_filter_condition(
            NormalizedTransaction.to_account_id, filters.to_account_ids
        )
        if cond is not None:
            predicates.append(cond)

    # Asset filter
    if filters.asset_ids:
        if len(filters.asset_ids) == 1:
            predicates.append(NormalizedTransaction.asset_id == filters.asset_ids[0])
        else:
            predicates.append(NormalizedTransaction.asset_id.in_(filters.asset_ids))

    # Category filter — filter by assets belonging to the selected categories
    if filters.category_ids:
        asset_subquery = (
            select(AssetCategory.asset_id)
            .where(AssetCategory.category_id.in_(filters.category_ids))
            .distinct()
        )
        predicates.append(NormalizedTransaction.asset_id.in_(asset_subquery))

    # Transaction type filter
    if filters.transaction_types:
        if len(filters.transaction_types) == 1:
            predicates.append(
                NormalizedTransaction.transaction_type == filters.transaction_types[0]
            )
        else:
            predicates.append(
                NormalizedTransaction.transaction_type.in_(filters.transaction_types)
            )

    # Direction filter
    if filters.directions:
        if len(filters.directions) == 1:
            predicates.append(
                NormalizedTransaction.direction == filters.directions[0]
            )
        else:
            predicates.append(
                NormalizedTransaction.direction.in_(filters.directions)
            )

    # Connector run filter
    if filters.connector_run_ids:
        if len(filters.connector_run_ids) == 1:
            predicates.append(
                NormalizedTransaction.sync_connector_run_id == filters.connector_run_ids[0]
            )
        else:
            predicates.append(
                NormalizedTransaction.sync_connector_run_id.in_(
                    filters.connector_run_ids
                )
            )

    # Date range filters
    if filters.date_from:
        try:
            from backend.core.utils import parse_date_from

            from_dt = parse_date_from(filters.date_from)
            predicates.append(NormalizedTransaction.date_time >= from_dt)
        except ValueError:
            pass

    if filters.date_to:
        try:
            from backend.core.utils import parse_date_to

            to_dt = parse_date_to(filters.date_to)
            predicates.append(NormalizedTransaction.date_time <= to_dt)
        except ValueError:
            pass

    # Tag filter using JSONB operators
    if filters.tag_keys:
        tag_conditions: List[ColumnElement] = []
        for tag_filter in filters.tag_keys:
            if ":" in tag_filter:
                key, value = tag_filter.split(":", 1)
                tag_conditions.append(
                    NormalizedTransaction.tags.op("@>")(  # type: ignore[union-attr]
                        [{key: value}]
                    )
                )
            else:
                tag_conditions.append(
                    cast(NormalizedTransaction.tags, String).like(
                        f'%"{tag_filter}"%'
                    )
                )
        if tag_conditions:
            predicates.append(or_(*tag_conditions))

    # Network filter
    if filters.networks:
        if len(filters.networks) == 1:
            predicates.append(NormalizedTransaction.network == filters.networks[0])
        else:
            predicates.append(NormalizedTransaction.network.in_(filters.networks))

    # Non-owned counterparty filter
    if non_owned:
        non_owned_subquery = select(Account.id).where(Account.owned == False)  # noqa: E712
        predicates.append(
            or_(
                # from_account is non-owned or unmapped
                NormalizedTransaction.from_account_id.in_(non_owned_subquery),
                NormalizedTransaction.from_account_id.is_(None),
                # to_account is non-owned or unmapped
                NormalizedTransaction.to_account_id.in_(non_owned_subquery),
                NormalizedTransaction.to_account_id.is_(None),
            )
        )

    return predicates


def build_filtered_transaction_query(
    filters: AppliedFilters,
    *,
    non_owned: bool = False,
) -> "select":
    """
    Build a SELECT query returning NormalizedTransaction.id values
    matching the given filters.

    Returns:
        SQLAlchemy Select statement for NormalizedTransaction.id
    """
    query = select(NormalizedTransaction.id)
    for predicate in build_transaction_filter_predicates(
        filters, non_owned=non_owned
    ):
        query = query.where(predicate)
    return query


def has_active_filters(
    filters: AppliedFilters,
    *,
    non_owned: bool = False,
) -> bool:
    """
    Check whether an AppliedFilters object has any active filter dimensions.

    Returns True if at least one filter is set.
    """
    if non_owned:
        return True
    return bool(
        filters.review_statuses
        or filters.taxability
        or filters.sources
        or filters.account_ids
        or filters.from_account_ids
        or filters.to_account_ids
        or filters.asset_ids
        or filters.category_ids
        or filters.transaction_types
        or filters.directions
        or filters.connector_run_ids
        or filters.tag_keys
        or filters.networks
        or filters.date_from
        or filters.date_to
    )
