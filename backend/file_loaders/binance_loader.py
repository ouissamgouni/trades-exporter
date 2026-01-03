import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("binance_loader")

def load_binance_file(file_path):
    """Load and standardize Binance trades."""
    log.info("loading_binance_file", file_path=file_path)
    df = pd.read_excel(file_path, keep_default_na=False, na_values=[''])
    df = df.rename(columns={
        "Date(UTC)": "datetime",
        "Base Asset": "base",
        "Quote Asset": "quote",
        "Amount": "quantity",
        "Price": "price",
        "Total": "total",
        "Type": "type",
        "Fee": "fee",
        "Fee Coin": "fee_quote"
    })
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)
    df["exchange"] = "Binance"
    return df
