"""
Unit tests for DeGiro Account File connector — FX tags enrichment on dividends
and cash-in-lieu attribution.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timezone

from backend.connectors.cex.connector_degiro_account_file import DeGiroAccountFileConnector
from backend.file_loaders.degiro_account_loader import AccountRowType


def _make_dividend_raw(**overrides) -> dict:
    """Build a minimal raw dividend row for normalization."""
    base = {
        "datetime": datetime(2025, 1, 2, 8, 30, tzinfo=timezone.utc),
        "date": "02-01-2025",
        "time": "08:30",
        "value_date": "02-01-2025",
        "product": "MICROSOFT CORP",
        "isin": "US5949181045",
        "description": "Dividende",
        "order_id": "",
        "change": "3,57",
        "change_decimal": Decimal("3.57"),
        "currency": "USD",
        "_row_type": AccountRowType.DIVIDEND,
        "_generated_id": "test-div-001",
        "withholding_amount": Decimal("1.07"),
        "withholding_jurisdiction": "US",
    }
    base.update(overrides)
    return base


class TestNormalizeDividendFxTags:

    @pytest.fixture
    def connector(self):
        return DeGiroAccountFileConnector(
            account_id=1,
            connector_id=1,
            config={"file_path": "/tmp/test.csv"},
        )

    def test_dividend_with_fx_data(self, connector):
        """When raw row has FX data, all FX tags should be present."""
        raw = _make_dividend_raw(
            fx_rate=Decimal("1.0850"),
            fx_net_amount_base=Decimal("2.30"),
            fx_base_currency="EUR",
        )
        tx = connector.raw_to_normalized(raw)

        # Flatten tags for easy assertion
        flat = {}
        for t in tx.tags:
            flat.update(t)

        # WHT tags
        assert flat["withholding_amount"] == "1.07"
        assert flat["withholding_jurisdiction"] == "US"
        assert "withholding_rate" in flat

        # FX tags
        assert flat["fx_rate"] == "1.0850"
        assert flat["net_amount_base"] == "2.30"
        assert flat["base_currency"] == "EUR"

        # Source currency/amount tags (always present)
        assert flat["source_currency"] == "USD"
        assert flat["gross_amount_source"] == "3.57"
        assert flat["wht_amount_source"] == "1.07"

    def test_dividend_without_fx_data(self, connector):
        """When raw row has no FX data, only WHT + source tags present."""
        raw = _make_dividend_raw()  # No fx_rate, fx_net_amount_base, fx_base_currency
        tx = connector.raw_to_normalized(raw)

        flat = {}
        for t in tx.tags:
            flat.update(t)

        # WHT tags present
        assert flat["withholding_amount"] == "1.07"
        assert flat["withholding_jurisdiction"] == "US"

        # FX tags absent
        assert "fx_rate" not in flat
        assert "net_amount_base" not in flat
        assert "base_currency" not in flat

        # Source currency/amount always present
        assert flat["source_currency"] == "USD"
        assert flat["gross_amount_source"] == "3.57"
        assert flat["wht_amount_source"] == "1.07"

    def test_dividend_no_withholding(self, connector):
        """Dividend without withholding → no WHT tags, only source tags."""
        raw = _make_dividend_raw(
            withholding_amount=Decimal("0"),
            withholding_jurisdiction=None,
        )
        tx = connector.raw_to_normalized(raw)

        flat = {}
        for t in tx.tags:
            flat.update(t)

        assert "withholding_amount" not in flat
        assert "withholding_jurisdiction" not in flat
        assert "wht_amount_source" not in flat
        assert flat["source_currency"] == "USD"
        assert flat["gross_amount_source"] == "3.57"

    def test_eur_dividend_no_fx(self, connector):
        """EUR dividend (same currency) → source_currency is EUR, no FX tags."""
        raw = _make_dividend_raw(
            currency="EUR",
            change_decimal=Decimal("5.20"),
            withholding_amount=Decimal("1.04"),
            withholding_jurisdiction="NL",
            isin="NL0010273215",
            product="ASML HOLDING",
        )
        tx = connector.raw_to_normalized(raw)

        flat = {}
        for t in tx.tags:
            flat.update(t)

        assert flat["source_currency"] == "EUR"
        assert flat["gross_amount_source"] == "5.20"
        assert "fx_rate" not in flat


# ---------------------------------------------------------------------------
# Helper: Build a minimal raw cash-in-lieu row
# ---------------------------------------------------------------------------

def _make_cash_in_lieu_raw(**overrides) -> dict:
    """Build a minimal raw cash-in-lieu row for normalization."""
    base = {
        "datetime": datetime(2025, 4, 7, 14, 34, tzinfo=timezone.utc),
        "date": "07-04-2025",
        "time": "14:34",
        "value_date": "01-04-2025",
        "product": "APTIV PLC",
        "isin": "JE00BTDN8H13",
        "description": "Règlement espèces - Action",
        "order_id": "",
        "change": "9,30",
        "change_decimal": Decimal("9.30"),
        "currency": "USD",
        "_row_type": AccountRowType.CASH_IN_LIEU,
        "_generated_id": "test-cil-001",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Tests: Cash-in-lieu attribution
# ---------------------------------------------------------------------------

class TestNormalizeCashInLieuAttribution:

    @pytest.fixture
    def connector(self):
        return DeGiroAccountFileConnector(
            account_id=1,
            connector_id=1,
            config={"file_path": "/tmp/test.csv"},
        )

    def test_attributed_asset_set_from_isin_and_product(self, connector):
        """Cash-in-lieu with ISIN + product → source_attributed_asset_symbol set."""
        raw = _make_cash_in_lieu_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.source_attributed_asset_symbol == "APTIV PLC (JE00BTDN8H13)"

    def test_attributed_asset_none_when_no_isin(self, connector):
        """Cash-in-lieu without ISIN → source_attributed_asset_symbol is None."""
        raw = _make_cash_in_lieu_raw(isin=None, product=None)
        tx = connector.raw_to_normalized(raw)
        assert tx.source_attributed_asset_symbol is None

    def test_corporate_action_tag_present(self, connector):
        """Cash-in-lieu always has corporate_action source tag."""
        raw = _make_cash_in_lieu_raw()
        tx = connector.raw_to_normalized(raw)
        flat = {}
        for t in tx.tags:
            flat.update(t)
        assert flat["source"] == "corporate_action"

    def test_isin_tag_present(self, connector):
        """Cash-in-lieu with ISIN → isin tag present."""
        raw = _make_cash_in_lieu_raw()
        tx = connector.raw_to_normalized(raw)
        flat = {}
        for t in tx.tags:
            flat.update(t)
        assert flat["isin"] == "JE00BTDN8H13"

    def test_isin_tag_absent_when_no_isin(self, connector):
        """Cash-in-lieu without ISIN → no isin tag."""
        raw = _make_cash_in_lieu_raw(isin=None, product=None)
        tx = connector.raw_to_normalized(raw)
        flat = {}
        for t in tx.tags:
            flat.update(t)
        assert "isin" not in flat
        assert flat["source"] == "corporate_action"

    def test_transaction_type_is_trade(self, connector):
        """Cash-in-lieu normalizes as trade (forced disposal)."""
        raw = _make_cash_in_lieu_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.transaction_type == "trade"
        assert tx.source_transaction_type == "cash_in_lieu"

    def test_direction_is_inflow(self, connector):
        """Cash-in-lieu is an inflow of cash."""
        raw = _make_cash_in_lieu_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.direction == "inflow"
        assert tx.quantity == 9.30


# ---------------------------------------------------------------------------
# Helper: Build a minimal raw fee row
# ---------------------------------------------------------------------------

def _make_fee_raw(**overrides) -> dict:
    """Build a minimal raw exchange fee row for normalization."""
    base = {
        "datetime": datetime(2025, 3, 1, 10, 0, tzinfo=timezone.utc),
        "date": "01-03-2025",
        "time": "10:00",
        "value_date": "01-03-2025",
        "product": "",
        "isin": "",
        "description": "Frais de connexion à la bourse 2025",
        "order_id": "",
        "change": "-2,50",
        "change_decimal": Decimal("-2.50"),
        "currency": "EUR",
        "_row_type": AccountRowType.EXCHANGE_FEE,
        "_generated_id": "test-fee-001",
    }
    base.update(overrides)
    return base


def _make_adr_fee_raw(**overrides) -> dict:
    """Build a minimal raw ADR custody fee row for normalization."""
    base = {
        "datetime": datetime(2025, 4, 15, 8, 0, tzinfo=timezone.utc),
        "date": "15-04-2025",
        "time": "08:00",
        "value_date": "15-04-2025",
        "product": "APTIV PLC",
        "isin": "JE00BTDN8H13",
        "description": "Frais ADR/GDR",
        "order_id": "",
        "change": "-0,01",
        "change_decimal": Decimal("-0.01"),
        "currency": "USD",
        "_row_type": AccountRowType.ADR_FEE,
        "_generated_id": "test-adr-001",
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Tests: COST transactions no longer set source_asset_symbol
# ---------------------------------------------------------------------------

class TestCostTransactionNoSourceAsset:
    """Verify broker fee COST txs use new format (qty=fee, price=1, price_quote=currency)."""

    @pytest.fixture
    def connector(self):
        return DeGiroAccountFileConnector(
            account_id=1, raw_file_id=1, connector_name="degiro-test",
        )

    def test_exchange_fee_no_source_asset_symbol(self, connector):
        """Exchange fee should not set source_asset_symbol."""
        raw = _make_fee_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.transaction_type == "cost"
        assert tx.source_asset_symbol == ""

    def test_adr_fee_no_source_asset_symbol(self, connector):
        """ADR custody fee should not set source_asset_symbol."""
        raw = _make_adr_fee_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.transaction_type == "cost"
        assert tx.source_asset_symbol == ""

    def test_adr_fee_attributed_asset_still_set(self, connector):
        """ADR fee should still have source_attributed_asset_symbol."""
        raw = _make_adr_fee_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.source_attributed_asset_symbol == "APTIV PLC (JE00BTDN8H13)"

    def test_exchange_fee_new_format(self, connector):
        """Exchange fee uses new COST format: qty=fee_amount, price=1, price_quote=currency."""
        raw = _make_fee_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.quantity == 2.50
        assert tx.price == 1.0
        assert tx.source_price_quote_asset_symbol == "EUR"
        assert tx.direction == "outflow"
        assert tx.include_fee is False

    def test_adr_fee_new_format(self, connector):
        """ADR fee uses new COST format: qty=fee_amount, price=1, price_quote=currency."""
        raw = _make_adr_fee_raw()
        tx = connector.raw_to_normalized(raw)
        assert tx.quantity == 0.01
        assert tx.price == 1.0
        assert tx.source_price_quote_asset_symbol == "USD"
        assert tx.direction == "outflow"
        assert tx.include_fee is False
