"""
P&L Calculation Module - Modular cost basis and realized P&L calculation.

This module implements a comprehensive P&L calculation engine with support for:
- FIFO, LIFO, HIFO cost lot methods
- LOT_TRAVEL and MEGA_WALLET lot modes
- Fee expansion at P&L runtime
- Unified group handling for all transaction types
- Configurable taxability rules

Architecture:
- CalculationUnit (DB model): Unified model for transaction groupings (both runtime and persisted)
- UserCalculationBundle: User-defined bundles for grouping transactions
- unit_origin field: Tracks source as "bundle:{id}" or "tx:{id}"

Usage:
    from backend.services.pnl.engine import PnLEngine
    from backend.services.pnl.config import PnLConfig, CostMethod, LotMode

    config = PnLConfig(
        lot_method=CostMethod.FIFO,
        lot_mode=LotMode.LOT_TRAVEL,
        base_currency_id=1,  # EUR
    )

    engine = PnLEngine(session=session, price_service=price_service, config=config)
    result = engine.calculate()
"""

from backend.services.pnl.config import PnLConfig, CostMethod, LotMode, WarningType
from backend.services.pnl.models import (
    PnLResult,
    RuntimeCalculationUnit,  # Backward compat alias for CalculationUnit
    RuntimeUnitType,
)
from backend.db.models import CostLot, ConsumedLotSlice, RealizedPnl, LotSettlement, CalculationUnit, PnlWarning
from backend.services.pnl.lot_manager import LotManager
from backend.services.pnl.tax_models import TaxLineItem, TaxSummary, TaxReport

__all__ = [
    # Config
    "PnLConfig",
    "CostMethod",
    "LotMode",
    "WarningType",
    # Models (SQLModel entities from db.models)
    "CalculationUnit",
    "CostLot",
    "ConsumedLotSlice",
    "RealizedPnl",
    "LotSettlement",
    # Runtime models
    "PnLWarning",
    "PnLResult",
    "RuntimeCalculationUnit",  # Backward compat alias
    "RuntimeUnitType",
    # Tax models
    "TaxLineItem",
    "TaxSummary",
    "TaxReport",
    # Components
    "LotManager",
]

# NOTE: PnLEngine and handle_unit are NOT re-exported here to avoid circular imports.
# Import them directly from their modules:
#   from backend.services.pnl.engine import PnLEngine
#   from backend.services.pnl.group_handler import handle_unit
