"""
Unit tests for TransferDetector service.
Tests the detection of internal transfers between owned accounts.
"""

from datetime import datetime

from backend.db.models import NormalizedTransaction, Account, RawAccount


# Helper to create test transactions with required fields
def make_tx(**kwargs):
    """Create a NormalizedTransaction with default required fields."""
    defaults = {
        "source": "binance",
        "source_transaction_id": "test123",
        "date_time": datetime(2024, 1, 1, 12, 0, 0),
        "direction": "inflow",
        "transaction_type": "acquisition",
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


class MockRawAccountRepository:
    """Mock RawAccountRepository for testing."""

    def __init__(self):
        self.raw_accounts = {}

    def get_or_create(self, source: str, label: str):
        """Mock get_or_create method."""
        key = f"{source}:{label}"
        if key in self.raw_accounts:
            return self.raw_accounts[key]
        # Return new unlinked raw account by default
        return RawAccount(source=source, label=label, account_id=None)

    def add_mapping(self, source: str, label: str, account_id: int):
        """Helper to add a mapping for testing."""
        key = f"{source}:{label}"
        self.raw_accounts[key] = RawAccount(
            source=source, label=label, account_id=account_id
        )


class TestTransferDetectorResolveAccount:
    """Tests for account resolution."""

    def test_resolve_unmapped_address(self):
        """Unmapped address should return None, None."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        detector = TransferDetector(session)
        detector.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = detector.resolve_account("blockscout_base", "0xunmapped")

        assert account_id is None
        assert is_owned is None

    def test_resolve_mapped_owned_account(self):
        """Mapped address to owned account should return account_id, True."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmyaddr", 1)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        account_id, is_owned = detector.resolve_account("blockscout_base", "0xmyaddr")

        assert account_id == 1
        assert is_owned is True

    def test_resolve_mapped_unowned_account(self):
        """Mapped address to unowned account should return account_id, False."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[2] = Account(id=2, name="Exchange Hot Wallet", owned=False)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xexchange", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        account_id, is_owned = detector.resolve_account("blockscout_base", "0xexchange")

        assert account_id == 2
        assert is_owned is False

    def test_resolve_empty_label(self):
        """Empty label should return None, None."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        detector = TransferDetector(session)
        detector.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = detector.resolve_account("blockscout_base", "")

        assert account_id is None
        assert is_owned is None

    def test_resolve_none_label(self):
        """None label should return None, None."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        detector = TransferDetector(session)
        detector.raw_account_repo = MockRawAccountRepository()

        account_id, is_owned = detector.resolve_account("blockscout_base", None)

        assert account_id is None
        assert is_owned is None


class TestDetectInternalTransfer:
    """Tests for internal transfer detection."""

    def test_internal_transfer_both_owned(self):
        """Transfer between two owned accounts is internal."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)
        session.accounts[2] = Account(id=2, name="Wallet B", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletB", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        from_id, to_id, is_internal = detector.detect_internal_transfer(
            source="blockscout_base",
            source_from_account="0xwalletA",
            source_to_account="0xwalletB",
        )

        assert from_id == 1
        assert to_id == 2
        assert is_internal is True

    def test_external_transfer_from_unowned(self):
        """Transfer from unowned to owned is not internal."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Exchange", owned=False)
        session.accounts[2] = Account(id=2, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xexchange", 1)
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        from_id, to_id, is_internal = detector.detect_internal_transfer(
            source="blockscout_base",
            source_from_account="0xexchange",
            source_to_account="0xmywallet",
        )

        assert from_id == 1
        assert to_id == 2
        assert is_internal is False

    def test_external_transfer_to_unowned(self):
        """Transfer from owned to unowned is not internal."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)
        session.accounts[2] = Account(id=2, name="Exchange", owned=False)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 1)
        mock_repo.add_mapping("blockscout_base", "0xexchange", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        from_id, to_id, is_internal = detector.detect_internal_transfer(
            source="blockscout_base",
            source_from_account="0xmywallet",
            source_to_account="0xexchange",
        )

        assert from_id == 1
        assert to_id == 2
        assert is_internal is False

    def test_transfer_with_unmapped_from(self):
        """Transfer from unmapped address is not internal."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 1)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        from_id, to_id, is_internal = detector.detect_internal_transfer(
            source="blockscout_base",
            source_from_account="0xunknown",
            source_to_account="0xmywallet",
        )

        assert from_id is None
        assert to_id == 1
        assert is_internal is False

    def test_transfer_with_unmapped_to(self):
        """Transfer to unmapped address is not internal."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 1)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        from_id, to_id, is_internal = detector.detect_internal_transfer(
            source="blockscout_base",
            source_from_account="0xmywallet",
            source_to_account="0xunknown",
        )

        assert from_id == 1
        assert to_id is None
        assert is_internal is False


class TestEnrichTransaction:
    """Tests for transaction enrichment."""

    def test_enrich_internal_transfer(self):
        """Internal transfer should be marked as transfer type."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)
        session.accounts[2] = Account(id=2, name="Wallet B", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletB", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_transaction_id="0xhash123",
            source_transaction_type="token_transfer",
            source_asset_symbol="ETH",
            source_from_account="0xwalletA",
            source_to_account="0xwalletB",
            quantity=1.0,
            transaction_type="inflow",
            taxable=True,
        )

        enriched = detector.enrich_transaction(tx, "blockscout_base")

        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2
        assert enriched.transaction_type == "transfer"
        assert enriched.taxable is False  # Should be marked non-taxable

    def test_enrich_external_transfer(self):
        """External transfer should NOT be marked as transfer type."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Exchange", owned=False)
        session.accounts[2] = Account(id=2, name="My Wallet", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xexchange", 1)
        mock_repo.add_mapping("blockscout_base", "0xmywallet", 2)

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        tx = make_tx(
            source="blockscout_base",
            source_transaction_id="0xhash456",
            source_transaction_type="token_transfer",
            source_asset_symbol="ETH",
            source_from_account="0xexchange",
            source_to_account="0xmywallet",
            quantity=2.0,
            transaction_type="inflow",
            taxable=True,
        )

        enriched = detector.enrich_transaction(tx, "blockscout_base")

        assert enriched.from_account_id == 1
        assert enriched.to_account_id == 2
        # Should NOT be changed to transfer type (external transfer)
        assert enriched.transaction_type == "inflow"
        assert enriched.taxable is True

    def test_enrich_no_addresses(self):
        """Transaction without addresses should pass through unchanged."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        detector = TransferDetector(session)
        detector.raw_account_repo = MockRawAccountRepository()

        tx = make_tx(
            source="binance",
            source_transaction_id="123",
            source_transaction_type="buy",
            source_asset_symbol="BTC",
            quantity=1.0,
            transaction_type="inflow",
        )

        enriched = detector.enrich_transaction(tx, "binance")

        assert enriched.from_account_id is None
        assert enriched.to_account_id is None
        assert enriched.transaction_type == "inflow"


class TestCaching:
    """Tests for account ownership caching."""

    def test_cache_hit_for_repeated_lookups(self):
        """Repeated lookups for same account should use cache."""
        from backend.services.transfer_detector import TransferDetector

        session = MockSession()
        session.accounts[1] = Account(id=1, name="Wallet A", owned=True)

        mock_repo = MockRawAccountRepository()
        mock_repo.add_mapping("blockscout_base", "0xwalletA", 1)
        mock_repo.add_mapping("blockscout_base", "0xwalletA2", 1)  # Same account

        detector = TransferDetector(session)
        detector.raw_account_repo = mock_repo

        # First lookup - populates cache
        account_id1, owned1 = detector.resolve_account("blockscout_base", "0xwalletA")

        # Second lookup - should use cache
        account_id2, owned2 = detector.resolve_account("blockscout_base", "0xwalletA2")

        assert account_id1 == 1
        assert owned1 is True
        assert account_id2 == 1
        assert owned2 is True

        # Verify cache was used (account should be in cache)
        assert 1 in detector._account_owned_cache
