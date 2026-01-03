"""
Raw Asset Repository - CRUD operations for raw assets.
"""

from typing import Optional, List
from sqlmodel import Session, select

from backend.db.models import RawAsset


class RawAssetRepository:
    """Repository for RawAsset CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, raw_asset: RawAsset) -> RawAsset:
        """Create a new raw asset."""
        self.session.add(raw_asset)
        self.session.flush()
        self.session.refresh(raw_asset)
        self.session.commit()
        return raw_asset

    def get(self, symbol: str, source: str) -> Optional[RawAsset]:
        """Get a raw asset by composite key."""
        statement = select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
        )
        return self.session.exec(statement).first()

    def get_asset_id(self, symbol: str, source: str) -> Optional[int]:
        """Get the asset_id for a symbol/source pair."""
        raw_asset = self.get(symbol, source)
        return raw_asset.asset_id if raw_asset else None

    def get_or_create(self, symbol: str, source: str) -> RawAsset:
        """Get existing raw asset or create a new one."""
        existing = self.get(symbol, source)
        if existing:
            return existing

        new_raw_asset = RawAsset(symbol=symbol, source=source)
        return self.create(new_raw_asset)

    def list_all(
        self,
        source: Optional[str] = None,
        has_asset_id: Optional[bool] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[RawAsset]:
        """List raw assets with optional filtering."""
        statement = select(RawAsset)

        if source:
            statement = statement.where(RawAsset.source == source)

        if has_asset_id is not None:
            if has_asset_id:
                statement = statement.where(RawAsset.asset_id.isnot(None))
            else:
                statement = statement.where(RawAsset.asset_id.is_(None))

        statement = (
            statement.order_by(RawAsset.source, RawAsset.symbol)
            .offset(offset)
            .limit(limit)
        )
        return list(self.session.exec(statement).all())

    def update(self, raw_asset: RawAsset) -> RawAsset:
        """Update a raw asset."""
        self.session.add(raw_asset)
        self.session.flush()
        self.session.refresh(raw_asset)
        self.session.commit()
        return raw_asset

    def update_asset_id(self, symbol: str, source: str, asset_id: int) -> bool:
        """Update the asset_id for a symbol/source pair."""
        raw_asset = self.get(symbol, source)
        if raw_asset:
            raw_asset.asset_id = asset_id
            self.session.add(raw_asset)
            self.session.commit()
            return True
        return False

    def delete(self, symbol: str, source: str) -> bool:
        """Delete a raw asset by composite key."""
        raw_asset = self.get(symbol, source)
        if raw_asset:
            self.session.delete(raw_asset)
            self.session.commit()
            return True
        return False
