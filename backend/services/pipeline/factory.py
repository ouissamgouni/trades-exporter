"""
Pipeline Factory - Functions to create pre-configured pipelines.
"""

from sqlmodel import Session

from backend.services.pipeline.base import TransactionPipeline
from backend.services.pipeline.stages import (
    TransferDetectionStage,
    AssetEnrichmentStage,
    PersistenceStage,
)


def create_default_pipeline(
    session: Session,
) -> TransactionPipeline:
    """
    Create a pipeline with the default stage configuration.

    Stages (in order):
    1. TransferDetectionStage - Detect internal transfers
    2. AssetEnrichmentStage - Resolve symbols to asset IDs
    3. PersistenceStage - Save to database

    NOTE: Leg expansion (outflow/inflow/fee legs) is now done at P&L time
    via leg_expander.prepare_transactions_for_pnl(). This keeps the
    transaction table clean and atomic.

    Args:
        session: SQLModel session

    Returns:
        Configured TransactionPipeline
    """
    pipeline = TransactionPipeline(session)
    pipeline.add_stage(TransferDetectionStage())
    pipeline.add_stage(AssetEnrichmentStage())
    pipeline.add_stage(PersistenceStage())

    return pipeline
