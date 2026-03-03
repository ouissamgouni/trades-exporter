"""
Shared transaction filter engine.

Provides reusable filter query building for both the transactions API
and the P&L module's post-calculation filtering.
"""

from backend.services.filters.transaction_filter import (
    build_transaction_filter_predicates,
    build_filtered_transaction_query,
    build_account_filter_condition,
    has_active_filters,
)

__all__ = [
    "build_transaction_filter_predicates",
    "build_filtered_transaction_query",
    "build_account_filter_condition",
    "has_active_filters",
]
