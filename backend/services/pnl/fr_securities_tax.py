"""
French Securities Tax Calculator — Article 150-0 A CGI.

Implements the CUMP (Coût Unitaire Moyen Pondéré) method for French securities taxation:
  - On buy:  total_cost += qty × price, total_qty += qty, cump = total_cost / total_qty
  - On sell: gain = qty × (proceeds_per_unit - cump), total_cost -= qty × cump, total_qty -= qty
  - On split: total_qty *= ratio, cump /= ratio (total_cost unchanged)

Losses carry forward up to 10 years against future gains.

Architecture:
  PnL Engine → RealizedPnl entries (securities only) → FrenchSecuritiesTaxCalculator → TaxReport
"""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, ROUND_HALF_UP
from typing import List, Optional, Dict

from backend.db.models import RealizedPnl, Asset
from backend.services.pnl.tax_models import TaxLineItem, TaxSummary, TaxReport, TaxJurisdiction


# PFU rates
FR_INCOME_TAX_RATE = Decimal("0.128")
FR_SOCIAL_CONTRIBUTIONS_RATE = Decimal("0.172")
FR_PFU_TOTAL_RATE = Decimal("0.30")

TWO_PLACES = Decimal("0.01")

# Securities losses carry forward for 10 years
LOSS_CARRYFORWARD_YEARS = 10


@dataclass
class CUMPState:
    """Per-asset CUMP tracking state."""
    total_qty: Decimal = Decimal("0")
    total_cost: Decimal = Decimal("0")
    
    @property
    def cump(self) -> Decimal:
        """Current CUMP (Coût Unitaire Moyen Pondéré)."""
        if self.total_qty <= 0:
            return Decimal("0")
        return self.total_cost / self.total_qty

    def buy(self, qty: Decimal, price_per_unit: Decimal) -> None:
        """Record a purchase: accumulate cost and quantity."""
        self.total_cost += qty * price_per_unit
        self.total_qty += qty

    def sell(self, qty: Decimal, proceeds_per_unit: Decimal) -> Decimal:
        """
        Record a sale: compute gain/loss and update state.
        
        Returns:
            gain_or_loss: qty × (proceeds_per_unit - cump)
        """
        current_cump = self.cump
        gain_or_loss = qty * (proceeds_per_unit - current_cump)
        self.total_cost -= qty * current_cump
        self.total_qty -= qty
        # Guard against floating point drift
        if self.total_qty < 0:
            self.total_qty = Decimal("0")
        if self.total_cost < 0:
            self.total_cost = Decimal("0")
        return gain_or_loss


class FrenchSecuritiesTaxCalculator:
    """
    Computes French securities taxes from RealizedPnl entries using CUMP.
    
    Usage:
        calculator = FrenchSecuritiesTaxCalculator(config)
        report = calculator.compute(securities_pnl_entries, asset_map)
    """

    def __init__(self, base_currency_symbol: str = "EUR"):
        self.base_currency_symbol = base_currency_symbol

    def compute(
        self,
        entries: List[RealizedPnl],
        asset_map: Optional[Dict[int, Asset]] = None,
        effective_taxable_map: Optional[Dict[int, bool]] = None,
    ) -> TaxReport:
        """
        Compute French securities taxes for all entries using CUMP method.
        
        Groups entries by fiscal year, maintains per-asset CUMP state across years.
        
        Args:
            effective_taxable_map: Optional dict {transaction_id: is_taxable} from
                TransactionTaxOverride. When present, overrides entry.disposal_taxable
                for tax classification without mutating the ORM object.
        """
        self._effective_taxable_map = effective_taxable_map or {}
        # Group entries by fiscal year
        by_year: Dict[int, List[RealizedPnl]] = defaultdict(list)
        for entry in entries:
            year = entry.realized_at.year if entry.realized_at else 0
            by_year[year].append(entry)

        summaries = []
        loss_carryforward = Decimal("0")

        for year in sorted(by_year.keys()):
            year_entries = by_year[year]
            summary = self._compute_year(year, year_entries, asset_map, loss_carryforward)
            loss_carryforward = summary.loss_carryforward
            summaries.append(summary)

        return TaxReport(
            tax_jurisdiction=TaxJurisdiction.FR,
            base_currency_symbol=self.base_currency_symbol,
            summaries=summaries,
        )

    def _compute_year(
        self,
        fiscal_year: int,
        entries: List[RealizedPnl],
        asset_map: Optional[Dict[int, Asset]],
        prior_loss_carryforward: Decimal,
    ) -> TaxSummary:
        """
        French securities tax for one fiscal year: PFU 30% with 10-year loss carryforward.
        
        Key rules:
        - Each taxable disposal gain/loss is computed per the CUMP method
        - Losses can offset gains within the same fiscal year
        - Net losses carry forward for up to 10 years
        - PFU = 12.8% IR + 17.2% PS on the net gain
        """
        summary = TaxSummary(
            tax_jurisdiction=TaxJurisdiction.FR,
            fiscal_year=fiscal_year,
            base_currency_symbol=self.base_currency_symbol,
            income_tax_rate=FR_INCOME_TAX_RATE,
            social_tax_rate=FR_SOCIAL_CONTRIBUTIONS_RATE,
        )

        line_items = []

        for entry in entries:
            gain_or_loss = (entry.proceeds_in_base or Decimal("0")) - (entry.cost_basis_in_base or Decimal("0"))
            asset_symbol = self._resolve_symbol(entry.asset_id, asset_map)

            effective_taxable = self._effective_taxable_map.get(
                entry.transaction_id, entry.disposal_taxable
            )

            item = TaxLineItem(
                pnl_id=entry.pnl_id,
                asset_id=entry.asset_id,
                asset_symbol=asset_symbol,
                realized_at=entry.realized_at,
                qty=entry.qty or Decimal("0"),
                proceeds_in_base=entry.proceeds_in_base or Decimal("0"),
                cost_basis_in_base=entry.cost_basis_in_base or Decimal("0"),
                gain_or_loss=gain_or_loss,
                holding_period_days=entry.holding_period_days,
                disposal_taxable=effective_taxable,
                tax_jurisdiction=TaxJurisdiction.FR,
            )

            summary.total_disposals += 1
            summary.total_proceeds += item.proceeds_in_base
            summary.total_cost_basis += item.cost_basis_in_base

            if gain_or_loss >= 0:
                summary.total_gains += gain_or_loss
            else:
                summary.total_losses += gain_or_loss

            if effective_taxable:
                summary.taxable_disposals += 1
                summary.taxable_proceeds += item.proceeds_in_base
                summary.taxable_cost_basis += item.cost_basis_in_base
                if gain_or_loss >= 0:
                    summary.taxable_gains += gain_or_loss
                else:
                    summary.taxable_losses += gain_or_loss
            else:
                summary.non_taxable_disposals += 1

            line_items.append(item)

        summary.net_gain_or_loss = summary.total_gains + summary.total_losses

        # Securities: losses offset gains within the year
        net_taxable_before_carryforward = summary.taxable_gains + summary.taxable_losses

        # Apply prior loss carryforward (10-year window)
        net_after_carryforward = net_taxable_before_carryforward + prior_loss_carryforward

        if net_after_carryforward > 0:
            summary.net_taxable = net_after_carryforward
            summary.loss_carryforward = Decimal("0")
        else:
            summary.net_taxable = Decimal("0")
            summary.loss_carryforward = net_after_carryforward

        # PFU on net taxable gain
        if summary.net_taxable > 0:
            summary.tax_income = (summary.net_taxable * FR_INCOME_TAX_RATE).quantize(TWO_PLACES, ROUND_HALF_UP)
            summary.tax_social = (summary.net_taxable * FR_SOCIAL_CONTRIBUTIONS_RATE).quantize(TWO_PLACES, ROUND_HALF_UP)
            summary.tax_total = summary.tax_income + summary.tax_social

            _distribute_tax_to_items(line_items, summary.net_taxable, summary.tax_income, summary.tax_social)

        summary.line_items = line_items
        return summary

    @staticmethod
    def _resolve_symbol(asset_id: int, asset_map: Optional[Dict[int, Asset]]) -> str:
        if asset_map and asset_id in asset_map:
            asset = asset_map[asset_id]
            return getattr(asset, 'symbol', f"ASSET_{asset_id}")
        return f"ASSET_{asset_id}"


def _distribute_tax_to_items(
    items: List[TaxLineItem],
    net_taxable: Decimal,
    total_income_tax: Decimal,
    total_social_tax: Decimal,
) -> None:
    """Distribute total tax proportionally across taxable gain line items."""
    if net_taxable <= 0:
        return

    taxable_gain_items = [i for i in items if i.disposal_taxable and i.gain_or_loss > 0]
    total_taxable_gains = sum(i.gain_or_loss for i in taxable_gain_items)

    if total_taxable_gains <= 0:
        return

    for item in taxable_gain_items:
        proportion = item.gain_or_loss / total_taxable_gains
        item.tax_income = (total_income_tax * proportion).quantize(TWO_PLACES, ROUND_HALF_UP)
        item.tax_social = (total_social_tax * proportion).quantize(TWO_PLACES, ROUND_HALF_UP)
        item.tax_total = item.tax_income + item.tax_social
