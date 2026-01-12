"""
Pipeline Base - Core pipeline infrastructure.

Contains:
- PipelineStage: Abstract base class for all stages
- TransactionPipeline: Orchestrates processing through stages
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional, Tuple, Union

from sqlmodel import Session

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.services.pipeline.context import PipelineContext
from backend.services.pipeline.result import PipelineResult

log = configure_logging("transaction_pipeline")


class PipelineStage(ABC):
    """
    Base class for pipeline stages.

    Each stage receives a list of transactions and context,
    processes them, and returns the (potentially modified) list.
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Stage name for logging."""

    @abstractmethod
    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Process transactions through this stage.

        Args:
            transactions: List of transactions to process
            context: Pipeline context with shared resources

        Returns:
            Tuple of (processed transactions, success flag)
            If success is False, pipeline should stop.
        """

    def should_skip(self, context: PipelineContext) -> bool:
        """Check if this stage should be skipped based on context."""
        return False


class TransactionPipeline:
    """
    Orchestrates transaction processing through multiple stages.

    Usage:
        pipeline = TransactionPipeline(session)
        pipeline.add_stage(SplitStage())
        pipeline.add_stage(TransferDetectionStage())
        pipeline.add_stage(AssetEnrichmentStage())
        pipeline.add_stage(PersistenceStage())

        result = pipeline.process(transactions, context)
    """

    def __init__(self, session: Session):
        """
        Initialize the pipeline with a database session.

        Args:
            session: SQLModel session for database operations
        """
        self.session = session
        self.stages: List[PipelineStage] = []
        self.logger = log

    def add_stage(self, stage: PipelineStage) -> "TransactionPipeline":
        """
        Add a stage to the pipeline.

        Args:
            stage: The stage to add

        Returns:
            Self for method chaining
        """
        self.stages.append(stage)
        return self

    def process(
        self,
        transactions: Union[NormalizedTransaction, List[NormalizedTransaction]],
        context: Optional[PipelineContext] = None,
    ) -> PipelineResult:
        """
        Process transaction(s) through all pipeline stages.

        Args:
            transactions: Single transaction or list of transactions
            context: Optional context (created if not provided)

        Returns:
            PipelineResult with processed transactions and metadata
        """
        # Normalize input to list
        if not isinstance(transactions, list):
            transactions = [transactions]

        # Create context if not provided
        if context is None:
            context = PipelineContext(session=self.session)

        # Initialize result
        result = PipelineResult(
            success=True,
            transactions=[],
            pydantic_transactions=[],
            units=[],  # V3: units instead of bundles
            errors=[],
            warnings=[],
        )

        # Track original count for split detection
        original_count = len(transactions)

        self.logger.debug(
            f"Starting pipeline with {len(transactions)} transaction(s), "
            f"{len(self.stages)} stage(s)"
        )

        # Process through each stage
        current_transactions = transactions
        for stage in self.stages:
            if stage.should_skip(context):
                self.logger.debug(f"Skipping stage: {stage.name}")
                continue

            try:
                self.logger.debug(
                    f"Running stage: {stage.name} "
                    f"with {len(current_transactions)} transaction(s)"
                )

                current_transactions, success = stage.process(
                    current_transactions, context
                )

                if not success:
                    result.success = False
                    result.errors.extend(context.errors)
                    self.logger.error(f"Stage {stage.name} failed: {context.errors}")
                    break

            except Exception as e:
                result.success = False
                error_msg = f"Stage {stage.name} raised exception: {e}"
                result.errors.append(error_msg)
                self.logger.error(error_msg, exc_info=True)
                break

        # Populate result
        result.pydantic_transactions = current_transactions
        result.units = context.created_units  # V3: units instead of bundles
        result.warnings = context.warnings

        # Copy statistics from context
        result.new_count = context.new_count
        result.updated_count = context.updated_count
        result.skipped_count = context.skipped_count
        result.split_count = context.split_count
        result.transfer_count = context.transfer_count
        result.persistence_result = context.persistence_result  # For sync job tracking

        # Calculate split count if not set by stage
        if result.split_count == 0 and len(current_transactions) > original_count:
            result.split_count = len(current_transactions) - original_count

        self.logger.debug(
            f"Pipeline completed. Success: {result.success}, "
            f"Transactions: {len(current_transactions)}, "
            f"Units: {len(result.units)}"
        )

        return result

    def process_single(
        self,
        transaction: NormalizedTransaction,
        raw_item: Optional[Dict[str, Any]] = None,
        source: Optional[str] = None,
    ) -> PipelineResult:
        """
        Convenience method to process a single transaction.

        Args:
            transaction: The transaction to process
            raw_item: Optional raw data for persistence
            source: Optional source identifier

        Returns:
            PipelineResult
        """
        context = PipelineContext(
            session=self.session,
            raw_item=raw_item,
            source=source or transaction.source,
        )
        return self.process(transaction, context)
