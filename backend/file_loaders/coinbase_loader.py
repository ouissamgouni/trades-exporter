import pandas as pd
import re
from backend.config.loader import configure_logging

log = configure_logging("coinbase_loader")


def parse_eur_amount(x):
    """Convert '€344.99', '-€147.45', '0.00', '' → float."""
    if pd.isna(x):
        return 0.0
    s = str(x)
    m = re.search(r"-?\d+(\.\d+)?", s.replace(",", ""))
    return float(m.group(0)) if m else 0.0


def extract_type(tx_type: str):
    """Normalize Coinbase transaction type into buy/sell or None."""
    if not isinstance(tx_type, str):
        return None
    s = tx_type.lower()
    if "buy" in s:
        return "buy"
    if "sell" in s:
        return "sell"
    return None


def load_coinbase_file(path):
    """
    Coinbase CSV → normalized df:
    datetime, type, base, quote, quantity, total, price, fee, fee_quote, exchange
    """
    log.info("loading_coinbase_file", path=path)

    # Read CSV with controlled NA handling to avoid string 'nan' issues
    df_origin = pd.read_csv(path, keep_default_na=False, na_values=[""])

    # ---------------------------------------
    # Work on a clean copy
    # ---------------------------------------
    df = df_origin.copy()

    # Normalize type
    df["type"] = df["Transaction Type"].apply(extract_type)

    # Keep only buy/sell
    df = df[df["type"].notna()].copy()

    if df.empty:
        log.warning("No buy/sell operations found in Coinbase CSV")
        return df

    # Datetime (UTC included in string) - keep timezone-aware
    df["datetime"] = pd.to_datetime(df["Timestamp"], utc=True)

    df["base"] = df["Asset"].str.upper()
    df["quote"] = df["Price Currency"].str.upper()

    df["quantity"] = df["Quantity Transacted"].astype(float)

    df["price"] = df["Price at Transaction"].apply(parse_eur_amount)
    df["total"] = df["Total (inclusive of fees and/or spread)"].apply(parse_eur_amount)

    df["fee"] = df["Fees and/or Spread"].apply(parse_eur_amount)
    df["fee_quote"] = df["quote"]  # Coinbase uses EUR consistently

    df["exchange"] = "COINBASE"

    # Keep only normalized output columns
    return df[
        [
            "datetime",
            "type",
            "base",
            "quote",
            "quantity",
            "total",
            "price",
            "fee",
            "fee_quote",
            "exchange",
        ]
    ]
