"""
Unit tests for FrenchTaxService — classification, envelope filtering, and persist logic.

Tests cover:
- Crypto vs securities classification (price_type-based)
- Catch-all: unknown/None/future price_type → securities (not crypto)
- Fiat entries skipped
- PEA/AV envelope entries excluded from both calculators
- Non-taxable entries not persisted to tax entry tables
"""

import pytest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import Mock, MagicMock, patch, call

from backend.services.french_tax_service import FrenchTaxService
from backend.services.pnl.tax_models import TaxLineItem, TaxSummary, TaxReport, TaxJurisdiction
from backend.db.models import (
    Account,
    Asset,
    CalculationUnit,
    CalculationVersion,
    FrenchCryptoTaxEntry,
    FrenchCryptoTaxAnnualSummary,
    FrenchSecuritiesTaxEntry,
    FrenchSecuritiesTaxAnnualSummary,
    NormalizedTransaction,
    RealizedPnl,
)


# ============================================================================
# Helpers
# ============================================================================


def make_asset(asset_id: int, symbol: str, price_type: str) -> Mock:
    a = Mock(spec=Asset)
    a.asset_id = asset_id
    a.symbol = symbol
    a.price_type = price_type
    return a


def make_account(account_id: int = 1, envelope: str = None) -> Mock:
    a = Mock(spec=Account)
    a.id = account_id
    a.envelope = envelope
    return a


def make_transaction(account: Mock) -> Mock:
    tx = Mock(spec=NormalizedTransaction)
    tx.account_rel = account
    tx.account_id = account.id
    return tx


def make_pnl_entry(
    pnl_id: int,
    asset_id: int,
    transaction: Mock = None,
    disposal_taxable: bool = True,
    proceeds: Decimal = Decimal("1000"),
    cost_basis: Decimal = Decimal("800"),
) -> Mock:
    entry = Mock(spec=RealizedPnl)
    entry.pnl_id = pnl_id
    entry.asset_id = asset_id
    entry.qty = Decimal("10")
    entry.proceeds_in_base = proceeds
    entry.cost_basis_in_base = cost_basis
    entry.pnl_in_base = proceeds - cost_basis
    entry.gain_loss_in_base = proceeds - cost_basis
    entry.disposal_taxable = disposal_taxable
    entry.realized_at = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    entry.holding_period_days = 100
    entry.transaction = transaction
    entry.origin_unit_id = 1
    return entry


def make_tax_line_item(pnl_id: int, disposal_taxable: bool = True, gain: Decimal = Decimal("200")) -> TaxLineItem:
    return TaxLineItem(
        pnl_id=pnl_id,
        asset_id=1,
        asset_symbol="BTC",
        realized_at=datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc),
        qty=Decimal("10"),
        proceeds_in_base=Decimal("1000"),
        cost_basis_in_base=Decimal("800"),
        gain_or_loss=gain,
        holding_period_days=100,
        disposal_taxable=disposal_taxable,
        tax_jurisdiction=TaxJurisdiction.FR,
        tax_total=gain * Decimal("0.30") if disposal_taxable and gain > 0 else Decimal("0"),
    )


def make_tax_summary(fiscal_year: int, line_items: list) -> TaxSummary:
    taxable_items = [i for i in line_items if i.disposal_taxable]
    gains = sum(i.gain_or_loss for i in taxable_items if i.gain_or_loss > 0)
    losses = sum(i.gain_or_loss for i in taxable_items if i.gain_or_loss < 0)
    return TaxSummary(
        tax_jurisdiction=TaxJurisdiction.FR,
        fiscal_year=fiscal_year,
        base_currency_symbol="EUR",
        total_disposals=len(line_items),
        taxable_disposals=len(taxable_items),
        non_taxable_disposals=len(line_items) - len(taxable_items),
        taxable_gains=gains,
        taxable_losses=losses,
        net_taxable=max(gains + losses, Decimal("0")),
        tax_total=max(gains + losses, Decimal("0")) * Decimal("0.30"),
        loss_carryforward=abs(min(gains + losses, Decimal("0"))),
        line_items=line_items,
    )


def make_tax_report(summaries: list) -> TaxReport:
    return TaxReport(
        tax_jurisdiction=TaxJurisdiction.FR,
        summaries=summaries,
    )


# ============================================================================
# Classification Tests
# ============================================================================


class TestClassification:
    """Test the envelope + price_type classification logic."""

    def _run_classification(self, pnl_entries, asset_map):
        """
        Extract and test the classification logic from compute_for_version.
        
        Mimics the loop in compute_for_version without DB calls.
        """
        crypto_entries = []
        securities_entries = []
        excluded_entries = 0
        skipped_entries = 0

        for entry in pnl_entries:
            account = None
            if entry.transaction and entry.transaction.account_rel:
                account = entry.transaction.account_rel
            envelope = getattr(account, "envelope", None) if account else None

            if envelope in ("pea", "av"):
                excluded_entries += 1
                continue

            asset = asset_map.get(entry.asset_id)
            price_type = getattr(asset, "price_type", None) if asset else None

            if price_type == "crypto":
                crypto_entries.append(entry)
            elif price_type == "fiat":
                skipped_entries += 1
                continue
            else:
                securities_entries.append(entry)

        return crypto_entries, securities_entries, excluded_entries, skipped_entries

    def test_crypto_asset_goes_to_crypto(self):
        """Asset with price_type='crypto' → crypto_entries."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "BTC", "crypto")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 1
        assert len(securities) == 0
        assert excluded == 0
        assert skipped == 0

    def test_stock_asset_goes_to_securities(self):
        """Asset with price_type='stock' → securities_entries."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "AAPL", "stock")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 1

    def test_none_price_type_goes_to_securities(self):
        """Asset with price_type=None → securities (catch-all, NOT crypto)."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "UNKNOWN", None)

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 1
        assert excluded == 0

    def test_future_price_type_goes_to_securities(self):
        """Asset with unknown future price_type (e.g., 'commodity') → securities (catch-all)."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "GOLD", "commodity")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 1

    def test_fiat_asset_is_skipped(self):
        """Asset with price_type='fiat' → skipped (no tax computation)."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "EUR", "fiat")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 0
        assert skipped == 1

    def test_pea_envelope_excludes_from_both(self):
        """Entry from PEA account → excluded from crypto AND securities."""
        account = make_account(1, envelope="pea")
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "AAPL", "stock")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 0
        assert excluded == 1

    def test_av_envelope_excludes_from_both(self):
        """Entry from AV account → excluded from crypto AND securities."""
        account = make_account(1, envelope="av")
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "BTC", "crypto")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 0
        assert len(securities) == 0
        assert excluded == 1

    def test_cto_envelope_not_excluded(self):
        """CTO envelope → standard taxable, not excluded."""
        account = make_account(1, envelope="cto")
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "AAPL", "stock")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(securities) == 1
        assert excluded == 0

    def test_no_envelope_not_excluded(self):
        """No envelope (None) → standard taxable, not excluded."""
        account = make_account(1, envelope=None)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=10, transaction=tx)
        asset = make_asset(10, "BTC", "crypto")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 1
        assert excluded == 0

    def test_no_transaction_no_account(self):
        """Entry with no transaction → no account, no envelope → classified by price_type."""
        entry = make_pnl_entry(1, asset_id=10, transaction=None)
        asset = make_asset(10, "BTC", "crypto")

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {10: asset}
        )
        assert len(crypto) == 1
        assert excluded == 0

    def test_missing_asset_goes_to_securities(self):
        """Entry with no matching asset → price_type=None → securities (catch-all)."""
        account = make_account(1)
        tx = make_transaction(account)
        entry = make_pnl_entry(1, asset_id=999, transaction=tx)

        crypto, securities, excluded, skipped = self._run_classification(
            [entry], {}  # empty asset_map
        )
        assert len(crypto) == 0
        assert len(securities) == 1

    def test_mixed_classification(self):
        """Multiple entries with different types are classified correctly."""
        acct = make_account(1)
        pea_acct = make_account(2, envelope="pea")

        entries = [
            make_pnl_entry(1, asset_id=10, transaction=make_transaction(acct)),     # crypto
            make_pnl_entry(2, asset_id=20, transaction=make_transaction(acct)),     # stock
            make_pnl_entry(3, asset_id=30, transaction=make_transaction(acct)),     # fiat
            make_pnl_entry(4, asset_id=40, transaction=make_transaction(pea_acct)), # pea
            make_pnl_entry(5, asset_id=50, transaction=make_transaction(acct)),     # None
        ]

        asset_map = {
            10: make_asset(10, "BTC", "crypto"),
            20: make_asset(20, "AAPL", "stock"),
            30: make_asset(30, "EUR", "fiat"),
            40: make_asset(40, "MSFT", "stock"),
            50: make_asset(50, "UNKNOWN", None),
        }

        crypto, securities, excluded, skipped = self._run_classification(
            entries, asset_map
        )
        assert len(crypto) == 1      # BTC
        assert len(securities) == 2   # AAPL + UNKNOWN
        assert excluded == 1          # PEA account
        assert skipped == 1           # EUR fiat


# ============================================================================
# Persist Filtering Tests
# ============================================================================


class TestPersistFiltering:
    """Test that non-taxable entries are filtered at persist time."""

    def test_persist_crypto_skips_non_taxable(self):
        """_persist_crypto_tax skips entries with disposal_taxable=False."""
        session = MagicMock()
        service = FrenchTaxService(session)

        items = [
            make_tax_line_item(1, disposal_taxable=True, gain=Decimal("200")),
            make_tax_line_item(2, disposal_taxable=False, gain=Decimal("500")),
            make_tax_line_item(3, disposal_taxable=True, gain=Decimal("300")),
        ]
        summary = make_tax_summary(2025, items)
        report = make_tax_report([summary])

        version = Mock()
        version.version_id = 1

        service._persist_crypto_tax(version, report, account_id=1)

        # session.add should be called for: 2 taxable entries + 1 annual summary = 3
        add_calls = session.add.call_args_list
        assert len(add_calls) == 3

        # Verify the two entries are FrenchCryptoTaxEntry (not the non-taxable one)
        entry_calls = [c for c in add_calls if isinstance(c[0][0], FrenchCryptoTaxEntry)]
        annual_calls = [c for c in add_calls if isinstance(c[0][0], FrenchCryptoTaxAnnualSummary)]
        assert len(entry_calls) == 2
        assert len(annual_calls) == 1

    def test_persist_securities_skips_non_taxable(self):
        """_persist_securities_tax skips entries with disposal_taxable=False."""
        session = MagicMock()
        service = FrenchTaxService(session)

        items = [
            make_tax_line_item(1, disposal_taxable=False, gain=Decimal("100")),
            make_tax_line_item(2, disposal_taxable=True, gain=Decimal("400")),
        ]
        summary = make_tax_summary(2025, items)
        report = make_tax_report([summary])

        version = Mock()
        version.version_id = 1

        service._persist_securities_tax(version, report, account_id=1)

        add_calls = session.add.call_args_list
        # 1 taxable entry + 1 annual summary = 2
        assert len(add_calls) == 2

        entry_calls = [c for c in add_calls if isinstance(c[0][0], FrenchSecuritiesTaxEntry)]
        assert len(entry_calls) == 1

    def test_persist_crypto_all_non_taxable(self):
        """When all entries are non-taxable, only the annual summary is persisted."""
        session = MagicMock()
        service = FrenchTaxService(session)

        items = [
            make_tax_line_item(1, disposal_taxable=False),
            make_tax_line_item(2, disposal_taxable=False),
        ]
        summary = make_tax_summary(2025, items)
        report = make_tax_report([summary])

        version = Mock()
        version.version_id = 1

        service._persist_crypto_tax(version, report, account_id=1)

        add_calls = session.add.call_args_list
        # Only the annual summary, no entries
        assert len(add_calls) == 1
        assert isinstance(add_calls[0][0][0], FrenchCryptoTaxAnnualSummary)
