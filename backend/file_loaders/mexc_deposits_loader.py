"""
MEXC Deposits File Loader - Parse MEXC deposit history XLSX exports.

Expected XLSX columns:
- UID: User ID
- Status: Deposit status (filter for "Credited Successfully")
- Time: Deposit timestamp
- Crypto: Currency symbol
- Network: Blockchain network
- Deposit Amount: Amount deposited
- TxID: Blockchain transaction ID (format: hash:index)
- Progress: Confirmation progress (not used)
"""

import io
import pandas as pd
from typing import Optional
from backend.config.loader import configure_logging

log = configure_logging("mexc_deposits_loader")


def load_mexc_deposits_file(file_path: Optional[str] = None, content: Optional[bytes] = None) -> pd.DataFrame:
    """
    Load and standardize MEXC deposits from XLSX file.
    
    Args:
        file_path: Path to the XLSX file (used if content is not provided)
        content: Raw file content as bytes (used for API uploads)
        
    Returns:
        pd.DataFrame: Standardized deposits with columns:
            - datetime: UTC timestamp
            - currency: Asset symbol (uppercase)
            - amount: Deposit amount
            - txid: Blockchain transaction ID (includes :index suffix)
            - network: Blockchain network
            - status: Deposit status
    
    Raises:
        ValueError: If neither file_path nor content is provided
    """
    if content is not None:
        log.info("loading_mexc_deposits_file from content", content_size=len(content))
        df_origin = pd.read_excel(io.BytesIO(content), keep_default_na=False, na_values=[''])
    elif file_path is not None:
        log.info("loading_mexc_deposits_file", file_path=file_path)
        df_origin = pd.read_excel(file_path, keep_default_na=False, na_values=[''])
    else:
        raise ValueError("Either file_path or content must be provided")
    
    # Filter for successfully credited deposits only
    df_filtered = df_origin[df_origin['Status'] == 'Credited Successfully'].copy()
    
    if df_filtered.empty:
        log.warning("No 'Credited Successfully' deposits found in file")
        return pd.DataFrame(columns=['datetime', 'currency', 'amount', 'txid', 'network', 'status'])
    
    # Standardize to common format
    df = pd.DataFrame()
    # MEXC Excel exports use UTC+1 timezone - parse and convert to UTC
    # The API returns UTC timestamps, so we need to convert file timestamps to match
    df['datetime'] = pd.to_datetime(df_filtered['Time']).dt.tz_localize('Etc/GMT-1').dt.tz_convert('UTC')
    df['currency'] = df_filtered['Crypto'].str.upper()
    df['amount'] = pd.to_numeric(df_filtered['Deposit Amount'], errors='coerce')
    df['txid'] = df_filtered['TxID'].astype(str)
    df['network'] = df_filtered['Network'].astype(str)
    df['status'] = df_filtered['Status']
    
    log.info(f"✅ Loaded {len(df)} deposits from MEXC file")
    return df


def get_mexc_deposits_file_preview(content: bytes) -> dict:
    """
    Parse MEXC deposits file and return preview data for UI.
    
    Args:
        content: Raw file content as bytes
        
    Returns:
        dict: Preview data containing:
            - row_count: Total number of deposits
            - date_range: {min_date, max_date}
            - currencies: List of unique currencies
            - sample_rows: First 5 rows as dicts
    """
    df = load_mexc_deposits_file(content=content)
    
    if df.empty:
        return {
            "row_count": 0,
            "date_range": None,
            "currencies": [],
            "sample_rows": [],
        }
    
    # Get unique currencies
    currencies = df['currency'].unique().tolist()
    
    # Get date range
    min_date = df['datetime'].min()
    max_date = df['datetime'].max()
    
    # Get sample rows (first 5)
    sample_df = df.head(5).copy()
    # Convert datetime to ISO string for JSON serialization
    sample_df['datetime'] = sample_df['datetime'].dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    sample_rows = sample_df.to_dict('records')
    
    return {
        "row_count": len(df),
        "date_range": {
            "min_date": min_date.strftime('%Y-%m-%dT%H:%M:%SZ') if pd.notna(min_date) else None,
            "max_date": max_date.strftime('%Y-%m-%dT%H:%M:%SZ') if pd.notna(max_date) else None,
        },
        "currencies": currencies,
        "sample_rows": sample_rows,
    }
