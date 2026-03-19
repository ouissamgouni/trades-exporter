import os
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import logging


def compute_trade_content_hash(
    dt: datetime,
    base: str,
    quote: str,
    quantity: float,
    price: float,
    side: str,
) -> str:
    """
    Compute a content hash for a trade to enable cross-source deduplication.
    
    Uses MD5 hash of normalized trade content. The same trade imported via
    different sources (API vs file) should produce the same hash.
    
    Args:
        dt: Transaction datetime (UTC)
        base: Base asset symbol (e.g., "BTC")
        quote: Quote asset symbol (e.g., "USDT")  
        quantity: Trade quantity (normalized to 8 decimal places)
        price: Trade price (normalized to 8 decimal places)
        side: Trade side ("buy" or "sell")
    
    Returns:
        MD5 hash string (32 hex characters)
    
    Formula: MD5({datetime_iso}_{BASE}_{QUOTE}_{qty:.8f}_{price:.8f}_{side})
    """
    # Normalize datetime to ISO format with microseconds truncated for consistency
    dt_str = dt.strftime("%Y-%m-%dT%H:%M:%S")
    
    # Normalize symbols to uppercase
    base_normalized = base.upper().strip()
    quote_normalized = quote.upper().strip()
    
    # Normalize floats to Decimal with 8 decimal places for precision
    qty_decimal = Decimal(str(quantity)).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    price_decimal = Decimal(str(price)).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    
    # Normalize side to lowercase
    side_normalized = side.lower().strip()
    
    # Build unique string
    content_str = f"{dt_str}_{base_normalized}_{quote_normalized}_{qty_decimal}_{price_decimal}_{side_normalized}"
    
    # Compute MD5 hash
    return hashlib.md5(content_str.encode("utf-8")).hexdigest()


def ensure_dir(path: str):
    os.makedirs(path, exist_ok=True)
    return path

def list_new_files(base_dir: str):
    """List all files under <exchange>/new/"""
    for root, _, files in os.walk(base_dir):
        for f in files:
            if f.lower().endswith((".xlsx", ".xls", ".csv")):
                yield os.path.join(root, f)

def move_to_processed(file_path: str):
    processed_dir = os.path.join(os.path.dirname(os.path.dirname(file_path)), "processed")
    ensure_dir(processed_dir)
    os.rename(file_path, os.path.join(processed_dir, os.path.basename(file_path)))

def write_failed(export_dir, failed_rows):
    if not len(failed_rows):
        return
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    failed_dir = ensure_dir(export_dir)
    failed_path = os.path.join(failed_dir, f"failed_{ts}.xlsx")
    failed_rows.to_excel(failed_path, index=False)
    logging.warning(f"⚠️ Failed rows written to {failed_path}")


# ============================================================================
# Date Parsing Utilities for Filters
# ============================================================================


def parse_date_from(date_str: str) -> datetime:
    """
    Parse a date filter string for 'from' (start of range).
    
    Handles both date-only (YYYY-MM-DD) and full datetime formats.
    For date-only strings, returns start of day (00:00:00).
    
    Args:
        date_str: Date string in ISO format or date-only
        
    Returns:
        Parsed datetime
        
    Raises:
        ValueError: If the date string cannot be parsed
    """
    if 'T' in date_str or ' ' in date_str:
        return datetime.fromisoformat(date_str.replace('Z', '+00:00'))
    return datetime.fromisoformat(f"{date_str}T00:00:00")


def parse_date_to(date_str: str) -> datetime:
    """
    Parse a date filter string for 'to' (end of range).
    
    Handles both date-only (YYYY-MM-DD) and full datetime formats.
    For date-only strings, returns end of day (23:59:59.999999).
    
    Args:
        date_str: Date string in ISO format or date-only
        
    Returns:
        Parsed datetime
        
    Raises:
        ValueError: If the date string cannot be parsed
    """
    if 'T' in date_str or ' ' in date_str:
        return datetime.fromisoformat(date_str.replace('Z', '+00:00'))
    return datetime.fromisoformat(f"{date_str}T23:59:59.999999")
