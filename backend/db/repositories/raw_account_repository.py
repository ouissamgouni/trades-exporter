"""
Raw Account Repository - CRUD operations for raw accounts.
"""

from typing import Optional, List
from sqlmodel import Session, select

from backend.db.models import RawAccount


class RawAccountRepository:
    """Repository for RawAccount CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, raw_account: RawAccount) -> RawAccount:
        """Create a new raw account."""
        self.session.add(raw_account)
        self.session.flush()
        self.session.refresh(raw_account)
        self.session.commit()
        return raw_account

    def get(self, source: str, label: str) -> Optional[RawAccount]:
        """Get a raw account by composite key (source + label)."""
        statement = select(RawAccount).where(
            RawAccount.source == source,
            RawAccount.label == label,
        )
        return self.session.exec(statement).first()

    def get_by_id(self, raw_account_id: int) -> Optional[RawAccount]:
        """Get a raw account by ID."""
        statement = select(RawAccount).where(RawAccount.id == raw_account_id)
        return self.session.exec(statement).first()

    def get_account_id(self, source: str, label: str) -> Optional[int]:
        """Get the account_id for a source/label pair."""
        raw_account = self.get(source, label)
        return raw_account.account_id if raw_account else None

    def get_or_create(self, source: str, label: str) -> RawAccount:
        """Get existing raw account or create a new one."""
        existing = self.get(source, label)
        if existing:
            return existing

        new_raw_account = RawAccount(source=source, label=label)
        return self.create(new_raw_account)

    def list_all(
        self,
        source: Optional[str] = None,
        has_account_id: Optional[bool] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> List[RawAccount]:
        """List raw accounts with optional filtering."""
        statement = select(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is not None:
            if has_account_id:
                statement = statement.where(RawAccount.account_id.isnot(None))
            else:
                statement = statement.where(RawAccount.account_id.is_(None))

        statement = (
            statement.order_by(RawAccount.source, RawAccount.label)
            .offset(offset)
            .limit(limit)
        )
        return list(self.session.exec(statement).all())

    def count(
        self,
        source: Optional[str] = None,
        has_account_id: Optional[bool] = None,
    ) -> int:
        """Count raw accounts with optional filtering."""
        from sqlmodel import func

        statement = select(func.count()).select_from(RawAccount)

        if source:
            statement = statement.where(RawAccount.source == source)

        if has_account_id is not None:
            if has_account_id:
                statement = statement.where(RawAccount.account_id.isnot(None))
            else:
                statement = statement.where(RawAccount.account_id.is_(None))

        return self.session.exec(statement).one()

    def update(self, raw_account: RawAccount) -> RawAccount:
        """Update a raw account."""
        self.session.add(raw_account)
        self.session.flush()
        self.session.refresh(raw_account)
        self.session.commit()
        return raw_account

    def update_account_id(self, source: str, label: str, account_id: int) -> bool:
        """Update the account_id for a source/label pair."""
        raw_account = self.get(source, label)
        if raw_account:
            raw_account.account_id = account_id
            self.session.add(raw_account)
            self.session.commit()
            return True
        return False

    def clear_account_id(self, source: str, label: str) -> bool:
        """Clear the account_id for a source/label pair (unmap)."""
        raw_account = self.get(source, label)
        if raw_account:
            raw_account.account_id = None
            self.session.add(raw_account)
            self.session.commit()
            return True
        return False

    def delete(self, source: str, label: str) -> bool:
        """Delete a raw account by composite key."""
        raw_account = self.get(source, label)
        if raw_account:
            self.session.delete(raw_account)
            self.session.commit()
            return True
        return False

    def find_by_account_id(self, account_id: int) -> List[RawAccount]:
        """Find all raw accounts mapped to a specific account."""
        statement = select(RawAccount).where(RawAccount.account_id == account_id)
        return list(self.session.exec(statement).all())
