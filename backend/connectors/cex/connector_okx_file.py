"""
OKX Trading History File-based connector: Unified connector for OKX "Trading History" CSV export.

Replaces both connector_okx_trades_file.py and connector_okx_funding_file.py.
The Trading History export contains spot trades, convert trades, and transfers
(deposits/withdrawals) in a single file.

Pipeline: yield_raws → raw_to_normalized → enrichment → persistence
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("okx_file")


class OKXFileConnector(BaseConnector):
    """
    Unified OKX file-based connector that loads the "Trading History" CSV export.

    Handles:
    - Spot trades → direction=inflow, transaction_type=trade
    - Convert trades → direction=inflow, transaction_type=trade, tags={"type":"convert"}
    - Deposits (Transfer in) → direction=inflow, transaction_type=transfer
    - Withdrawals (Transfer out) → direction=outflow, transaction_type=transfer

    Config options:
    - file_path: Path to the CSV file to import (required in file mode)
    - file_import_id: Database ID of the FileImport record for tracking
    - source_timezone: Timezone of timestamps in the file.
        Detects from filename (e.g. "~UTC0~") or falls back to config value.
        Defaults to UTC.
    - sync_mode: "file" for file-based import

    Lifecycle:
    - On processing start: FileImport status -> "processing"
    - On success: FileImport status -> "completed", file kept for retention
    - On failure: FileImport status -> "failed", file kept for retry
    """

    @property
    def connector_name(self) -> str:
        return "okx_file"

    def __init__(
        self,
        account_id: int = None,
        connector_id: int = None,
        config: Dict[str, Any] = None,
        progress_callback=None,
        **kwargs,
    ):
        super().__init__(
            account_id=account_id,
            connector_id=connector_id,
            config=config,
            progress_callback=progress_callback,
        )

        self._file_path = config.get("file_path") if config else None
        self._file_import_id = config.get("file_import_id") if config else None
        self._source_timezone = config.get("source_timezone") if config else None
        self._cached_data: Optional[List[Dict[str, Any]]] = None
        self._processing_success = False
        self._new_count = 0
        self._updated_count = 0
        self._skipped_count = 0

        if self._file_path:
            log.info(f"📁 OKX file connector initialized with file: {self._file_path}")
            if self._file_import_id:
                log.info(f"📝 File import ID: {self._file_import_id}")
        else:
            log.warning("⚠️ OKX file connector initialized without file_path")

    def _resolve_timezone(self) -> Optional[str]:
        """
        Resolve the source timezone.

        Priority:
        1. Explicit config value (source_timezone)
        2. Extracted from filename (e.g. "~UTC0~")
        3. None (loader defaults to UTC)
        """
        if self._source_timezone:
            return self._source_timezone

        # Try extracting from filename
        if self._file_path:
            from backend.file_loaders.okx_trading_history_loader import _parse_filename_timezone
            tz = _parse_filename_timezone(self._file_path)
            if tz:
                log.info(f"📍 Auto-detected timezone from filename: {tz}")
                return tz

        return None

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """Load and parse the CSV file using okx_trading_history_loader."""
        if self._cached_data is not None:
            return self._cached_data

        if not self._file_path:
            raise ValueError("No file uploaded — upload a file before syncing")

        try:
            from backend.file_loaders.okx_trading_history_loader import load_okx_trading_history_file

            tz = self._resolve_timezone()
            log.info(f"📂 Loading OKX Trading History from: {self._file_path} (tz={tz})")
            df = load_okx_trading_history_file(self._file_path, source_timezone=tz)

            if df.empty:
                log.warning("⚠️ No data found in file")
                return []

            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} rows from file")
            return self._cached_data

        except Exception as e:
            log.error(f"❌ Failed to load OKX Trading History file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Yield raw row dicts from the CSV file."""
        data = self._load_file_data()

        if not data:
            log.warning("⚠️ No data to yield from OKX Trading History file")
            return

        total = len(data)
        log.info(f"🔄 Processing {total} rows from file")

        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} rows from file",
            fetched_count=0,
        )

        for idx, row in enumerate(data):
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping file processing")
                break

            yield row

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
            log_message=f"✅ Processed {total} rows from file",
            fetched_count=total,
        )
        log.info(f"✅ Completed processing {total} rows from file")
        self._processing_success = True

    def set_processing_metrics(self, new_count: int, updated_count: int, skipped_count: int):
        """Set processing metrics from the pipeline."""
        self._new_count = new_count
        self._updated_count = updated_count
        self._skipped_count = skipped_count

    def mark_failed(self, error_message: str):
        """Mark the file import as failed."""
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

        Files are kept for the full retention period to allow preview and re-processing.
        Cleanup is handled by the retention cleanup job.
        """
        super().cleanup()

        if self._file_import_id:
            if self._processing_success:
                self._update_file_import_status("completed")
                log.info(f"📁 Keeping file for retention period: {self._file_path}")
            else:
                log.info(f"📁 Keeping file for retry: {self._file_path}")

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        """
        Convert an okx_trading_history_loader row to NormalizedTransaction.

        Dispatches to _normalize_trade or _normalize_transfer based on row_type.
        """
        row_type = raw_item.get("row_type", "")

        if row_type == "trade":
            return self._normalize_trade(raw_item)
        elif row_type == "transfer":
            return self._normalize_transfer(raw_item)
        else:
            raise ValueError(f"Unknown row_type: {row_type!r}")

    def _normalize_trade(self, raw_item: dict) -> NormalizedTransaction:
        """
        Normalize a trade row (spot or convert).

        All trades are treated as inflow / buy, matching the previous
        OKXTradesFileConnector behavior.
        """
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

        dt = self._parse_datetime(raw_item)

        raw_tags = raw_item.get("tags") or {}
        tags = [raw_tags] if isinstance(raw_tags, dict) and raw_tags else (raw_tags if raw_tags else None)

        return NormalizedTransaction(
            source="okx-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=transaction_id,
            date_time=dt,
            direction="inflow",
            source_transaction_type="buy",
            transaction_type="trade",
            source_asset_symbol=base_asset,
            quantity=quantity,
            price=price,
            source_price_quote_asset_symbol=quote_asset,
            total=total,
            fee=fee,
            source_fee_quote_asset_symbol=fee_currency,
            include_fee=True,
            tags=tags,
        )

    def _normalize_transfer(self, raw_item: dict) -> NormalizedTransaction:
        """
        Normalize a transfer row (deposit or withdrawal).

        Deposits → inflow, Withdrawals → outflow.
        Matches the previous OKXFundingFileConnector behavior.
        """
        transaction_id = str(raw_item.get("transaction_id", ""))
        if not transaction_id:
            raise ValueError("Missing 'transaction_id' field")

        transfer_type = str(raw_item.get("transfer_type", "")).lower()
        if transfer_type not in ("deposit", "withdrawal"):
            raise ValueError(f"Invalid transfer_type: {transfer_type}")

        currency = str(raw_item.get("currency", "")).upper()
        if not currency:
            raise ValueError("Missing 'currency' field")

        amount = raw_item.get("amount")
        if amount is None:
            raise ValueError("Missing or invalid 'amount' field")
        amount = float(amount)

        dt = self._parse_datetime(raw_item)

        fee = 0.0
        fee_quote = currency

        direction = "inflow" if transfer_type == "deposit" else "outflow"

        if direction == "inflow":
            source_to_account = self._get_account_identifier()
            to_account_id = self.account_id
            source_from_account = None
            from_account_id = None
        else:
            source_from_account = self._get_account_identifier()
            from_account_id = self.account_id
            source_to_account = None
            to_account_id = None

        return NormalizedTransaction(
            source="okx-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=transaction_id,
            date_time=dt,
            direction=direction,
            source_transaction_type=transfer_type,
            transaction_type="transfer",
            source_asset_symbol=currency,
            quantity=amount,
            fee=fee,
            source_fee_quote_asset_symbol=fee_quote,
            include_fee=(direction == "outflow"),
            source_from_account=source_from_account,
            from_account_id=from_account_id,
            source_to_account=source_to_account,
            to_account_id=to_account_id,
        )

    @staticmethod
    def _parse_datetime(raw_item: dict) -> datetime:
        """Parse datetime from a raw row (pandas Timestamp, datetime, or ISO string)."""
        dt_value = raw_item.get("datetime")
        if hasattr(dt_value, "to_pydatetime"):
            dt = dt_value.to_pydatetime()
        elif isinstance(dt_value, datetime):
            dt = dt_value
        else:
            dt = datetime.fromisoformat(str(dt_value))

        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
