"""
Pipeline Stages - Individual processing stages for the transaction pipeline.

Note: LegExpansionStage and SplitStage are deprecated.
Leg expansion is now done at P&L time via leg_expander.py.
"""

from backend.services.pipeline.stages.transfer import TransferDetectionStage
from backend.services.pipeline.stages.enrichment import AssetEnrichmentStage
from backend.services.pipeline.stages.persistence import PersistenceStage

__all__ = [
    "TransferDetectionStage",
    "AssetEnrichmentStage",
    "PersistenceStage",
]
