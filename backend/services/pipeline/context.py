"""
PipelineContext - Shared context passed through pipeline stages.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from sqlmodel import Session

from backend.db.models import CalculationUnit


@dataclass
class PersistenceResult:
    """Result of persistence operations with detailed tracking."""

    synced_ids: List[str] = field(default_factory=list)  # source_transaction_ids created
    updated_ids: List[str] = field(default_factory=list)  # source_transaction_ids updated
    skipped_ids: List[str] = field(default_factory=list)  # source_transaction_ids skipped
    error_details: List[dict] = field(default_factory=list)  # {source_transaction_id, error}


@dataclass
class PipelineContext:
    """
    Context object passed through the pipeline.

    Contains shared resources and configuration that stages can use.
    """

    session: Session
    raw_item: Optional[Dict[str, Any]] = None  # Original raw data (for sync jobs)
    source: Optional[str] = None  # Source identifier (e.g., 'binance', 'manual')

    # Sync job tracking
    sync_connector_run_id: Optional[int] = None  # FK to SyncJobConnectorRun for tracking

    # Options
    skip_persistence: bool = False  # Skip persistence stage (useful for dry runs)
    skip_split: bool = False  # Skip splitting (useful if already split)
    skip_transfer_detection: bool = False  # Skip transfer detection
    skip_asset_enrichment: bool = (
        False  # Skip asset enrichment (if already has asset_ids)
    )

    # Metadata collected during processing
    created_units: List[CalculationUnit] = field(
        default_factory=list
    )  # V3: units instead of bundles
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    # Persistence result (populated by PersistenceStage)
    persistence_result: Optional[PersistenceResult] = None

    # Statistics (populated by stages)
    new_count: int = 0
    updated_count: int = 0
    skipped_count: int = 0
    split_count: int = 0
    transfer_count: int = 0
