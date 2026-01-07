"""
Taxability Calculator - Determines disposal taxability for P&L legs.

This service encapsulates the taxability decision chain, keeping the 
CalculationUnitLeg model as pure data and treating taxability rules 
as a policy that can vary by jurisdiction.

The decision chain priority (first match wins):
1. Bundle taxability override (explicit user decision)
2. Disposing base currency → NEVER taxable (absolute rule)
3. Explicit transaction flag (disposal_taxable on transaction)
4. Inflows → never taxable (only outflows/fees can be disposals)
5. Cost basis transfers → never taxable (transfers, splits)
6. Fees → use config.fee_taxable_by_default
7. Outflow-only → taxable (payment, gift, etc.)
8. Disposal to base currency (selling) → taxable
9. Default: crypto-to-crypto swap taxability from config

This module also provides `suggest_bundle_taxability()` for suggestion-time
taxability hints, using the same logic but adapted for bundle-level context
(before legs exist).
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional, Protocol

from backend.db.models import TaxabilityStatus

if TYPE_CHECKING:
    from backend.db.models import CalculationUnitLeg, CalculationUnit
    from backend.services.pnl.config import PnLConfig


# ============================================================================
# Bundle-Level Taxability Suggestion (for API suggestions)
# ============================================================================


@dataclass
class BundleTaxabilitySuggestion:
    """Result of a bundle taxability suggestion."""
    
    taxability: TaxabilityStatus
    reason: str
    is_hint: bool = True  # Always True - this is a hint, not authoritative


def suggest_bundle_taxability(
    pattern: Optional[str],
    crypto_swap_taxable: bool = False,
) -> BundleTaxabilitySuggestion:
    """
    Suggest taxability for a bundle based on pattern and configuration.
    
    This is a HINT for UX purposes, not the authoritative taxability decision.
    The actual per-leg taxability is computed during P&L calculation by
    TaxabilityCalculator, which has access to full leg context.
    
    The suggestion uses the same decision logic as TaxabilityCalculator but
    adapted for bundle-level (pattern-based) decisions:
    - Rule 5: Cost basis transfers (transfer/split) → non-taxable
    - Rule 5b: Pending transfers → non-taxable  
    - Rule 9: Swaps → use crypto_swap_taxable config
    
    Note: Rules 2-4, 6-8 require leg-level context and are handled during P&L.
    
    Args:
        pattern: The bundle pattern (transfer, swap, split, pending_transfer, etc.)
        crypto_swap_taxable: Whether crypto-to-crypto swaps are taxable (from config)
        
    Returns:
        BundleTaxabilitySuggestion with taxability status and explanation
    """
    # Rule 5: Cost basis transfers (transfer/split) → never taxable
    if pattern in ("transfer", "split"):
        return BundleTaxabilitySuggestion(
            taxability=TaxabilityStatus.NON_TAXABLE,
            reason=f"Pattern '{pattern}' is a cost basis transfer (non-taxable by default)",
        )
    
    # Rule 5b: Pending transfers → non-taxable
    if pattern == "pending_transfer":
        return BundleTaxabilitySuggestion(
            taxability=TaxabilityStatus.NON_TAXABLE,
            reason="Pending transfer awaiting counterpart (non-taxable)",
        )
    
    # Rule 9: Swaps → use config
    if pattern == "swap":
        if crypto_swap_taxable:
            return BundleTaxabilitySuggestion(
                taxability=TaxabilityStatus.TAXABLE,
                reason="Crypto-to-crypto swap (taxable per configuration)",
            )
        else:
            return BundleTaxabilitySuggestion(
                taxability=TaxabilityStatus.NON_TAXABLE,
                reason="Crypto-to-crypto swap (non-taxable per configuration)",
            )
    
    # Unknown pattern
    return BundleTaxabilitySuggestion(
        taxability=TaxabilityStatus.UNKNOWN,
        reason="Pattern not recognized; taxability will be computed during P&L calculation",
    )


# ============================================================================
# Leg-Level Taxability Calculator (for P&L processing)
# ============================================================================


class LegLike(Protocol):
    """Protocol for leg-like objects (CalculationUnitLeg)."""
    asset_id: int
    leg_type: str
    tx_disposal_taxable: bool
    unit: "CalculationUnit"


class TaxabilityCalculator:
    """
    Calculates disposal taxability for P&L legs.
    
    This is a stateless calculator that applies taxability rules based on:
    - The leg being disposed
    - The unit context (bundle overrides, pattern, etc.)
    - Configuration (base currency, swap taxability, etc.)
    
    Usage:
        calculator = TaxabilityCalculator(config)
        for leg in disposal_legs:
            leg.disposal_taxable = calculator.compute(leg)
    """
    
    def __init__(self, config: "PnLConfig"):
        self.config = config
    
    def compute(self, leg: LegLike) -> bool:
        """
        Compute disposal taxability for a leg.
        
        Args:
            leg: The leg to evaluate (CalculationUnitLeg or any LegLike object)
            
        Returns:
            True if the disposal is taxable, False otherwise
        """
        unit = leg.unit
        if not unit:
            return False
        
        # 1. Bundle taxability override (explicit user decision)
        bundle_override = getattr(unit, 'bundle_taxability_override', None)
        if bundle_override:
            return bundle_override == "taxable"
        
        # 2. Disposing base currency is NEVER taxable (absolute rule)
        if self._is_base_currency(leg.asset_id):
            return False
        
        # 3. Explicit transaction flag (user override on transaction)
        if self._has_taxable_override(leg):
            return True
        
        # 4. Inflows never taxable
        if self._is_inflow(leg):
            return False
        
        # 5. Cost basis transfers never taxable
        if self._is_cost_basis_transfer(unit):
            return False
        
        # 5b. Pending transfers are non-taxable (P&L realization skipped anyway)
        if self._is_pending_transfer(unit):
            return False
        
        # 6. Fees use config
        if self._is_fee(leg):
            return self.config.fee_taxable_by_default
        
        # 7. Outflow-only always taxable (but not pending transfers - handled above)
        if self._is_outflow_only(unit):
            return True
        
        # 8. Disposal to base currency (selling) always taxable
        if self._is_selling_to_base(unit):
            return True
        
        # 9. Default: crypto-to-crypto swap taxability
        return self.config.crypto_swap_taxable_by_default
    
    def apply_to_legs(self, legs: list) -> None:
        """
        Compute and store disposal_taxable on multiple legs.
        
        Convenience method that computes taxability for each leg
        and stores the result on the leg's disposal_taxable field.
        
        Args:
            legs: List of legs (CalculationUnitLeg or LegLike objects)
        """
        for leg in legs:
            leg.disposal_taxable = self.compute(leg)
    
    # -------------------------------------------------------------------------
    # Private helper methods for readability
    # -------------------------------------------------------------------------
    
    def _is_base_currency(self, asset_id: int) -> bool:
        """Check if asset is the base currency."""
        return (
            asset_id is not None 
            and self.config.base_currency_id 
            and asset_id == self.config.base_currency_id
        )
    
    def _has_taxable_override(self, leg: LegLike) -> bool:
        """Check if leg has explicit taxable override from transaction."""
        return getattr(leg, 'tx_disposal_taxable', False) is True
    
    def _is_inflow(self, leg: LegLike) -> bool:
        """Check if leg is an inflow (never taxable)."""
        leg_type = getattr(leg, 'leg_type', None)
        return leg_type == "inflow"
    
    def _is_fee(self, leg: LegLike) -> bool:
        """Check if leg is a fee."""
        leg_type = getattr(leg, 'leg_type', None)
        is_fee = getattr(leg, 'is_fee', False)
        return leg_type == "fee" or is_fee
    
    def _is_cost_basis_transfer(self, unit: Any) -> bool:
        """Check if unit is a cost basis transfer (transfer/split)."""
        return getattr(unit, 'is_cost_basis_transfer', False)
    
    def _is_pending_transfer(self, unit: Any) -> bool:
        """Check if unit is a pending transfer (incomplete transfer awaiting counterpart)."""
        pattern = getattr(unit, 'pattern', None)
        return pattern == "pending_transfer"
    
    def _is_outflow_only(self, unit: Any) -> bool:
        """Check if unit has only outflows (payment, gift, etc.)."""
        return getattr(unit, 'is_outflow_only', False)
    
    def _is_selling_to_base(self, unit: Any) -> bool:
        """Check if unit is selling to base currency."""
        inflow_asset_ids = getattr(unit, '_inflow_asset_ids', set())
        return self.config.base_currency_id in inflow_asset_ids
