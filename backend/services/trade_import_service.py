"""
Trade Import Service.

Handles importing trades from parsed CSV data into the database.
Creates RawAccount and RawAsset entries for user mapping,
and persists NormalizedTransaction records.

Usage:
    from backend.services.trade_import_service import TradeImportService
    from backend.file_loaders.trades_csv_loader import TradesCSVLoader
    
    loader = TradesCSVLoader()
    result = loader.load("path/to/trades.csv")
    
    service = TradeImportService(session)
    import_result = service.import_from_load_result(result)
"""

from typing import List, Dict, Any, Optional, Set
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from sqlmodel import Session, select

from backend.db.models import (
    NormalizedTransaction,
    RawAccount,
    RawAsset,
    Account,
    Asset,
)
from backend.services.pipeline.stages.enrichment import AssetEnrichmentStage
from backend.services.pipeline.context import PipelineContext
from backend.file_loaders.trades_csv_loader import (
    TradesLoadResult,
    ParsedTransaction,
    SOURCE_IDENTIFIER,
)
from backend.config.loader import configure_logging

log = configure_logging("trade_import_service")


def utc_now() -> datetime:
    """Return current UTC time (timezone-aware)."""
    return datetime.now(timezone.utc)


def ensure_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Ensure datetime is timezone-aware (UTC)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


@dataclass
class ImportStats:
    """Statistics for an import operation."""
    created: int = 0
    skipped: int = 0
    errors: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class TradeImportResult:
    """Complete result of a trade import operation."""
    transactions: ImportStats = field(default_factory=ImportStats)
    raw_accounts: ImportStats = field(default_factory=ImportStats)
    raw_assets: ImportStats = field(default_factory=ImportStats)
    pending_review_count: int = 0
    parse_errors: List[Dict[str, Any]] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    dry_run: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for display."""
        return {
            "transactions": {
                "created": self.transactions.created,
                "skipped": self.transactions.skipped,
                "errors": self.transactions.errors,
            },
            "raw_accounts": {
                "created": self.raw_accounts.created,
                "skipped": self.raw_accounts.skipped,
                "errors": self.raw_accounts.errors,
            },
            "raw_assets": {
                "created": self.raw_assets.created,
                "skipped": self.raw_assets.skipped,
                "errors": self.raw_assets.errors,
            },
            "pending_review_count": self.pending_review_count,
            "parse_errors": self.parse_errors,
            "warnings": self.warnings,
            "dry_run": self.dry_run,
            "summary": {
                "total_transactions": self.transactions.created,
                "total_raw_accounts": self.raw_accounts.created,
                "total_raw_assets": self.raw_assets.created,
                "total_errors": (
                    len(self.transactions.errors) +
                    len(self.raw_accounts.errors) +
                    len(self.raw_assets.errors) +
                    len(self.parse_errors)
                ),
            }
        }


class TradeImportService:
    """
    Service for importing trades from parsed CSV data.
    
    Handles:
    - RawAccount upsert by (source, label) - skips existing
    - RawAsset upsert by (source, symbol) - skips existing (excludes FEES)
    - NormalizedTransaction creation with idempotent source_transaction_id
    - Sets review_status="pending" for unmapped accounts/assets
    """
    
    def __init__(self, session: Session):
        self.session = session
        self._raw_account_cache: Dict[str, Optional[int]] = {}  # label -> account_id
        self._raw_asset_cache: Dict[str, Optional[int]] = {}  # symbol -> asset_id
        self._existing_tx_ids: Set[str] = set()  # source_transaction_id set
        self._eur_asset_id: Optional[int] = None  # EUR asset ID for fee resolution
    
    def import_from_load_result(
        self,
        load_result: TradesLoadResult,
        dry_run: bool = False
    ) -> TradeImportResult:
        """
        Import trades from a TradesLoadResult.
        
        Args:
            load_result: Parsed data from TradesCSVLoader
            dry_run: If True, don't commit changes
            
        Returns:
            TradeImportResult with statistics and errors
        """
        result = TradeImportResult(
            parse_errors=load_result.errors,
            warnings=load_result.warnings,
            dry_run=dry_run
        )
        
        log.info("starting_trade_import",
                 transactions_count=len(load_result.transactions),
                 accounts_count=len(load_result.unique_accounts),
                 assets_count=len(load_result.unique_assets),
                 dry_run=dry_run)
        
        try:
            # Step 1: Load existing data caches
            self._load_existing_data()
            
            # Step 2: Create RawAccount entries for unique accounts
            result.raw_accounts = self._import_raw_accounts(
                load_result.unique_accounts, dry_run
            )
            
            # Step 3: Create RawAsset entries for unique assets (excluding FEES)
            result.raw_assets = self._import_raw_assets(
                load_result.unique_assets, dry_run
            )
            
            # Step 4: Import transactions
            result.transactions, result.pending_review_count, imported_txs = self._import_transactions(
                load_result.transactions, dry_run
            )
            
            # Step 5: Run asset enrichment pipeline stage to create RawAsset entries
            # This uses the existing pipeline stage which handles all symbol types
            # (main asset, price quote, fee quote) via get_or_create
            if not dry_run and imported_txs:
                self._run_asset_enrichment(imported_txs)
            
            if not dry_run:
                self.session.commit()
                log.info("trade_import_committed")
            else:
                self.session.rollback()
                log.info("trade_import_dry_run_complete")
                
        except Exception as e:
            self.session.rollback()
            log.error("trade_import_failed", error=str(e))
            result.transactions.errors.append({
                "error": f"Import failed: {str(e)}"
            })
        
        return result
    
    def _load_existing_data(self):
        """Load existing raw accounts, raw assets, and transaction IDs into caches."""
        
        # Load existing RawAccounts for this source
        stmt = select(RawAccount).where(RawAccount.source == SOURCE_IDENTIFIER)
        for raw_account in self.session.exec(stmt):
            self._raw_account_cache[raw_account.label] = raw_account.account_id
        
        # Load existing RawAssets for this source
        stmt = select(RawAsset).where(RawAsset.source == SOURCE_IDENTIFIER)
        for raw_asset in self.session.exec(stmt):
            self._raw_asset_cache[raw_asset.symbol] = raw_asset.asset_id
        
        # Load existing transaction IDs for this source
        stmt = select(NormalizedTransaction.source_transaction_id).where(
            NormalizedTransaction.source == SOURCE_IDENTIFIER
        )
        for (tx_id,) in self.session.exec(stmt):
            if tx_id:
                self._existing_tx_ids.add(tx_id)
        
        # Try to find EUR asset for fee resolution
        from backend.db.models import Asset
        stmt = select(Asset).where(Asset.symbol == "EUR")
        eur_asset = self.session.exec(stmt).first()
        if eur_asset:
            self._eur_asset_id = eur_asset.asset_id
        
        log.info("loaded_existing_data",
                 raw_accounts=len(self._raw_account_cache),
                 raw_assets=len(self._raw_asset_cache),
                 existing_transactions=len(self._existing_tx_ids),
                 eur_asset_id=self._eur_asset_id)
    
    def _import_raw_accounts(
        self,
        account_codes: Set[str],
        dry_run: bool
    ) -> ImportStats:
        """Create RawAccount entries for unknown accounts."""
        stats = ImportStats()
        
        for account_code in account_codes:
            # Skip if already exists
            if account_code in self._raw_account_cache:
                stats.skipped += 1
                continue
            
            try:
                raw_account = RawAccount(
                    source=SOURCE_IDENTIFIER,
                    label=account_code,
                    account_id=None,  # Pending user mapping
                    created_at=utc_now()
                )
                
                if not dry_run:
                    self.session.add(raw_account)
                    self.session.flush()
                
                # Add to cache (with None since not mapped)
                self._raw_account_cache[account_code] = None
                stats.created += 1
                
                log.debug("created_raw_account", label=account_code)
                
            except Exception as e:
                stats.errors.append({
                    "account_code": account_code,
                    "error": str(e)
                })
        
        log.info("raw_accounts_imported",
                 created=stats.created,
                 skipped=stats.skipped,
                 errors=len(stats.errors))
        
        return stats
    
    def _import_raw_assets(
        self,
        asset_tickers: Set[str],
        dry_run: bool
    ) -> ImportStats:
        """Create RawAsset entries for unknown assets (excluding FEES)."""
        stats = ImportStats()
        
        for ticker in asset_tickers:
            # Skip FEES assets - they don't need mapping
            if ticker.startswith("_FEES:"):
                stats.skipped += 1
                continue
            
            # Skip if already exists
            if ticker in self._raw_asset_cache:
                stats.skipped += 1
                continue
            
            try:
                raw_asset = RawAsset(
                    source=SOURCE_IDENTIFIER,
                    symbol=ticker,
                    asset_id=None,  # Pending user mapping
                )
                
                if not dry_run:
                    self.session.add(raw_asset)
                    self.session.flush()
                
                # Add to cache (with None since not mapped)
                self._raw_asset_cache[ticker] = None
                stats.created += 1
                
                log.debug("created_raw_asset", symbol=ticker)
                
            except Exception as e:
                stats.errors.append({
                    "ticker": ticker,
                    "error": str(e)
                })
        
        log.info("raw_assets_imported",
                 created=stats.created,
                 skipped=stats.skipped,
                 errors=len(stats.errors))
        
        return stats
    
    def _run_asset_enrichment(self, transactions: List[NormalizedTransaction]) -> None:
        """
        Run the AssetEnrichmentStage on imported transactions.
        
        This reuses the existing pipeline stage which handles:
        - source_asset_symbol -> asset_id (via get_or_create RawAsset)
        - source_price_quote_asset_symbol -> price_quote_asset_id
        - source_fee_quote_asset_symbol -> fee_quote_asset_id
        
        Note: FEES transactions (source_asset_symbol starting with _FEES:) are
        filtered out as they don't need raw asset entries for the main asset.
        The enrichment will still create raw assets for their quote symbols (EUR).
        """
        # Filter out FEES transactions for main asset enrichment
        # But we still need to process them for fee_quote_asset enrichment
        # So we clear their source_asset_symbol temporarily
        fees_txs = []
        for tx in transactions:
            if tx.source_asset_symbol and tx.source_asset_symbol.startswith("_FEES:"):
                fees_txs.append((tx, tx.source_asset_symbol))
                tx.source_asset_symbol = ""  # Clear to skip main asset enrichment
        
        context = PipelineContext(
            session=self.session,
            source=SOURCE_IDENTIFIER,
            skip_asset_enrichment=False
        )
        
        stage = AssetEnrichmentStage()
        enriched_txs, success = stage.process(transactions, context)
        
        # Restore source_asset_symbol for FEES transactions
        for tx, original_symbol in fees_txs:
            tx.source_asset_symbol = original_symbol
        
        if context.warnings:
            log.warning("asset_enrichment_warnings", warnings=context.warnings)
        
        log.info("asset_enrichment_complete", 
                 transactions_processed=len(enriched_txs),
                 success=success)
    
    def _import_transactions(
        self,
        transactions: List[ParsedTransaction],
        dry_run: bool
    ) -> tuple[ImportStats, int, List[NormalizedTransaction]]:
        """Import transactions, returning stats, pending review count, and imported transactions."""
        stats = ImportStats()
        pending_count = 0
        imported_txs: List[NormalizedTransaction] = []
        
        for parsed in transactions:
            # Skip if transaction already exists (idempotent)
            if parsed.source_transaction_id in self._existing_tx_ids:
                stats.skipped += 1
                continue
            
            try:
                tx = self._create_transaction(parsed)
                
                # Count pending transactions
                if tx.review_status == "pending":
                    pending_count += 1
                
                if not dry_run:
                    self.session.add(tx)
                    self.session.flush()
                    self._existing_tx_ids.add(parsed.source_transaction_id)
                    imported_txs.append(tx)
                
                stats.created += 1
                
            except Exception as e:
                stats.errors.append({
                    "source_transaction_id": parsed.source_transaction_id,
                    "asset": parsed.asset_ticker,
                    "date": str(parsed.date_time),
                    "error": str(e)
                })
        
        log.info("transactions_imported",
                 created=stats.created,
                 skipped=stats.skipped,
                 pending=pending_count,
                 errors=len(stats.errors))
        
        return stats, pending_count, imported_txs
    
    def _create_transaction(self, parsed: ParsedTransaction) -> NormalizedTransaction:
        """Create a NormalizedTransaction from parsed data."""
        
        # Resolve account_id from cache
        account_id = self._raw_account_cache.get(parsed.account_code)
        
        # Resolve asset_id from cache (only for non-FEES)
        asset_id = None
        if not parsed.is_fee_transaction:
            asset_id = self._raw_asset_cache.get(parsed.asset_ticker)
        
        # Determine if needs review (unmapped account or asset)
        needs_review = (
            account_id is None or
            (not parsed.is_fee_transaction and asset_id is None)
        )
        review_status = "pending" if needs_review else "valid"
        
        # Determine direction and transaction_type
        if parsed.is_fee_transaction:
            # FEES transactions: cost type with outflow direction
            # These represent account-level fees (frais de gestion) that the broker
            # collects by liquidating a portion of held assets.
            # qty=fee_amount, price=1, price_quote=EUR (the fee currency).
            direction = "outflow"
            transaction_type = "cost"
            quantity = parsed.quantity  # Fee amount promoted to quantity
            fee = None
            source_fee_quote_asset_symbol = ""
            fee_quote_asset_id = None
        else:
            # Regular trades
            if parsed.transaction_type.lower() == "buy":
                direction = "inflow"
            elif parsed.transaction_type.lower() == "sell":
                direction = "outflow"
            else:
                direction = "inflow"  # Default to inflow for unknown
            
            transaction_type = "trade"
            quantity = parsed.quantity or Decimal(0)
            fee = parsed.fee
            source_fee_quote_asset_symbol = "EUR" if fee else ""
            fee_quote_asset_id = self._eur_asset_id if fee else None  # Resolve EUR for trading fees too
        
        # For FEES transactions, also check if EUR is resolved for review status
        if parsed.is_fee_transaction and self._eur_asset_id is None:
            needs_review = True
            review_status = "pending"
        
        # Build transaction
        if parsed.is_fee_transaction:
            # COST: price=1, price_quote=EUR, no asset_id
            tx_price = Decimal(1)
            tx_source_price_quote = "EUR"
            tx_asset_id = None  # COST transactions have no base asset
            tx_price_quote_asset_id = self._eur_asset_id
        else:
            tx_price = parsed.price
            tx_source_price_quote = "EUR" if parsed.price else ""
            tx_asset_id = asset_id
            tx_price_quote_asset_id = None
        
        tx = NormalizedTransaction(
            # Source traceability
            source=SOURCE_IDENTIFIER,
            source_asset_symbol=parsed.asset_ticker,
            source_transaction_type=parsed.transaction_type if not parsed.is_fee_transaction else "management_fee",
            source_transaction_id=parsed.source_transaction_id,
            
            # Account (may be None if unmapped)
            account_id=account_id,
            source_account=parsed.account_code,  # Raw account identifier for later mapping
            
            # Core fields
            date_time=ensure_utc(parsed.date_time),
            direction=direction,
            transaction_type=transaction_type,
            
            # Asset and quantity
            asset_id=tx_asset_id,
            quantity=quantity,
            
            # Pricing
            price=tx_price,
            source_price_quote_asset_symbol=tx_source_price_quote,
            price_quote_asset_id=tx_price_quote_asset_id,
            
            # Fees
            fee=fee,
            fee_quote_asset_id=fee_quote_asset_id,
            source_fee_quote_asset_symbol=source_fee_quote_asset_symbol,
            include_fee=True if fee else False,
            
            # Status
            review_status=review_status,
            taxability_status="unknown",
            
            # Timestamps
            created_at=utc_now(),
            updated_at=utc_now(),
        )
        
        return tx
