"""
DeGiro Account File connector: Load operations from DeGiro Account.csv export.
Pipeline: yield_raws → raw_to_normalized → enrichment → persistence

Imports dividends, interest, exchange fees, ADR fees, deposits, and cash-in-lieu.
Withholding tax is paired with dividends at the loader level and stored in tags.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Dict, Any, List, Generator, Optional

from backend.connectors.base.base_connector import BaseConnector
from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.file_loaders.degiro_account_loader import AccountRowType

log = configure_logging("degiro_account_file")


class DeGiroAccountFileConnector(BaseConnector):
    """
    DeGiro Account file connector: imports operations from Account.csv.

    Uses ISIN as source_asset_symbol for dividend/fee attribution.
    Cash assets use currency code (EUR, USD) as source_asset_symbol.
    """

    @property
    def connector_name(self) -> str:
        return "degiro_account_file"

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

        if self._file_path:
            log.info(f"📁 DeGiro Account connector initialized with file: {self._file_path}")

    def _load_file_data(self) -> List[Dict[str, Any]]:
        """Load and parse the Account CSV file."""
        if self._cached_data is not None:
            return self._cached_data

        if not self._file_path:
            raise ValueError("No file uploaded — upload a file before syncing")

        from backend.file_loaders.degiro_account_loader import load_degiro_account_file

        log.info(f"📂 Loading DeGiro Account operations from: {self._file_path}")
        self._cached_data = load_degiro_account_file(file_path=self._file_path)
        log.info(f"✅ Loaded {len(self._cached_data)} operations from Account file")
        return self._cached_data

    def yield_raws(self) -> Generator[Dict[str, Any], None, None]:
        """Yield raw operation dicts from the Account CSV file."""
        data = self._load_file_data()

        if not data:
            log.warning("⚠️ No data to yield from DeGiro Account file")
            return

        total = len(data)
        self.update_progress(
            operation="Loading file",
            current=0,
            total=total,
            log_message=f"Starting to process {total} operations from file",
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
            log_message=f"✅ Processed {total} operations from Account file",
            fetched_count=total,
        )
        self._processing_success = True

    def raw_to_normalized(self, raw_item: dict) -> NormalizedTransaction:
        """
        Convert a classified Account.csv row to NormalizedTransaction.

        Row type determines transaction_type, direction, and metadata.
        """
        from backend.core.utils import compute_trade_content_hash

        row_type = raw_item["_row_type"]
        dt = raw_item["datetime"]
        isin = raw_item.get("isin", "")
        product = raw_item.get("product", "")
        currency = raw_item.get("currency", "EUR")
        change = raw_item.get("change_decimal", Decimal(0))
        transaction_id = raw_item.get("_generated_id", "")

        # Source asset symbol: "PRODUCT (ISIN)" for stocks, currency code for cash
        source_asset_symbol = f"{product} ({isin})" if isin and product else (isin or currency)

        # Content hash for cross-source deduplication
        content_hash = compute_trade_content_hash(
            dt=dt,
            base=isin or currency,
            quote=currency,
            quantity=float(abs(change)),
            price=1.0,
            side=row_type,
        )

        if row_type == AccountRowType.DIVIDEND:
            return self._normalize_dividend(raw_item, dt, isin, product, currency, change, transaction_id, content_hash)
        elif row_type == AccountRowType.INTEREST:
            return self._normalize_interest(raw_item, dt, currency, change, transaction_id, content_hash)
        elif row_type == AccountRowType.EXCHANGE_FEE:
            return self._normalize_fee(raw_item, dt, currency, change, transaction_id, content_hash, "exchange_fee")
        elif row_type == AccountRowType.ADR_FEE:
            return self._normalize_adr_fee(raw_item, dt, isin, product, currency, change, transaction_id, content_hash)
        elif row_type == AccountRowType.DEPOSIT:
            return self._normalize_deposit(raw_item, dt, currency, change, transaction_id, content_hash)
        elif row_type == AccountRowType.CASH_IN_LIEU:
            return self._normalize_cash_in_lieu(raw_item, dt, isin, product, currency, change, transaction_id, content_hash)
        else:
            raise ValueError(f"Unexpected row type in normalization: {row_type}")

    def _normalize_dividend(
        self, raw, dt, isin, product, currency, change, tx_id, content_hash
    ) -> NormalizedTransaction:
        """Normalize a dividend row (paired with withholding)."""
        gross_amount = abs(change)
        withholding = raw.get("withholding_amount", Decimal(0))
        jurisdiction = raw.get("withholding_jurisdiction")

        # Compute withholding rate
        withholding_rate = None
        if withholding and gross_amount:
            withholding_rate = str(withholding / gross_amount)

        # Source asset symbol for the cash received
        cash_symbol = currency

        # Tags carry withholding info for IncomeEvent creation in group_handler
        tags = []
        if withholding:
            tags.append({"withholding_amount": str(withholding)})
        if jurisdiction:
            tags.append({"withholding_jurisdiction": jurisdiction})
        if withholding_rate:
            tags.append({"withholding_rate": withholding_rate})

        # FX data enriched by loader's _pair_fx_to_dividends()
        fx_rate = raw.get("fx_rate")
        if fx_rate is not None:
            tags.append({"fx_rate": str(fx_rate)})
        fx_net_base = raw.get("fx_net_amount_base")
        if fx_net_base is not None:
            tags.append({"net_amount_base": str(fx_net_base)})
        fx_base_ccy = raw.get("fx_base_currency")
        if fx_base_ccy:
            tags.append({"base_currency": fx_base_ccy})
        # Always record source currency and amounts for currency conversion
        tags.append({"source_currency": currency})
        tags.append({"gross_amount_source": str(gross_amount)})
        if withholding:
            tags.append({"wht_amount_source": str(withholding)})

        # The attributed_asset is the stock (ISIN), the received asset is cash
        source_attributed_symbol = f"{product} ({isin})" if isin and product else isin

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="inflow",
            transaction_type="dividend",
            source_transaction_type="dividend",
            source_asset_symbol=cash_symbol,
            quantity=float(gross_amount),
            price=1.0,  # Cash at face value
            source_price_quote_asset_symbol=currency,
            fee=0.0,
            content_hash=content_hash,
            tags=tags,
            source_attributed_asset_symbol=source_attributed_symbol,
        )

    def _normalize_interest(
        self, raw, dt, currency, change, tx_id, content_hash
    ) -> NormalizedTransaction:
        """Normalize an interest income row."""
        amount = abs(change)

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="inflow",
            transaction_type="dividend",
            source_transaction_type="interest",
            source_asset_symbol=currency,
            quantity=float(amount),
            price=1.0,
            source_price_quote_asset_symbol=currency,
            fee=0.0,
            content_hash=content_hash,
        )

    def _normalize_fee(
        self, raw, dt, currency, change, tx_id, content_hash, fee_type: str
    ) -> NormalizedTransaction:
        """Normalize an exchange connectivity fee."""
        fee_amount = abs(change)

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="outflow",
            transaction_type="cost",
            source_transaction_type=fee_type,
            quantity=float(fee_amount),
            price=1.0,
            source_price_quote_asset_symbol=currency,
            include_fee=False,
            content_hash=content_hash,
        )

    def _normalize_adr_fee(
        self, raw, dt, isin, product, currency, change, tx_id, content_hash
    ) -> NormalizedTransaction:
        """Normalize an ADR/GDR custody fee (attributed to the ADR asset)."""
        fee_amount = abs(change)
        source_attributed_symbol = f"{product} ({isin})" if isin and product else isin

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="outflow",
            transaction_type="cost",
            source_transaction_type="adr_custody_fee",
            quantity=float(fee_amount),
            price=1.0,
            source_price_quote_asset_symbol=currency,
            include_fee=False,
            content_hash=content_hash,
            source_attributed_asset_symbol=source_attributed_symbol,
        )

    def _normalize_deposit(
        self, raw, dt, currency, change, tx_id, content_hash
    ) -> NormalizedTransaction:
        """Normalize a cash deposit."""
        amount = abs(change)

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="inflow",
            transaction_type="transfer",
            source_transaction_type="deposit",
            source_asset_symbol=currency,
            quantity=float(amount),
            price=1.0,
            source_price_quote_asset_symbol=currency,
            fee=0.0,
            content_hash=content_hash,
            taxability_status="non_taxable",
        )

    def _normalize_cash_in_lieu(
        self, raw, dt, isin, product, currency, change, tx_id, content_hash
    ) -> NormalizedTransaction:
        """
        Normalize cash-in-lieu (corporate action cash settlement).

        Covers forced disposal of fractional spinoff shares, merger consideration,
        or other corporate action cash proceeds. Creates a trade (not income)
        because it's a forced sale / disposal event.
        """
        amount = abs(change)

        # Attribute to the source asset when ISIN is available
        attributed = f"{product} ({isin})" if isin and product else None

        # Tag as corporate action to distinguish from regular trades
        tags = [{"source": "corporate_action"}]
        if isin:
            tags.append({"isin": isin})

        return NormalizedTransaction(
            source="degiro-account-file",
            account_id=self.account_id,
            source_account=self.connector_name,
            source_transaction_id=tx_id,
            date_time=dt,
            direction="inflow",
            transaction_type="trade",
            source_transaction_type="cash_in_lieu",
            source_asset_symbol=currency,
            source_attributed_asset_symbol=attributed,
            quantity=float(amount),
            price=1.0,
            source_price_quote_asset_symbol=currency,
            fee=0.0,
            content_hash=content_hash,
            taxability_status="taxable",
            tags=tags,
        )

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

    def _update_file_import_status(self, status: str, error_message: str = None):
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
                repo.update_status(
                    self._file_import_id,
                    status=status,
                    error_message=error_message,
                )
                session.commit()
        except Exception as e:
            log.error(f"Failed to update file import status: {e}")
