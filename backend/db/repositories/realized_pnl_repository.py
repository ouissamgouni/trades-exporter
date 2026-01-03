"""
Realized PnL Repository - CRUD operations for realized profit/loss records.
"""

from typing import Optional, List
from sqlmodel import Session, select

from backend.db.models import RealizedPnl


class RealizedPnlRepository:
    """Repository for RealizedPnl CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, pnl: RealizedPnl) -> RealizedPnl:
        """Create a new realized PnL record."""
        self.session.add(pnl)
        self.session.flush()
        self.session.refresh(pnl)
        return pnl

    def get(self, pnl_id: int) -> Optional[RealizedPnl]:
        """Get a realized PnL record by ID."""
        return self.session.get(RealizedPnl, pnl_id)

    def list_by_asset(self, asset_id: int) -> List[RealizedPnl]:
        """List all realized PnL for an asset."""
        statement = (
            select(RealizedPnl)
            .where(RealizedPnl.asset_id == asset_id)
            .order_by(RealizedPnl.disposal_date)
        )
        return list(self.session.exec(statement).all())

    def list_by_transaction(self, transaction_id: int) -> List[RealizedPnl]:
        """List all realized PnL for a transaction."""
        statement = select(RealizedPnl).where(
            RealizedPnl.disposal_transaction_id == transaction_id
        )
        return list(self.session.exec(statement).all())

    def update(self, pnl: RealizedPnl) -> RealizedPnl:
        """Update a realized PnL record."""
        self.session.add(pnl)
        self.session.flush()
        self.session.refresh(pnl)
        return pnl

    def delete(self, pnl_id: int) -> bool:
        """Delete a realized PnL record by ID."""
        pnl = self.get(pnl_id)
        if pnl:
            self.session.delete(pnl)
            return True
        return False
