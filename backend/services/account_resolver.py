"""
Account Resolver Service: Resolves source addresses to account IDs.

Resolves source_from_account and source_to_account fields to actual account IDs
by looking up mappings in the raw_accounts table.

This service does NOT change transaction_type. Internal transfer detection is
handled at the P&L calculation level.
"""

from typing import Optional, Tuple
from sqlmodel import Session

from backend.config.loader import configure_logging
from backend.db.models import Account
from backend.db.repositories import RawAccountRepository

log = configure_logging("account_resolver")


class AccountResolver:
    """
    Resolves source addresses to account IDs.

    Uses raw_accounts table to map source addresses to accounts.
    Sets from_account_id and to_account_id on transactions.
    """

    def __init__(self, session: Session):
        """
        Initialize the account resolver.

        Args:
            session: Database session for lookups
        """
        self.session = session
        self.raw_account_repo = RawAccountRepository(session)
        # Cache for account ownership lookups
        self._account_owned_cache: dict[int, bool] = {}

    def resolve_account(
        self, source: str, label: str, network: str = ""
    ) -> Tuple[Optional[int], Optional[bool]]:
        """
        Resolve a source/label/network triple to an account_id and owned status.

        Args:
            source: The connector source (e.g., 'blockscout_base', 'binance')
            label: The address or account identifier
            network: Normalized chain name (e.g. 'bsc', 'ethereum', '')

        Returns:
            Tuple of (account_id, is_owned) or (None, None) if not mapped
        """
        if not source or not label:
            return None, None

        # Get or create raw_account entry
        raw_account = self.raw_account_repo.get_or_create(source, label, network)

        if not raw_account.account_id:
            return None, None

        # Check if account is owned (with caching)
        account_id = raw_account.account_id
        if account_id not in self._account_owned_cache:
            account = self.session.get(Account, account_id)
            self._account_owned_cache[account_id] = account.owned if account else False

        return account_id, self._account_owned_cache[account_id]

    def resolve_transaction_accounts(
        self,
        source: str,
        source_from_account: Optional[str],
        source_to_account: Optional[str],
        network: str = "",
    ) -> Tuple[Optional[int], Optional[int]]:
        """
        Resolve from and to account IDs for a transaction.

        Args:
            source: The connector source
            source_from_account: Raw from address/account
            source_to_account: Raw to address/account
            network: Normalized chain name

        Returns:
            Tuple of (from_account_id, to_account_id)
        """
        from_account_id = None
        to_account_id = None

        # Resolve from account
        if source_from_account:
            from_account_id, _ = self.resolve_account(source, source_from_account, network)

        # Resolve to account
        if source_to_account:
            to_account_id, _ = self.resolve_account(source, source_to_account, network)

        if from_account_id or to_account_id:
            log.debug(
                f"Resolved accounts: from={from_account_id}, to={to_account_id}"
            )

        return from_account_id, to_account_id

    def enrich_transaction(
        self,
        transaction,
        source: str,
    ):
        """
        Enrich a transaction with account IDs.

        Sets from_account_id and to_account_id if they can be resolved.
        Does NOT modify transaction_type - that's handled at P&L calculation time.

        Args:
            transaction: The transaction to enrich (dict or model with attributes)
            source: The connector source

        Returns:
            The enriched transaction
        """
        # Get source addresses
        source_from = getattr(transaction, "source_from_account", None)
        source_to = getattr(transaction, "source_to_account", None)

        if not source_from and not source_to:
            return transaction

        # Extract network from transaction for network-aware mapping
        network = getattr(transaction, "network", None) or ""

        # Resolve accounts
        from_id, to_id = self.resolve_transaction_accounts(
            source, source_from, source_to, network
        )

        # Auto-link RawAccounts when connector pre-set the account ID
        # (e.g., deposit connectors set to_account_id, withdrawal connectors set from_account_id)
        pre_set_to = getattr(transaction, "to_account_id", None)
        if source_to and pre_set_to and to_id is None:
            self._auto_link_raw_account(source, source_to, pre_set_to, network)

        pre_set_from = getattr(transaction, "from_account_id", None)
        if source_from and pre_set_from and from_id is None:
            self._auto_link_raw_account(source, source_from, pre_set_from, network)

        # Set account IDs
        if from_id is not None:
            transaction.from_account_id = from_id
        if to_id is not None:
            transaction.to_account_id = to_id

        return transaction

    def _auto_link_raw_account(
        self, source: str, label: str, account_id: int, network: str = ""
    ) -> None:
        """
        Auto-link a RawAccount to an account when the connector already knows
        the mapping (e.g., deposit address belongs to the connector's account).

        Only links if the RawAccount exists and has no account_id yet.

        Args:
            source: The connector source (e.g., 'binance-deposits')
            label: The raw address or identifier
            account_id: The account ID to link to
            network: Normalized chain name
        """
        raw_account = self.raw_account_repo.get(source, label, network)
        if raw_account and raw_account.account_id is None:
            raw_account.account_id = account_id
            self.session.add(raw_account)
            log.debug(
                f"Auto-linked raw account '{label}' (source={source}, network={network}) "
                f"to account_id={account_id}"
            )
