"""
OKX Trade Details file loader: Load trade history from OKX CSV export files.

CSV Format (header row with data rows, no metadata):
Order ID,Trade ID,Trade Time,Instrument,Symbol,Filled Amount,Filled Amount Unit,Filled Price,Fill Price Unit,Trading Volume,Trading Volume Unit,taker/maker,Fee,Fee Unit

Example row:
2944876033454710784,923433,2025-10-12 11:55:44,Spot,USDC-EUR,16.1864,USDC,0.87060000,EUR,14.09188855,EUR,taker,0.00000000,USDC

Key Features:
- Parses trade records with high-precision decimal values
- Converts fee values to absolute values (fees may be negative in CSV)
- Handles both regular spot trades and convert trades (Symbol contains "-CONVERT")
- Extracts base/quote assets from "Filled Amount Unit" and "Fill Price Unit"
- All timestamps are assumed to be in UTC
"""

import io
import pandas as pd
from typing import Optional
from backend.config.loader import configure_logging

log = configure_logging("okx_trades_loader")


def load_okx_trades_file(
    file_path: Optional[str] = None,
    content: Optional[bytes] = None
) -> pd.DataFrame:
    """
    Load and parse OKX trade details CSV file.
    
    Args:
        file_path: Path to CSV file (mutually exclusive with content)
        content: File content as bytes (mutually exclusive with file_path)
        
    Returns:
        pd.DataFrame: Standardized DataFrame with columns:
            - datetime: Timestamp in UTC (timezone-aware)
            - transaction_id: Trade ID (unique identifier)
            - instrument: Instrument type (e.g., 'Spot')
            - symbol: Trading pair symbol (e.g., 'USDC-EUR', 'BTC-EUR-CONVERT')
            - base_asset: Base currency from "Filled Amount Unit" (uppercase)
            - quantity: Filled amount (base asset quantity)
            - price: Filled price per unit
            - quote_asset: Quote currency from "Fill Price Unit" (uppercase)
            - total: Trading volume (quote asset total)
            - fee: Absolute fee amount
            - fee_currency: Fee currency (uppercase)
            
    Raises:
        ValueError: If neither file_path nor content provided, or both provided
        FileNotFoundError: If file_path doesn't exist
    """
    if content is None and file_path is None:
        raise ValueError("Either file_path or content must be provided")
    if content is not None and file_path is not None:
        raise ValueError("Only one of file_path or content should be provided")
    
    try:
        # Read the CSV file
        if content is not None:
            df_origin = pd.read_csv(
                io.BytesIO(content),
                keep_default_na=False,
                na_values=[''],
            )
        else:
            df_origin = pd.read_csv(
                file_path,
                keep_default_na=False,
                na_values=[''],
            )
        
        log.info(f"📂 Loaded CSV with {len(df_origin)} rows")
        
        # Validate required columns
        required_cols = [
            'Trade ID', 'Trade Time', 'Instrument', 'Symbol',
            'Filled Amount', 'Filled Amount Unit', 'Filled Price', 'Fill Price Unit',
            'Trading Volume', 'Trading Volume Unit', 'Fee', 'Fee Unit'
        ]
        missing_cols = [col for col in required_cols if col not in df_origin.columns]
        if missing_cols:
            raise ValueError(f"Missing required columns: {missing_cols}")
        
        # Create standardized DataFrame
        df = pd.DataFrame()
        
        # Parse timestamps (assumed to be UTC)
        df['datetime'] = pd.to_datetime(df_origin['Trade Time'], format='%Y-%m-%d %H:%M:%S')
        df['datetime'] = df['datetime'].dt.tz_localize('UTC')
        
        # Transaction ID (Trade ID is unique identifier)
        df['transaction_id'] = df_origin['Trade ID'].astype(str)
        
        # Instrument and symbol
        df['instrument'] = df_origin['Instrument'].astype(str)
        df['symbol'] = df_origin['Symbol'].astype(str)
        
        # Base asset and quantity (from "Filled Amount" and "Filled Amount Unit")
        df['base_asset'] = df_origin['Filled Amount Unit'].str.upper()
        df['quantity'] = pd.to_numeric(df_origin['Filled Amount'], errors='coerce')
        
        # Price
        df['price'] = pd.to_numeric(df_origin['Filled Price'], errors='coerce')
        
        # Quote asset and total (from "Fill Price Unit" and "Trading Volume")
        df['quote_asset'] = df_origin['Fill Price Unit'].str.upper()
        df['total'] = pd.to_numeric(df_origin['Trading Volume'], errors='coerce')
        
        # Fee (convert to absolute value)
        fee_values = pd.to_numeric(df_origin['Fee'], errors='coerce')
        df['fee'] = fee_values.abs()
        df['fee_currency'] = df_origin['Fee Unit'].str.upper()
        
        # Log summary
        convert_count = df[df['symbol'].str.contains('CONVERT', case=False, na=False)].shape[0]
        regular_count = len(df) - convert_count
        log.info(f"📊 Processed {len(df)} trades ({regular_count} regular, {convert_count} convert)")
        
        return df
        
    except Exception as e:
        log.error(f"❌ Failed to load OKX trades file: {e}")
        raise


def get_okx_trades_file_preview(content: bytes) -> dict:
    """
    Generate preview data for OKX trades file.
    
    Used by the API to show file preview before confirming import.
    
    Args:
        content: Raw file content as bytes
        
    Returns:
        dict: Preview data containing:
            - row_count: Total number of trades
            - date_range: {min_date, max_date}
            - currencies: List of unique base currencies
            - convert_trades_count: Number of convert trades
            - sample_rows: First 5 rows as dicts
    """
    df = load_okx_trades_file(content=content)
    
    if df.empty:
        return {
            "row_count": 0,
            "date_range": None,
            "currencies": [],
            "convert_trades_count": 0,
            "sample_rows": [],
        }
    
    # Get unique base currencies
    currencies = sorted(df['base_asset'].unique().tolist())
    
    # Count convert trades
    convert_count = df[df['symbol'].str.contains('CONVERT', case=False, na=False)].shape[0]
    
    # Get date range
    min_date = df['datetime'].min()
    max_date = df['datetime'].max()
    
    # Get sample rows (first 5)
    sample_df = df.head(5).copy()
    # Convert datetime to ISO string for JSON serialization
    sample_df['datetime'] = sample_df['datetime'].dt.strftime('%Y-%m-%dT%H:%M:%SZ')
    
    # Add explicit columns for UI display clarity
    sample_df['price_asset'] = sample_df['quote_asset']
    sample_df['fee_asset'] = sample_df['fee_currency']
    
    sample_rows = sample_df.to_dict('records')
    
    return {
        "row_count": len(df),
        "date_range": {
            "min_date": min_date.strftime('%Y-%m-%dT%H:%M:%SZ') if pd.notna(min_date) else None,
            "max_date": max_date.strftime('%Y-%m-%dT%H:%M:%SZ') if pd.notna(max_date) else None,
        },
        "currencies": currencies,
        "convert_trades_count": convert_count,
        "sample_rows": sample_rows,
    }
