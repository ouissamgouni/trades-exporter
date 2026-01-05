"""
Asset CSV Loader.

Parses CSV files containing asset definitions with multi-source price getter
configurations and category assignments.

Expected CSV format:
    Unique Label,Ticker / Symbol,Label,Source 1,Symbol 1,Source 2,Symbol 2,Source 3,Symbol 3,Currency,Investment Category 2,Investment Category 1

Usage:
    from backend.file_loaders.asset_csv_loader import AssetCSVLoader
    
    loader = AssetCSVLoader()
    result = loader.load("path/to/assets.csv")
    
    # result contains:
    # - assets: List of parsed asset data
    # - categories: Set of unique category definitions
    # - errors: List of parsing errors
"""

import pandas as pd
from pathlib import Path
from typing import List, Dict, Any, Set, Tuple, Optional
from dataclasses import dataclass, field
from io import StringIO, BytesIO

from backend.config.loader import configure_logging

log = configure_logging("asset_csv_loader")


# Mapping from CSV source names to internal price getter names
SOURCE_TO_GETTER_MAP = {
    "coingecko": "coingecko",
    "yahoo": "yahoo",
    "yahoo to eur": "yahoo",  # Yahoo with EUR conversion
    "alphavantage": "datareader",  # Use datareader as fallback
    "marketstack": "datareader",  # Use datareader as fallback
    "eodhd": "datareader",  # Use datareader as fallback
    "google finance": "yahoo",  # Use yahoo as fallback
    "manual": None,  # No automatic price fetching
}


@dataclass
class PriceGetterConfig:
    """Configuration for a single price getter."""
    price_getter: str
    priority: int
    external_id: Optional[str] = None  # API identifier: "BTC-USD", "bitcoin", "AAPL"
    enabled: bool = True
    params: Dict[str, Any] = field(default_factory=dict)  # Extra params


@dataclass
class CategoryDefinition:
    """Definition for a category to be created."""
    dimension: str  # Kept for backward compatibility (mapped to dimension_label)
    dimension_label: str
    key: str  # Kept for backward compatibility (mapped from label)
    label: str


@dataclass
class ParsedAsset:
    """Parsed asset data from CSV row."""
    symbol: str
    label: str
    price_type: str
    currency: str
    price_getters: List[PriceGetterConfig]
    category_keys: List[Tuple[str, str, Optional[str]]]  # (dimension_label, category_label, parent_label) tuples
    raw_row: Dict[str, Any] = field(default_factory=dict)


@dataclass 
class LoadResult:
    """Result of loading and parsing a CSV file."""
    assets: List[ParsedAsset]
    categories: List[CategoryDefinition]
    errors: List[Dict[str, Any]]
    warnings: List[str]


class AssetCSVLoader:
    """
    Loader for asset CSV files.
    
    Parses multi-source price getter configurations and category assignments
    from the standard asset CSV format.
    """
    
    # Column name mappings (flexible matching)
    COLUMN_MAPPINGS = {
        "symbol": ["Ticker / Symbol", "Symbol", "Ticker", "symbol"],
        "label": ["Label", "Name", "label", "name"],
        "unique_label": ["Unique Label", "unique_label"],
        "currency": ["Currency", "currency", "Base Currency"],
        "category_1": ["Investment Category 1", "Category 1", "Asset Class"],
        "category_2": ["Investment Category 2", "Category 2", "Sector"],
        "source_1": ["Source 1", "source_1", "Price Source 1"],
        "symbol_1": ["Symbol 1", "symbol_1", "Ticker 1"],
        "source_2": ["Source 2", "source_2", "Price Source 2"],
        "symbol_2": ["Symbol 2", "symbol_2", "Ticker 2"],
        "source_3": ["Source 3", "source_3", "Price Source 3"],
        "symbol_3": ["Symbol 3", "symbol_3", "Ticker 3"],
    }
    
    def __init__(self):
        self.errors: List[Dict[str, Any]] = []
        self.warnings: List[str] = []
    
    def load(self, file_path: str | Path) -> LoadResult:
        """
        Load and parse an asset CSV file.
        
        Args:
            file_path: Path to the CSV file
            
        Returns:
            LoadResult with parsed assets, categories, and any errors
        """
        self.errors = []
        self.warnings = []
        
        log.info("loading_asset_csv", file_path=str(file_path))
        
        try:
            df = pd.read_csv(file_path, keep_default_na=False, na_values=[''])
        except Exception as e:
            log.error("csv_read_error", error=str(e))
            return LoadResult(
                assets=[],
                categories=[],
                errors=[{"row": 0, "error": f"Failed to read CSV: {str(e)}"}],
                warnings=[]
            )
        
        return self._parse_dataframe(df)
    
    def load_from_content(self, content: str | bytes) -> LoadResult:
        """
        Load and parse CSV from string or bytes content.
        
        Args:
            content: CSV content as string or bytes
            
        Returns:
            LoadResult with parsed assets, categories, and any errors
        """
        self.errors = []
        self.warnings = []
        
        log.info("loading_asset_csv_from_content")
        
        try:
            if isinstance(content, bytes):
                df = pd.read_csv(BytesIO(content), keep_default_na=False, na_values=[''])
            else:
                df = pd.read_csv(StringIO(content), keep_default_na=False, na_values=[''])
        except Exception as e:
            log.error("csv_parse_error", error=str(e))
            return LoadResult(
                assets=[],
                categories=[],
                errors=[{"row": 0, "error": f"Failed to parse CSV: {str(e)}"}],
                warnings=[]
            )
        
        return self._parse_dataframe(df)
    
    def _parse_dataframe(self, df: pd.DataFrame) -> LoadResult:
        """Parse a pandas DataFrame into assets and categories."""
        
        # Map columns to standard names
        column_map = self._map_columns(df.columns.tolist())
        
        if "symbol" not in column_map:
            return LoadResult(
                assets=[],
                categories=[],
                errors=[{"row": 0, "error": "Missing required column: Ticker / Symbol"}],
                warnings=self.warnings
            )
        
        assets: List[ParsedAsset] = []
        categories_set: Set[Tuple[str, str]] = set()  # (dimension_label, category_label)
        
        for idx, row in df.iterrows():
            row_num = idx + 2  # 1-indexed, plus header row
            
            try:
                parsed = self._parse_row(row, column_map, row_num)
                if parsed:
                    assets.append(parsed)
                    
                    # Collect category definitions (now flat, no hierarchy)
                    for dim_label, cat_label, _ in parsed.category_keys:
                        if cat_label:
                            categories_set.add((dim_label, cat_label))
                            
            except Exception as e:
                self.errors.append({
                    "row": row_num,
                    "symbol": row.get(column_map.get("symbol", ""), "unknown"),
                    "error": str(e)
                })
                log.warning("row_parse_error", row=row_num, error=str(e))
        
        # Build category definitions (each dimension is separate)
        categories = [
            CategoryDefinition(
                dimension=dim_label.lower().replace(' ', '_'),  # Generate key for backward compat
                dimension_label=dim_label,
                key=cat_label.lower().replace(' ', '_').replace('/', '_'),  # Generate key for backward compat
                label=cat_label
            )
            for dim_label, cat_label in categories_set
            if cat_label  # Skip empty labels
        ]
        
        log.info("csv_parsing_complete", 
                 assets_count=len(assets),
                 categories_count=len(categories),
                 errors_count=len(self.errors))
        
        return LoadResult(
            assets=assets,
            categories=categories,
            errors=self.errors,
            warnings=self.warnings
        )
    
    def _map_columns(self, columns: List[str]) -> Dict[str, str]:
        """Map CSV column names to standard names."""
        result = {}
        
        for standard_name, possible_names in self.COLUMN_MAPPINGS.items():
            for col in columns:
                if col in possible_names or col.strip().lower() in [p.lower() for p in possible_names]:
                    result[standard_name] = col
                    break
        
        # Log unmapped columns
        mapped_cols = set(result.values())
        unmapped = [c for c in columns if c not in mapped_cols]
        if unmapped:
            log.debug("unmapped_columns", columns=unmapped)
        
        return result
    
    def _parse_row(self, row: pd.Series, column_map: Dict[str, str], row_num: int) -> Optional[ParsedAsset]:
        """Parse a single CSV row into a ParsedAsset."""
        
        # Get symbol (required)
        symbol = str(row.get(column_map.get("symbol", ""), "")).strip()
        if not symbol:
            self.warnings.append(f"Row {row_num}: Empty symbol, skipping")
            return None
        
        # Get label
        label = str(row.get(column_map.get("label", ""), "")).strip() or symbol
        
        # Get currency
        currency = str(row.get(column_map.get("currency", ""), "EUR")).strip() or "EUR"
        
        # Determine price type from category or symbol patterns
        category_1 = str(row.get(column_map.get("category_1", ""), "")).strip()
        price_type = self._infer_price_type(category_1, symbol)
        
        # Parse price getters from Source 1/2/3 columns
        price_getters = self._parse_price_getters(row, column_map, symbol)
        
        # Parse categories
        category_keys = self._parse_categories(row, column_map)
        
        return ParsedAsset(
            symbol=symbol,
            label=label,
            price_type=price_type,
            currency=currency,
            price_getters=price_getters,
            category_keys=category_keys,
            raw_row=row.to_dict()
        )
    
    def _infer_price_type(self, category: str, symbol: str) -> str:
        """Infer price type from category or symbol."""
        category_lower = category.lower()
        symbol_lower = symbol.lower()
        
        # Crypto indicators
        if "crypto" in category_lower or "digital assets" in category_lower:
            return "crypto"
        
        # Fiat indicators
        if symbol in ["EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD"]:
            return "fiat"
        
        # Stock/ETF indicators
        if any(x in category_lower for x in ["equities", "bonds", "real assets", "fixed income"]):
            return "stock"
        
        # Symbol patterns
        if "." in symbol:  # e.g., AAPL.PA, BTC.DE
            return "stock"
        
        # Default to stock for traditional assets
        return "stock"
    
    def _parse_price_getters(self, row: pd.Series, column_map: Dict[str, str], asset_symbol: str) -> List[PriceGetterConfig]:
        """Parse price getter configurations from Source columns."""
        getters = []
        
        for i in range(1, 4):  # Source 1, 2, 3
            source_col = column_map.get(f"source_{i}")
            symbol_col = column_map.get(f"symbol_{i}")
            
            if not source_col:
                continue
            
            source_value = row.get(source_col, "")
            # Handle NaN/None values from pandas
            if pd.isna(source_value) or source_value is None:
                continue
            
            source_name = str(source_value).strip().lower()
            
            # Skip empty or "nan" values
            if not source_name or source_name == "nan" or source_name == "manual":
                continue
            
            # Get symbol value, also handling NaN
            source_symbol = ""
            if symbol_col:
                symbol_value = row.get(symbol_col, "")
                if not pd.isna(symbol_value) and symbol_value is not None:
                    source_symbol = str(symbol_value).strip()
            
            # Map source name to getter
            getter_name = SOURCE_TO_GETTER_MAP.get(source_name)
            if not getter_name:
                self.warnings.append(f"Unknown source '{source_name}' for {asset_symbol}, skipping")
                continue
            
            # Build external_id and params based on getter type
            external_id, params = self._build_getter_params(getter_name, source_name, source_symbol, asset_symbol)
            
            getters.append(PriceGetterConfig(
                price_getter=getter_name,
                priority=i,  # Source 1 = priority 1 (highest)
                external_id=external_id,
                enabled=True,
                params=params
            ))
        
        return getters
    
    def _build_getter_params(self, getter_name: str, source_name: str, source_symbol: str, asset_symbol: str) -> Tuple[Optional[str], Dict[str, Any]]:
        """Build external_id and extra params for a price getter.
        
        Returns:
            Tuple of (external_id, extra_params)
        """
        params: Dict[str, Any] = {}
        
        # Use source symbol if provided, otherwise use asset symbol
        effective_symbol = source_symbol if source_symbol else asset_symbol
        
        # external_id is the primary API identifier
        external_id = effective_symbol if effective_symbol else None
        
        if getter_name == "coingecko":
            # CoinGecko uses lowercase coin IDs like "bitcoin", "ethereum"
            if external_id:
                external_id = external_id.lower()
            
        elif getter_name == "yahoo":
            # Yahoo uses ticker like "BTC-USD", "AAPL"
            # Check if EUR conversion needed
            if "to eur" in source_name.lower():
                params["native_quote_currency"] = "EUR"
                
        elif getter_name == "datareader":
            # DataReader uses ticker
            params["source"] = "stooq"  # Default source
        
        return external_id, params
    
    def _parse_categories(self, row: pd.Series, column_map: Dict[str, str]) -> List[Tuple[str, str, Optional[str]]]:
        """Parse category assignments from Investment Category columns.
        
        Returns (dimension_label, category_label, parent_label) tuples.
        Investment Category 1 -> 'Sector' dimension
        Investment Category 2 -> 'Sub-Sector' dimension
        """
        categories = []
        
        # Investment Category 1 -> Sector dimension
        cat_1 = str(row.get(column_map.get("category_1", ""), "")).strip()
        if cat_1:
            categories.append(("Sector", cat_1, None))
        
        # Investment Category 2 -> Sub-Sector dimension
        cat_2 = str(row.get(column_map.get("category_2", ""), "")).strip()
        if cat_2:
            categories.append(("Sub-Sector", cat_2, None))
        
        return categories
    
    def _category_label_to_key(self, label: str) -> str:
        """Convert category label to a key (lowercase, underscored). Deprecated - kept for compatibility."""
        return label.lower().replace(" / ", "_").replace(" ", "_").replace("|", "_").replace("&", "and")
