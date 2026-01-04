"""
Suggestion Service - Generate CalculationUnit suggestions for transaction grouping.

This service wraps the GroupingEngine to generate suggestions.
Suggestions are computed on-demand and only persisted when the user accepts them.

The GroupingEngine has sophisticated rules for:
- Rule 1: Network TX ID match (transfer with exact hash match)
- Rule 2: Same asset transfer between owned accounts
- Rule 3: Same source_transaction_id grouping (swap detection)
- Rule 4: Swap detection (different assets, same account, short time window)
- Rule 5: Bridge detection (same asset, different accounts)
- Rule 6: Catch-all for remaining ungrouped transactions

Returns CalculationUnit objects directly (the unified grouping concept).
"""

from decimal import Decimal
from typing import List, Optional
from sqlmodel import Session, select

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction, UserCalculationBundle, UnitPattern
from backend.services.grouping_engine import (
    GroupingEngine,
    GroupingConfig,
    TransactionData,
    GroupingSuggestion,
    PATTERN_UNKNOWN,
)

log = configure_logging("suggestion_service")


# Taxability defaults for patterns
_PATTERN_TAXABILITY = {
    UnitPattern.TRANSFER.value: "non_taxable",
    UnitPattern.SWAP.value: "taxable",  # Default, but depends on config
    UnitPattern.SPLIT.value: "non_taxable",
    UnitPattern.UNKNOWN.value: "unknown",
}


class SuggestionService:
    """
    Service for generating CalculationUnit suggestions.

    Wraps the GroupingEngine and returns CalculationUnit objects directly.
    Suggestions are ephemeral until user accepts them.
    """

    def __init__(self, session: Session, config: Optional[GroupingConfig] = None):
        self.session = session
        self.engine = GroupingEngine(config)

    def get_suggestions(
        self,
        transactions: Optional[List[NormalizedTransaction]] = None,
        max_suggestions: int = 20,
        include_unknown: bool = False,
    ) -> List[GroupingSuggestion]:
        """
        Generate grouping suggestions for transactions.

        Args:
            transactions: Transactions to analyze. If None, fetches pending ones.
            max_suggestions: Maximum number of suggestions to return.
            include_unknown: Whether to include "unknown" pattern suggestions.

        Returns:
            List of GroupingSuggestion objects (can be converted to CalculationUnit).
        """
        if transactions is None:
            transactions = self._get_pending_transactions()

        if not transactions:
            return []

        # Convert to TransactionData for GroupingEngine
        tx_data = [self._to_transaction_data(tx) for tx in transactions]

        # Get suggestions from GroupingEngine
        suggestions = self.engine.suggest_groups(tx_data)

        # Filter suggestions
        filtered = [
            s for s in suggestions
            if len(s.transaction_ids) >= 2  # Only 2+ transactions
            and (include_unknown or s.pattern != PATTERN_UNKNOWN)
        ]

        # Sort by confidence and limit
        filtered.sort(key=lambda s: s.confidence, reverse=True)
        return filtered[:max_suggestions]

    def accept_suggestion(
        self,
        suggestion: GroupingSuggestion,
        label: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> UserCalculationBundle:
        """
        Accept a suggestion and create a UserCalculationBundle.

        Args:
            suggestion: The suggestion to accept
            label: Override label (uses suggestion.label if None)
            notes: Optional notes

        Returns:
            Created UserCalculationBundle (persisted)
        """
        # Create UserCalculationBundle from suggestion
        bundle = UserCalculationBundle(
            label=label or suggestion.label,
            pattern=suggestion.pattern,
            notes=notes or suggestion.reason,
            # Don't set taxability_override - let P&L compute it
            confidence=None,  # Clear confidence - this is now confirmed
            reason=suggestion.reason,  # Keep reason for history
        )
        self.session.add(bundle)
        self.session.flush()  # Get the ID

        # Link transactions to the bundle
        for tx_id in suggestion.transaction_ids:
            tx = self.session.get(NormalizedTransaction, tx_id)
            if tx:
                tx.user_calculation_unit_id = bundle.id
                self.session.add(tx)

        self.session.commit()
        log.info(
            f"Created UserCalculationBundle {bundle.id} with {len(suggestion.transaction_ids)} transactions"
        )

        return bundle

    def _get_pending_transactions(self) -> List[NormalizedTransaction]:
        """Get all pending transactions (not yet reviewed/grouped)."""
        statement = (
            select(NormalizedTransaction)
            .where(NormalizedTransaction.review_status == "pending")
            .where(NormalizedTransaction.user_calculation_unit_id.is_(None))
            .order_by(NormalizedTransaction.date_time)
        )
        return list(self.session.exec(statement).all())

    def _to_transaction_data(self, tx: NormalizedTransaction) -> TransactionData:
        """Convert NormalizedTransaction to TransactionData for GroupingEngine."""
        return TransactionData(
            id=tx.id,
            source=tx.source or "",
            source_transaction_id=tx.source_transaction_id,
            network_transaction_id=tx.network_transaction_id,
            date_time=tx.date_time,
            direction=tx.direction or "neutral",
            transaction_type=tx.transaction_type or "",
            asset_id=tx.asset_id,
            source_asset_symbol=tx.source_asset_symbol or "",
            quantity=tx.quantity or Decimal(0),
            total_in_base=tx.total,
            account_id=tx.account_id,
            to_account_id=tx.to_account_id,
            from_account_id=tx.from_account_id,
            source_to_account=tx.source_to_account,
            source_from_account=tx.source_from_account,
            network=tx.network,
        )
