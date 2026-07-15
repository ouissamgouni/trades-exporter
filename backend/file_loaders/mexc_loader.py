import io
import pandas as pd
import re
from typing import Union, Optional
from backend.config.loader import configure_logging

log = configure_logging("mexc_loader")


def load_mexc_file(file_path: Optional[str] = None, content: Optional[bytes] = None) -> pd.DataFrame:
    """
    Load and standardize MEXC trades from XLSX file.
    
    Args:
        file_path: Path to the XLSX file (used if content is not provided)
        content: Raw file content as bytes (used for API uploads)
        
    Returns:
        pd.DataFrame: Standardized trades with columns:
            - base, quote: Trading pair components
            - datetime: UTC timestamp
            - fee, fee_quote: Fee amount and currency
            - quantity, total, price: Trade amounts
            - type: 'buy' or 'sell'
            - exchange: 'MEXC'
    
    Raises:
        ValueError: If neither file_path nor content is provided
    """
    if content is not None:
        log.info("loading_mexc_file from content", content_size=len(content))
        df_origin = pd.read_excel(io.BytesIO(content), keep_default_na=False, na_values=[''])
    elif file_path is not None:
        log.info("loading_mexc_file", file_path=file_path)
        df_origin = pd.read_excel(file_path, keep_default_na=False, na_values=[''])
    else:
        raise ValueError("Either file_path or content must be provided")
    
    df = pd.DataFrame()
    df[["base", "quote"]] = df_origin["Pairs"].str.split("_", expand=True)
    # MEXC Excel exports use UTC+1 timezone - parse and convert to UTC
    # The API returns UTC timestamps, so we need to convert file timestamps to match
    df["datetime"] = pd.to_datetime(df_origin["Time"]).dt.tz_localize('Etc/GMT-1').dt.tz_convert('UTC')
    df["fee"] = df_origin["Fee"].apply(lambda x: float(re.match(r"([0-9.]+)", str(x)).group(1)) if pd.notna(x) else 0)
    df["fee_quote"] = df_origin["Fee"].apply(lambda x: re.search(r"[A-Za-z]+", str(x)).group(0) if pd.notna(x) else None)

    df[["quantity", "total", "price"]] = df_origin[["Executed Amount", "Total", "Filled Price"]]
    df["type"] = df_origin["Side"].str.lower()
    df["exchange"] = "MEXC"
    return df


def get_mexc_file_preview(content: bytes) -> dict:
    """
    Parse MEXC file and return preview data for UI.
    
    Args:
        content: Raw file content as bytes
        
    Returns:
        dict: Preview data containing:
            - row_count: Total number of trades
            - date_range: {min_date, max_date}
            - pairs: List of unique trading pairs
            - sample_rows: First 5 rows as dicts
    """
    df = load_mexc_file(content=content)
    
    if df.empty:
        return {
            "row_count": 0,
            "date_range": None,
            "pairs": [],
            "sample_rows": [],
        }
    
    # Get unique pairs
    pairs = (df["base"] + "/" + df["quote"]).unique().tolist()
    
    # Get date range
    min_date = df["datetime"].min()
    max_date = df["datetime"].max()
    
    # Get sample rows (first 5)
    sample_df = df.head(5).copy()
    # Convert datetime to ISO string for JSON serialization
    sample_df["datetime"] = sample_df["datetime"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
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
