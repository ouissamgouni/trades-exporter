"""
OKX Trades File-based connector: Load trade history from OKX CSV export files.
Follows the same pipeline as OKXConnectorTrx and OKXConvertConnector (yield_raws → raw_to_normalized → pipeline).
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("okx_trades_file")


class OKXTradesFileConnector(BaseConnector):
    """
    OKX trades file-based connector that loads trade history from CSV export files.
    
    Follows the same pipeline as OKXConnectorTrx and OKXConvertConnector:
    - yield_raws(): Yields raw dicts from parsed CSV file
    - raw_to_normalized(): Converts okx_trades_loader format to NormalizedTransaction
    - Pipeline: enrichment, persistence via raw_transactions table
    
    Handles both regular spot trades and convert trades:
    - Regular trades: Direction inflow, transaction_type trade
    - Convert trades: Direction inflow, transaction_type trade, tags {"type": "convert"}
    
    Config options:
    - file_path: Path to the CSV file to import (required in file mode)
    - file_import_id: Database ID of the FileImport record for tracking
    - sync_mode: "file" for file-based import
    
    Lifecycle:
    - On processing start: FileImport status -> "processing"
    - On success: FileImport status -> "completed", file kept for retention
    - On failure: FileImport status -> "failed", file kept for retry
    """

    @property
    def connector_name(self) -> str:
        return "okx_trades_file"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize OKX trades file connector.
        
        Args:
            account_id: The Account ID this connector belongs to
            connector_id: The AccountConnector ID
            config: Connector config dict containing:
                - file_path: Path to CSV file to import
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
            log.info(f"📁 OKX trades file connector initialized with file: {self._file_path}")
            if self._file_import_id:
                log.info(f"📝 File import ID: {self._file_import_id}")
        else:
            log.warning("⚠️ OKX trades file connector initialized without file_path")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """
        Load and parse the CSV file using okx_trades_loader.
        
        Returns:
            List of trade dicts from the parsed file
        """
        if self._cached_data is not None:
            return self._cached_data
        
        if not self._file_path:
            raise ValueError("No file uploaded — upload a file before syncing")
        
        try:
            from backend.file_loaders.okx_trades_loader import load_okx_trades_file
            
            log.info(f"📂 Loading OKX trades from: {self._file_path}")
            df = load_okx_trades_file(self._file_path)
            
            if df.empty:
                log.warning("⚠️ No trades found in file")
                return []
            
            # Convert DataFrame to list of dicts
            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} trades from file")
            
            return self._cached_data
            
        except Exception as e:
            log.error(f"❌ Failed to load OKX trades file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw trade data from the CSV file.
        
        Yields:
            Dict[str, Any]: Trade dictionaries from okx_trades_loader format
        """
        data = self._load_file_data()
        
        if not data:
            log.warning("⚠️ No data to yield from OKX trades file")
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
            
            yield row
            
            # Update progress every 50 rows
            if (idx + 1) % 50 == 0 or idx == total - 1:
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
        
        # Mark processing as successful so cleanup knows to update status
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
        
        - On success: Mark FileImport as completed, keep file for retention period
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
        Convert an okx_trades_loader row to NormalizedTransaction.
        
        Handles both regular spot trades and convert trades.
        All trades are treated as inflow with direction="inflow" and source_transaction_type="buy".
        
        okx_trades_loader format:
        {
            'datetime': Timestamp('2025-10-12 11:55:44+0000'),
            'transaction_id': '923433',
            'instrument': 'Spot',
            'symbol': 'USDC-EUR',  # or 'BTC-EUR-CONVERT' for convert trades
            'base_asset': 'USDC',
            'quantity': 16.1864,
            'price': 0.87060000,
            'quote_asset': 'EUR',
            'total': 14.09188855,
            'fee': 0.00000000,
            'fee_currency': 'USDC'
        }
        
        Returns:
            NormalizedTransaction: Normalized transaction object
        """
        try:
            # Extract fields from okx_trades_loader format
            transaction_id = str(raw_item.get("transaction_id", ""))
            if not transaction_id:
                raise ValueError("Missing 'transaction_id' field")
            
            base_asset = str(raw_item.get("base_asset", "")).upper()
            if not base_asset:
                raise ValueError("Missing 'base_asset' field")
            
            quote_asset = str(raw_item.get("quote_asset", "")).upper()
            if not quote_asset:
                raise ValueError("Missing 'quote_asset' field")
            
            quantity = raw_item.get("quantity")
            if quantity is None:
                raise ValueError("Missing or invalid 'quantity' field")
            quantity = float(quantity)
            
            price = raw_item.get("price")
            if price is None:
                raise ValueError("Missing or invalid 'price' field")
            price = float(price)
            
            total = raw_item.get("total")
            if total is None:
                raise ValueError("Missing or invalid 'total' field")
            total = float(total)
            
            fee = float(raw_item.get("fee", 0))
            fee_currency = str(raw_item.get("fee_currency", quote_asset)).upper()
            
            symbol = str(raw_item.get("symbol", ""))
            instrument = str(raw_item.get("instrument", ""))
            
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
            
            # Detect convert trades and add tag
            tags = {}
            if "CONVERT" in symbol.upper():
                tags["type"] = "convert"
            
            return NormalizedTransaction(
                source="okx-trades-file",
                account_id=self.account_id,
                source_account=self.connector_name,  # Raw account identifier for mapping
                source_transaction_id=transaction_id,
                date_time=dt,
                direction="inflow",  # All trades treated as inflow
                source_transaction_type="buy",  # All trades treated as buy
                transaction_type="trade",
                source_asset_symbol=base_asset,
                quantity=quantity,
                price=price,
                source_price_quote_asset_symbol=quote_asset,
                total=total,
                fee=fee,
                source_fee_quote_asset_symbol=fee_currency,
                tags=tags if tags else None,
            )
            
        except Exception as e:
            error_msg = f"Failed to normalize OKX trade from file: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e
