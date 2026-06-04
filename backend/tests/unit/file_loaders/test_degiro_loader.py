"""
Unit tests for DeGiro Transactions file loader.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timezone

from backend.file_loaders.degiro_loader import (
    load_degiro_file,
    get_degiro_file_preview,
    parse_european_number,
    generate_transaction_id,
    _reset_sequence_counter,
)


# ---------------------------------------------------------------------------
# Sample CSV content
# ---------------------------------------------------------------------------

SAMPLE_CSV = (
    "Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,"
    "Local value,,Value EUR,Exchange rate,AutoFX Fee,"
    "Transaction and/or third party fees EUR,Total EUR,Order ID\n"
    # Buy: 14 shares of RIGETTI at 42.385 USD
    "31-10-2025,16:51,RIGETTI COMPUTING INC,US76655K1034,NDQ,CDED,"
    '-14,"42,385",USD,"-593,39",USD,"-548,27","0,9239",,"-0,39","-548,66",'
    "baa19ae8-1111-2222-3333-444455556666\n"
    # Sell: 10 shares of ASML at 685.40 EUR
    "15-09-2025,10:30,ASML HOLDING,NL0010273215,AMS,XAMS,"
    '10,"685,40",EUR,"6854,00",EUR,"6854,00",,,"-4,90","6849,10",'
    "ccdd1122-aaaa-bbbb-cccc-ddddeeeeffff\n"
    # Buy: 5 shares, EUR-priced, with autofx fee
    "01-01-2025,09:00,TEST PRODUCT,GB0000000001,LSE,XLON,"
    '-5,"100,50",GBP,"-502,50",GBP,"-590,00","1,1741","-2,50","-0,50","-593,00",'
    "aabb0011-1111-2222-3333-000011112222\n"
)

SAMPLE_CSV_BYTES = SAMPLE_CSV.encode("utf-8")


# ---------------------------------------------------------------------------
# Tests: parse_european_number
# ---------------------------------------------------------------------------


class TestParseEuropeanNumber:
    def test_simple_decimal(self):
        assert parse_european_number("42,385") == Decimal("42.385")

    def test_negative(self):
        assert parse_european_number("-0,39") == Decimal("-0.39")

    def test_thousand_separator(self):
        assert parse_european_number("1.234,56") == Decimal("1234.56")

    def test_negative_with_thousands(self):
        assert parse_european_number("-593,39") == Decimal("-593.39")

    def test_integer(self):
        assert parse_european_number("14") == Decimal("14")

    def test_empty_string(self):
        assert parse_european_number("") is None

    def test_none(self):
        assert parse_european_number(None) is None

    def test_whitespace_only(self):
        assert parse_european_number("   ") is None

    def test_non_string(self):
        assert parse_european_number(123) is None

    def test_large_number(self):
        assert parse_european_number("1.000.000,99") == Decimal("1000000.99")


# ---------------------------------------------------------------------------
# Tests: generate_transaction_id
# ---------------------------------------------------------------------------


class TestGenerateTransactionId:
    def setup_method(self):
        _reset_sequence_counter()

    def test_returns_md5_hash(self):
        row = {
            "datetime": datetime(2025, 10, 31, 16, 51, tzinfo=timezone.utc),
            "isin": "US76655K1034",
            "quantity": 14.0,
            "price": 42.385,
            "order_id": "baa19ae8",
        }
        tid = generate_transaction_id(row)
        assert len(tid) == 32  # MD5 hex
        assert tid.isalnum()

    def test_deterministic(self):
        _reset_sequence_counter()
        row = {
            "datetime": datetime(2025, 10, 31, 16, 51, tzinfo=timezone.utc),
            "isin": "US76655K1034",
            "quantity": 14.0,
            "price": 42.385,
            "order_id": "test-order",
        }
        first = generate_transaction_id(row)
        _reset_sequence_counter()
        second = generate_transaction_id(row)
        assert first == second

    def test_generate_transaction_id_has_no_global_sequence(self):
        """Identical direct calls should return the same deterministic ID."""
        row = {
            "datetime": datetime(2025, 10, 31, 16, 51, tzinfo=timezone.utc),
            "isin": "US76655K1034",
            "quantity": 14.0,
            "price": 42.385,
            "order_id": "same-order",
        }
        first = generate_transaction_id(row)
        second = generate_transaction_id(row)
        assert first == second

    def test_different_isins_get_different_ids(self):
        row1 = {
            "datetime": datetime(2025, 10, 31, 16, 51, tzinfo=timezone.utc),
            "isin": "US76655K1034",
            "quantity": 14.0,
            "price": 42.385,
            "order_id": "order-1",
        }
        row2 = {**row1, "isin": "NL0010273215"}
        assert generate_transaction_id(row1) != generate_transaction_id(row2)


# ---------------------------------------------------------------------------
# Tests: load_degiro_file
# ---------------------------------------------------------------------------


class TestLoadDegiroFile:
    def test_load_from_content(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        assert len(df) == 3

    def test_expected_columns(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        expected = {
            "datetime",
            "product",
            "isin",
            "exchange",
            "venue",
            "quantity",
            "price",
            "price_currency",
            "local_value",
            "value_eur",
            "exchange_rate",
            "autofx_fee",
            "transaction_fee",
            "fee",
            "total_eur",
            "order_id",
            "direction",
        }
        assert expected.issubset(set(df.columns))

    def test_buy_direction(self):
        """Negative quantity in CSV → direction='sell' (outflow from perspective of shares), quantity becomes positive."""
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        rigetti = df[df["isin"] == "US76655K1034"].iloc[0]
        # Loader: negative qty → sell, abs(qty)
        assert rigetti["direction"] == "sell"
        assert rigetti["quantity"] == pytest.approx(14.0)

    def test_sell_direction(self):
        """Positive quantity in CSV → direction='buy'."""
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        asml = df[df["isin"] == "NL0010273215"].iloc[0]
        assert asml["direction"] == "buy"  # positive qty = buy
        assert asml["quantity"] == pytest.approx(10.0)

    def test_price_parsing(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        rigetti = df[df["isin"] == "US76655K1034"].iloc[0]
        assert rigetti["price"] == pytest.approx(42.385, abs=1e-3)

    def test_price_currency(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        rigetti = df[df["isin"] == "US76655K1034"].iloc[0]
        assert rigetti["price_currency"] == "USD"

    def test_fee_aggregation(self):
        """Fee should be sum of autofx + transaction fee, as positive."""
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        gb_row = df[df["isin"] == "GB0000000001"].iloc[0]
        # autofx=2.50 + transaction=0.50 = 3.00
        assert gb_row["fee"] == pytest.approx(3.0, abs=1e-2)

    def test_transaction_fee_only(self):
        """Row with only transaction fee, no autofx."""
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        rigetti = df[df["isin"] == "US76655K1034"].iloc[0]
        # Only transaction fee of 0.39
        assert rigetti["fee"] == pytest.approx(0.39, abs=1e-2)

    def test_datetime_utc(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        rigetti = df[df["isin"] == "US76655K1034"].iloc[0]
        dt = rigetti["datetime"]
        assert dt.tzinfo == timezone.utc
        assert dt.year == 2025
        assert dt.month == 10
        assert dt.day == 31
        assert dt.hour == 16
        assert dt.minute == 51

    def test_isin_uppercased(self):
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        for isin in df["isin"]:
            assert isin == isin.upper()

    def test_empty_content(self):
        empty_csv = "Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID\n"
        df = load_degiro_file(content=empty_csv.encode())
        assert df.empty

    def test_both_args_raises(self):
        with pytest.raises(ValueError, match="Only one"):
            load_degiro_file(file_path="/some/file.csv", content=b"data")

    def test_no_args_raises(self):
        with pytest.raises(ValueError, match="Either"):
            load_degiro_file()

    def test_missing_columns_raises(self):
        bad_csv = "ColA,ColB,ColC\n1,2,3\n"
        with pytest.raises(ValueError, match="Missing required columns"):
            load_degiro_file(content=bad_csv.encode())


# ---------------------------------------------------------------------------
# Tests: get_degiro_file_preview
# ---------------------------------------------------------------------------


class TestPreview:
    def test_row_count(self):
        preview = get_degiro_file_preview(SAMPLE_CSV_BYTES)
        assert preview["row_count"] == 3

    def test_pairs_are_isins(self):
        preview = get_degiro_file_preview(SAMPLE_CSV_BYTES)
        assert "US76655K1034" in preview["pairs"]
        assert "NL0010273215" in preview["pairs"]

    def test_date_range(self):
        preview = get_degiro_file_preview(SAMPLE_CSV_BYTES)
        assert preview["date_range"] is not None
        assert "min_date" in preview["date_range"]
        assert "max_date" in preview["date_range"]

    def test_sample_rows(self):
        preview = get_degiro_file_preview(SAMPLE_CSV_BYTES)
        assert len(preview["sample_rows"]) <= 5
        assert len(preview["sample_rows"]) > 0

    def test_empty_file(self):
        empty_csv = "Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID\n"
        preview = get_degiro_file_preview(empty_csv.encode())
        assert preview["row_count"] == 0
        assert preview["pairs"] == []


# ---------------------------------------------------------------------------
# Tests: deterministic IDs across multiple loads (dedup safety)
# ---------------------------------------------------------------------------


class TestIdempotency:
    def test_same_csv_produces_same_ids(self):
        """Loading the same CSV twice should produce identical transaction IDs."""
        df1 = load_degiro_file(content=SAMPLE_CSV_BYTES)
        ids1 = [generate_transaction_id(row) for _, row in df1.iterrows()]

        _reset_sequence_counter()

        df2 = load_degiro_file(content=SAMPLE_CSV_BYTES)
        ids2 = [generate_transaction_id(row) for _, row in df2.iterrows()]

        assert ids1 == ids2

    def test_ids_unique_within_single_load(self):
        """All IDs within a single load should be unique."""
        df = load_degiro_file(content=SAMPLE_CSV_BYTES)
        ids = [generate_transaction_id(row) for _, row in df.iterrows()]
        assert len(ids) == len(set(ids))

    def test_duplicate_rows_get_deterministic_sequence_within_load(self):
        """Identical rows in one file should get stable per-file sequence suffixes."""
        lines = SAMPLE_CSV.splitlines()
        duplicate_csv = "\n".join([lines[0], lines[1], lines[1]]) + "\n"

        df1 = load_degiro_file(content=duplicate_csv.encode("utf-8"))
        ids1 = [generate_transaction_id(row) for _, row in df1.iterrows()]

        df2 = load_degiro_file(content=duplicate_csv.encode("utf-8"))
        ids2 = [generate_transaction_id(row) for _, row in df2.iterrows()]

        assert ids1 == ids2
        assert ids1[0] != ids1[1]
        assert ids1[1].endswith("_seq_1")
