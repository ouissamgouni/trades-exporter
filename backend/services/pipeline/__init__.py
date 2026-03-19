"""
Transaction Enrichment Pipeline

A modular pipeline for processing transactions through multiple stages:
1. Account Resolution - Resolve source addresses to account IDs
2. Asset Enrichment - Resolve asset symbols to asset IDs
3. Persistence - Save transactions to database

Note: Trade splitting (buy/sell into atomic legs) is now done at P&L engine
level via prepare_transactions_for_pnl() to preserve original transactions.

The pipeline can be used from:
- Sync job service (bulk processing from connectors)
- Manual transaction creation from UI
- Any other source that needs to create normalized transactions
"""

from backend.services.pipeline.context import PipelineContext
from backend.services.pipeline.result import PipelineResult
from backend.services.pipeline.base import PipelineStage, TransactionPipeline
from backend.services.pipeline.factory import (
    create_default_pipeline,
)
from backend.services.pipeline.stages import (
    AccountResolutionStage,
    AssetEnrichmentStage,
    PersistenceStage,
)

__all__ = [
    # Core
    "TransactionPipeline",
    "PipelineContext",
    "PipelineResult",
    "PipelineStage",
    # Stages
    "AccountResolutionStage",
    "AssetEnrichmentStage",
    "PersistenceStage",
    # Factories
    "create_default_pipeline",
]
