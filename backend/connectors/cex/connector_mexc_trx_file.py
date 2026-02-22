"""
MEXC File-based connector: Load trades from MEXC XLSX export files.
Follows the same pipeline as MEXCConnectorTrx (yield_raws → raw_to_normalized → pipeline).
"""

import hashlib
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("mexc_file")

# Global sequence counter for within-file duplicate detection
_transaction_id_sequence = defaultdict(int)


def generate_transaction_id(row: Dict[str, Any]) -> str:
    """
    Generate a unique transaction ID from row data for deduplication.
    Uses hash of: datetime + base + quote + quantity + price + type
    
    Uses fixed-precision formatting (8 decimals) to ensure consistent hashes
    across multiple runs with the same data.
    
    For identical rows within the same file (partial order fills), appends
    a sequence counter (_seq_N) to ensure uniqueness while preserving
    detectability by duplicate detection service.
    
    Args:
        row: Dictionary with trade data from mexc_loader
        
    Returns:
        str: Unique transaction ID (hex hash with optional sequence suffix)
    """
    from decimal import Decimal, ROUND_DOWN
    
    # Format datetime consistently (ISO format)
    dt_val = row.get("datetime", "")
    if hasattr(dt_val, "isoformat"):
        dt_str = dt_val.isoformat()
    elif hasattr(dt_val, "to_pydatetime"):
        # pandas Timestamp
        dt_str = dt_val.to_pydatetime().isoformat()
    else:
        dt_str = str(dt_val)
    
    base = str(row.get("base", "")).upper()
    quote = str(row.get("quote", "")).upper()
    
    # Use Decimal with fixed precision for consistent hashing
    quantity = Decimal(str(row.get("quantity", 0))).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )
    price = Decimal(str(row.get("price", 0))).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )
    
    trade_type = str(row.get("type", "")).lower()
    
    unique_str = f"{dt_str}_{base}_{quote}_{quantity}_{price}_{trade_type}"
    
    # Generate MD5 hash (sufficient for deduplication, not security)
    base_hash = hashlib.md5(unique_str.encode()).hexdigest()
    
    # Add sequence counter for within-file duplicates (partial order fills)
    sequence = _transaction_id_sequence[base_hash]
    _transaction_id_sequence[base_hash] += 1
    
    if sequence == 0:
        # First occurrence, no suffix needed
        return base_hash
    else:
        # Subsequent occurrences, append sequence number
        return f"{base_hash}_seq_{sequence}"


class MEXCTrxFileConnector(BaseConnector):
    """
    MEXC file-based connector that loads trades from XLSX export files.
    
    Follows the same pipeline as MEXCConnectorTrx:
    - yield_raws(): Yields raw dicts from parsed Excel file
    - raw_to_normalized(): Converts mexc_loader format to NormalizedTransaction
    - Pipeline: enrichment, persistence via raw_transactions table
    
    Config options:
    - file_path: Path to the XLSX file to import (required in file mode)
    - file_import_id: Database ID of the FileImport record for tracking
    - sync_mode: "file" for file-based import
    
    Lifecycle:
    - On processing start: FileImport status -> "processing"
    - On success: FileImport status -> "completed", file deleted
    - On failure: FileImport status -> "failed", file kept for retry
    """

    @property
    def connector_name(self) -> str:
        return "mexc_trx_file"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize MEXC file connector.
        
        Args:
            account_id: The Account ID this connector belongs to
            connector_id: The AccountConnector ID
            config: Connector config dict containing:
                - file_path: Path to XLSX file to import
                - file_import_id: Database ID for FileImport tracking
            progress_callback: Optional callback for progress reporting
        """
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )
        
        self._file_path = config.get("file_path") if config else None
        self._file_import_id = config.get("file_import_id") if config else None
        self._cached_data: Optional[List[Dict[str, Any]]] = None
        self._processing_success = False  # Track if processing completed successfully
        self._new_count = 0
        self._updated_count = 0
        self._skipped_count = 0
        
        if self._file_path:
            log.info(f"📁 MEXC file connector initialized with file: {self._file_path}")
            if self._file_import_id:
                log.info(f"📝 File import ID: {self._file_import_id}")
        else:
            log.warning("⚠️ MEXC file connector initialized without file_path")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """
        Load and parse the XLSX file using mexc_loader.
        
        Returns:
            List of trade dicts from the parsed file
        """
        if self._cached_data is not None:
            return self._cached_data
        
        if not self._file_path:
            log.error("❌ No file_path configured for MEXC file connector")
            return []
        
        try:
            from backend.file_loaders.mexc_loader import load_mexc_file
            
            log.info(f"📂 Loading MEXC trades from: {self._file_path}")
            df = load_mexc_file(self._file_path)
            
            if df.empty:
                log.warning("⚠️ No trades found in file")
                return []
            
            # Convert DataFrame to list of dicts
            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} trades from file")
            
            return self._cached_data
            
        except Exception as e:
            log.error(f"❌ Failed to load MEXC file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw trade data from the XLSX file.
        
        Yields:
            Dict[str, Any]: Trade dictionaries from mexc_loader format
        """
        data = self._load_file_data()
        
        if not data:
            log.warning("⚠️ No data to yield from MEXC file")
            return
        
        total = len(data)
        log.info(f"🔄 Processing {total} trades from file")
        
        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} trades from file",
            fetched_count=0,
        )
        
        for idx, row in enumerate(data):
            # Check for abort
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping file processing")
                break
            
            # Add generated transaction ID for deduplication
            row["_generated_id"] = generate_transaction_id(row)
            
            yield row
            
            # Update progress every 100 rows
            if (idx + 1) % 100 == 0 or idx == total - 1:
                self.update_progress(
                    operation=f"Processing row {idx + 1}/{total}",
                    current=idx + 1,
                    total=total,
                    fetched_count=idx + 1,
                )
        
        self.update_progress(
            operation="Completed",
            current=total,
            total=total,
            log_message=f"✅ Processed {total} trades from file",
            fetched_count=total,
        )
        log.info(f"✅ Completed processing {total} trades from file")
        
        # Mark processing as successful so cleanup knows to delete file
        self._processing_success = True

    def set_processing_metrics(self, new_count: int, updated_count: int, skipped_count: int):
        """
        Set processing metrics from the pipeline.
        Called by sync job service after processing completes.
        """
        self._new_count = new_count
        self._updated_count = updated_count
        self._skipped_count = skipped_count

    def mark_failed(self, error_message: str):
        """
        Mark the file import as failed.
        Called when an error occurs during processing.
        """
        self._processing_success = False
        if self._file_import_id:
            self._update_file_import_status("failed", error_message=error_message)

    def _update_file_import_status(
        self,
        status: str,
        error_message: str = None,
    ):
        """Update FileImport record in database."""
        if not self._file_import_id:
            return
        
        try:
            from backend.db.database import get_engine
            from sqlmodel import Session
            from backend.db.repositories import FileImportRepository
            
            engine = get_engine()
            with Session(engine) as session:
                repo = FileImportRepository(session)
                
                if status == "completed":
                    repo.mark_completed(
                        self._file_import_id,
                        new_count=self._new_count,
                        updated_count=self._updated_count,
                        skipped_count=self._skipped_count,
                    )
                elif status == "failed":
                    repo.mark_failed(self._file_import_id, error_message or "Unknown error")
                elif status == "processing":
                    repo.mark_processing(self._file_import_id)
                else:
                    repo.update_status(self._file_import_id, status)
                
                session.commit()
                log.info(f"📝 Updated FileImport {self._file_import_id} status to: {status}")
        except Exception as e:
            log.error(f"❌ Failed to update FileImport status: {e}")

    def cleanup(self):
        """
        Cleanup resources and handle file based on processing result.
        
        - On success: Mark FileImport as completed, keep file for 90-day retention
        - On failure: Keep file for retry, mark FileImport as failed
        
        Files are kept for the full retention period (90 days by default) to allow:
        - Preview of completed imports for audit/debugging
        - Re-processing if needed
        Files are cleaned up by the retention cleanup job after retention_expires_at.
        """
        super().cleanup()  # Call parent cleanup for file logger handlers
        
        if self._file_import_id:
            if self._processing_success:
                # Mark completed - keep file for retention period
                self._update_file_import_status("completed")
                log.info(f"📁 Keeping file for retention period: {self._file_path}")
            else:
                # Keep file for retry - don't delete
                log.info(f"📁 Keeping file for retry: {self._file_path}")
        # Note: No file deletion here - files are cleaned up by retention cleanup job

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        """
        Convert a mexc_loader row to NormalizedTransaction.
        
        mexc_loader format:
        {
            'base': 'BTC',
            'quote': 'USDT',
            'datetime': Timestamp('2024-01-15 12:00:00+0000'),
            'fee': 21.0,
            'fee_quote': 'USDT',
            'quantity': 0.5,
            'total': 21000.25,
            'price': 42000.50,
            'type': 'buy',
            'exchange': 'MEXC',
            '_generated_id': 'abc123...'  # Added by yield_raws
        }
        
        Returns:
            NormalizedTransaction: Normalized transaction object
        """
        from backend.core.utils import compute_trade_content_hash
        
        try:
            # Extract fields from mexc_loader format
            base = str(raw_item.get("base", "")).upper()
            quote = str(raw_item.get("quote", "")).upper()
            
            if not base or not quote:
                raise ValueError(f"Invalid base or quote: base='{base}', quote='{quote}'")
            
            # Parse datetime (pandas Timestamp or datetime)
            dt_value = raw_item.get("datetime")
            if hasattr(dt_value, "to_pydatetime"):
                # pandas Timestamp
                dt = dt_value.to_pydatetime()
            elif isinstance(dt_value, datetime):
                dt = dt_value
            else:
                dt = datetime.fromisoformat(str(dt_value))
            
            # Ensure timezone awareness
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            
            # Extract trade data
            quantity = float(raw_item.get("quantity", 0))
            price = float(raw_item.get("price", 0))
            total = float(raw_item.get("total", 0))
            trade_type = str(raw_item.get("type", "")).lower()
            
            if trade_type not in ["buy", "sell"]:
                raise ValueError(f"Unexpected trade type: '{trade_type}'")
            
            # Fee handling
            fee = float(raw_item.get("fee", 0)) if raw_item.get("fee") else 0
            fee_quote = str(raw_item.get("fee_quote", "")).upper() if raw_item.get("fee_quote") else quote
            
            # Use generated ID for source-specific deduplication
            transaction_id = raw_item.get("_generated_id", generate_transaction_id(raw_item))
            
            # Compute content hash for cross-source deduplication
            # (same formula as API connector for matching trades)
            content_hash = compute_trade_content_hash(
                dt=dt,
                base=base,
                quote=quote,
                quantity=quantity,
                price=price,
                side=trade_type,
            )
            
            return NormalizedTransaction(
                source="mexc-transactions-file",
                account_id=self.account_id,
                source_account=self.connector_name,
                source_transaction_id=transaction_id,
                date_time=dt,
                direction="inflow" if trade_type == "buy" else "outflow",
                transaction_type="trade",
                source_transaction_type=trade_type,
                source_asset_symbol=base,
                quantity=quantity,
                price=price,
                total=total,
                source_price_quote_asset_symbol=quote,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
                content_hash=content_hash,
            )
            
        except Exception as e:
            error_msg = f"Failed to normalize MEXC file trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e


# Integration tests:
# pytest tests/integration/exchanges/test_connector_mexc_file.py -v
