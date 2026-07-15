"""
Tax Summary Models - Data classes for tax calculation results.

These are runtime-only models (not persisted to DB) that represent
the output of post-PnL tax calculations.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import List, Optional, Dict


class TaxJurisdiction(str, Enum):
    """Tax jurisdiction for jurisdiction-specific tax calculations.
    
    Controls post-PnL tax computation:
    - STANDARD: No jurisdiction-specific tax overlays (default, per-lot analytics only)
    - FR: France — runs BOTH crypto (Art. 150 VH bis) and securities (CUMP) overlays
    """

    STANDARD = "standard"
    FR = "fr"


@dataclass
class TaxLineItem:
    """Tax computation for a single RealizedPnl entry."""

    pnl_id: Optional[int]
    asset_id: int
    asset_symbol: str
    realized_at: Optional[datetime]
    qty: Decimal
    proceeds_in_base: Decimal
    cost_basis_in_base: Decimal
    gain_or_loss: Decimal  # proceeds - cost_basis (positive = gain, negative = loss)
    holding_period_days: Optional[int]
    disposal_taxable: bool
    tax_jurisdiction: TaxJurisdiction

    # Tax amounts (only set for taxable disposals)
    tax_income: Decimal = Decimal("0")  # Income tax portion
    tax_social: Decimal = Decimal("0")  # Social contributions portion
    tax_total: Decimal = Decimal("0")  # Total tax = income + social


@dataclass
class TaxSummary:
    """
    Aggregated tax summary for a fiscal period.
    
    Produced by TaxCalculator from RealizedPnl entries.
    All amounts are in the base currency (e.g., EUR).
    """

    tax_jurisdiction: TaxJurisdiction
    fiscal_year: int
    base_currency_symbol: str = "EUR"

    # Gross aggregates
    total_proceeds: Decimal = Decimal("0")
    total_cost_basis: Decimal = Decimal("0")
    total_gains: Decimal = Decimal("0")  # Sum of positive gain_or_loss
    total_losses: Decimal = Decimal("0")  # Sum of negative gain_or_loss (stored as negative)
    net_gain_or_loss: Decimal = Decimal("0")  # total_gains + total_losses

    # Taxable amounts (only disposals where disposal_taxable=True)
    taxable_proceeds: Decimal = Decimal("0")
    taxable_cost_basis: Decimal = Decimal("0")
    taxable_gains: Decimal = Decimal("0")
    taxable_losses: Decimal = Decimal("0")
    net_taxable: Decimal = Decimal("0")  # Net taxable gain (capped at 0 for fr_crypto)

    # Tax breakdown
    tax_income: Decimal = Decimal("0")  # Income tax (IR) portion
    tax_social: Decimal = Decimal("0")  # Social contributions (PS) portion
    tax_total: Decimal = Decimal("0")  # Total tax = income + social

    # Tax rates applied (for transparency)
    income_tax_rate: Decimal = Decimal("0")
    social_tax_rate: Decimal = Decimal("0")

    # Entry counts
    total_disposals: int = 0
    taxable_disposals: int = 0
    non_taxable_disposals: int = 0

    # Line items
    line_items: List[TaxLineItem] = field(default_factory=list)

    # Loss carryforward (for fr_crypto: losses can offset future gains)
    loss_carryforward: Decimal = Decimal("0")

    @property
    def effective_tax_rate(self) -> Decimal:
        """Effective tax rate = tax_total / net_taxable (0 if no taxable gain)."""
        if self.net_taxable <= 0:
            return Decimal("0")
        return (self.tax_total / self.net_taxable * 100).quantize(Decimal("0.01"))


@dataclass
class TaxReport:
    """
    Complete tax report across multiple fiscal years.
    
    Contains TaxSummary per year, with cross-year loss carryforward tracking.
    """

    tax_jurisdiction: TaxJurisdiction
    base_currency_symbol: str = "EUR"
    summaries: List[TaxSummary] = field(default_factory=list)

    @property
    def total_tax(self) -> Decimal:
        """Total tax across all fiscal years."""
        return sum((s.tax_total for s in self.summaries), Decimal("0"))

    @property
    def fiscal_years(self) -> List[int]:
        """List of fiscal years in the report."""
        return sorted(s.fiscal_year for s in self.summaries)

    def get_summary(self, fiscal_year: int) -> Optional[TaxSummary]:
        """Get summary for a specific fiscal year."""
        for s in self.summaries:
            if s.fiscal_year == fiscal_year:
                return s
        return None
