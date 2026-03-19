"""
AccountResolutionStage - Resolve source addresses to account IDs.
"""

from typing import List, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.services.account_resolver import AccountResolver
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PipelineContext

log = configure_logging("account_resolution_stage")


class AccountResolutionStage(PipelineStage):
    """
    Resolve source addresses to account IDs.

    Resolves source_from_account and source_to_account to account IDs.
    Does NOT modify transaction_type - internal transfer detection happens at P&L time.
    """

    @property
    def name(self) -> str:
        return "account_resolution"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_transfer_detection

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Process transactions, resolving account IDs.

        Modifies transactions in place:
        - Sets from_account_id and to_account_id
        """
        resolver = AccountResolver(context.session)
        resolved_count = 0

        for tx in transactions:
            try:
                # Get source from transaction or context
                source = tx.source or context.source

                if not source:
                    continue

                # Check if transaction has addresses to resolve
                has_addresses = bool(
                    tx.source_from_account or tx.source_to_account
                )
                
                if not has_addresses:
                    continue

                # Enrich transaction with account IDs
                resolver.enrich_transaction(tx, source)

                # Count if we resolved any account
                if tx.from_account_id or tx.to_account_id:
                    resolved_count += 1

            except Exception as e:
                warning_msg = (
                    f"Account resolution failed for {tx.source_transaction_id}: {e}"
                )
                context.warnings.append(warning_msg)
                log.warning(warning_msg)

        # Update context statistics
        context.transfer_count = resolved_count

        if resolved_count > 0:
            log.debug(f"Resolved accounts for {resolved_count} transaction(s)")

        return transactions, True
