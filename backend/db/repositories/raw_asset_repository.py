"""
Raw Asset Repository - CRUD operations for raw assets.
"""

import re
from typing import Optional, List, Tuple
from sqlmodel import Session, select

from backend.db.models import RawAsset

_EVM_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def normalize_contract(address: Optional[str]) -> str:
    """Lowercase EVM addresses; keep others (Solana mints, Sui types) as-is since they are case-sensitive."""
    a = (address or "").strip()
    return a.lower() if _EVM_ADDRESS.match(a) else a


def token_key(network: Optional[str], contract_address: Optional[str]) -> Tuple[str, str]:
    """(network, contract) key part of a raw asset; network only matters for token rows."""
    contract = normalize_contract(contract_address)
    return ((network or "").strip().lower() if contract else "", contract)


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

    def get(
        self, symbol: str, source: str, network: str = "", contract_address: str = ""
    ) -> Optional[RawAsset]:
        """Get a raw asset by composite key."""
        network, contract = token_key(network, contract_address)
        statement = select(RawAsset).where(
            RawAsset.symbol == symbol,
            RawAsset.source == source,
            RawAsset.network == network,
            RawAsset.contract_address == contract,
        )
        return self.session.exec(statement).first()

    def get_asset_id(self, symbol: str, source: str) -> Optional[int]:
        """Get the asset_id for a symbol/source pair."""
        raw_asset = self.get(symbol, source)
        return raw_asset.asset_id if raw_asset else None

    def get_or_create(
        self, symbol: str, source: str, network: str = "", contract_address: str = ""
    ) -> RawAsset:
        """Get existing raw asset or create a new one.

        A new token contract is only auto-mapped when the same (network, contract) is
        already mapped to exactly one asset; otherwise it stays unmapped for review.
        """
        network, contract = token_key(network, contract_address)
        existing = self.get(symbol, source, network, contract)
        if existing:
            return existing

        asset_id = self.known_contract_asset_id(network, contract) if contract else None
        new_raw_asset = RawAsset(
            symbol=symbol,
            source=source,
            network=network,
            contract_address=contract,
            asset_id=asset_id,
        )
        return self.create(new_raw_asset)

    def known_contract_asset_id(self, network: str, contract_address: str) -> Optional[int]:
        """Asset already mapped to this token contract (from any source), if unambiguous."""
        network, contract = token_key(network, contract_address)
        if not contract:
            return None
        ids = self.session.exec(
            select(RawAsset.asset_id)
            .where(
                RawAsset.network == network,
                RawAsset.contract_address == contract,
                RawAsset.asset_id.isnot(None),
            )
            .distinct()
        ).all()
        return ids[0] if len(ids) == 1 else None

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
