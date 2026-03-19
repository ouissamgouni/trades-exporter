"""
Account Connector Repository - CRUD operations for account connectors.
"""

from datetime import datetime, timezone
from typing import Optional, List, Tuple

from sqlmodel import Session, select

from backend.db.models import Account, AccountConnector


class AccountConnectorRepository:
    """Repository for AccountConnector CRUD operations."""

    def __init__(self, session: Session):
        self.session = session

    def create(self, connector: AccountConnector) -> AccountConnector:
        """Create a new account connector."""
        self.session.add(connector)
        self.session.flush()
        self.session.refresh(connector)
        return connector

    def get(self, connector_id: int) -> Optional[AccountConnector]:
        """Get an account connector by ID."""
        return self.session.get(AccountConnector, connector_id)

    def get_with_account(
        self, connector_id: int
    ) -> Optional[Tuple[AccountConnector, Account]]:
        """Get an account connector with its parent account."""
        statement = (
            select(AccountConnector, Account)
            .join(Account)
            .where(AccountConnector.id == connector_id)
        )
        result = self.session.exec(statement).first()
        return result

    def get_all(self) -> List[Tuple[AccountConnector, Account]]:
        """
        Get all enabled connectors with their accounts.
        
        Only returns connectors where:
        - AccountConnector.enabled = True
        - Account.enabled = True (account-level enable flag)

        Returns:
            List of (AccountConnector, Account) tuples ordered by sync_priority
        """
        statement = (
            select(AccountConnector, Account)
            .join(Account)
            .order_by(AccountConnector.sync_priority)
        )
        return list(self.session.exec(statement).all())

    def get_enabled(self) -> List[Tuple[AccountConnector, Account]]:
        """
        Get all enabled connectors with their accounts.
        
        Only returns connectors where:
        - AccountConnector.enabled = True
        - Account.enabled = True (account-level enable flag)

        Returns:
            List of (AccountConnector, Account) tuples ordered by sync_priority
        """
        statement = (
            select(AccountConnector, Account)
            .join(Account)
            .where(AccountConnector.enabled)
            .where(Account.enabled)
            .order_by(AccountConnector.sync_priority)
        )
        return list(self.session.exec(statement).all())

    def get_by_account(
        self, account_id: int, enabled_only: bool = False
    ) -> List[AccountConnector]:
        """
        Get all connectors for a specific account.

        Args:
            account_id: The account ID
            enabled_only: If True, only return enabled connectors

        Returns:
            List of AccountConnector records ordered by sync_priority
        """
        statement = select(AccountConnector).where(
            AccountConnector.account_id == account_id
        )
        if enabled_only:
            statement = statement.where(AccountConnector.enabled)
        statement = statement.order_by(AccountConnector.sync_priority)
        return list(self.session.exec(statement).all())

    def get_by_account_and_type(
        self, account_id: int, connector_type: str
    ) -> Optional[AccountConnector]:
        """
        Get a connector by account ID and connector type.

        Args:
            account_id: The account ID
            connector_type: The connector type

        Returns:
            AccountConnector if found, None otherwise
        """
        statement = select(AccountConnector).where(
            AccountConnector.account_id == account_id,
            AccountConnector.connector_type == connector_type,
        )
        return self.session.exec(statement).first()

    def get_by_type(self, connector_type: str) -> List[AccountConnector]:
        """Get all connectors of a specific type."""
        statement = (
            select(AccountConnector)
            .where(AccountConnector.connector_type == connector_type)
            .order_by(AccountConnector.sync_priority)
        )
        return list(self.session.exec(statement).all())

    def list_all(self) -> List[AccountConnector]:
        """Get all account connectors."""
        statement = select(AccountConnector).order_by(AccountConnector.sync_priority)
        return list(self.session.exec(statement).all())

    def get_all_with_accounts(self) -> List[Tuple[AccountConnector, Account]]:
        """
        Get all connectors with their accounts (enabled and disabled).
        
        Returns all connectors regardless of enabled status, joined with account info.
        Used by sync config panel to allow enabling/disabling any connector.

        Returns:
            List of (AccountConnector, Account) tuples ordered by account name, sync_priority
        """
        statement = (
            select(AccountConnector, Account)
            .join(Account)
            .order_by(Account.name, AccountConnector.sync_priority)
        )
        return list(self.session.exec(statement).all())

    def update(self, connector: AccountConnector) -> AccountConnector:
        """Update an account connector."""
        self.session.add(connector)
        self.session.flush()
        self.session.refresh(connector)
        return connector

    def update_sync_status(
        self,
        connector_id: int,
        status: str,
        error: Optional[str] = None,
    ) -> Optional[AccountConnector]:
        """
        Update the sync status of a connector.

        Args:
            connector_id: The AccountConnector ID
            status: New status ('pending', 'running', 'success', 'failed')
            error: Optional error message if status is 'failed'

        Returns:
            Updated connector or None if not found
        """
        connector = self.get(connector_id)
        if not connector:
            return None

        connector.last_sync_status = status

        if status in ["success", "failed"]:
            connector.last_sync_at = datetime.now(timezone.utc)

        if status == "failed" and error:
            connector.last_error = error
        elif status == "success":
            connector.last_error = None

        self.session.add(connector)
        self.session.flush()
        return connector

    def delete(self, connector_id: int) -> bool:
        """Delete an account connector by ID."""
        connector = self.get(connector_id)
        if connector:
            self.session.delete(connector)
            return True
        return False

    def exists(self, account_id: int, connector_type: str) -> bool:
        """Check if a connector of this type exists for the account."""
        statement = select(AccountConnector).where(
            AccountConnector.account_id == account_id,
            AccountConnector.connector_type == connector_type,
        )
        return self.session.exec(statement).first() is not None
