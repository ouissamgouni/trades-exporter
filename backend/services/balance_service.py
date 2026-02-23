"""
Balance Service

Fetches live balances from connector APIs.
Supports per-connector, per-account, and global balance queries.
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlmodel import Session, select

from backend.config.loader import configure_logging
from backend.connectors.base.base_connector import BalanceEntry
from backend.connectors.connector_registry import get_connector_registry
from backend.db.models import Account, AccountConnector
from backend.services.connector_loader_service import ConnectorLoaderService

log = configure_logging("balance_service")


@dataclass
class ConnectorBalance:
    """Balance result for a single connector."""

    connector_id: int
    connector_type: str
    account_id: int
    account_name: str
    chain: Optional[str]
    entries: List[BalanceEntry]
    fetched_at: str  # ISO datetime
    error: Optional[str] = None


@dataclass
class AccountBalance:
    """Aggregated balance for an account (across all its connectors)."""

    account_id: int
    account_name: str
    account_type: str
    group: Optional[str]
    connector_balances: List[ConnectorBalance] = field(default_factory=list)


class BalanceService:
    """Service for fetching live balances from connector APIs."""

    def __init__(self, session: Session):
        self.session = session
        self._registry = get_connector_registry()
        self._loader = ConnectorLoaderService(session)

    def fetch_connector_balance(
        self,
        connector_id: int,
    ) -> Optional[ConnectorBalance]:
        """Fetch balance for a single connector.

        Args:
            connector_id: AccountConnector ID

        Returns:
            ConnectorBalance or None if connector not found / not supported
        """
        ac = self.session.get(AccountConnector, connector_id)
        if not ac:
            log.warning(f"Connector {connector_id} not found")
            return None

        info = self._registry.get(ac.connector_type)
        if not info or not info.supports_balance:
            return None

        account = self.session.get(Account, ac.account_id)
        if not account:
            return None

        return self._fetch_single(ac, account)

    def fetch_account_balance(
        self,
        account_id: int,
    ) -> Optional[AccountBalance]:
        """Fetch balances for all connectors of a single account.

        Args:
            account_id: Account ID

        Returns:
            AccountBalance or None if account not found
        """
        account = self.session.get(Account, account_id)
        if not account:
            return None

        connectors = self.session.exec(
            select(AccountConnector).where(
                AccountConnector.account_id == account_id,
                AccountConnector.enabled == True,
            )
        ).all()

        result = AccountBalance(
            account_id=account.id,
            account_name=account.name,
            account_type=account.account_type,
            group=account.group,
        )

        # Pick one balance-capable connector per chain to avoid
        # duplicate balances when multiple connectors (e.g. moralis +
        # etherscan) query the same wallet on the same chain.
        seen_chains: set[str | None] = set()

        for ac in connectors:
            info = self._registry.get(ac.connector_type)
            if not info or not info.supports_balance:
                continue

            chain = (ac.config or {}).get("chain")
            if chain in seen_chains:
                log.debug(
                    f"Skipping {ac.connector_type} (connector_id={ac.id}) "
                    f"for chain '{chain}' — already covered by another connector"
                )
                continue
            seen_chains.add(chain)

            cb = self._fetch_single(ac, account)
            if cb:
                result.connector_balances.append(cb)

        return result

    def fetch_all_balances(self) -> List[AccountBalance]:
        """Fetch balances for all enabled accounts/connectors.

        Returns:
            List of AccountBalance, one per account with balance-capable connectors
        """
        accounts = self.session.exec(
            select(Account).where(Account.enabled == True)
        ).all()

        results = []
        for account in accounts:
            ab = self.fetch_account_balance(account.id)
            if ab and ab.connector_balances:
                results.append(ab)

        return results

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _fetch_single(
        self,
        ac: AccountConnector,
        account: Account,
    ) -> ConnectorBalance:
        """Instantiate connector and fetch balance."""
        chain = (ac.config or {}).get("chain")
        now = datetime.now(timezone.utc).isoformat()

        try:
            connector = self._loader.instantiate_connector(ac, account)
            if connector is None:
                return ConnectorBalance(
                    connector_id=ac.id,
                    connector_type=ac.connector_type,
                    account_id=account.id,
                    account_name=account.name,
                    chain=chain,
                    entries=[],
                    fetched_at=now,
                    error="Failed to instantiate connector",
                )

            if not connector.supports_balance:
                return ConnectorBalance(
                    connector_id=ac.id,
                    connector_type=ac.connector_type,
                    account_id=account.id,
                    account_name=account.name,
                    chain=chain,
                    entries=[],
                    fetched_at=now,
                    error="Connector does not support balance",
                )

            entries = connector.get_balance()
            connector.cleanup()

            return ConnectorBalance(
                connector_id=ac.id,
                connector_type=ac.connector_type,
                account_id=account.id,
                account_name=account.name,
                chain=chain,
                entries=entries,
                fetched_at=now,
            )

        except Exception as e:
            log.error(
                f"Failed to fetch balance for {ac.connector_type} "
                f"(connector_id={ac.id}): {e}"
            )
            return ConnectorBalance(
                connector_id=ac.id,
                connector_type=ac.connector_type,
                account_id=account.id,
                account_name=account.name,
                chain=chain,
                entries=[],
                fetched_at=now,
                error=str(e),
            )
