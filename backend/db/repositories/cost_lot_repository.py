"""
Cost Lot Repository - CRUD operations for cost lots (tax accounting).
"""

from typing import Optional, List
from sqlmodel import Session, select

from backend.db.models import CostLot


class CostLotRepository:
    """Repository for CostLot CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, cost_lot: CostLot) -> CostLot:
        """Create a new cost lot."""
        self.session.add(cost_lot)
        self.session.flush()
        self.session.refresh(cost_lot)
        return cost_lot

    def get(self, lot_id: int) -> Optional[CostLot]:
        """Get a cost lot by ID."""
        return self.session.get(CostLot, lot_id)

    def list_by_asset(self, asset_id: int) -> List[CostLot]:
        """List all cost lots for an asset."""
        statement = (
            select(CostLot)
            .where(CostLot.asset_id == asset_id)
            .order_by(CostLot.acquisition_date)
        )
        return list(self.session.exec(statement).all())

    def list_available(self, asset_id: int) -> List[CostLot]:
        """List available (non-zero remaining) cost lots for an asset."""
        statement = (
            select(CostLot)
            .where(CostLot.asset_id == asset_id)
            .where(CostLot.remaining_quantity > 0)
            .order_by(CostLot.acquisition_date)
        )
        return list(self.session.exec(statement).all())

    def update(self, cost_lot: CostLot) -> CostLot:
        """Update a cost lot."""
        self.session.add(cost_lot)
        self.session.flush()
        self.session.refresh(cost_lot)
        return cost_lot

    def delete(self, lot_id: int) -> bool:
        """Delete a cost lot by ID."""
        cost_lot = self.get(lot_id)
        if cost_lot:
            self.session.delete(cost_lot)
            return True
        return False
