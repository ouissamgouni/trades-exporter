/**
 * Pure PnL calculation utilities.
 *
 * Extracted from usePnLPrices and usePnLData to eliminate duplication
 * of the unrealized P&L formula.
 */

import type { PriceResponse } from '../../types';
import type { AssetPnLRow } from './types';

/**
 * Recompute unrealized P&L fields for a single asset row given a price response.
 * Returns a new row with market_value, unrealized_pnl, unrealized_pnl_pct, unit_value,
 * price_source, price_fetched_at, and price_error updated.
 */
export function applyPriceToAssetRow(row: AssetPnLRow, priceObj: PriceResponse | undefined): AssetPnLRow {
    if (!priceObj || priceObj.price == null) {
        return {
            ...row,
            market_value: 0,
            unrealized_pnl: 0,
            unrealized_pnl_pct: 0,
            unit_value: null,
            price_source: priceObj?.source,
            price_fetched_at: priceObj?.fetched_at,
            price_error: priceObj?.error,
            price_loading: false,
        };
    }
    const marketValue = row.quantity * priceObj.price;
    const unrealizedPnl = marketValue - row.cost_basis;
    const unrealizedPnlPct = row.cost_basis > 0 ? unrealizedPnl / row.cost_basis : 0;
    return {
        ...row,
        market_value: marketValue,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_pct: unrealizedPnlPct,
        unit_value: priceObj.price,
        price_source: priceObj.source,
        price_fetched_at: priceObj.fetched_at,
        price_error: priceObj.error,
        price_loading: false,
    };
}

/**
 * Build a Map<assetId, PriceResponse> from a prices array.
 */
export function buildPriceMap(prices: PriceResponse[]): Map<number, PriceResponse> {
    const map = new Map<number, PriceResponse>();
    for (const p of prices) {
        if (p.asset.id != null) map.set(p.asset.id, p);
    }
    return map;
}

/**
 * Apply prices to all asset rows, returning a new array.
 */
export function applyPricesToAssets(assets: AssetPnLRow[], priceMap: Map<number, PriceResponse>): AssetPnLRow[] {
    return assets.map(row => {
        const assetId = row.asset.id;
        const priceObj = assetId != null ? priceMap.get(assetId) : undefined;
        return applyPriceToAssetRow(row, priceObj);
    });
}

/**
 * Compute summary totals from asset rows (unrealized P&L and portfolio value).
 */
export function computeSummaryTotals(assets: AssetPnLRow[]): { totalUnrealized: number; totalMarketValue: number } {
    let totalUnrealized = 0;
    let totalMarketValue = 0;
    for (const a of assets) {
        totalUnrealized += a.unrealized_pnl || 0;
        totalMarketValue += a.market_value || 0;
    }
    return { totalUnrealized, totalMarketValue };
}
