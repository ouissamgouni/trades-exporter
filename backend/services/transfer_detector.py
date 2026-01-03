"""
Transfer Detector Service: Detects internal transfers between owned accounts.

An internal transfer is when:
- source_from_account resolves to an owned account AND
- source_to_account resolves to an owned account

In this case, transaction_type is set to "transfer" and
from_account_id/to_account_id are populated.
"""

from typing import Optional, Tuple
from sqlmodel import Session

from backend.config.loader import configure_logging
from backend.db.models import Account
from backend.db.repositories import RawAccountRepository

log = configure_logging("transfer_detector")


class TransferDetector:
    """
    Detects internal transfers between owned accounts.

    Uses raw_accounts table to resolve source addresses to accounts,
    then checks if both from/to accounts are owned by user.
    """

    def __init__(self, session: Session):
        """
        Initialize the transfer detector.

        Args:
            session: Database session for lookups
        """
        self.session = session
        self.raw_account_repo = RawAccountRepository(session)
        # Cache for account ownership lookups
        self._account_owned_cache: dict[int, bool] = {}

    def resolve_account(
        self, source: str, label: str
    ) -> Tuple[Optional[int], Optional[bool]]:
        """
        Resolve a source/label pair to an account_id and owned status.

        Args:
            source: The connector source (e.g., 'blockscout_base', 'binance')
            label: The address or account identifier

        Returns:
            Tuple of (account_id, is_owned) or (None, None) if not mapped
        """
        if not source or not label:
            return None, None

        # Get or create raw_account entry
        raw_account = self.raw_account_repo.get_or_create(source, label)

        if not raw_account.account_id:
            return None, None

        # Check if account is owned (with caching)
        account_id = raw_account.account_id
        if account_id not in self._account_owned_cache:
            account = self.session.get(Account, account_id)
            self._account_owned_cache[account_id] = account.owned if account else False

        return account_id, self._account_owned_cache[account_id]

    def detect_internal_transfer(
        self,
        source: str,
        source_from_account: Optional[str],
        source_to_account: Optional[str],
    ) -> Tuple[Optional[int], Optional[int], bool]:
        """
        Detect if a transaction is an internal transfer between owned accounts.

        Args:
            source: The connector source
            source_from_account: Raw from address/account
            source_to_account: Raw to address/account

        Returns:
            Tuple of (from_account_id, to_account_id, is_internal_transfer)
        """
        from_account_id = None
        to_account_id = None
        from_owned = False
        to_owned = False

        # Resolve from account
        if source_from_account:
            from_account_id, from_owned = self.resolve_account(
                source, source_from_account
            )

        # Resolve to account
        if source_to_account:
            to_account_id, to_owned = self.resolve_account(source, source_to_account)

        # Internal transfer if BOTH from and to are owned accounts
        is_internal_transfer = (
            from_account_id is not None
            and to_account_id is not None
            and from_owned
            and to_owned
        )

        if is_internal_transfer:
            log.debug(
                f"Detected internal transfer: "
                f"from account {from_account_id} to account {to_account_id}"
            )

        return from_account_id, to_account_id, is_internal_transfer

    def enrich_transaction(
        self,
        transaction,
        source: str,
    ):
        """
        Enrich a transaction with account IDs and detect internal transfers.

        Modifies the transaction in place:
        - Sets from_account_id and to_account_id if resolved
        - Sets transaction_type to "transfer" if internal transfer detected

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

        # Detect transfer
        from_id, to_id, is_internal = self.detect_internal_transfer(
            source, source_from, source_to
        )

        # Enrich transaction
        if from_id is not None:
            transaction.from_account_id = from_id
        if to_id is not None:
            transaction.to_account_id = to_id

        # Mark as transfer if internal
        if is_internal:
            transaction.transaction_type = "transfer"
            # Internal transfers are typically not taxable
            transaction.taxable = False
            log.debug(
                f"Marked transaction as internal transfer: "
                f"{transaction.source_transaction_id}"
            )

        return transaction
