"""Manual price getter: assets with no market feed (e.g. euro funds).

Never fetches anything. PriceService treats assets whose only getter is
"manual" as stored-prices-only and uses the latest stored snapshot.
"""

from datetime import datetime
from typing import Optional

from backend.db.models import Asset
from backend.services.price_getters.base import (
    BasePriceGetter,
    PriceErrorReason,
    PriceGetterConfig,
    PriceGetterError,
    PriceResult,
)

MANUAL_GETTER_NAME = "manual"


class ManualPriceGetter(BasePriceGetter):
    name = MANUAL_GETTER_NAME
    max_retries = 1

    def _no_live_source(self, asset: Asset) -> PriceGetterError:
        return PriceGetterError(
            message="No live price source; using stored prices only",
            getter_name=self.name,
            reason=PriceErrorReason.NO_DATA_RETURNED,
            asset_symbol=asset.symbol,
        )

    def get_current_price(
        self,
        asset: Asset,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        raise self._no_live_source(asset)

    def get_historical_price(
        self,
        asset: Asset,
        dt: datetime,
        config: Optional[PriceGetterConfig] = None,
    ) -> PriceResult:
        raise self._no_live_source(asset)
