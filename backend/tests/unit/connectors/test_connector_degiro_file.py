"""
Unit tests for DeGiro file connector (connector_degiro_file.py).
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
import pandas as pd

from backend.connectors.cex.connector_degiro_file import DeGiroFileConnector
from backend.db.models import NormalizedTransaction


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_raw(
    isin="US76655K1034",
    product="RIGETTI COMPUTING INC",
    quantity=14.0,
    price=42.385,
    price_currency="USD",
    fee=0.39,
    total_eur=548.66,
    direction="buy",
    order_id="baa19ae8-1111-2222-3333-444455556666",
    dt=None,
    generated_id=None,
):
    return {
        "datetime": dt or datetime(2025, 10, 31, 16, 51, tzinfo=timezone.utc),
        "product": product,
        "isin": isin,
        "exchange": "NDQ",
        "venue": "CDED",
        "quantity": quantity,
        "price": price,
        "price_currency": price_currency,
        "local_value": -593.39,
        "value_eur": -548.27,
        "exchange_rate": 0.9239,
        "autofx_fee": 0.0,
        "transaction_fee": 0.39,
        "fee": fee,
        "total_eur": total_eur,
        "order_id": order_id,
        "direction": direction,
        "_generated_id": generated_id or "abc123def456abc123def456abc12345",
    }


def _make_connector(**kwargs):
    config = kwargs.pop("config", {})
    defaults = {
        "account_id": 1,
        "connector_id": 10,
        "config": {
            "file_path": "/tmp/test_degiro.csv",
            "_account_id": 1,
            "_account_name": "degiro-test",
            "_account_address_or_identifier": "degiro_main",
            **config,
        },
    }
    defaults.update(kwargs)
    return DeGiroFileConnector(**defaults)


# ---------------------------------------------------------------------------
# Tests: connector identity
# ---------------------------------------------------------------------------


class TestConnectorIdentity:

    def test_connector_name(self):
        connector = _make_connector()
        assert connector.connector_name == "degiro_file"

    def test_initialization_with_config(self):
        connector = _make_connector()
        assert connector._file_path == "/tmp/test_degiro.csv"

    def test_initialization_without_file_path(self):
        connector = DeGiroFileConnector(account_id=1, config={})
        assert connector._file_path is None


# ---------------------------------------------------------------------------
# Tests: raw_to_normalized
# ---------------------------------------------------------------------------


class TestRawToNormalized:

    def test_buy_trade(self):
        """Buy trade should produce inflow NormalizedTransaction."""
        connector = _make_connector()
        raw = _make_raw(direction="buy")
        result = connector.raw_to_normalized(raw)

        assert isinstance(result, NormalizedTransaction)
        assert result.source == "degiro-file"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "buy"
        assert result.transaction_type == "trade"
        assert result.source_asset_symbol == "RIGETTI COMPUTING INC (US76655K1034)"
        assert result.source_price_quote_asset_symbol == "EUR"
        assert float(result.quantity) == pytest.approx(14.0)
        # price = total_eur / qty = 548.66 / 14.0 (total includes fees)
        assert float(result.price) == pytest.approx(548.66 / 14.0, abs=1e-2)

    def test_sell_trade(self):
        """Sell trade should produce outflow NormalizedTransaction."""
        connector = _make_connector()
        raw = _make_raw(direction="sell", quantity=10.0)
        result = connector.raw_to_normalized(raw)

        assert result.direction == "outflow"
        assert result.source_transaction_type == "sell"

    def test_fee_in_eur(self):
        """Fee should be in EUR."""
        connector = _make_connector()
        raw = _make_raw(fee=3.29)
        result = connector.raw_to_normalized(raw)

        assert float(result.fee) == pytest.approx(3.29, abs=1e-2)
        assert result.source_fee_quote_asset_symbol == "EUR"

    def test_zero_fee(self):
        """Zero fee should have empty fee currency."""
        connector = _make_connector()
        raw = _make_raw(fee=0.0)
        result = connector.raw_to_normalized(raw)

        assert float(result.fee) == 0.0
        assert result.source_fee_quote_asset_symbol == ""

    def test_product_isin_as_asset_symbol(self):
        """source_asset_symbol should be 'PRODUCT (ISIN)'."""
        connector = _make_connector()
        raw = _make_raw(isin="NL0010273215", product="ASML HOLDING")
        result = connector.raw_to_normalized(raw)

        assert result.source_asset_symbol == "ASML HOLDING (NL0010273215)"

    def test_missing_product_falls_back_to_isin(self):
        """If product is empty, source_asset_symbol should be just ISIN."""
        connector = _make_connector()
        raw = _make_raw(isin="NL0010273215", product="")
        result = connector.raw_to_normalized(raw)

        assert result.source_asset_symbol == "NL0010273215"

    def test_price_is_total_eur_per_qty(self):
        """Price should be total_eur / quantity, in EUR (fees baked in)."""
        connector = _make_connector()
        raw = _make_raw(quantity=10.0, total_eur=685.40)
        result = connector.raw_to_normalized(raw)

        assert float(result.price) == pytest.approx(68.54, abs=1e-2)
        assert result.source_price_quote_asset_symbol == "EUR"
        assert result.include_fee is False

    def test_transaction_id(self):
        connector = _make_connector()
        raw = _make_raw(generated_id="test_tx_id_12345")
        result = connector.raw_to_normalized(raw)

        assert result.source_transaction_id == "test_tx_id_12345"

    def test_datetime_preserved(self):
        connector = _make_connector()
        dt = datetime(2025, 1, 15, 9, 30, tzinfo=timezone.utc)
        raw = _make_raw(dt=dt)
        result = connector.raw_to_normalized(raw)

        assert result.date_time == dt

    def test_content_hash_present(self):
        connector = _make_connector()
        raw = _make_raw()
        result = connector.raw_to_normalized(raw)

        assert result.content_hash is not None
        assert len(result.content_hash) > 0

    def test_account_id(self):
        connector = _make_connector(account_id=42)
        raw = _make_raw()
        result = connector.raw_to_normalized(raw)

        assert result.account_id == 42

    def test_missing_isin_raises(self):
        connector = _make_connector()
        raw = _make_raw(isin="")
        with pytest.raises(ValueError, match="ISIN"):
            connector.raw_to_normalized(raw)

    def test_pandas_timestamp(self):
        """Should handle pandas Timestamp datetime values."""
        connector = _make_connector()
        raw = _make_raw(dt=pd.Timestamp("2025-10-31 16:51:00+00:00"))
        result = connector.raw_to_normalized(raw)

        assert result.date_time.year == 2025
        assert result.date_time.month == 10


# ---------------------------------------------------------------------------
# Tests: yield_raws
# ---------------------------------------------------------------------------


class TestYieldRaws:

    @patch("backend.file_loaders.degiro_loader.load_degiro_file")
    def test_yields_correct_count(self, mock_loader):
        """yield_raws should yield one dict per DataFrame row."""
        mock_loader.return_value = pd.DataFrame([
            _make_raw(),
            _make_raw(isin="NL0010273215", product="ASML"),
        ])
        connector = _make_connector()
        # Clear cached data so it calls the loader
        connector._cached_data = None
        raws = list(connector.yield_raws())
        assert len(raws) == 2

    @patch("backend.file_loaders.degiro_loader.load_degiro_file")
    def test_generated_id_added(self, mock_loader):
        """Each yielded raw should have _generated_id set."""
        mock_loader.return_value = pd.DataFrame([_make_raw()])
        connector = _make_connector()
        connector._cached_data = None
        raws = list(connector.yield_raws())
        assert "_generated_id" in raws[0]
        assert raws[0]["_generated_id"]  # non-empty

    @patch("backend.file_loaders.degiro_loader.load_degiro_file")
    def test_empty_file(self, mock_loader):
        mock_loader.return_value = pd.DataFrame()
        connector = _make_connector()
        connector._cached_data = None
        raws = list(connector.yield_raws())
        assert len(raws) == 0

    def test_no_file_path_raises(self):
        connector = DeGiroFileConnector(account_id=1, config={})
        with pytest.raises(ValueError, match="[Nn]o file"):
            list(connector.yield_raws())
