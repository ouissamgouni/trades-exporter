"""
TransferDetectionStage - Detect internal transfers between owned accounts.
"""

from typing import List, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.services.transfer_detector import TransferDetector
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PipelineContext

log = configure_logging("transfer_stage")


class TransferDetectionStage(PipelineStage):
    """
    Detect internal transfers between owned accounts.

    Resolves source_from_account and source_to_account to account IDs,
    then marks as internal transfer if both are owned.
    """

    @property
    def name(self) -> str:
        return "transfer_detection"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_transfer_detection

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Process transactions, detecting internal transfers.

        Modifies transactions in place:
        - Sets from_account_id and to_account_id
        - Sets transaction_type to "transfer" if internal
        - Sets taxable to False for internal transfers
        """
        detector = TransferDetector(context.session)
        transfer_count = 0

        for tx in transactions:
            try:
                # Get source from transaction or context
                source = tx.source or context.source

                if not source:
                    continue

                # Remember original type to detect if it changed
                original_type = tx.transaction_type

                # Enrich transaction with account IDs and detect transfers
                detector.enrich_transaction(tx, source)

                # Track if this became a transfer
                if tx.transaction_type == "transfer" and original_type != "transfer":
                    transfer_count += 1

            except Exception as e:
                warning_msg = (
                    f"Transfer detection failed for {tx.source_transaction_id}: {e}"
                )
                context.warnings.append(warning_msg)
                log.warning(warning_msg)

        # Update context statistics
        context.transfer_count = transfer_count

        if transfer_count > 0:
            log.debug(f"Detected {transfer_count} internal transfer(s)")

        return transactions, True
