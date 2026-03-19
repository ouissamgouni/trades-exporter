"""
Unit tests for AccountResolver service.
Tests the resolution of source addresses to account IDs.
"""

from datetime import datetime

from backend.db.models import NormalizedTransaction, Account, RawAccount
from backend.core.network_normalizer import normalize_network


# Helper to create test transactions with required fields
def make_tx(**kwargs):
    """Create a NormalizedTransaction with default required fields."""
    defaults = {
        "source": "binance",
        "source_transaction_id": "test123",
        "date_time": datetime(2024, 1, 1, 12, 0, 0),
        "direction": "inflow",
        "transaction_type": "transfer",
        "quantity": 1.0,
    }
    defaults.update(kwargs)
    return NormalizedTransaction(**defaults)


class MockSession:
    """Mock database session for testing."""

    def __init__(self):
        self.accounts = {}

    def get(self, model_class, id):
        """Mock get method."""
        if model_class == Account:
            return self.accounts.get(id)
        return None

    def add(self, obj):
        """Mock add method (no-op for tests)."""
        pass


class MockRawAccountRepository:
    """Mock RawAccountRepository for testing."""

    def __init__(self):
        self.raw_accounts = {}

    def _key(self, source: str, label: str, network: str = "") -> str:
        network = normalize_network(network) or ""
        return f"{source}:{label}:{network}"

    def get(self, source: str, label: str, network: str = ""):
        """Mock get method."""
        return self.raw_accounts.get(self._key(source, label, network))

    def get_or_create(self, source: str, label: str, network: str = ""):
        """Mock get_or_create method."""
        key = self._key(source, label, network)
        if key in self.raw_accounts:
            return self.raw_accounts[key]
        # Create and store new unlinked raw account
        raw_account = RawAccount(source=source, label=label, network=network, account_id=None)
        self.raw_accounts[key] = raw_account
        return raw_account

    def add_mapping(self, source: str, label: str, account_id: int, network: str = ""):
        """Helper to add a mapping for testing."""
        key = self._key(source, label, network)
        self.raw_accounts[key] = RawAccount(
            source=source, label=label, network=network, account_id=account_id
        )


class TestAccountResolverResolveAccount:
    """Tests for account resolution."""

    def test_resolve_unmapped_address(self):
        """Unmapped address should return None, None."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        resolver = AccountResolver(session)
        resolver.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = resolver.resolve_account("blockscout_base", "0xunmapped")

        assert account_id is None
        assert is_owned is None

    def test_resolve_mapped_owned_account(self):
        """Mapped address to owned account should return account_id, True."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmyaddr", 1)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        account_id, is_owned = resolver.resolve_account("blockscout_base", "0xmyaddr")

        assert account_id == 1
        assert is_owned is True

    def test_resolve_mapped_unowned_account(self):
        """Mapped address to unowned account should return account_id, False."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[2] = Account(id=2, name="Exchange Hot Wallet", owned=False)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xexchange", 2)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        account_id, is_owned = resolver.resolve_account("blockscout_base", "0xexchange")

        assert account_id == 2
        assert is_owned is False

    def test_resolve_empty_label(self):
        """Empty label should return None, None."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        resolver = AccountResolver(session)
        resolver.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = resolver.resolve_account("blockscout_base", "")

        assert account_id is None
        assert is_owned is None

    def test_resolve_none_label(self):
        """None label should return None, None."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        resolver = AccountResolver(session)
        resolver.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = resolver.resolve_account("blockscout_base", None)

        assert account_id is None
        assert is_owned is None


class TestResolveTransactionAccounts:
    """Tests for resolving from/to account IDs."""

    def test_resolve_both_accounts(self):
        """Should resolve both from and to account IDs."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)
        session.accounts[2] = Account(id=2, name="Wallet B", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletB", 2)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        from_id, to_id = resolver.resolve_transaction_accounts(
            source="blockscout_base",
            source_from_account="0xwalletA",
            source_to_account="0xwalletB",
        )

        assert from_id == 1
        assert to_id == 2

    def test_resolve_only_from_account(self):
        """Should resolve only from account when to is unmapped."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 1)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        from_id, to_id = resolver.resolve_transaction_accounts(
            source="blockscout_base",
            source_from_account="0xmywallet",
            source_to_account="0xunknown",
        )

        assert from_id == 1
        assert to_id is None

    def test_resolve_only_to_account(self):
        """Should resolve only to account when from is unmapped."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 1)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        from_id, to_id = resolver.resolve_transaction_accounts(
            source="blockscout_base",
            source_from_account="0xunknown",
            source_to_account="0xmywallet",
        )

        assert from_id is None
        assert to_id == 1


class TestEnrichTransaction:
    """Tests for transaction enrichment."""

    def test_enrich_sets_account_ids(self):
        """Should set from_account_id and to_account_id."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)
        session.accounts[2] = Account(id=2, name="Wallet B", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletB", 2)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_transaction_id="0xhash123",
            source_transaction_type="token_transfer",
            source_asset_symbol="ETH",
            source_from_account="0xwalletA",
            source_to_account="0xwalletB",
            quantity=1.0,
            transaction_type="transfer",
        )

        enriched = resolver.enrich_transaction(tx, "blockscout_base")

        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2
        # Transaction type should NOT be modified
        assert enriched.transaction_type == "transfer"

    def test_enrich_does_not_change_transaction_type(self):
        """Should NOT modify transaction_type even if both accounts are owned."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)
        session.accounts[2] = Account(id=2, name="Wallet B", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletB", 2)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_from_account="0xwalletA",
            source_to_account="0xwalletB",
            transaction_type="transfer",  # Should stay as "transfer"
        )

        enriched = resolver.enrich_transaction(tx, "blockscout_base")

        # Should resolve accounts
        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2
        # Should NOT change transaction_type
        assert enriched.transaction_type == "transfer"

    def test_enrich_transfer_from_unowned_to_owned(self):
        """Should resolve accounts but not change type for external transfers."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Exchange", owned=False)
        session.accounts[2] = Account(id=2, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xexchange", 1)
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 2)

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_transaction_id="0xhash456",
            source_from_account="0xexchange",
            source_to_account="0xmywallet",
            quantity=2.0,
            transaction_type="transfer",
        )

        enriched = resolver.enrich_transaction(tx, "blockscout_base")

        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2
        # Should NOT modify transaction_type (external transfer)
        assert enriched.transaction_type == "transfer"

    def test_enrich_non_transfer_transaction(self):
        """Should skip enrichment for transactions without source addresses."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        resolver = AccountResolver(session)
        resolver.raw_account_repo = MockRawAccountRepository()

        tx = make_tx(
            source="binance",
            source_transaction_id="123",
            source_transaction_type="buy",
            source_asset_symbol="BTC",
            quantity=1.0,
            transaction_type="trade",
        )

        enriched = resolver.enrich_transaction(tx, "binance")

        assert enriched.from_account_id is None
        assert enriched.to_account_id is None
        assert enriched.transaction_type == "trade"


class TestCaching:
    """Tests for account ownership caching."""

    def test_cache_hit_for_repeated_lookups(self):
        """Repeated lookups for same account should use cache."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletA2", 1)  # Same account

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        # First lookup - populates cache
        account_id1, owned1 = resolver.resolve_account("blockscout_base", "0xwalletA")

        # Second lookup - should use cache
        account_id2, owned2 = resolver.resolve_account("blockscout_base", "0xwalletA2")

        assert account_id1 == 1
        assert owned1 is True
        assert account_id2 == 1
        assert owned2 is True

        # Verify cache was used (account should be in cache)
        assert 1 in resolver._account_owned_cache


class TestNetworkAwareResolution:
    """Tests for network-aware account resolution."""

    def test_same_label_different_networks_resolve_differently(self):
        """Same address on different networks should resolve to different accounts."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Tangem Base", owned=True)
        session.accounts[2] = Account(id=2, name="Tangem BSC", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xshared", 1, network="base")
        mock_repo.add_mapping("blockscout_base", "0xshared", 2, network="bsc")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        aid_base, _ = resolver.resolve_account("blockscout_base", "0xshared", network="base")
        aid_bsc, _ = resolver.resolve_account("blockscout_base", "0xshared", network="bsc")

        assert aid_base == 1
        assert aid_bsc == 2

    def test_empty_network_creates_separate_raw_account(self):
        """Empty network should not collide with network-specific mappings."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Tangem Base", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xshared", 1, network="base")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        # Empty network ≠ 'base'
        aid_empty, _ = resolver.resolve_account("blockscout_base", "0xshared", network="")
        aid_base, _ = resolver.resolve_account("blockscout_base", "0xshared", network="base")

        assert aid_empty is None  # no mapping for empty network
        assert aid_base == 1

    def test_resolve_transaction_accounts_with_network(self):
        """Transaction resolution should forward network to per-address lookups."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Sender", owned=True)
        session.accounts[2] = Account(id=2, name="Receiver", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xfrom", 1, network="base")
        mock_repo.add_mapping("blockscout_base", "0xto", 2, network="base")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        from_id, to_id = resolver.resolve_transaction_accounts(
            source="blockscout_base",
            source_from_account="0xfrom",
            source_to_account="0xto",
            network="base",
        )

        assert from_id == 1
        assert to_id == 2

    def test_enrich_transaction_extracts_network(self):
        """enrich_transaction should use tx.network for raw account lookups."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="From Account", owned=True)
        session.accounts[2] = Account(id=2, name="To Account", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xfrom", 1, network="base")
        mock_repo.add_mapping("blockscout_base", "0xto", 2, network="base")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_from_account="0xfrom",
            source_to_account="0xto",
            network="base",
            transaction_type="transfer",
        )

        enriched = resolver.enrich_transaction(tx, "blockscout_base")

        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2

    def test_non_canonical_network_resolves_via_normalization(self):
        """Passing a non-canonical alias (e.g. 'ETH') should resolve to a mapping stored under 'ethereum'."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Ethereum Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("etherscan", "0xaddr", 1, network="ethereum")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        # "ETH" is an alias for "ethereum" in NETWORK_ALIASES
        aid, owned = resolver.resolve_account("etherscan", "0xaddr", network="ETH")

        assert aid == 1
        assert owned is True

    def test_none_network_normalizes_to_empty(self):
        """None network should normalize to empty string and match mappings with network=''."""
        from backend.services.account_resolver import AccountResolver

        session = MockSession()
        session.accounts[1] = Account(id=1, name="CEX Account", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("binance", "main", 1, network="")

        resolver = AccountResolver(session)
        resolver.raw_account_repo = mock_repo

        aid, owned = resolver.resolve_account("binance", "main", network=None)

        assert aid == 1
        assert owned is True