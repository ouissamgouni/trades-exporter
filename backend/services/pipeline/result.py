"""
PipelineResult - Result of processing transactions through the pipeline.
"""

from dataclasses import dataclass
from typing import List, Optional, TYPE_CHECKING

from backend.db.models import NormalizedTransaction, CalculationUnit

if TYPE_CHECKING:
    from backend.services.pipeline.context import PersistenceResult


@dataclass
class PipelineResult:
    """
    Result of processing transaction(s) through the pipeline.
    """

    success: bool
    transactions: List[NormalizedTransaction]  # Persisted SQLModel transactions
    pydantic_transactions: List[
        NormalizedTransaction
    ]  # Pre-persistence transactions (SQLModel instances work as DTOs)
    units: List[CalculationUnit]  # V3: Created units (for split trades)
    errors: List[str]
    warnings: List[str]

    # Statistics
    new_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    split_count: int = 0  # Number of transactions that were split
    transfer_count: int = 0  # Number of internal transfers detected
    
    # Persistence details (for sync job tracking)
    persistence_result: Optional["PersistenceResult"] = None
