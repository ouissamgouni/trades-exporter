"""
DeGiro File-based connector: Load trades from DeGiro Transactions CSV export.
Pipeline: yield_raws → raw_to_normalized → enrichment → persistence

Uses ISIN as the source_asset_symbol for RawAsset mapping.
"""

import hashlib
from datetime import datetime, timezone
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction

log = configure_logging("degiro_file")


class DeGiroFileConnector(BaseConnector):
    """
    DeGiro file-based connector that loads trades from CSV export.

    Uses ISIN as the source_asset_symbol. Asset resolution happens via
    RawAsset entries (source="degiro-file", symbol=ISIN → asset_id).

    Config options:
    - file_path: Path to the CSV file to import
    - file_import_id: Database ID of the FileImport record for tracking

    Lifecycle:
    - On success: FileImport status -> "completed", file kept for retention
    - On failure: FileImport status -> "failed", file kept for retry
    """

    @property
    def connector_name(self) -> str:
        return "degiro_file"

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
        self._cached_data: Optional[List[Dict[str, Any]]] = None
        self._processing_success = False
        self._new_count = 0
        self._updated_count = 0
        self._skipped_count = 0

        if self._file_path:
            log.info(
                f"📁 DeGiro file connector initialized with file: {self._file_path}"
            )
        else:
            log.warning("⚠️ DeGiro file connector initialized without file_path")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """Load and parse the CSV file using degiro_loader."""
        if self._cached_data is not None:
            return self._cached_data

        if not self._file_path:
            raise ValueError("No file uploaded — upload a file before syncing")

        try:
            from backend.file_loaders.degiro_loader import load_degiro_file

            log.info(f"📂 Loading DeGiro trades from: {self._file_path}")
            df = load_degiro_file(self._file_path)

            if df.empty:
                log.warning("⚠️ No trades found in file")
                return []

            self._cached_data = df.to_dict("records")
            log.info(f"✅ Loaded {len(self._cached_data)} trades from file")
            return self._cached_data

        except Exception as e:
            log.error(f"❌ Failed to load DeGiro file: {e}")
            raise

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Yield raw trade dicts from the CSV file."""
        from backend.file_loaders.degiro_loader import generate_transaction_id

        data = self._load_file_data()

        if not data:
            log.warning("⚠️ No data to yield from DeGiro file")
            return

        total = len(data)
        log.info(f"🔄 Processing {total} trades from file")
        if self._file_import_id:
            self._update_file_import_status("processing")

        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} trades from file",
            fetched_count=0,
        )

        for idx, row in enumerate(data):
            if self.is_abort_requested():
                log.info("⚠️ Abort requested, stopping file processing")
                break

            row["_generated_id"] = row.get("_generated_id") or generate_transaction_id(
                row
            )
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
            log_message=f"✅ Processed {total} trades from file",
            fetched_count=total,
        )
        log.info(f"✅ Completed processing {total} trades from file")
        self._processing_success = True

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        """
        Convert a degiro_loader row to NormalizedTransaction.

        - source_asset_symbol = "PRODUCT (ISIN)" for raw asset mapping
        - price = value_eur / quantity (EUR-denominated unit price)
        - price quote = EUR
        - fee in EUR
        """
        from backend.core.utils import compute_trade_content_hash

        try:
            isin = str(raw_item.get("isin", "")).upper().strip()
            product = str(raw_item.get("product", "")).strip()
            if not isin:
                raise ValueError("Missing ISIN")

            # Source asset symbol: "PRODUCT (ISIN)" for raw asset mapping
            source_asset_symbol = f"{product} ({isin})" if product else isin

            # Parse datetime
            dt_value = raw_item.get("datetime")
            if hasattr(dt_value, "to_pydatetime"):
                dt = dt_value.to_pydatetime()
            elif isinstance(dt_value, datetime):
                dt = dt_value
            else:
                dt = datetime.fromisoformat(str(dt_value))

            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)

            # Extract trade data
            quantity = float(raw_item.get("quantity", 0))
            total_eur = abs(float(raw_item.get("total_eur", 0)))
            direction_str = str(raw_item.get("direction", "buy")).lower()

            # Unit price = total_eur / quantity (total_eur includes fees)
            # Since fees are baked into the price, include_fee is set to False
            if quantity > 0:
                price = total_eur / quantity
            else:
                price = 0.0

            # Fee is already aggregated in EUR by the loader
            fee = float(raw_item.get("fee", 0))

            # Transaction ID for deduplication
            transaction_id = raw_item.get("_generated_id", "")
            if not transaction_id:
                from backend.file_loaders.degiro_loader import generate_transaction_id

                transaction_id = generate_transaction_id(raw_item)

            # Content hash for cross-source deduplication
            content_hash = compute_trade_content_hash(
                dt=dt,
                base=isin,
                quote="EUR",
                quantity=quantity,
                price=price,
                side=direction_str,
            )

            return NormalizedTransaction(
                source="degiro-file",
                account_id=self.account_id,
                source_account=self.connector_name,
                source_transaction_id=transaction_id,
                date_time=dt,
                direction="inflow" if direction_str == "buy" else "outflow",
                transaction_type="trade",
                source_transaction_type=direction_str,
                source_asset_symbol=source_asset_symbol,
                quantity=quantity,
                price=price,
                source_price_quote_asset_symbol="EUR",
                fee=fee,
                source_fee_quote_asset_symbol="EUR" if fee else "",
                include_fee=False,
                content_hash=content_hash,
            )

        except Exception as e:
            error_msg = f"Failed to normalize DeGiro trade: {e}"
            log.error(error_msg)
            raise ValueError(error_msg) from e

    def set_processing_metrics(
        self, new_count: int, updated_count: int, skipped_count: int
    ):
        """Set processing metrics from the pipeline."""
        self._new_count = new_count
        self._updated_count = updated_count
        self._skipped_count = skipped_count

    def mark_failed(self, error_message: str):
        """Mark the file import as failed."""
        self._processing_success = False
        if self._file_import_id:
            self._update_file_import_status("failed", error_message=error_message)

    def _update_file_import_status(self, status: str, error_message: str = None):
        """Update FileImport record in database."""
        if not self._file_import_id:
            return

        try:
            from backend.db.database import get_engine
            from sqlmodel import Session
            from backend.db.repositories import FileImportRepository
            from backend.db.models import AccountConnector
            from sqlalchemy.orm.attributes import flag_modified

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
                    account_connector = (
                        session.get(AccountConnector, self.connector_id)
                        if self.connector_id
                        else None
                    )
                    if account_connector:
                        config = dict(account_connector.config or {})
                        if config.get("file_import_id") == self._file_import_id:
                            config.pop("file_path", None)
                            config.pop("file_import_id", None)
                            account_connector.config = config
                            flag_modified(account_connector, "config")
                            session.add(account_connector)
                elif status == "failed":
                    repo.mark_failed(
                        self._file_import_id, error_message or "Unknown error"
                    )
                elif status == "processing":
                    repo.mark_processing(self._file_import_id)
                else:
                    repo.update_status(self._file_import_id, status)

                session.commit()
                log.info(
                    f"📝 Updated FileImport {self._file_import_id} status to: {status}"
                )
        except Exception as e:
            log.error(f"❌ Failed to update FileImport status: {e}")

    def cleanup(self):
        """Cleanup resources and update file import status."""
        super().cleanup()

        if self._file_import_id:
            if self._processing_success:
                self._update_file_import_status("completed")
                log.info(f"📁 Keeping file for retention period: {self._file_path}")
            else:
                log.info(f"📁 Keeping file for retry: {self._file_path}")
