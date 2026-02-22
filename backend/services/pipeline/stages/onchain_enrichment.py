"""
OnChainAddressEnrichmentStage - Enrich missing from/to addresses using on-chain explorers.

For CEX deposit/withdrawal transactions that have an on-chain transaction hash
but are missing the sender or receiver address, this stage queries blockchain
explorer APIs to fill in the missing data.

Must run BEFORE AccountResolutionStage, since account resolution depends on
source_from_account/source_to_account being populated.
"""

from typing import List, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.services.onchain_address_lookup import OnChainAddressLookupService
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PipelineContext

log = configure_logging("onchain_enrichment_stage")


class OnChainAddressEnrichmentStage(PipelineStage):
    """
    Enrich transactions with missing from/to addresses by querying on-chain explorers.

    Conditions for enrichment:
    - Transaction has a network_transaction_id (blockchain tx hash)
    - Transaction has a network (e.g., "bsc", "bep20")
    - For inflow: source_from_account is missing
    - For outflow: source_to_account is missing
    """

    @property
    def name(self) -> str:
        return "onchain_address_enrichment"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_onchain_enrichment

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Enrich transactions with missing addresses from on-chain data.

        A single OnChainAddressLookupService instance is shared across all
        transactions in the batch, so its in-memory cache deduplicates
        lookups for the same tx hash.
        """
        lookup_service = OnChainAddressLookupService()
        enriched_count = 0

        for tx in transactions:
            enriched = self._enrich_transaction(tx, lookup_service, context)
            enriched_count += enriched

        if enriched_count > 0:
            log.info(
                f"Enriched {enriched_count} address(es) from on-chain data"
            )

        return transactions, True

    def _enrich_transaction(
        self,
        tx: NormalizedTransaction,
        lookup_service: OnChainAddressLookupService,
        context: PipelineContext,
    ) -> int:
        """
        Enrich a single transaction's missing address. Returns count of addresses enriched.
        """
        if not tx.network_transaction_id or not tx.network:
            return 0

        try:
            return self._resolve_missing_address(tx, lookup_service)
        except Exception as e:
            warning_msg = (
                f"On-chain address enrichment failed for "
                f"{tx.source_transaction_id}: {e}"
            )
            context.warnings.append(warning_msg)
            log.warning(warning_msg)
            return 0

    def _resolve_missing_address(
        self,
        tx: NormalizedTransaction,
        lookup_service: OnChainAddressLookupService,
    ) -> int:
        """Resolve and set missing address for a transaction. Returns count enriched."""
        enriched = 0

        if tx.direction == "inflow" and not self._has_address(tx.source_from_account):
            address = lookup_service.lookup_address(
                network=tx.network,
                tx_hash=tx.network_transaction_id,
                direction="inflow",
            )
            if address:
                tx.source_from_account = address
                enriched += 1
                log.debug(
                    f"Enriched source_from_account for "
                    f"{tx.source_transaction_id}: {address}"
                )

        if tx.direction == "outflow" and not self._has_address(tx.source_to_account):
            address = lookup_service.lookup_address(
                network=tx.network,
                tx_hash=tx.network_transaction_id,
                direction="outflow",
            )
            if address:
                tx.source_to_account = address
                enriched += 1
                log.debug(
                    f"Enriched source_to_account for "
                    f"{tx.source_transaction_id}: {address}"
                )

        return enriched

    @staticmethod
    def _has_address(value: str | None) -> bool:
        """Check if an address value is present and meaningful (not empty/None)."""
        if not value:
            return False
        stripped = str(value).strip().lower()
        return stripped not in ("", "none", "null")
