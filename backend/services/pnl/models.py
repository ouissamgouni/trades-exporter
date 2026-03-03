"""
P&L Data Models - Data classes for P&L calculation results.

This module contains:
- PnLResult: Complete result of P&L calculation

- ResidualWarning: Warning for value residuals
- RuntimeUnitType: Enum for unit types (deprecated, use CalculationUnit.pattern)

SQLModel entities (CalculationUnit, CostLot, ConsumedLotSlice, RealizedPnl, LotSettlement, 
PnlWarning) are imported from backend.db.models and used directly for both runtime
calculation and persistence.

Note: RuntimeCalculationUnit has been merged into CalculationUnit (SQLModel).
CalculationUnit now serves both as the persistence model AND the runtime wrapper.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from functools import cached_property
from sys import version
from typing import Optional, List, Dict, Set, Any, TYPE_CHECKING
from uuid import UUID
from enum import Enum

# Import SQLModel entities for direct use in P&L engine
from backend.db.models import (
    CalculationVersion,
    CalculationUnit,
    UnitPattern,
    Asset,
    CostLot,
    ConsumedLotSlice,
    RealizedPnl,
    LotSettlement,
    PnlWarning,
)
from backend.services.pnl.config import WarningType


if TYPE_CHECKING:
    from backend.services.pnl.config import PnLConfig


# Re-export SQLModel entities for backward compatibility
# Code can import from this module or directly from db.models
__all__ = [
    "RuntimeUnitType",
    "CalculationUnit",  # Now the unified model (was RuntimeCalculationUnit)
    "CostLot",
    "ConsumedLotSlice",
    "RealizedPnl",
    "LotSettlement",
    "PnLWarning",
    "PnLResult",
]


class RuntimeUnitType(str, Enum):
    """Runtime unit types for P&L processing.
    
    Simplified to two fundamental operations:
    - SWAP: Any exchange of value (buy, sell, trade, airdrop, payment)
    - TRANSFER: Same asset moves between owned accounts (non-taxable)
    
    Deprecated: Use CalculationUnit.pattern property instead (supports transfer, swap, split, unknown).
    """

    SWAP = "swap"  # Exchange of value (taxability depends on asset types)
    TRANSFER = "transfer"  # Self-transfer between owned accounts (never taxable)


# =============================================================================
# PnLWarning is now a SQLModel imported from backend.db.models
# =============================================================================
# 
# PnLWarning used to be a dataclass here but has been moved to db.models as a SQLModel.
# It is used directly for both runtime warnings and persistence.
#
# =============================================================================


# =============================================================================
# RuntimeCalculationUnit has been MERGED into CalculationUnit (SQLModel)
# =============================================================================
# 
# CalculationUnit now serves as BOTH:
# 1. The persistence model (stored in calculation_units table)
# 2. The runtime wrapper (with members populated during P&L calculation)
#
# Key changes:
# - RuntimeCalculationUnit dataclass → CalculationUnit SQLModel (db.models)
# - ProcessedUnit SQLModel → Merged into CalculationUnit
# - calculation_unit_id field → unit_origin field ("bundle:{id}" or "tx:{id}")
#
# All runtime properties (outflows, inflows, fees, pattern, is_cost_basis_transfer,
# is_disposal_taxable) are now on the CalculationUnit class in db.models.
# =============================================================================

# Backward compatibility alias
RuntimeCalculationUnit = CalculationUnit


# =============================================================================
# ResidualWarning has been DEPRECATED
# =============================================================================
# 
# ResidualWarning used to be a separate dataclass for value residual warnings.
# It has been replaced with regular PnlWarning with type RESIDUAL_MISMATCH.
#
# Residual details are now stored in PnlWarning.details field:
# {
#   "residual_in_base": float,
#   "residual_pct": float,
#   "inflow_total": float,
#   "outflow_total": float,
#   "fees_total": float,
# }
#
# Migration:
# - ResidualWarning → PnlWarning with warning_type=RESIDUAL_MISMATCH
# - PnLResult.residual_warnings → Part of PnLResult.warnings (via unit.warnings)
# - unit.residual_warning → Removed (warnings stored in unit.warnings)
# =============================================================================


# =============================================================================
# UnitExecutionResult has been ELIMINATED
# =============================================================================
# 
# UnitExecutionResult was a temporary dataclass used to collect P&L artifacts
# during calculation unit processing. It has been eliminated in favor of direct
# entity attachment to CalculationUnit relationships:
#
# BEFORE (with UnitExecutionResult):
#   unit_result = UnitExecutionResult()
#   unit_result.created_lots.append(lot)
#   # ... then unpack unit_result and attach to unit
#
# AFTER (direct attachment):
#   unit.cost_lots.append(lot)  # Direct attachment during processing
#
# Entities are now attached directly to CalculationUnit relationships as they're
# created, eliminating 40+ lines of redundant unpacking logic in the engine.
#
# Migration notes:
# - created_lots → unit.cost_lots (relationship)
# - realized_entries → unit.realized_pnl_records (relationship)
# - warnings → unit.warnings (relationship)
# - consumed_slices → accessible via unit.cost_lots[*].consumed_slices (traversal)
# - settlement_records → accessible via unit.cost_lots[*].outgoing_settlements (traversal)
# - residual_pct → unit.residual_pct (runtime attribute)
# - residual_warning → unit.residual_warning (runtime attribute)
# =============================================================================


@dataclass
class PnLResult:
    """
    Complete result of P&L calculation.
    
    With cascade relationships, data flows naturally:
    - CalculationVersion → calculation_units (cascade)
    - CalculationUnit → cost_lots, realized_pnl_records, warnings (cascade)
    - CostLot → consumed_slices, outgoing_settlements (cascade)
    
    All lists are computed properties derived from traversing the version's relationships.
    Just add CalculationUnits to version.calculation_units and everything persists automatically.
    """

    config: Any  # PnLConfig
    version: CalculationVersion  # The version entity - owns everything via cascade

 

    # ==========================================================================
    # Computed properties - derived from version's cascade relationships
    # ==========================================================================
    
    @property
    def version_id(self) -> Optional[int]:
        """Version ID (None until persisted)."""
        return self.version.version_id
    
    @property
    def calculation_units(self) -> List[CalculationUnit]:
        """All calculation units from this version."""
        return self.version.calculation_units or []
    
    @property
    def created_lots(self) -> List[CostLot]:
        """All cost lots created across all units."""
        lots = []
        for unit in self.calculation_units:
            lots.extend(unit.cost_lots or [])
        return lots
    
    @property
    def realized_pnl_entries(self) -> List[RealizedPnl]:
        """All realized P&L entries across all units."""
        entries = []
        for unit in self.calculation_units:
            entries.extend(unit.realized_pnl_records or [])
        return entries
    
    @property
    def consumed_slices(self) -> List[ConsumedLotSlice]:
        """All consumed slices across all calculation units."""
        slices = []
        for unit in self.calculation_units:
            slices.extend(unit.consumed_slices or [])
        return slices
    
    @property
    def settlement_records(self) -> List[LotSettlement]:
        """All settlement records across all cost lots."""
        settlements = []
        for lot in self.created_lots:
            settlements.extend(lot.outgoing_settlements or [])
        return settlements
    
    @property
    def warnings(self) -> List[PnlWarning]:
        """All warnings across all units."""
        all_warnings = []
        for unit in self.calculation_units:
            all_warnings.extend(unit.warnings or [])
        return all_warnings

    # ==========================================================================
    # Summary stats - computed from relationships
    # ==========================================================================
    
    @property
    def total_realized_pnl(self) -> Decimal:
        """Sum of taxable realized P&L."""
        total = Decimal("0")
        for entry in self.realized_pnl_entries:
            if entry.disposal_taxable and entry.pnl_in_base:
                total += entry.pnl_in_base
        return total
    
    @property
    def total_all_pnl(self) -> Decimal:
        """Sum of ALL realized P&L (taxable + non-taxable, e.g. derivative settlements)."""
        total = Decimal("0")
        for entry in self.realized_pnl_entries:
            if entry.pnl_in_base:
                total += entry.pnl_in_base
        return total
    

        
