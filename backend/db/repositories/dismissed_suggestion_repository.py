"""
Repository for DismissedSuggestion CRUD operations.
"""

from datetime import datetime, timezone
from typing import List, Optional, Set

from sqlmodel import Session, select

from backend.db.models import DismissedSuggestion
from backend.services.suggestion_fingerprint import compute_suggestion_fingerprint


class DismissedSuggestionRepository:
    """Repository for managing dismissed suggestions."""

    def __init__(self, session: Session):
        self.session = session

    def dismiss(
        self,
        pattern: str,
        transaction_ids: List[int],
        label: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> DismissedSuggestion:
        """
        Dismiss a suggestion by storing its fingerprint.

        Returns the created DismissedSuggestion record.
        Raises ValueError if the suggestion is already dismissed.
        """
        fingerprint = compute_suggestion_fingerprint(pattern, transaction_ids)

        # Check if already dismissed
        existing = self.session.exec(
            select(DismissedSuggestion).where(
                DismissedSuggestion.fingerprint == fingerprint
            )
        ).first()

        if existing:
            raise ValueError(
                f"Suggestion with fingerprint {fingerprint} is already dismissed"
            )

        dismissed = DismissedSuggestion(
            fingerprint=fingerprint,
            pattern=pattern,
            transaction_ids=sorted(transaction_ids),
            label=label,
            reason=reason,
        )
        self.session.add(dismissed)
        self.session.flush()
        return dismissed

    def undismiss(self, fingerprint: str) -> bool:
        """
        Restore a dismissed suggestion by removing its record.

        Returns True if a record was deleted, False if not found.
        """
        record = self.session.exec(
            select(DismissedSuggestion).where(
                DismissedSuggestion.fingerprint == fingerprint
            )
        ).first()

        if not record:
            return False

        self.session.delete(record)
        self.session.flush()
        return True

    def is_dismissed(self, fingerprint: str) -> bool:
        """Check if a suggestion fingerprint is dismissed."""
        record = self.session.exec(
            select(DismissedSuggestion).where(
                DismissedSuggestion.fingerprint == fingerprint
            )
        ).first()
        return record is not None

    def get_dismissed_fingerprints(self) -> Set[str]:
        """Get all dismissed fingerprints as a set for fast lookup."""
        records = self.session.exec(select(DismissedSuggestion)).all()
        return {r.fingerprint for r in records}

    def list_dismissed(self) -> List[DismissedSuggestion]:
        """List all dismissed suggestions, newest first."""
        return list(
            self.session.exec(
                select(DismissedSuggestion).order_by(
                    DismissedSuggestion.dismissed_at.desc()
                )
            ).all()
        )

    def get_by_fingerprint(self, fingerprint: str) -> Optional[DismissedSuggestion]:
        """Get a dismissed suggestion by fingerprint."""
        return self.session.exec(
            select(DismissedSuggestion).where(
                DismissedSuggestion.fingerprint == fingerprint
            )
        ).first()
