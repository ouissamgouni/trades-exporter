"""
Pipeline Factory - Functions to create pre-configured pipelines.
"""

from sqlmodel import Session

from backend.services.pipeline.base import TransactionPipeline
from backend.services.pipeline.stages import (
    OnChainAddressEnrichmentStage,
    AccountResolutionStage,
    AssetEnrichmentStage,
    PersistenceStage,
)


def create_default_pipeline(
    session: Session,
) -> TransactionPipeline:
    """
    Create a pipeline with the default stage configuration.

    Stages (in order):
    1. OnChainAddressEnrichmentStage - Fill missing from/to addresses from blockchain explorers
    2. AccountResolutionStage - Resolve source addresses to account IDs
    3. AssetEnrichmentStage - Resolve symbols to asset IDs
    4. PersistenceStage - Save to database

    NOTE: Leg expansion (outflow/inflow/fee legs) is now done at P&L time
    via leg_expander.prepare_transactions_for_pnl(). This keeps the
    transaction table clean and atomic.

    Args:
        session: SQLModel session

    Returns:
        Configured TransactionPipeline
    """
    pipeline = TransactionPipeline(session)
    pipeline.add_stage(OnChainAddressEnrichmentStage())
    pipeline.add_stage(AccountResolutionStage())
    pipeline.add_stage(AssetEnrichmentStage())
    pipeline.add_stage(PersistenceStage())

    return pipeline
