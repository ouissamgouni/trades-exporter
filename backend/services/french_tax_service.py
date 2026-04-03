"""
French Tax Service — Standalone on-demand tax computation.

Decoupled from the PnL engine. Consumes existing RealizedPnl entries
for a given CalculationVersion and persists French tax results
(crypto Art. 150 VH bis + securities Art. 150-0 A).

Usage:
    service = FrenchTaxService(session)
    service.compute_for_version(version_id)
"""

from decimal import Decimal
from typing import Optional

from sqlmodel import Session, select

from backend.config.loader import configure_logging
from backend.db.models import (
    Asset,
    CalculationUnit,
    CalculationVersion,
    FrenchCryptoTaxAnnualSummary,
    FrenchCryptoTaxEntry,
    FrenchSecuritiesTaxAnnualSummary,
    FrenchSecuritiesTaxEntry,
    NormalizedTransaction,
    RealizedPnl,
    TransactionTaxOverride,
)
from backend.services.pnl.fr_crypto_tax import FrenchCryptoTaxCalculator
from backend.services.pnl.fr_securities_tax import FrenchSecuritiesTaxCalculator

log = configure_logging("french_tax_service")


class FrenchTaxService:
    """Standalone French tax computation service."""

    def __init__(self, session: Session):
        self.session = session

    def compute_for_version(self, version_id: int) -> dict:
        """
        Compute French tax for an existing PnL version.
        
        Idempotent: deletes any previous tax results for this version
        before inserting new ones.

        Returns:
            Dict with crypto_entries, securities_entries counts and status.
        """
        version = self.session.get(CalculationVersion, version_id)
        if not version:
            raise ValueError(f"CalculationVersion {version_id} not found")

        # Gather all RealizedPnl entries for this version (with transaction + account eager-loaded)
        from sqlmodel import col
        from sqlalchemy.orm import selectinload

        pnl_entries = (
            self.session.exec(
                select(RealizedPnl)
                .join(CalculationUnit, RealizedPnl.origin_unit_id == CalculationUnit.id)
                .where(CalculationUnit.version_id == version.version_id)
                .options(
                    selectinload(RealizedPnl.transaction).selectinload(NormalizedTransaction.account_rel),
                )
            )
            .all()
        )

        if not pnl_entries:
            log.info("tax_no_pnl_entries", version_id=version_id)
            return {"status": "no_data", "crypto_entries": 0, "securities_entries": 0, "excluded_entries": 0, "skipped_entries": 0}

        # Build asset_map: asset_id → Asset
        asset_ids = {e.asset_id for e in pnl_entries}
        assets = self.session.exec(select(Asset).where(Asset.asset_id.in_(asset_ids))).all()
        asset_map = {a.asset_id: a for a in assets}

        # Load FR tax overrides for all transactions in this version
        tx_ids = [e.transaction_id for e in pnl_entries if e.transaction_id]
        fr_overrides: dict[int, bool] = {}
        if tx_ids:
            override_rows = self.session.exec(
                select(TransactionTaxOverride.transaction_id, TransactionTaxOverride.is_taxable)
                .where(TransactionTaxOverride.jurisdiction == "fr")
                .where(TransactionTaxOverride.transaction_id.in_(tx_ids))
            ).all()
            fr_overrides = {tid: val for tid, val in override_rows}

        # Classify entries by asset price_type
        # - price_type == 'crypto' → crypto tax (Art. 150 VH bis)
        # - price_type == 'fiat' → skipped (base currency, no tax)
        # - everything else (stock, None, any future type) → securities tax (Art. 150-0 A)
        crypto_entries = []
        securities_entries = []
        skipped_entries = 0

        for entry in pnl_entries:
            asset = asset_map.get(entry.asset_id)
            price_type = getattr(asset, "price_type", None) if asset else None

            if price_type == "crypto":
                crypto_entries.append(entry)
            elif price_type == "fiat":
                skipped_entries += 1
                continue
            else:
                # Catch-all: stock, None, any future type → securities
                securities_entries.append(entry)

        # Delete previous tax results for idempotency
        self._delete_tax_results(version_id)

        # Resolve base currency symbol from version
        base_currency_symbol = "EUR"
        if version.base_currency_id:
            base_asset = self.session.get(Asset, version.base_currency_id)
            if base_asset:
                base_currency_symbol = base_asset.symbol

        account_id = version.account_ids[0] if version.account_ids else None

        # Run crypto tax calculator (Art. 150 VH bis)
        if crypto_entries:
            crypto_calc = FrenchCryptoTaxCalculator(base_currency_symbol)
            crypto_report = crypto_calc.compute(list(crypto_entries), asset_map, effective_taxable_map=fr_overrides)
            self._persist_crypto_tax(version, crypto_report, account_id)

        # Run securities tax calculator (Art. 150-0 A, CUMP)
        if securities_entries:
            securities_calc = FrenchSecuritiesTaxCalculator(base_currency_symbol)
            securities_report = securities_calc.compute(list(securities_entries), asset_map, effective_taxable_map=fr_overrides)
            self._persist_securities_tax(version, securities_report, account_id)

        self.session.commit()

        log.info(
            "tax_results_computed",
            version_id=version_id,
            crypto_entries=len(crypto_entries),
            securities_entries=len(securities_entries),
            skipped_entries=skipped_entries,
        )

        return {
            "status": "computed",
            "crypto_entries": len(crypto_entries),
            "securities_entries": len(securities_entries),
            "excluded_entries": 0,
            "skipped_entries": skipped_entries,
        }

    def get_tax_status(self, version_id: int) -> dict:
        """Check whether tax results exist for a version.

        Checks both entry tables AND annual summary tables. When all
        disposals are non-taxable, no entry rows are persisted but
        annual summaries still are — so we must check both.
        """
        has_crypto_entries = self.session.exec(
            select(FrenchCryptoTaxEntry)
            .where(FrenchCryptoTaxEntry.calculation_version_id == version_id)
        ).first() is not None
        has_crypto_summaries = self.session.exec(
            select(FrenchCryptoTaxAnnualSummary)
            .where(FrenchCryptoTaxAnnualSummary.calculation_version_id == version_id)
        ).first() is not None
        has_securities_entries = self.session.exec(
            select(FrenchSecuritiesTaxEntry)
            .where(FrenchSecuritiesTaxEntry.calculation_version_id == version_id)
        ).first() is not None
        has_securities_summaries = self.session.exec(
            select(FrenchSecuritiesTaxAnnualSummary)
            .where(FrenchSecuritiesTaxAnnualSummary.calculation_version_id == version_id)
        ).first() is not None

        has_crypto = has_crypto_entries or has_crypto_summaries
        has_securities = has_securities_entries or has_securities_summaries
        return {
            "version_id": version_id,
            "has_tax_results": has_crypto or has_securities,
            "has_crypto": has_crypto,
            "has_securities": has_securities,
        }

    def _delete_tax_results(self, version_id: int) -> None:
        """Delete all French tax results for a version (idempotent re-compute)."""
        for model in [
            FrenchCryptoTaxEntry,
            FrenchCryptoTaxAnnualSummary,
            FrenchSecuritiesTaxEntry,
            FrenchSecuritiesTaxAnnualSummary,
        ]:
            rows = self.session.exec(
                select(model).where(model.calculation_version_id == version_id)
            ).all()
            for row in rows:
                self.session.delete(row)
        self.session.flush()

    def _persist_crypto_tax(self, version, report, account_id: Optional[int]) -> None:
        """Persist crypto tax results to FrenchCryptoTaxEntry + FrenchCryptoTaxAnnualSummary.
        
        Only taxable entries are persisted. Non-taxable entries (crypto-to-crypto swaps,
        internal transfers, etc.) are excluded — they remain accessible via /realized-pnl.
        """
        for summary in report.summaries:
            for item in summary.line_items:
                if not item.disposal_taxable:
                    continue
                entry = FrenchCryptoTaxEntry(
                    calculation_version_id=version.version_id,
                    account_id=account_id,
                    realized_pnl_id=item.pnl_id,
                    fiscal_year=summary.fiscal_year,
                    cession_date=item.realized_at,
                    asset_symbol=item.asset_symbol,
                    proceeds=item.proceeds_in_base,
                    cost_basis=item.cost_basis_in_base,
                    portfolio_value_at_cession=Decimal("0"),
                    total_acquisition_cost=Decimal("0"),
                    taxable_gain=item.gain_or_loss,
                    tax_amount=item.tax_total,
                )
                self.session.add(entry)

            annual = FrenchCryptoTaxAnnualSummary(
                calculation_version_id=version.version_id,
                account_id=account_id,
                fiscal_year=summary.fiscal_year,
                total_gains=summary.taxable_gains,
                total_losses=abs(summary.taxable_losses),
                net_taxable=summary.net_taxable,
                tax_before_carryforward=summary.tax_total,
                loss_carryforward_used=Decimal("0"),
                loss_carried_forward=summary.loss_carryforward,
                tax_total=summary.tax_total,
                transaction_count=summary.taxable_disposals,
            )
            self.session.add(annual)

    def _persist_securities_tax(self, version, report, account_id: Optional[int]) -> None:
        """Persist securities tax results to FrenchSecuritiesTaxEntry + FrenchSecuritiesTaxAnnualSummary.
        
        Only taxable entries are persisted. Non-taxable entries are excluded —
        they remain accessible via /realized-pnl.
        """
        for summary in report.summaries:
            for item in summary.line_items:
                if not item.disposal_taxable:
                    continue
                entry = FrenchSecuritiesTaxEntry(
                    calculation_version_id=version.version_id,
                    account_id=account_id,
                    realized_pnl_id=item.pnl_id,
                    fiscal_year=summary.fiscal_year,
                    trade_date=item.realized_at,
                    asset_symbol=item.asset_symbol,
                    direction="sell",
                    qty=item.qty,
                    proceeds_per_unit=item.proceeds_in_base,
                    cump_at_time=item.cost_basis_in_base,
                    gain_loss=item.gain_or_loss,
                    tax_amount=item.tax_total,
                )
                self.session.add(entry)

            annual = FrenchSecuritiesTaxAnnualSummary(
                calculation_version_id=version.version_id,
                account_id=account_id,
                fiscal_year=summary.fiscal_year,
                total_gains=summary.taxable_gains,
                total_losses=abs(summary.taxable_losses),
                net_taxable=summary.net_taxable,
                loss_carryforward_used=Decimal("0"),
                loss_carried_forward=summary.loss_carryforward,
                tax_total=summary.tax_total,
                transaction_count=summary.taxable_disposals,
            )
            self.session.add(annual)
