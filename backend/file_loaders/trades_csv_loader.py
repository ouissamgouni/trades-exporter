"""
Trades CSV Loader.

Parses CSV files containing trade transactions with the following format:
- Date (DD/MM/YYYY HH:MM:SS)
- Transaction Type (Buy/Sell)
- Stock / ETF Symbol ("Name (TICKER)")
- Quantity of Units (European format: "1.234,56")
- Amount per unit (€xx,xx)
- Total Amount (European format)
- Trading Fees (optional)
- Investment Account ("TYPE(NAME)" e.g., "AV(LINXEA1)")

Usage:
    from backend.file_loaders.trades_csv_loader import TradesCSVLoader
    
    loader = TradesCSVLoader()
    result = loader.load("path/to/trades.csv")
"""

import re
import hashlib
import pandas as pd
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from datetime import datetime
from io import StringIO, BytesIO

from backend.config.loader import configure_logging

log = configure_logging("trades_csv_loader")

# Source identifier for all raw entries created from this loader
SOURCE_IDENTIFIER = "csv-trades"


def parse_european_number(value: str) -> Optional[Decimal]:
    """
    Parse European number format (e.g., "1.234,56" or "1 234,56") to Decimal.
    
    Handles:
    - Thousand separators: space, non-breaking space, narrow no-break space, dot, or none
    - Decimal separator: comma
    - Currency symbols: € prefix/suffix
    """
    if not value or pd.isna(value):
        return None
    
    # Convert to string and strip whitespace
    s = str(value).strip()
    if not s:
        return None
    
    # Remove currency symbols
    s = s.replace("€", "").strip()
    
    # Check for empty after currency removal
    if not s:
        return None
    
    # Remove ALL whitespace characters (space, non-breaking space, narrow no-break space, etc.)
    # \s covers regular spaces, \u00a0 is non-breaking space, \u202f is narrow no-break space
    s = re.sub(r'[\s\u00a0\u202f\u2009\u200a]+', '', s)
    
    # Remove dot as thousand separator (but keep track if there's a comma)
    # European format: dot = thousand sep, comma = decimal sep
    s = s.replace(".", "")
    
    # Replace comma decimal separator with dot
    s = s.replace(",", ".")
    
    # Final check - should only contain digits, optional minus, and optional decimal point
    if not s or s == "-" or s == ".":
        return None
    
    # Pre-validate: must match a valid number pattern
    # Allows: "123", "-123", "123.45", "-123.45", ".45", "-.45"
    if not re.match(r'^-?\d*\.?\d+$', s):
        log.warning(f"Invalid number format: '{value}' -> '{s}'")
        return None
    
    try:
        return Decimal(s)
    except Exception as e:
        log.warning(f"Decimal conversion failed: '{value}' -> '{s}': {e}")
        return None


def parse_date(value: str) -> Optional[datetime]:
    """
    Parse date in DD/MM/YYYY HH:MM:SS format.
    """
    if not value or pd.isna(value):
        return None
    
    s = str(value).strip()
    
    # Try different formats
    formats = [
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    
    return None


def extract_ticker_from_symbol(symbol: str) -> tuple[str, str]:
    """
    Extract ticker and label from symbol format "Name (TICKER)".
    
    Examples:
        "MSCI World (MWRD.PA)" -> ("MWRD.PA", "MSCI World")
        "Crypto Bitcoin (ETN) (WBIT.DE)" -> ("WBIT.DE", "Crypto Bitcoin (ETN)")
        "FEES:AV:PD (_FEES:AV:PD)" -> ("_FEES:AV:PD", "FEES:AV:PD")
    
    Returns:
        (ticker, label) tuple
    """
    if not symbol or pd.isna(symbol):
        return ("", "")
    
    s = str(symbol).strip()
    
    # Match the last parenthetical group as the ticker
    match = re.match(r"^(.+?)\s*\(([^)]+)\)\s*$", s)
    if match:
        label = match.group(1).strip()
        ticker = match.group(2).strip()
        return (ticker, label)
    
    # No parentheses - use whole string as both
    return (s, s)


def extract_account_parts(account: str) -> tuple[str, str]:
    """
    Extract account type prefix and name from "TYPE(NAME)" format.
    
    Examples:
        "AV(LINXEA1)" -> ("AV", "LINXEA1")
        "CTO(DEGIRO)" -> ("CTO", "DEGIRO")
        "PEA(BOURSD)" -> ("PEA", "BOURSD")
        "ES(GRPMA)" -> ("ES", "GRPMA")
    
    Returns:
        (type_prefix, name) tuple
    """
    if not account or pd.isna(account):
        return ("", "")
    
    s = str(account).strip()
    
    match = re.match(r"^(\w+)\(([^)]+)\)$", s)
    if match:
        return (match.group(1), match.group(2))
    
    return ("", s)


def generate_transaction_id(
    date: Optional[datetime],
    account_code: str,
    asset_ticker: str,
    quantity: Optional[Decimal],
    price: Optional[Decimal]
) -> str:
    """
    Generate a deterministic transaction ID from key fields.
    
    Uses SHA256 hash of (date, account, asset, quantity, price) for idempotent imports.
    """
    parts = [
        date.isoformat() if date else "",
        account_code,
        asset_ticker,
        str(quantity) if quantity else "",
        str(price) if price else "",
    ]
    combined = "|".join(parts)
    return hashlib.sha256(combined.encode()).hexdigest()[:32]


@dataclass
class ParsedTransaction:
    """Parsed transaction data from CSV row."""
    date_time: Optional[datetime]
    transaction_type: str  # "Buy" or "Sell"
    asset_ticker: str  # Extracted ticker (e.g., "MWRD.PA")
    asset_label: str  # Full name (e.g., "MSCI World")
    quantity: Optional[Decimal]
    price: Optional[Decimal]
    fee: Optional[Decimal]
    account_code: str  # Full code (e.g., "AV(LINXEA1)")
    account_type_prefix: str  # Extracted prefix (e.g., "AV")
    account_name: str  # Extracted name (e.g., "LINXEA1")
    source_transaction_id: str  # Generated hash for idempotency
    is_fee_transaction: bool  # True if this is a FEES:* transaction
    raw_row: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TradesLoadResult:
    """Result of loading and parsing a trades CSV file."""
    transactions: List[ParsedTransaction]
    unique_accounts: Set[str]  # Unique account codes
    unique_assets: Set[str]  # Unique asset tickers (excluding FEES)
    errors: List[Dict[str, Any]]
    warnings: List[str]
    
    @property
    def stats(self) -> Dict[str, int]:
        """Return parsing statistics."""
        return {
            "total_transactions": len(self.transactions),
            "unique_accounts": len(self.unique_accounts),
            "unique_assets": len(self.unique_assets),
            "fee_transactions": sum(1 for t in self.transactions if t.is_fee_transaction),
            "errors": len(self.errors),
            "warnings": len(self.warnings),
        }


class TradesCSVLoader:
    """
    Loader for trades CSV files.
    
    Parses trade transactions with European number format and extracts
    account/asset metadata from the standard trades CSV format.
    """
    
    # Column name mappings (flexible matching)
    COLUMN_MAPPINGS = {
        "date": ["Date (MM-DD-YYYY)", "Date", "date", "DateTime"],
        "transaction_type": ["Transaction Type", "Type", "transaction_type", "Side"],
        "symbol": ["Asset", "Stock / ETF Symbol", "Symbol", "symbol"],
        "quantity": ["Quantity", "Quantity of Units", "quantity", "Amount"],
        "price": ["Unit Price", "Amount per unit", "Price", "price"],
        "fee": ["Trading Fees", "Fee", "Fees", "fee", "Commission"],
        "account": ["Investment Account", "Account", "account", "Portfolio"],
    }
    
    def __init__(self):
        self.errors: List[Dict[str, Any]] = []
        self.warnings: List[str] = []
    
    def load(self, file_path: str | Path) -> TradesLoadResult:
        """
        Load and parse a trades CSV file.
        
        Args:
            file_path: Path to the CSV file
            
        Returns:
            TradesLoadResult with parsed transactions and any errors
        """
        self.errors = []
        self.warnings = []
        
        log.info("loading_trades_csv", file_path=str(file_path))
        
        try:
            df = pd.read_csv(file_path, keep_default_na=False, na_values=[''])
        except Exception as e:
            log.error("csv_read_error", error=str(e))
            return TradesLoadResult(
                transactions=[],
                unique_accounts=set(),
                unique_assets=set(),
                errors=[{"row": 0, "error": f"Failed to read CSV: {str(e)}"}],
                warnings=[]
            )
        
        return self._parse_dataframe(df)
    
    def load_from_content(self, content: str | bytes) -> TradesLoadResult:
        """
        Load and parse CSV from string or bytes content.
        
        Args:
            content: CSV content as string or bytes
            
        Returns:
            TradesLoadResult with parsed transactions and any errors
        """
        self.errors = []
        self.warnings = []
        
        log.info("loading_trades_csv_from_content")
        
        try:
            if isinstance(content, bytes):
                buffer = BytesIO(content)
            else:
                buffer = StringIO(content)
            
            df = pd.read_csv(buffer, keep_default_na=False, na_values=[''])
        except Exception as e:
            log.error("csv_read_error", error=str(e))
            return TradesLoadResult(
                transactions=[],
                unique_accounts=set(),
                unique_assets=set(),
                errors=[{"row": 0, "error": f"Failed to read CSV: {str(e)}"}],
                warnings=[]
            )
        
        return self._parse_dataframe(df)
    
    def _find_column(self, df: pd.DataFrame, field_name: str) -> Optional[str]:
        """Find the actual column name in the DataFrame."""
        possible_names = self.COLUMN_MAPPINGS.get(field_name, [])
        for name in possible_names:
            if name in df.columns:
                return name
        return None
    
    def _parse_dataframe(self, df: pd.DataFrame) -> TradesLoadResult:
        """Parse DataFrame into TradesLoadResult."""
        transactions: List[ParsedTransaction] = []
        unique_accounts: Set[str] = set()
        unique_assets: Set[str] = set()
        
        # Find columns
        col_map = {}
        for field_name in self.COLUMN_MAPPINGS.keys():
            col_map[field_name] = self._find_column(df, field_name)
        
        # Validate required columns
        required = ["date", "transaction_type", "symbol", "account"]
        missing = [f for f in required if col_map.get(f) is None]
        if missing:
            self.errors.append({
                "row": 0,
                "error": f"Missing required columns: {missing}"
            })
            return TradesLoadResult(
                transactions=[],
                unique_accounts=set(),
                unique_assets=set(),
                errors=self.errors,
                warnings=self.warnings
            )
        
        log.info("parsing_rows", total_rows=len(df))
        
        # Parse each row
        for idx, row in df.iterrows():
            row_num = idx + 2  # Account for header and 0-indexing
            
            try:
                parsed = self._parse_row(row, col_map, row_num)
                if parsed:
                    transactions.append(parsed)
                    unique_accounts.add(parsed.account_code)
                    
                    # Only track non-FEES assets
                    if not parsed.is_fee_transaction:
                        unique_assets.add(parsed.asset_ticker)
                        
            except Exception as e:
                self.errors.append({
                    "row": row_num,
                    "error": str(e),
                    "data": dict(row)
                })
        
        log.info("parsing_complete",
                 transactions=len(transactions),
                 accounts=len(unique_accounts),
                 assets=len(unique_assets),
                 errors=len(self.errors))
        
        return TradesLoadResult(
            transactions=transactions,
            unique_accounts=unique_accounts,
            unique_assets=unique_assets,
            errors=self.errors,
            warnings=self.warnings
        )
    
    def _parse_row(
        self, 
        row: pd.Series, 
        col_map: Dict[str, Optional[str]], 
        row_num: int
    ) -> Optional[ParsedTransaction]:
        """Parse a single row into a ParsedTransaction."""
        
        def get_val(field: str) -> Any:
            col = col_map.get(field)
            return row[col] if col and col in row else None
        
        # Extract raw values
        date_raw = get_val("date")
        tx_type = str(get_val("transaction_type") or "").strip()
        symbol_raw = str(get_val("symbol") or "").strip()
        quantity_raw = get_val("quantity")
        price_raw = get_val("price")
        fee_raw = get_val("fee")
        account_raw = str(get_val("account") or "").strip()
        
        # Skip empty rows
        if not symbol_raw or not account_raw:
            return None
        
        # Parse values
        date_time = parse_date(date_raw)
        quantity = parse_european_number(quantity_raw)
        price = parse_european_number(price_raw)
        fee = parse_european_number(fee_raw)
        
        # Extract ticker and label from symbol
        asset_ticker, asset_label = extract_ticker_from_symbol(symbol_raw)
        
        # Extract account parts
        account_type_prefix, account_name = extract_account_parts(account_raw)
        
        # Check if this is a FEES transaction
        is_fee_transaction = asset_ticker.startswith("_FEES:") or asset_label.startswith("FEES:")
        
        # Generate transaction ID
        source_transaction_id = generate_transaction_id(
            date_time, account_raw, asset_ticker, quantity, price
        )
        
        # Validation warnings
        if date_time is None:
            self.warnings.append(f"Row {row_num}: Could not parse date '{date_raw}'")
        
        if quantity is None and not is_fee_transaction:
            self.warnings.append(f"Row {row_num}: Could not parse quantity '{quantity_raw}'")
        
        return ParsedTransaction(
            date_time=date_time,
            transaction_type=tx_type,
            asset_ticker=asset_ticker,
            asset_label=asset_label,
            quantity=quantity,
            price=price,
            fee=fee,
            account_code=account_raw,
            account_type_prefix=account_type_prefix,
            account_name=account_name,
            source_transaction_id=source_transaction_id,
            is_fee_transaction=is_fee_transaction,
            raw_row=dict(row)
        )
