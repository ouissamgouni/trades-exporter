"""
Normalized Transaction Repository - CRUD operations for normalized transactions.
"""

from datetime import datetime
from typing import Optional, List
from sqlmodel import Session, select
from sqlalchemy import func

from backend.db.models import NormalizedTransaction, RawTransaction


class NormalizedTransactionRepository:
    """Repository for NormalizedTransaction CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, tx: NormalizedTransaction) -> NormalizedTransaction:
        """Create a new normalized transaction."""
        self.session.add(tx)
        self.session.flush()
        self.session.refresh(tx)
        return tx

    def get(self, tx_id: int) -> Optional[NormalizedTransaction]:
        """Get a normalized transaction by ID."""
        return self.session.get(NormalizedTransaction, tx_id)

    def exists(self, source: str, source_transaction_id: str) -> bool:
        """Check if a normalized transaction exists."""
        statement = select(NormalizedTransaction).where(
            NormalizedTransaction.source == source,
            NormalizedTransaction.source_transaction_id == source_transaction_id,
        )
        return self.session.exec(statement).first() is not None

    def get_max_datetime_by_connector(self, connector_id: int) -> Optional[datetime]:
        """
        Get the maximum transaction datetime for a specific connector.
        
        This is used to determine the "since" datetime for incremental sync.
        Joins normalized_transactions with raw_transactions to filter by connector_id.
        
        Args:
            connector_id: The AccountConnector ID to filter by
            
        Returns:
            The maximum date_time value for transactions from this connector,
            or None if no transactions found.
        """
        statement = (
            select(func.max(NormalizedTransaction.date_time))
            .join(
                RawTransaction,
                NormalizedTransaction.raw_transaction_id == RawTransaction.id
            )
            .where(RawTransaction.connector_id == connector_id)
        )
        result = self.session.exec(statement).first()
        return result

    def list_all(
        self,
        status: Optional[str] = None,
        source: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[NormalizedTransaction]:
        """List normalized transactions with optional filtering."""
        statement = select(NormalizedTransaction)

        if status:
            statement = statement.where(NormalizedTransaction.review_status == status)

        if source:
            statement = statement.where(NormalizedTransaction.source == source)

        statement = (
            statement.order_by(NormalizedTransaction.date_time.desc())
            .offset(offset)
            .limit(limit)
        )
        return list(self.session.exec(statement).all())

    def update(self, tx: NormalizedTransaction) -> NormalizedTransaction:
        """Update a normalized transaction."""
        self.session.add(tx)
        self.session.flush()
        self.session.refresh(tx)
        return tx

    def delete(self, tx_id: int) -> bool:
        """Delete a normalized transaction by ID."""
        tx = self.get(tx_id)
        if tx:
            self.session.delete(tx)
            return True
        return False

    def update_group_ids(self, transaction_ids: List[int], group_id: int) -> int:
        """Update group_id for multiple transactions."""
        count = 0
        for tx_id in transaction_ids:
            tx = self.get(tx_id)
            if tx:
                tx.group_id = group_id
                self.session.add(tx)
                count += 1
        return count
