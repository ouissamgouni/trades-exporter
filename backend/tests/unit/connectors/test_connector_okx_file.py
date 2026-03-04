"""
Unit tests for OKX unified file connector (connector_okx_file.py).
"""

import pytest
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock
import pandas as pd

from backend.connectors.cex.connector_okx_file import OKXFileConnector
from backend.db.models import NormalizedTransaction


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_trade_raw(
    transaction_id="123456",
    symbol="USDC-EUR",
    base_asset="USDC",
    quantity=16.1864,
    price=0.8706,
    quote_asset="EUR",
    total=14.09188855,
    fee=0.0,
    fee_currency="USDC",
    tags=None,
    dt=None,
):
    return {
        "datetime": dt or pd.Timestamp("2025-10-12 10:55:44+00:00"),
        "row_type": "trade",
        "transaction_id": transaction_id,
        "symbol": symbol,
        "base_asset": base_asset,
        "quantity": quantity,
        "price": price,
        "quote_asset": quote_asset,
        "total": total,
        "fee": fee,
        "fee_currency": fee_currency,
        "tags": tags or {},
    }


def _make_transfer_raw(
    transaction_id="789012",
    transfer_type="deposit",
    currency="EUR",
    amount=500.0,
    dt=None,
):
    return {
        "datetime": dt or pd.Timestamp("2025-10-11 23:50:46+00:00"),
        "row_type": "transfer",
        "transaction_id": transaction_id,
        "transfer_type": transfer_type,
        "currency": currency,
        "amount": amount,
        "fee": 0.0,
        "symbol": "",
        "base_asset": "",
        "quantity": 0.0,
        "price": 0.0,
        "quote_asset": "",
        "total": 0.0,
        "fee_currency": currency,
        "tags": {},
    }


def _make_connector(**kwargs):
    config = kwargs.pop("config", {})
    defaults = {
        "account_id": 1,
        "connector_id": 10,
        "config": {
            "file_path": "/tmp/test.csv",
            "_account_id": 1,
            "_account_name": "okx-test",
            "_account_address_or_identifier": "okx_main",
            **config,
        },
    }
    defaults.update(kwargs)
    return OKXFileConnector(**defaults)


# ---------------------------------------------------------------------------
# Tests: connector identity
# ---------------------------------------------------------------------------


class TestConnectorIdentity:

    def test_connector_name(self):
        connector = _make_connector()
        assert connector.connector_name == "okx_file"

    def test_initialization_with_config(self):
        connector = _make_connector()
        assert connector._file_path == "/tmp/test.csv"

    def test_initialization_without_file_path(self):
        connector = OKXFileConnector(account_id=1, config={})
        assert connector._file_path is None


# ---------------------------------------------------------------------------
# Tests: trade normalization
# ---------------------------------------------------------------------------


class TestNormalizeTrade:

    def test_regular_trade(self):
        """Regular trade should produce inflow/buy NormalizedTransaction."""
        connector = _make_connector()
        raw = _make_trade_raw()
        result = connector.raw_to_normalized(raw)

        assert isinstance(result, NormalizedTransaction)
        assert result.source == "okx-file"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "buy"
        assert result.transaction_type == "trade"
        assert result.source_asset_symbol == "USDC"
        assert result.source_price_quote_asset_symbol == "EUR"
        assert float(result.quantity) == pytest.approx(16.1864, abs=1e-4)
        assert float(result.price) == pytest.approx(0.8706, abs=1e-4)
        assert result.source_transaction_id == "123456"

    def test_convert_trade(self):
        """Convert trade should have tags={'type': 'convert'}."""
        connector = _make_connector()
        raw = _make_trade_raw(
            symbol="BTC-EUR-CONVERT",
            base_asset="BTC",
            quantity=0.01227261,
            price=101852.817,
            total=1250.0,
            tags={"type": "convert"},
        )
        result = connector.raw_to_normalized(raw)

        assert result.tags == [{"type": "convert"}]
        assert result.source_asset_symbol == "BTC"
        assert result.transaction_type == "trade"

    def test_trade_with_fee(self):
        """Trade with fee should carry fee correctly."""
        connector = _make_connector()
        raw = _make_trade_raw(fee=0.00027391, fee_currency="ETH")
        result = connector.raw_to_normalized(raw)

        assert float(result.fee) == pytest.approx(0.00027391, abs=1e-8)
        assert result.source_fee_quote_asset_symbol == "ETH"

    def test_missing_transaction_id_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw(transaction_id="")
        with pytest.raises(ValueError, match="transaction_id"):
            connector.raw_to_normalized(raw)

    def test_missing_base_asset_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw(base_asset="")
        with pytest.raises(ValueError, match="base_asset"):
            connector.raw_to_normalized(raw)

    def test_missing_quote_asset_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw(quote_asset="")
        with pytest.raises(ValueError, match="quote_asset"):
            connector.raw_to_normalized(raw)

    def test_missing_quantity_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw()
        raw["quantity"] = None
        with pytest.raises(ValueError, match="quantity"):
            connector.raw_to_normalized(raw)

    def test_missing_price_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw()
        raw["price"] = None
        with pytest.raises(ValueError, match="price"):
            connector.raw_to_normalized(raw)

    def test_missing_total_raises(self):
        connector = _make_connector()
        raw = _make_trade_raw()
        raw["total"] = None
        with pytest.raises(ValueError, match="total"):
            connector.raw_to_normalized(raw)

    def test_all_trades_are_inflow_buy(self):
        """All trade rows should be direction=inflow, source_transaction_type=buy."""
        connector = _make_connector()
        for raw in [
            _make_trade_raw(transaction_id="1"),
            _make_trade_raw(transaction_id="2", symbol="BTC-EUR-CONVERT", tags={"type": "convert"}),
            _make_trade_raw(transaction_id="3", base_asset="ETH"),
        ]:
            result = connector.raw_to_normalized(raw)
            assert result.direction == "inflow"
            assert result.source_transaction_type == "buy"


# ---------------------------------------------------------------------------
# Tests: transfer normalization
# ---------------------------------------------------------------------------


class TestNormalizeTransfer:

    def test_deposit(self):
        """Deposit should produce inflow/transfer with to_account set."""
        connector = _make_connector()
        raw = _make_transfer_raw(transfer_type="deposit")
        result = connector.raw_to_normalized(raw)

        assert isinstance(result, NormalizedTransaction)
        assert result.source == "okx-file"
        assert result.direction == "inflow"
        assert result.source_transaction_type == "deposit"
        assert result.transaction_type == "transfer"
        assert result.source_asset_symbol == "EUR"
        assert float(result.quantity) == pytest.approx(500.0, abs=1e-4)
        assert result.source_to_account == "okx_main"
        assert result.to_account_id == 1
        assert result.source_from_account is None
        assert result.from_account_id is None

    def test_withdrawal(self):
        """Withdrawal should produce outflow/transfer with from_account set."""
        connector = _make_connector()
        raw = _make_transfer_raw(
            transfer_type="withdrawal",
            currency="USDC",
            amount=575.033331,
        )
        result = connector.raw_to_normalized(raw)

        assert result.direction == "outflow"
        assert result.source_transaction_type == "withdrawal"
        assert result.transaction_type == "transfer"
        assert result.source_asset_symbol == "USDC"
        assert float(result.quantity) == pytest.approx(575.033331, abs=1e-4)
        assert result.source_from_account == "okx_main"
        assert result.from_account_id == 1
        assert result.source_to_account is None
        assert result.to_account_id is None

    def test_transfer_fee_is_zero(self):
        """Transfer fee should always be 0."""
        connector = _make_connector()
        raw = _make_transfer_raw()
        result = connector.raw_to_normalized(raw)
        assert float(result.fee) == 0.0

    def test_missing_transaction_id_raises(self):
        connector = _make_connector()
        raw = _make_transfer_raw(transaction_id="")
        with pytest.raises(ValueError, match="transaction_id"):
            connector.raw_to_normalized(raw)

    def test_invalid_transfer_type_raises(self):
        connector = _make_connector()
        raw = _make_transfer_raw(transfer_type="unknown")
        with pytest.raises(ValueError, match="transfer_type"):
            connector.raw_to_normalized(raw)

    def test_missing_currency_raises(self):
        connector = _make_connector()
        raw = _make_transfer_raw(currency="")
        with pytest.raises(ValueError, match="currency"):
            connector.raw_to_normalized(raw)


# ---------------------------------------------------------------------------
# Tests: unknown row_type
# ---------------------------------------------------------------------------


class TestUnknownRowType:

    def test_unknown_row_type_raises(self):
        connector = _make_connector()
        raw = {"row_type": "something_else", "datetime": datetime(2025, 1, 1, tzinfo=timezone.utc)}
        with pytest.raises(ValueError, match="Unknown row_type"):
            connector.raw_to_normalized(raw)


# ---------------------------------------------------------------------------
# Tests: datetime parsing
# ---------------------------------------------------------------------------


class TestDatetimeParsing:

    def test_pandas_timestamp(self):
        """Should handle pandas Timestamp."""
        connector = _make_connector()
        raw = _make_trade_raw(dt=pd.Timestamp("2025-10-12 10:55:44+00:00"))
        result = connector.raw_to_normalized(raw)
        assert result.date_time.year == 2025
        assert result.date_time.month == 10
        assert result.date_time.day == 12
        assert result.date_time.tzinfo is not None

    def test_datetime_object(self):
        """Should handle datetime object."""
        connector = _make_connector()
        raw = _make_trade_raw(dt=datetime(2025, 10, 12, 10, 55, 44, tzinfo=timezone.utc))
        result = connector.raw_to_normalized(raw)
        assert result.date_time.hour == 10
        assert result.date_time.tzinfo is not None

    def test_naive_datetime_gets_utc(self):
        """Timezone-naive datetime should get UTC."""
        connector = _make_connector()
        raw = _make_trade_raw(dt=datetime(2025, 10, 12, 10, 55, 44))
        result = connector.raw_to_normalized(raw)
        assert result.date_time.tzinfo == timezone.utc


# ---------------------------------------------------------------------------
# Tests: timezone resolution
# ---------------------------------------------------------------------------


class TestTimezoneResolution:

    def test_explicit_timezone(self):
        """Explicit source_timezone should be used."""
        connector = _make_connector(config={"source_timezone": "Europe/Paris"})
        tz = connector._resolve_timezone()
        assert tz == "Europe/Paris"

    def test_filename_autodetect(self):
        """Should auto-detect timezone from file path."""
        connector = _make_connector(
            config={"file_path": "/tmp/Trading History_2025~2026~UTC+1~abc.csv"}
        )
        # Remove explicit source_timezone
        connector._source_timezone = None
        tz = connector._resolve_timezone()
        assert tz == "UTC+1"

    def test_fallback_none(self):
        """Should return None when no timezone info available."""
        connector = OKXFileConnector(
            account_id=1,
            config={"file_path": "/tmp/some_file.csv"},
        )
        tz = connector._resolve_timezone()
        assert tz is None


# ---------------------------------------------------------------------------
# Tests: yield_raws with mocked loader
# ---------------------------------------------------------------------------


class TestYieldRaws:

    @patch("backend.file_loaders.okx_trading_history_loader.load_okx_trading_history_file")
    def test_yield_raws_trades_and_transfers(self, mock_load):
        """yield_raws should yield all rows from loader."""
        mock_df = pd.DataFrame([
            _make_trade_raw(transaction_id="1"),
            _make_transfer_raw(transaction_id="2"),
        ])
        mock_load.return_value = mock_df

        connector = _make_connector()
        rows = list(connector.yield_raws())

        assert len(rows) == 2
        assert rows[0]["transaction_id"] == "1"
        assert rows[1]["transaction_id"] == "2"

    @patch("backend.file_loaders.okx_trading_history_loader.load_okx_trading_history_file")
    def test_yield_raws_empty(self, mock_load):
        """yield_raws should handle empty DataFrame."""
        mock_load.return_value = pd.DataFrame()

        connector = _make_connector()
        rows = list(connector.yield_raws())

        assert rows == []

    def test_load_without_file_path_raises(self):
        """Loading without file_path should raise ValueError."""
        connector = OKXFileConnector(account_id=1, config={})
        with pytest.raises(ValueError, match="No file uploaded"):
            list(connector.yield_raws())
