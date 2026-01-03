"""
AssetEnrichmentStage - Resolve asset symbols to asset IDs from raw_assets table.
"""

from typing import List, Tuple

from backend.config.loader import configure_logging
from backend.db.models import NormalizedTransaction
from backend.db.repositories import RawAssetRepository
from backend.services.pipeline.base import PipelineStage
from backend.services.pipeline.context import PipelineContext

log = configure_logging("enrichment_stage")


class AssetEnrichmentStage(PipelineStage):
    """
    Resolve asset symbols to asset IDs from raw_assets table.

    Enriches:
    - asset_id from source_asset_symbol
    - price_quote_asset_id from source_price_quote_asset_symbol
    - fee_quote_asset_id from source_fee_quote_asset_symbol
    """

    @property
    def name(self) -> str:
        return "asset_enrichment"

    def should_skip(self, context: PipelineContext) -> bool:
        return context.skip_asset_enrichment

    def process(
        self,
        transactions: List[NormalizedTransaction],
        context: PipelineContext,
    ) -> Tuple[List[NormalizedTransaction], bool]:
        """
        Process transactions, enriching with asset IDs.
        """
        raw_asset_repo = RawAssetRepository(context.session)

        for tx in transactions:
            try:
                source = tx.source or context.source

                if not source:
                    context.warnings.append(
                        f"Cannot enrich {tx.source_transaction_id}: no source"
                    )
                    continue

                # Enrich main asset
                if tx.source_asset_symbol and not tx.asset_id:
                    raw_asset = raw_asset_repo.get_or_create(
                        tx.source_asset_symbol, source
                    )
                    if raw_asset.asset_id:
                        tx.asset_id = raw_asset.asset_id

                # Enrich price quote asset
                if tx.source_price_quote_asset_symbol and not tx.price_quote_asset_id:
                    raw_asset = raw_asset_repo.get_or_create(
                        tx.source_price_quote_asset_symbol, source
                    )
                    if raw_asset.asset_id:
                        tx.price_quote_asset_id = raw_asset.asset_id

                # Enrich fee quote asset
                if tx.source_fee_quote_asset_symbol and not tx.fee_quote_asset_id:
                    raw_asset = raw_asset_repo.get_or_create(
                        tx.source_fee_quote_asset_symbol, source
                    )
                    if raw_asset.asset_id:
                        tx.fee_quote_asset_id = raw_asset.asset_id

            except Exception as e:
                warning_msg = (
                    f"Asset enrichment failed for {tx.source_transaction_id}: {e}"
                )
                context.warnings.append(warning_msg)
                log.warning(warning_msg)

        return transactions, True
