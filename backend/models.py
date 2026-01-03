"""
DEPRECATED: This module is kept for backwards compatibility.
All models have been moved to backend.api.schemas.

Please update your imports to use:
    from backend.api.schemas import <ModelName>
"""

# Re-export everything from schemas for backwards compatibility
from backend.api.schemas import (
    # Transaction models
    TransactionUpdate,
    TransactionResponse,
    # Unit models
    CreateUnitRequest,
    UnitResponse,
    SuggestedUnit,
    # P&L models
    CostLotResponse,
    ConsumedLotDetail,
    RealizedPnLResponse,
    UnrealizedPnLResponse,
    CalculationVersionResponse,
    AssetBalanceResponse,
    PnLCalculationRequest,
    PnLCalculationResponse,
    PnLSummaryResponse,
    # SQLModel re-exports
    NormalizedTransaction,
    Asset,
)

__all__ = [
    "TransactionUpdate",
    "TransactionResponse",
    "CreateUnitRequest",
    "UnitResponse",
    "SuggestedUnit",
    "CostLotResponse",
    "ConsumedLotDetail",
    "RealizedPnLResponse",
    "UnrealizedPnLResponse",
    "CalculationVersionResponse",
    "AssetBalanceResponse",
    "PnLCalculationRequest",
    "PnLCalculationResponse",
    "PnLSummaryResponse",
    "NormalizedTransaction",
    "Asset",
]
