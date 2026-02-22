"""
MEXC Withdrawals File-based connector: Load withdrawals from MEXC XLSX export files.
Follows the same pipeline as MEXCDepositsFileConnector (yield_raws → raw_to_normalized → pipeline).
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.core.network_normalizer import normalize_network

log = configure_logging("mexc_withdrawals_file")


class MEXCWithdrawalsFileConnector(BaseConnector):
    """
    MEXC withdrawals file-based connector that loads withdrawals from XLSX export files.
    
    Follows the same pipeline as MEXCDepositsFileConnector:
    - yield_raws(): Yields raw dicts from parsed Excel file
    - raw_to_normalized(): Converts mexc_withdrawals_loader format to NormalizedTransaction
    - Pipeline: enrichment, persistence via raw_transactions table
    
    Config options:
    - file_path: Path to the XLSX file to import (required in file mode)
    - file_import_id: Database ID of the FileImport record for tracking
    - sync_mode: "file" for file-based import
    
    Lifecycle:
    - On processing start: FileImport status -> "processing"
    - On success: FileImport status -> "completed", file kept for retention
    - On failure: FileImport status -> "failed", file kept for retry
    """

    @property
    def connector_name(self) -> str:
        return "mexc_withdrawals_file"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        """
        Initialize MEXC withdrawals file connector.
        
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
            log.info(f"📁 MEXC withdrawals file connector initialized with file: {self._file_path}")
            if self._file_import_id:
                log.info(f"📝 File import ID: {self._file_import_id}")
        else:
            log.warning("⚠️ MEXC withdrawals file connector initialized without file_path")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """
        Load and parse the XLSX file using mexc_withdrawals_loader.
        
        Returns:
            List of withdrawal dicts from the parsed file
        """
        if self._cached_data is not None:
            return self._cached_data
        
        if not self._file_path:
            log.error("❌ No file_path configured for MEXC withdrawals file connector")
            return []
        
        try:
            from backend.file_loaders.mexc_withdrawals_loader import load_mexc_withdrawals_file
            
            log.info(f"📂 Loading MEXC withdrawals from: {self._file_path}")
            df = load_mexc_withdrawals_file(self._file_path)
            
            if df.empty:
                log.warning("⚠️ No withdrawals found in file")
                return []
            
            # Convert DataFrame to list of dicts
            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} withdrawals from file")
            
            return self._cached_data
            
        except Exception as e:
            log.error(f"❌ Failed to load MEXC withdrawals file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """
        Yield raw withdrawal data from the XLSX file.
        
        Yields:
            Dict[str, Any]: Withdrawal dictionaries from mexc_withdrawals_loader format
        """
        data = self._load_file_data()
        
        if not data:
            log.warning("⚠️ No data to yield from MEXC withdrawals file")
            return
        
        total = len(data)
        log.info(f"🔄 Processing {total} withdrawals from file")
        
        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} withdrawals from file",
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
            log_message=f"✅ Processed {total} withdrawals from file",
            fetched_count=total,
        )
        log.info(f"✅ Completed processing {total} withdrawals from file")
        
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
        Convert a mexc_withdrawals_loader row to NormalizedTransaction.
        
        Key differences from deposits:
        - direction = "outflow" (vs "inflow" for deposits)
        - source_transaction_type = "withdrawal" (vs "deposit")
        - source_to_account = withdrawal_address (destination)
        - fee from Trading Fee column (vs 0 for deposits)
        
        mexc_withdrawals_loader format:
        {
            'datetime': Timestamp('2025-11-19 04:11:45+0000'),
            'currency': 'USDT',
            'amount': 260.77232529,
            'txid': '0xdd9b3df2059f5e63113806a9a6692df22362785ee50a4b3e8edccfae404e65d2',
            'network': 'BNB Smart Chain(BEP20)',
            'status': 'Withdrawal Successful',
            'withdrawal_address': '0xf00da769cd5c9c13cc6d35a25de700b26df54d36',
            'fee': 0.01,
            'memo': '--'
        }
        
        Returns:
            NormalizedTransaction: Normalized transaction object
        """
        try:
            # Extract fields from mexc_withdrawals_loader format
            currency = str(raw_item.get("currency", "")).upper()
            if not currency:
                raise ValueError("Missing 'currency' field")
            
            amount = raw_item.get("amount")
            if amount is None:
                raise ValueError("Missing or invalid 'amount' field")
            amount = float(amount)
            
            # TxID is used as the unique identifier
            txid = str(raw_item.get("txid", ""))
            if not txid:
                raise ValueError("Missing 'txid' field - cannot create unique identifier")
            
            network = normalize_network(raw_item.get("network", ""))
            
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
            
            # Fee from Trading Fee column
            fee = raw_item.get("fee", 0.0)
            if fee is None:
                fee = 0.0
            fee = float(fee)
            fee_quote = currency
            
            # Withdrawal destination address
            withdrawal_address = str(raw_item.get("withdrawal_address", ""))
            
            # Extract blockchain hash from txid (remove :index suffix if present)
            # Format can be: 0xhash:index OR just 0xhash
            blockchain_hash = txid.split(':')[0] if ':' in txid else txid
            
            return NormalizedTransaction(
                source="mexc-withdrawals-file",
                account_id=self.account_id,
                source_account=self.connector_name,  # Raw account identifier for mapping
                source_transaction_id=txid,  # Full txid with :index for uniqueness
                date_time=dt,
                direction="outflow",  # KEY DIFFERENCE from deposits
                source_transaction_type="withdrawal",  # Different from deposits
                transaction_type="transfer",
                source_asset_symbol=currency,
                quantity=amount,
                fee=fee,
                source_fee_quote_asset_symbol=fee_quote,
                source_from_account=self._get_account_identifier(),
                from_account_id=self.account_id,
                source_to_account=withdrawal_address,  # Destination address
                network=network,
                network_transaction_id=blockchain_hash,  # Blockchain hash without index
            )
            
        except Exception as e:
            error_msg = f"Failed to normalize MEXC withdrawal from file: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e


# Integration tests:
# pytest tests/integration/exchanges/test_connector_mexc_withdrawals_file.py -v
