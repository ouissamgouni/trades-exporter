"""
Asset Repository - CRUD operations for assets.
"""

from typing import Optional, List
from sqlmodel import Session, select

from backend.db.models import Asset


class AssetRepository:
    """Repository for Asset CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, asset: Asset) -> Asset:
        """Create a new asset."""
        self.session.add(asset)
        self.session.flush()
        self.session.refresh(asset)
        return asset

    def get(self, asset_id: int) -> Optional[Asset]:
        """Get an asset by ID."""
        return self.session.get(Asset, asset_id)

    def get_by_symbol(self, symbol: str) -> Optional[Asset]:
        """Get an asset by symbol."""
        statement = select(Asset).where(Asset.symbol == symbol)
        return self.session.exec(statement).first()

    def get_or_create_by_symbol(self, symbol: str) -> Asset:
        """Get asset by symbol, creating it if it doesn't exist."""
        asset = self.get_by_symbol(symbol)
        if asset:
            return asset

        new_asset = Asset(
            symbol=symbol,
            label=symbol,
            tags="auto-created",
            price_getter_asset_id=symbol,
        )
        return self.create(new_asset)

    def list_all(self, limit: int = 100, offset: int = 0) -> List[Asset]:
        """List all assets with pagination."""
        statement = select(Asset).offset(offset).limit(limit)
        return list(self.session.exec(statement).all())

    def update(self, asset: Asset) -> Asset:
        """Update an existing asset."""
        self.session.add(asset)
        self.session.flush()
        self.session.refresh(asset)
        return asset

    def delete(self, asset_id: int) -> bool:
        """Delete an asset by ID."""
        asset = self.get(asset_id)
        if asset:
            self.session.delete(asset)
            return True
        return False
