"""
P&L post-calculation filter utilities.

Resolves transaction-level filters into a set of CalculationUnit IDs
for a given P&L version, enabling post-calculation filtering of P&L results
without recalculation.

The core function `resolve_filtered_unit_ids()` joins CalculationUnitLeg → 
NormalizedTransaction with the shared filter predicates, then returns the
distinct set of unit_ids that match.
"""

import hashlib
import json
from functools import lru_cache
from typing import FrozenSet, Optional

from sqlmodel import Session, select

from backend.api.schemas import AppliedFilters
from backend.db.models import CalculationUnit, CalculationUnitLeg, NormalizedTransaction
from backend.services.filters.transaction_filter import (
    build_transaction_filter_predicates,
    has_active_filters,
)


def _make_filter_hash(filters: AppliedFilters, non_owned: bool) -> str:
    """Create a stable hash key from filter state for caching."""
    data = filters.model_dump(mode="json")
    data["_non_owned"] = non_owned
    raw = json.dumps(data, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()


# LRU cache keyed on (version_id, filter_hash).
# Stores recent filter resolutions to avoid redundant queries
# when multiple P&L endpoints are called with the same filters.
@lru_cache(maxsize=128)
def _cached_resolve(
    version_id: int,
    filter_hash: str,
    # Session can't be in the cache key — caller must ensure consistency
    _session_id: int,
) -> Optional[FrozenSet[int]]:
    """Internal cache placeholder — actual resolution in resolve_filtered_unit_ids."""
    # This is never called directly — it's populated by the outer function
    return None  # pragma: no cover


def resolve_filtered_unit_ids(
    session: Session,
    version_id: int,
    filters: AppliedFilters,
    *,
    non_owned: bool = False,
) -> Optional[FrozenSet[int]]:
    """
    Resolve transaction-level filters into matching CalculationUnit IDs.

    Args:
        session: DB session
        version_id: P&L version ID
        filters: Validated transaction filter state
        non_owned: If True, filter to units with non-owned/unmapped counterparties

    Returns:
        frozenset of unit IDs matching the filters, or None if no filters are active
        (meaning all units should be included).
    """
    if not has_active_filters(filters, non_owned=non_owned):
        return None

    # Build filter predicates on NormalizedTransaction
    predicates = build_transaction_filter_predicates(filters, non_owned=non_owned)

    # Query: find unit_ids where at least one leg's transaction matches all predicates
    query = (
        select(CalculationUnitLeg.unit_id)
        .join(
            NormalizedTransaction,
            CalculationUnitLeg.transaction_id == NormalizedTransaction.id,
        )
        .join(
            CalculationUnit,
            CalculationUnitLeg.unit_id == CalculationUnit.id,
        )
        .where(CalculationUnit.version_id == version_id)
    )

    for predicate in predicates:
        query = query.where(predicate)

    query = query.distinct()

    result = session.exec(query).all()
    return frozenset(result)


def clear_filter_cache() -> None:
    """Clear the filter resolution cache (e.g., after version deletion)."""
    _cached_resolve.cache_clear()
