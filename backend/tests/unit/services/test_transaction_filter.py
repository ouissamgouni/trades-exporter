"""
Unit tests for the shared transaction filter builder.

Tests cover:
- build_account_filter_condition: sentinel handling (unmapped, undefined, non-owned)
- build_transaction_filter_predicates: predicate generation for each dimension
- has_active_filters: correct True/False detection
- build_filtered_transaction_query: returns a Select with correct WHERE clauses
"""

import pytest
from unittest.mock import MagicMock

from sqlalchemy import Column, Integer

from backend.api.schemas import AppliedFilters
from backend.services.filters.transaction_filter import (
    build_account_filter_condition,
    build_transaction_filter_predicates,
    build_filtered_transaction_query,
    has_active_filters,
)


# ============================================================================
# build_account_filter_condition
# ============================================================================

class TestBuildAccountFilterCondition:
    """Tests for the account filter condition builder with sentinel support."""

    def test_empty_list_returns_none(self):
        col = MagicMock(spec=Column)
        result = build_account_filter_condition(col, [])
        assert result is None

    def test_numeric_ids_only(self):
        """Numeric IDs should produce an IN clause."""
        from backend.db.models import NormalizedTransaction
        col = NormalizedTransaction.from_account_id
        result = build_account_filter_condition(col, [1, 2, 3])
        assert result is not None
        compiled = str(result.compile(compile_kwargs={"literal_binds": True}))
        assert "IN" in compiled.upper()

    def test_unmapped_sentinel(self):
        """'unmapped' should produce IS NULL."""
        from backend.db.models import NormalizedTransaction
        col = NormalizedTransaction.from_account_id
        result = build_account_filter_condition(col, ["unmapped"])
        assert result is not None
        compiled = str(result.compile(compile_kwargs={"literal_binds": True}))
        assert "IS NULL" in compiled.upper() or "IS_NULL" in compiled.upper() or "NULL" in compiled.upper()

    def test_undefined_sentinel(self):
        """'undefined' should produce IS NULL (same as unmapped)."""
        from backend.db.models import NormalizedTransaction
        col = NormalizedTransaction.from_account_id
        result = build_account_filter_condition(col, ["undefined"])
        assert result is not None
        compiled = str(result.compile(compile_kwargs={"literal_binds": True}))
        assert "NULL" in compiled.upper()

    def test_non_owned_sentinel(self):
        """'non-owned' should produce a subquery + IS NULL."""
        from backend.db.models import NormalizedTransaction
        col = NormalizedTransaction.from_account_id
        result = build_account_filter_condition(col, ["non-owned"])
        assert result is not None
        compiled = str(result.compile(compile_kwargs={"literal_binds": True}))
        # Should reference the accounts table (subquery for owned=false)
        assert "account" in compiled.lower()
        # Should also include NULL
        assert "NULL" in compiled.upper()

    def test_mixed_numeric_and_sentinel(self):
        """Both numeric IDs and sentinels should produce an OR clause."""
        from backend.db.models import NormalizedTransaction
        col = NormalizedTransaction.to_account_id
        result = build_account_filter_condition(col, [1, "unmapped"])
        assert result is not None
        compiled = str(result.compile(compile_kwargs={"literal_binds": True}))
        assert "NULL" in compiled.upper()
        assert "IN" in compiled.upper() or "=" in compiled


# ============================================================================
# build_transaction_filter_predicates
# ============================================================================

class TestBuildTransactionFilterPredicates:
    """Tests for building WHERE predicates from AppliedFilters."""

    def test_empty_filters_returns_empty(self):
        """No active filters should return an empty predicate list."""
        filters = AppliedFilters()
        predicates = build_transaction_filter_predicates(filters)
        assert predicates == []

    def test_source_filter(self):
        filters = AppliedFilters(sources=["kraken"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile(compile_kwargs={"literal_binds": True}))
        assert "source" in compiled.lower()

    def test_multi_source_filter(self):
        filters = AppliedFilters(sources=["kraken", "binance"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile(compile_kwargs={"literal_binds": True}))
        assert "IN" in compiled.upper()

    def test_account_id_filter(self):
        filters = AppliedFilters(account_ids=[10, 20])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_from_account_filter_with_sentinel(self):
        filters = AppliedFilters(from_account_ids=["undefined"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile(compile_kwargs={"literal_binds": True}))
        assert "NULL" in compiled.upper()

    def test_asset_filter(self):
        filters = AppliedFilters(asset_ids=[5])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_category_filter_uses_subquery(self):
        filters = AppliedFilters(category_ids=[1, 2])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile())
        assert "asset_categories" in compiled.lower()

    def test_transaction_type_filter(self):
        filters = AppliedFilters(transaction_types=["trade"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_direction_filter(self):
        filters = AppliedFilters(directions=["in", "out"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile(compile_kwargs={"literal_binds": True}))
        assert "IN" in compiled.upper()

    def test_network_filter(self):
        filters = AppliedFilters(networks=["ethereum"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_review_status_filter(self):
        filters = AppliedFilters(review_statuses=["valid"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_connector_run_filter(self):
        filters = AppliedFilters(connector_run_ids=[100])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_date_from_filter(self):
        filters = AppliedFilters(date_from="2024-01-01")
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_date_to_filter(self):
        filters = AppliedFilters(date_to="2024-12-31")
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_non_owned_flag(self):
        """non_owned=True should add a predicate even with no other filters."""
        filters = AppliedFilters()
        predicates = build_transaction_filter_predicates(filters, non_owned=True)
        assert len(predicates) == 1
        compiled = str(predicates[0].compile(compile_kwargs={"literal_binds": True}))
        assert "NULL" in compiled.upper()
        assert "account" in compiled.lower()

    def test_multiple_filters_combine(self):
        """Multiple active dimensions should yield one predicate each."""
        filters = AppliedFilters(
            sources=["kraken"],
            asset_ids=[5],
            directions=["in"],
            date_from="2024-01-01",
        )
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 4

    def test_tag_key_filter(self):
        filters = AppliedFilters(tag_keys=["staking"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1

    def test_tag_key_value_filter(self):
        filters = AppliedFilters(tag_keys=["pool:ethpool"])
        predicates = build_transaction_filter_predicates(filters)
        assert len(predicates) == 1
        # JSONB @> operator for key:value pairs
        compiled = str(predicates[0].compile())
        assert "tags" in compiled.lower()


# ============================================================================
# has_active_filters
# ============================================================================

class TestHasActiveFilters:
    """Tests for the active filters check utility."""

    def test_empty_filters(self):
        assert has_active_filters(AppliedFilters()) is False

    def test_sources_active(self):
        assert has_active_filters(AppliedFilters(sources=["kraken"])) is True

    def test_account_ids_active(self):
        assert has_active_filters(AppliedFilters(account_ids=[1])) is True

    def test_asset_ids_active(self):
        assert has_active_filters(AppliedFilters(asset_ids=[5])) is True

    def test_date_from_active(self):
        assert has_active_filters(AppliedFilters(date_from="2024-01-01")) is True

    def test_non_owned_flag_active(self):
        assert has_active_filters(AppliedFilters(), non_owned=True) is True

    def test_non_owned_false_with_no_filters(self):
        assert has_active_filters(AppliedFilters(), non_owned=False) is False

    def test_multiple_dimensions(self):
        assert has_active_filters(
            AppliedFilters(sources=["x"], directions=["in"])
        ) is True

    def test_category_ids_active(self):
        assert has_active_filters(AppliedFilters(category_ids=[1])) is True

    def test_networks_active(self):
        assert has_active_filters(AppliedFilters(networks=["ethereum"])) is True

    def test_tag_keys_active(self):
        assert has_active_filters(AppliedFilters(tag_keys=["staking"])) is True


# ============================================================================
# build_filtered_transaction_query
# ============================================================================

class TestBuildFilteredTransactionQuery:
    """Tests for the query builder wrapper."""

    def test_returns_select_with_no_filters(self):
        """Should return a base SELECT on NormalizedTransaction.id."""
        filters = AppliedFilters()
        query = build_filtered_transaction_query(filters)
        compiled = str(query.compile(compile_kwargs={"literal_binds": True}))
        assert "normalized_transaction" in compiled.lower()
        assert "id" in compiled.lower()

    def test_returns_select_with_filters(self):
        """Should include WHERE clauses for active filters."""
        filters = AppliedFilters(sources=["kraken"], asset_ids=[5])
        query = build_filtered_transaction_query(filters)
        compiled = str(query.compile(compile_kwargs={"literal_binds": True}))
        assert "WHERE" in compiled.upper()
        assert "source" in compiled.lower()

    def test_non_owned_adds_where(self):
        filters = AppliedFilters()
        query = build_filtered_transaction_query(filters, non_owned=True)
        compiled = str(query.compile(compile_kwargs={"literal_binds": True}))
        assert "WHERE" in compiled.upper()
        assert "account" in compiled.lower()
