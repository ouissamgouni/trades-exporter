"""
Raw Transaction Repository - CRUD operations for raw transactions.
"""

from typing import Optional, Dict, Any
from sqlmodel import Session, select

from backend.db.models import RawTransaction
from backend.db.repositories.base import make_json_serializable


class RawTransactionRepository:
    """Repository for RawTransaction CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, raw_tx: RawTransaction) -> RawTransaction:
        """Create a new raw transaction."""
        self.session.add(raw_tx)
        self.session.flush()
        self.session.refresh(raw_tx)
        return raw_tx

    def insert(
        self, source: str, source_transaction_id: str, raw_data: Dict[str, Any]
    ) -> int:
        """Insert a raw transaction and return its ID."""
        # Ensure raw_data is JSON-serializable
        serializable_data = make_json_serializable(raw_data)

        raw_tx = RawTransaction(
            source=source,
            source_transaction_id=source_transaction_id,
            raw_data=serializable_data,
        )
        self.create(raw_tx)
        return raw_tx.id

    def get(self, raw_id: int) -> Optional[RawTransaction]:
        """Get a raw transaction by ID."""
        return self.session.get(RawTransaction, raw_id)

    def exists(self, source: str, source_transaction_id: str) -> bool:
        """Check if a raw transaction exists."""
        statement = select(RawTransaction).where(
            RawTransaction.source == source,
            RawTransaction.source_transaction_id == source_transaction_id,
        )
        return self.session.exec(statement).first() is not None
