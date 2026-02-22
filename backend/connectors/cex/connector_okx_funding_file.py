"""
OKX Funding History File-based connector: Load deposits and withdrawals from OKX CSV export files.
Follows the same pipeline as MEXCDepositsFileConnector (yield_raws → raw_to_normalized → pipeline).
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("okx_funding_file")


class OKXFundingFileConnector(BaseConnector):
    """
    OKX funding history file-based connector that loads deposits and withdrawals from CSV export files.
    
    Follows the same pipeline as MEXCDepositsFileConnector:
    - yield_raws(): Yields raw dicts from parsed CSV file
    - raw_to_normalized(): Converts okx_funding_loader format to NormalizedTransaction
    - Pipeline: enrichment, persistence via raw_transactions table
    
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
        return "okx_funding_file"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize OKX funding history file connector.
        
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
            log.info(f"📁 OKX funding file connector initialized with file: {self._file_path}")
            if self._file_import_id:
                log.info(f"📝 File import ID: {self._file_import_id}")
        else:
            log.warning("⚠️ OKX funding file connector initialized without file_path")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """
        Load and parse the CSV file using okx_funding_loader.
        
        Returns:
            List of funding transaction dicts from the parsed file
        """
        if self._cached_data is not None:
            return self._cached_data
        
        if not self._file_path:
            raise ValueError("No file uploaded — upload a file before syncing")
        
        try:
            from backend.file_loaders.okx_funding_loader import load_okx_funding_file
            
            log.info(f"📂 Loading OKX funding history from: {self._file_path}")
            df = load_okx_funding_file(self._file_path)
            
            if df.empty:
                log.warning("⚠️ No funding transactions found in file")
                return []
            
            # Convert DataFrame to list of dicts
            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} funding transactions from file")
            
            return self._cached_data
            
        except Exception as e:
            log.error(f"❌ Failed to load OKX funding file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw funding transaction data from the CSV file.
        
        Yields:
            Dict[str, Any]: Funding transaction dictionaries from okx_funding_loader format
        """
        data = self._load_file_data()
        
        if not data:
            log.warning("⚠️ No data to yield from OKX funding file")
            return
        
        total = len(data)
        log.info(f"🔄 Processing {total} funding transactions from file")
        
        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} funding transactions from file",
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
            log_message=f"✅ Processed {total} funding transactions from file",
            fetched_count=total,
        )
        log.info(f"✅ Completed processing {total} funding transactions from file")
        
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
        Convert an okx_funding_loader row to NormalizedTransaction.
        
        okx_funding_loader format:
        {
            'datetime': Timestamp('2025-10-12 12:37:15+0000'),
            'transaction_id': '10018451232',
            'transaction_type': 'withdrawal',  # or 'deposit'
            'currency': 'USDC',
            'amount': 575.033331,  # Always positive (absolute value)
            'before_balance': 575.033331,
            'after_balance': 0.0
        }
        
        Returns:
            NormalizedTransaction: Normalized transaction object
        """
        try:
            # Extract fields from okx_funding_loader format
            transaction_id = str(raw_item.get("transaction_id", ""))
            if not transaction_id:
                raise ValueError("Missing 'transaction_id' field")
            
            transaction_type = str(raw_item.get("transaction_type", "")).lower()
            if transaction_type not in ("deposit", "withdrawal"):
                raise ValueError(f"Invalid transaction_type: {transaction_type}")
            
            currency = str(raw_item.get("currency", "")).upper()
            if not currency:
                raise ValueError("Missing 'currency' field")
            
            amount = raw_item.get("amount")
            if amount is None:
                raise ValueError("Missing or invalid 'amount' field")
            amount = float(amount)
            
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
            
            # Fee is not available in funding history exports - set to 0
            fee = 0.0
            fee_quote = currency
            
            # Determine direction based on transaction type
            direction = "inflow" if transaction_type == "deposit" else "outflow"
            
            # Set account fields based on direction
            if direction == "inflow":
                # For deposits, destination is the connector's account
                source_to_account = self._get_account_identifier()
                to_account_id = self.account_id
                source_from_account = None
                from_account_id = None
            else:
                # For withdrawals, source is the connector's account
                source_from_account = self._get_account_identifier()
                from_account_id = self.account_id
                source_to_account = None
                to_account_id = None
            
            return NormalizedTransaction(
                source="okx-funding-file",
                account_id=self.account_id,
                source_account=self.connector_name,  # Raw account identifier for mapping
                source_transaction_id=transaction_id,  # Transaction ID from CSV
                date_time=dt,
                direction=direction,
                source_transaction_type=transaction_type,
                transaction_type="transfer",  # Deposits and withdrawals are transfers
                source_asset_symbol=currency,
                quantity=amount,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
                source_from_account=source_from_account,
                from_account_id=from_account_id,
                source_to_account=source_to_account,
                to_account_id=to_account_id,
            )
            
        except Exception as e:
            error_msg = f"Failed to normalize OKX funding transaction from file: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e


# Integration tests:
# pytest tests/integration/exchanges/test_connector_okx_funding_file.py -v
