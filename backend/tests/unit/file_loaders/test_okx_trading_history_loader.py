"""
Unit tests for OKX Trading History file loader.
"""

import pytest
import pandas as pd
from backend.file_loaders.okx_trading_history_loader import (
    load_okx_trading_history_file,
    get_okx_trading_history_file_preview,
    _parse_filename_timezone,
    _resolve_timezone,
)

# ---------------------------------------------------------------------------
# Sample CSV content
# ---------------------------------------------------------------------------

SAMPLE_CSV = (
    "id,Order id,Time,Trade Type,Symbol,Action,Amount,Trading Unit,"
    "Filled Price,PnL,Fee,Fee Unit,Position Change,Position Balance,"
    "Balance Change,Balance,Balance Unit\n"
    # Transfer out (withdrawal)
    "2944959422929117184,2944959420319404032,2025-10-12 11:37:10,Transfer,,Transfer out,0.0,cont,"
    "0.00000000,0.00000000,0.00000000,USDC,0.00000000,0.00000000,-575.03333100,0.00000000,USDC\n"
    # Spot sell leg (fiat, should be filtered out: Balance Unit == Trading Unit)
    "2944876033488265220,2944876033454710784,2025-10-12 10:55:44,Spot,USDC-EUR,Sell,14.09188855,EUR,"
    "0.87060000,0.00000000,0.00000000,EUR,0.00000000,0.00000000,-14.09188855,0.11176965,EUR\n"
    # Spot buy leg (base asset, should be kept)
    "2944876033488265219,2944876033454710784,2025-10-12 10:55:44,Spot,USDC-EUR,Buy,16.18641000,EUR,"
    "0.87060000,0.00000000,0.00000000,USDC,0.00000000,0.00000000,16.18641000,575.03333100,USDC\n"
    # Transfer in (deposit)
    "2943537269197316096,2943537266621149184,2025-10-11 23:50:46,Transfer,,Transfer in,0.0,cont,"
    "0.00000000,0.00000000,0.00000000,EUR,0.00000000,0.00000000,500.00000000,500.62401824,EUR\n"
    # Convert trade (BTC-EUR-CONVERT): BTC leg
    "2914509106702262273,2914509106635153408,2025-10-01 23:32:19,Spot,BTC-EUR-CONVERT,,0.01227261,EUR,"
    "101852.81713905,0.00000000,0.00000000,BTC,0.00000000,0.00000000,0.01227261,0.01227261,BTC\n"
    # Convert trade (BTC-EUR-CONVERT): EUR leg (should be filtered out)
    "2914509106702262274,2914509106635153408,2025-10-01 23:32:19,Spot,BTC-EUR-CONVERT,,1250.00000000,EUR,"
    "101852.81713905,0.00000000,0.00000000,EUR,0.00000000,0.00000000,-1250.00000000,1250.00000000,EUR\n"
    # Another spot buy with fee
    "2917047534413225985,2917047534379671552,2025-10-02 20:33:11,Spot,ETH-EUR,Buy,0.07826100,EUR,"
    "3817.51000000,0.00000000,-0.00027391,ETH,0.00000000,0.00000000,0.07798709,0.07798709,ETH\n"
)


SAMPLE_CSV_BYTES = SAMPLE_CSV.encode("utf-8")


# ---------------------------------------------------------------------------
# Tests: _parse_filename_timezone
# ---------------------------------------------------------------------------


class TestParseFilenameTimezone:

    def test_utc0(self):
        fn = "Trading History_2025-06-30~2026-02-19~UTC0~8339611181c.csv"
        assert _parse_filename_timezone(fn) == "UTC0"

    def test_utc_plus_1(self):
        fn = "Trading History_2025-06-30~2026-02-19~UTC+1~abc.csv"
        assert _parse_filename_timezone(fn) == "UTC+1"

    def test_utc_minus_5(self):
        fn = "Trading History_2025-06-30~2026-02-19~UTC-5~abc.csv"
        assert _parse_filename_timezone(fn) == "UTC-5"

    def test_no_timezone(self):
        fn = "Trading History.csv"
        assert _parse_filename_timezone(fn) is None

    def test_none_input(self):
        assert _parse_filename_timezone(None) is None


# ---------------------------------------------------------------------------
# Tests: _resolve_timezone
# ---------------------------------------------------------------------------


class TestResolveTimezone:

    def test_none(self):
        assert _resolve_timezone(None) == "UTC"

    def test_utc0(self):
        assert _resolve_timezone("UTC0") == "UTC"

    def test_utc_plus_0(self):
        assert _resolve_timezone("UTC+0") == "UTC"

    def test_utc_plain(self):
        assert _resolve_timezone("UTC") == "UTC"

    def test_utc_plus_1(self):
        result = _resolve_timezone("UTC+1")
        assert result == "Etc/GMT-1"

    def test_utc_minus_5(self):
        result = _resolve_timezone("UTC-5")
        assert result == "Etc/GMT+5"

    def test_iana(self):
        assert _resolve_timezone("Europe/Paris") == "Europe/Paris"


# ---------------------------------------------------------------------------
# Tests: load_okx_trading_history_file
# ---------------------------------------------------------------------------


class TestLoadOKXTradingHistoryFile:

    def test_basic_parsing(self):
        """Should parse both trade and transfer rows."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        assert not df.empty
        # 1 withdrawal + 1 buy trade + 1 deposit + 1 convert trade + 1 ETH trade = 5 rows
        # The sell/fiat legs should be filtered out
        assert len(df) == 5

    def test_row_types(self):
        """Should have correct row_type classification."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        trade_rows = df[df["row_type"] == "trade"]
        transfer_rows = df[df["row_type"] == "transfer"]
        assert len(trade_rows) == 3  # USDC buy + BTC convert + ETH buy
        assert len(transfer_rows) == 2  # 1 withdrawal + 1 deposit

    def test_fiat_legs_filtered(self):
        """Rows where Balance Unit == Trading Unit (fiat legs) should be filtered."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        # The EUR sell legs should not appear
        transaction_ids = df["transaction_id"].tolist()
        assert "2944876033488265220" not in transaction_ids  # EUR sell leg
        assert "2914509106702262274" not in transaction_ids  # EUR convert leg

    def test_trade_fields(self):
        """Trade rows should have correct field values."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        usdc_trade = df[df["transaction_id"] == "2944876033488265219"].iloc[0]
        assert usdc_trade["row_type"] == "trade"
        assert usdc_trade["base_asset"] == "USDC"
        assert usdc_trade["quote_asset"] == "EUR"
        assert usdc_trade["quantity"] == pytest.approx(16.18641, abs=1e-4)
        assert usdc_trade["price"] == pytest.approx(0.8706, abs=1e-4)
        assert usdc_trade["symbol"] == "USDC-EUR"

    def test_convert_trade_tagged(self):
        """Convert trades should have tags={'type': 'convert'}."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        btc_convert = df[df["transaction_id"] == "2914509106702262273"].iloc[0]
        assert btc_convert["tags"] == {"type": "convert"}
        assert btc_convert["base_asset"] == "BTC"

    def test_regular_trade_no_tags(self):
        """Regular trades should have empty tags dict."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        usdc_trade = df[df["transaction_id"] == "2944876033488265219"].iloc[0]
        assert usdc_trade["tags"] == {}

    def test_transfer_deposit(self):
        """Deposit transfers should have correct fields."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        deposit = df[df["transaction_id"] == "2943537269197316096"].iloc[0]
        assert deposit["row_type"] == "transfer"
        assert deposit["transfer_type"] == "deposit"
        assert deposit["currency"] == "EUR"
        assert deposit["amount"] == pytest.approx(500.0, abs=1e-4)

    def test_transfer_withdrawal(self):
        """Withdrawal transfers should have correct fields."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        withdrawal = df[df["transaction_id"] == "2944959422929117184"].iloc[0]
        assert withdrawal["row_type"] == "transfer"
        assert withdrawal["transfer_type"] == "withdrawal"
        assert withdrawal["currency"] == "USDC"
        assert withdrawal["amount"] == pytest.approx(575.033331, abs=1e-4)

    def test_fee_absolute_value(self):
        """Fees should be stored as absolute values."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        eth_trade = df[df["transaction_id"] == "2917047534413225985"].iloc[0]
        assert eth_trade["fee"] == pytest.approx(0.00027391, abs=1e-8)
        assert eth_trade["fee_currency"] == "ETH"

    def test_timestamps_utc(self):
        """Timestamps should be UTC timezone-aware."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES)
        assert all(dt.tzinfo is not None for dt in df["datetime"])
        assert str(df["datetime"].iloc[0].tzinfo) == "UTC"

    def test_timezone_conversion(self):
        """When source_timezone is non-UTC, timestamps should be converted."""
        df = load_okx_trading_history_file(content=SAMPLE_CSV_BYTES, source_timezone="UTC+1")
        # Original: 2025-10-12 11:37:10 in UTC+1 → 10:37:10 in UTC
        withdrawal = df[df["transaction_id"] == "2944959422929117184"].iloc[0]
        assert withdrawal["datetime"].hour == 10

    def test_missing_columns(self):
        """Should raise ValueError when required columns missing."""
        bad_csv = b"col1,col2\nval1,val2\n"
        with pytest.raises(ValueError, match="Missing required columns"):
            load_okx_trading_history_file(content=bad_csv)

    def test_neither_args_raises(self):
        """Should raise ValueError when neither file_path nor content provided."""
        with pytest.raises(ValueError, match="Either file_path or content"):
            load_okx_trading_history_file()

    def test_both_args_raises(self):
        """Should raise ValueError when both file_path and content provided."""
        with pytest.raises(ValueError, match="Only one of"):
            load_okx_trading_history_file(file_path="/tmp/test.csv", content=b"data")

    def test_empty_trades_file(self):
        """Should return empty DataFrame for header-only file."""
        header_only = SAMPLE_CSV.split("\n")[0] + "\n"
        df = load_okx_trading_history_file(content=header_only.encode("utf-8"))
        assert df.empty


# ---------------------------------------------------------------------------
# Tests: get_okx_trading_history_file_preview
# ---------------------------------------------------------------------------


class TestPreview:

    def test_preview_structure(self):
        """Preview should include all expected keys."""
        preview = get_okx_trading_history_file_preview(SAMPLE_CSV_BYTES)
        assert "row_count" in preview
        assert "date_range" in preview
        assert "currencies" in preview
        assert "trade_count" in preview
        assert "transfer_count" in preview
        assert "convert_trades_count" in preview
        assert "sample_rows" in preview

    def test_preview_counts(self):
        """Preview should have correct counts of trades and transfers."""
        preview = get_okx_trading_history_file_preview(SAMPLE_CSV_BYTES)
        assert preview["row_count"] == 5
        assert preview["trade_count"] == 3
        assert preview["transfer_count"] == 2
        assert preview["convert_trades_count"] == 1

    def test_preview_currencies(self):
        """Preview should list all unique asset symbols."""
        preview = get_okx_trading_history_file_preview(SAMPLE_CSV_BYTES)
        currencies = preview["currencies"]
        assert "USDC" in currencies
        assert "BTC" in currencies
        assert "EUR" in currencies
        assert "ETH" in currencies

    def test_preview_date_range(self):
        """Preview should have valid date range."""
        preview = get_okx_trading_history_file_preview(SAMPLE_CSV_BYTES)
        assert preview["date_range"] is not None
        assert preview["date_range"]["min_date"] is not None
        assert preview["date_range"]["max_date"] is not None

    def test_preview_sample_rows(self):
        """Preview should have up to 5 sample rows."""
        preview = get_okx_trading_history_file_preview(SAMPLE_CSV_BYTES)
        assert len(preview["sample_rows"]) == 5
