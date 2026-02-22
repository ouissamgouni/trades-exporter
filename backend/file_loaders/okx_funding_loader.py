"""
OKX Funding History file loader: Load deposits and withdrawals from OKX CSV export files.

CSV Format:
- Row 1 (metadata): UID:758849262158803266,Account Type:Main,Time Zone:UTC+1
- Row 2 (headers): id,Time,Type,Amount,Before Balance,After Balance,Symbol
- Rows 3+: Data rows

Key Features:
- Parses metadata header to extract timezone information
- Handles high-precision decimal values (e.g., 575.033331000000000000)
- Converts negative amounts for withdrawals to positive (amount is signed in CSV)
- Converts timestamps from local timezone to UTC
- Distinguishes deposits (Type=Deposit) from withdrawals (Type=Withdrawal)
"""

import io
import re
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

import pandas as pd
from backend.config.loader import configure_logging

log = configure_logging("okx_funding_loader")


def _parse_timezone_offset(tz_string: str) -> int:
    """
    Parse timezone offset from string like 'UTC+1' or 'UTC-5'.
    
    Args:
        tz_string: Timezone string (e.g., 'UTC+1', 'UTC-5')
        
    Returns:
        int: Offset in hours (positive for east, negative for west)
    """
    match = re.match(r'UTC([+-]\d+)', tz_string)
    if not match:
        log.warning(f"Could not parse timezone '{tz_string}', defaulting to UTC")
        return 0
    return int(match.group(1))


def load_okx_funding_file(
    file_path: Optional[str] = None,
    content: Optional[bytes] = None
) -> pd.DataFrame:
    """
    Load and parse OKX funding history CSV file.
    
    Args:
        file_path: Path to CSV file (mutually exclusive with content)
        content: File content as bytes (mutually exclusive with file_path)
        
    Returns:
        pd.DataFrame: Standardized DataFrame with columns:
            - datetime: Timestamp in UTC (timezone-aware)
            - transaction_id: Transaction ID (from 'id' column)
            - transaction_type: 'deposit' or 'withdrawal'
            - currency: Asset symbol (uppercase)
            - amount: Transaction amount (always positive)
            - before_balance: Balance before transaction
            - after_balance: Balance after transaction
            
    Raises:
        ValueError: If neither file_path nor content provided, or both provided
        FileNotFoundError: If file_path doesn't exist
    """
    if content is None and file_path is None:
        raise ValueError("Either file_path or content must be provided")
    if content is not None and file_path is not None:
        raise ValueError("Only one of file_path or content should be provided")
    
    try:
        # Read the file
        if content is not None:
            df_raw = pd.read_csv(
                io.BytesIO(content),
                keep_default_na=False,
                na_values=[''],
            )
        else:
            df_raw = pd.read_csv(
                file_path,
                keep_default_na=False,
                na_values=[''],
            )
        
        log.info(f"📂 Loaded CSV with {len(df_raw)} rows")
        
        # Parse metadata from first row
        # Format: "UID:758849262158803266,Account Type:Main,Time Zone:UTC+1"
        metadata_row = df_raw.columns.tolist()
        timezone_offset = 0
        
        # Extract timezone from metadata
        for col in metadata_row:
            if 'Time Zone:' in str(col):
                tz_match = re.search(r'Time Zone:(UTC[+-]\d+)', str(col))
                if tz_match:
                    timezone_offset = _parse_timezone_offset(tz_match.group(1))
                    log.info(f"📍 Detected timezone: UTC{timezone_offset:+d}")
        
        # The actual headers are in the first data row
        # Re-read with proper headers
        if content is not None:
            df_origin = pd.read_csv(
                io.BytesIO(content),
                skiprows=1,  # Skip metadata row
                keep_default_na=False,
                na_values=[''],
            )
        else:
            df_origin = pd.read_csv(
                file_path,
                skiprows=1,  # Skip metadata row
                keep_default_na=False,
                na_values=[''],
            )
        
        log.info(f"📊 Processing {len(df_origin)} funding transactions")
        
        # Validate required columns
        required_cols = ['id', 'Time', 'Type', 'Amount', 'Symbol']
        missing_cols = [col for col in required_cols if col not in df_origin.columns]
        if missing_cols:
            raise ValueError(f"Missing required columns: {missing_cols}")
        
        # Create standardized DataFrame
        df = pd.DataFrame()
        
        # Parse timestamps and convert to UTC
        # Timestamps are in local timezone specified in metadata
        df['datetime'] = pd.to_datetime(df_origin['Time'], format='%Y-%m-%d %H:%M:%S')
        
        # Apply timezone offset
        if timezone_offset != 0:
            # Create timezone with offset (e.g., UTC+1 = Etc/GMT-1)
            # Note: Etc/GMT uses inverted sign
            tz_name = f'Etc/GMT{-timezone_offset:+d}'
            df['datetime'] = df['datetime'].dt.tz_localize(tz_name).dt.tz_convert('UTC')
        else:
            df['datetime'] = df['datetime'].dt.tz_localize('UTC')
        
        # Transaction ID (unique identifier)
        df['transaction_id'] = df_origin['id'].astype(str)
        
        # Transaction type (normalize to lowercase)
        df['transaction_type'] = df_origin['Type'].str.lower()
        
        # Validate transaction types
        valid_types = {'deposit', 'withdrawal'}
        invalid_types = set(df['transaction_type'].unique()) - valid_types
        if invalid_types:
            log.warning(f"⚠️ Found unexpected transaction types: {invalid_types}")
        
        # Currency (uppercase)
        df['currency'] = df_origin['Symbol'].str.upper()
        
        # Amount (convert to absolute value since withdrawals are negative)
        df['amount'] = pd.to_numeric(df_origin['Amount'], errors='coerce').abs()
        
        # Balance fields (optional, for validation)
        df['before_balance'] = pd.to_numeric(df_origin['Before Balance'], errors='coerce')
        df['after_balance'] = pd.to_numeric(df_origin['After Balance'], errors='coerce')
        
        # Drop rows with invalid amounts
        invalid_rows = df['amount'].isna()
        if invalid_rows.any():
            log.warning(f"⚠️ Dropping {invalid_rows.sum()} rows with invalid amounts")
            df = df[~invalid_rows].copy()
        
        log.info(f"✅ Parsed {len(df)} valid funding transactions")
        log.info(f"📈 Deposits: {(df['transaction_type'] == 'deposit').sum()}, "
                 f"Withdrawals: {(df['transaction_type'] == 'withdrawal').sum()}")
        
        return df
        
    except Exception as e:
        log.error(f"❌ Failed to load OKX funding file: {e}")
        raise


def get_okx_funding_file_preview(content: bytes) -> Dict[str, Any]:
    """
    Generate preview data for OKX funding history file.
    
    Used by the API to show file preview before confirming import.
    
    Args:
        content: File content as bytes
        
    Returns:
        dict: Preview data with structure:
            {
                "row_count": int,
                "date_range": {"min_date": str, "max_date": str},
                "currencies": List[str],
                "transaction_types": Dict[str, int],  # Type -> count
                "sample_rows": List[dict],
            }
    """
    try:
        df = load_okx_funding_file(content=content)
        
        if df.empty:
            return {
                "row_count": 0,
                "date_range": {"min_date": None, "max_date": None},
                "currencies": [],
                "transaction_types": {},
                "sample_rows": [],
            }
        
        # Date range
        min_date = df['datetime'].min()
        max_date = df['datetime'].max()
        
        # Transaction type counts
        type_counts = df['transaction_type'].value_counts().to_dict()
        
        # Sample rows (first 5, convert to dict)
        sample_df = df.head(5).copy()
        
        # Convert datetime to ISO string for JSON serialization
        sample_df['datetime'] = sample_df['datetime'].dt.strftime('%Y-%m-%dT%H:%M:%SZ')
        
        # Drop balance columns from preview (not needed for display)
        sample_df = sample_df.drop(columns=['before_balance', 'after_balance'], errors='ignore')
        
        preview = {
            "row_count": len(df),
            "date_range": {
                "min_date": min_date.strftime('%Y-%m-%dT%H:%M:%SZ'),
                "max_date": max_date.strftime('%Y-%m-%dT%H:%M:%SZ'),
            },
            "currencies": sorted(df['currency'].unique().tolist()),
            "transaction_types": type_counts,
            "sample_rows": sample_df.to_dict('records'),
        }
        
        log.info(f"📋 Generated preview: {len(df)} rows, "
                 f"{len(preview['currencies'])} currencies, "
                 f"{preview['date_range']['min_date']} to {preview['date_range']['max_date']}")
        
        return preview
        
    except Exception as e:
        log.error(f"❌ Failed to generate preview: {e}")
        raise


# Integration tests:
# pytest tests/integration/file_loaders/test_okx_funding_loader.py -v
