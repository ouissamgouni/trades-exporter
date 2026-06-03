"""
DeGiro Transactions file loader: Parse DeGiro CSV export into a standardized DataFrame.

CSV Format (DeGiro Transactions export):
Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,,Local value,,
Value EUR,Exchange rate,AutoFX Fee,Transaction and/or third party fees EUR,Total EUR,Order ID,

Key characteristics:
- European number format: comma as decimal separator (e.g. "1.234,56")
- Dates in DD-MM-YYYY format, times in HH:MM
- Price currency in column index 8 (unnamed), local value currency in column index 10
- All fees in EUR (AutoFX Fee + Transaction fees)
- ISIN is the asset identifier (mapped via RawAsset)
- Negative quantities = buy (outflow of cash), positive quantities possible for sells
"""

import io
import hashlib
from decimal import Decimal, ROUND_DOWN
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from collections import defaultdict

import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("degiro_loader")


def parse_european_number(value: str) -> Optional[Decimal]:
    """
    Parse European-format number string to Decimal.

    Examples:
        "1.234,56" → Decimal("1234.56")
        "-0,39"    → Decimal("-0.39")
        "39,5000"  → Decimal("39.5000")
        ""         → None
    """
    if not value or not isinstance(value, str):
        return None
    value = value.strip().replace("\xa0", "").replace(" ", "")
    if not value:
        return None
    # Remove thousand separators (dots) then swap comma for decimal point
    value = value.replace(".", "").replace(",", ".")
    try:
        return Decimal(value)
    except Exception:
        return None


def generate_transaction_id(row: Dict[str, Any]) -> str:
    """
    Generate a unique transaction ID for deduplication.

    Hash of: datetime + isin + quantity + price + order_id

    For partial order fills (same order_id, different rows), appends
    a sequence counter (_seq_N) to ensure uniqueness.
    """
    dt_val = row.get("datetime")
    if hasattr(dt_val, "isoformat"):
        dt_str = dt_val.isoformat()
    elif hasattr(dt_val, "to_pydatetime"):
        dt_str = dt_val.to_pydatetime().isoformat()
    else:
        dt_str = str(dt_val)

    isin = str(row.get("isin", "")).upper()
    quantity = Decimal(str(row.get("quantity", 0))).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )
    price = Decimal(str(row.get("price", 0))).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )
    order_id = str(row.get("order_id", ""))

    unique_str = f"{dt_str}_{isin}_{quantity}_{price}_{order_id}"
    base_hash = hashlib.md5(unique_str.encode()).hexdigest()

    sequence = _transaction_id_sequence[base_hash]
    _transaction_id_sequence[base_hash] += 1

    if sequence == 0:
        return base_hash
    return f"{base_hash}_seq_{sequence}"


# Global sequence counter for within-file duplicate detection
_transaction_id_sequence: Dict[str, int] = defaultdict(int)


def _reset_sequence_counter():
    """Reset the global sequence counter (for testing)."""
    _transaction_id_sequence.clear()


def load_degiro_file(
    file_path: Optional[str] = None,
    content: Optional[bytes] = None,
) -> pd.DataFrame:
    """
    Load a DeGiro Transactions CSV and return a standardized DataFrame.

    Args:
        file_path: Path to the CSV file.
        content: Raw CSV bytes (e.g., from file upload).

    Returns:
        DataFrame with columns:
            datetime, product, isin, exchange, venue, quantity, price,
            price_currency, local_value, value_eur, exchange_rate,
            autofx_fee, transaction_fee, total_eur, order_id, direction
    """
    if file_path and content:
        raise ValueError("Only one of file_path or content should be provided")
    if not file_path and content is None:
        raise ValueError("Either file_path or content must be provided")

    _reset_sequence_counter()

    # Read CSV with European format
    if content is not None:
        text = content.decode("utf-8-sig") if isinstance(content, bytes) else content
        buf = io.StringIO(text)
    else:
        buf = file_path

    # DeGiro CSV has unnamed columns at positions 8 and 10 (currencies)
    # Read with no assumed header names first to handle the trailing comma
    df = pd.read_csv(buf, sep=",", dtype=str, keep_default_na=False)

    if df.empty:
        return pd.DataFrame()

    # Validate expected columns
    expected_headers = {"Date", "Time", "Product", "ISIN", "Quantity", "Price"}
    actual_headers = set(df.columns)
    missing = expected_headers - actual_headers
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    records: List[Dict[str, Any]] = []

    for _, row in df.iterrows():
        date_str = str(row.get("Date", "")).strip()
        time_str = str(row.get("Time", "")).strip()
        product = str(row.get("Product", "")).strip()
        isin = str(row.get("ISIN", "")).strip().upper()

        if not date_str or not isin:
            continue

        # Parse date + time → datetime (UTC)
        try:
            if time_str and time_str != "00:00":
                dt = datetime.strptime(f"{date_str} {time_str}", "%d-%m-%Y %H:%M")
            else:
                dt = datetime.strptime(date_str, "%d-%m-%Y")
            dt = dt.replace(tzinfo=timezone.utc)
        except ValueError:
            log.warning(f"Skipping row with unparseable date: {date_str} {time_str}")
            continue

        # Parse numeric fields (European format)
        quantity = parse_european_number(str(row.get("Quantity", "")))
        price = parse_european_number(str(row.get("Price", "")))
        value_eur = parse_european_number(str(row.get("Value EUR", "")))
        exchange_rate = parse_european_number(str(row.get("Exchange rate", "")))
        autofx_fee = parse_european_number(str(row.get("AutoFX Fee", "")))
        total_eur = parse_european_number(str(row.get("Total EUR", "")))

        # Transaction fee column name varies
        transaction_fee = None
        for col_name in [
            "Transaction and/or third party fees EUR",
            "Transaction fees",
            "Transaction and/or third",
        ]:
            if col_name in row.index:
                transaction_fee = parse_european_number(str(row.get(col_name, "")))
                if transaction_fee is not None:
                    break

        # Price currency is in the unnamed column after Price (index 8)
        cols = list(df.columns)
        price_currency = ""
        if len(cols) > 8:
            price_currency = str(row.iloc[8]).strip().upper()
        if not price_currency or price_currency == "NAN":
            price_currency = "EUR"

        # Determine direction from quantity sign or local value sign
        # DeGiro: negative local_value = buy, positive = sell
        if quantity is not None and quantity < 0:
            direction = "sell"
            quantity = abs(quantity)
        elif quantity is not None and quantity > 0:
            direction = "buy"
        else:
            direction = "buy"

        exchange = str(row.get("Reference exchange", "")).strip()
        venue = str(row.get("Venue", "")).strip()
        order_id = str(row.get("Order ID", "")).strip()

        # Compute total fee in EUR (autofx + transaction fee), as positive value
        total_fee_eur = Decimal("0")
        if autofx_fee is not None:
            total_fee_eur += abs(autofx_fee)
        if transaction_fee is not None:
            total_fee_eur += abs(transaction_fee)

        record = {
            "datetime": dt,
            "product": product,
            "isin": isin,
            "exchange": exchange,
            "venue": venue,
            "quantity": float(quantity) if quantity is not None else 0.0,
            "price": float(abs(price)) if price is not None else 0.0,
            "price_currency": price_currency,
            "local_value": float(row.get("Local value", "0").replace(".", "").replace(",", ".") or 0) if "Local value" in row.index else 0.0,
            "value_eur": float(value_eur) if value_eur is not None else 0.0,
            "exchange_rate": float(exchange_rate) if exchange_rate is not None else None,
            "autofx_fee": float(abs(autofx_fee)) if autofx_fee is not None else 0.0,
            "transaction_fee": float(abs(transaction_fee)) if transaction_fee is not None else 0.0,
            "fee": float(total_fee_eur),
            "total_eur": float(abs(total_eur)) if total_eur is not None else 0.0,
            "order_id": order_id,
            "direction": direction,
        }

        records.append(record)

    if not records:
        return pd.DataFrame()

    result_df = pd.DataFrame(records)
    # Replace pandas NaN with None so downstream JSON serialization works
    # (pandas converts None → NaN in numeric columns)
    result_df = result_df.where(result_df.notna(), other=None)
    log.info(f"✅ Loaded {len(result_df)} transactions from DeGiro CSV")
    return result_df


def get_degiro_file_preview(content: bytes) -> dict:
    """
    Generate preview data for a DeGiro Transactions CSV file.

    Args:
        content: Raw file content as bytes.

    Returns:
        dict with keys: row_count, date_range, pairs (ISINs), sample_rows
    """
    df = load_degiro_file(content=content)

    if df.empty:
        return {
            "row_count": 0,
            "date_range": None,
            "pairs": [],
            "sample_rows": [],
        }

    pairs = sorted(df["isin"].unique().tolist())

    min_date = df["datetime"].min()
    max_date = df["datetime"].max()

    sample_df = df.head(5).copy()
    sample_df["datetime"] = sample_df["datetime"].apply(
        lambda dt: dt.strftime("%Y-%m-%dT%H:%M:%SZ") if hasattr(dt, "strftime") else str(dt)
    )
    sample_rows = sample_df.to_dict("records")

    return {
        "row_count": len(df),
        "date_range": {
            "min_date": min_date.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(min_date) else None,
            "max_date": max_date.strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(max_date) else None,
        },
        "pairs": pairs,
        "sample_rows": sample_rows,
    }
