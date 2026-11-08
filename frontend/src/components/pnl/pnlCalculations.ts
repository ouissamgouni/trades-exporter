/**
 * Pure PnL calculation utilities.
 *
 * Extracted from usePnLPrices and usePnLData to eliminate duplication
 * of the unrealized P&L formula.
 */

import type { PriceResponse } from '../../types';
import type { AggregatedBalanceItem, AssetPnLRow } from './types';
import { resolvePriceState } from './priceState';

/**
 * Map aggregated balances (GET /balances?group_by_asset=true) to asset rows (unpriced).
 */
export function balancesToAssetRows(balances: AggregatedBalanceItem[]): AssetPnLRow[] {
    return balances.map((balance) => ({
        asset: balance.asset,
        account_ids: balance.account_ids || [],
        category_ids: balance.category_ids || [],
        quantity: balance.qty,
        market_value: 0,
        cost_basis: balance.cost_basis_in_base,
        tax_cost_basis: balance.tax_cost_basis_in_base,
        total_invested: balance.total_invested_in_base,
        unit_cost: balance.avg_unit_cost_in_base,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
        realized_pnl: balance.realized_pnl_in_base,
        taxable_realized_pnl: balance.taxable_realized_pnl_in_base ?? 0,
        total_fees: balance.total_fees_in_base ?? 0,
        lot_count: balance.lot_count,
        realized_event_count: balance.realized_event_count,
        warning_count: balance.warning_count,
        has_lots: balance.lot_count > 0 || balance.realized_event_count > 0,
        has_open_position: balance.has_open_position,
        price_fetch_eligible: balance.price_fetch_eligible,
        valuation_status: balance.valuation_status,
        valuation_note: balance.valuation_note,
    }));
}

/**
 * Price account-scoped rows with the unit price already loaded on the matching full-portfolio row.
 */
export function priceScopedRows(scopedRows: AssetPnLRow[], pricedRows: AssetPnLRow[]): AssetPnLRow[] {
    const byId = new Map<number, AssetPnLRow>();
    for (const r of pricedRows) {
        if (r.asset.id != null) byId.set(r.asset.id, r);
    }
    return scopedRows.map(row => {
        const priced = row.asset.id != null ? byId.get(row.asset.id) : undefined;
        const priceMeta = {
            unit_value: priced?.unit_value ?? null,
            price_source: priced?.price_source,
            price_fetched_at: priced?.price_fetched_at,
            price_error: priced?.price_error,
            price_loading: priced?.price_loading,
            price_state: priced?.price_state,
        };
        if (priceMeta.unit_value == null) {
            return { ...row, ...priceMeta, market_value: 0, unrealized_pnl: 0, unrealized_pnl_pct: 0 };
        }
        const marketValue = row.quantity * priceMeta.unit_value;
        const unrealizedPnl = marketValue - row.cost_basis;
        return {
            ...row,
            ...priceMeta,
            market_value: marketValue,
            unrealized_pnl: unrealizedPnl,
            unrealized_pnl_pct: row.cost_basis > 0 ? unrealizedPnl / row.cost_basis : 0,
        };
    });
}

/**
 * Sum live balances (symbol -> accountId -> qty) over the given accounts into symbol -> qty.
 */
export function sumLiveBalancesForAccounts(
    liveAccountBalances: Map<string, Map<number, number>>,
    accountIds: number[],
): Map<string, number> {
    const result = new Map<string, number>();
    for (const [sym, byAccount] of liveAccountBalances) {
        let total = 0;
        let found = false;
        for (const id of accountIds) {
            const qty = byAccount.get(id);
            if (qty != null) {
                total += qty;
                found = true;
            }
        }
        if (found) result.set(sym, total);
    }
    return result;
}

/**
 * Recompute unrealized P&L fields for a single asset row given a price response.
 * Returns a new row with market_value, unrealized_pnl, unrealized_pnl_pct, unit_value,
 * price_source, price_fetched_at, and price_error updated.
 */
export function applyPriceToAssetRow(row: AssetPnLRow, priceObj: PriceResponse | undefined): AssetPnLRow {
    const hasLive = priceObj?.price != null;
    // A failed fetch still values the position at the last known price (flagged via price_state)
    const unitPrice = hasLive ? priceObj!.price : priceObj?.last_known_price ?? null;
    const meta = {
        price_source: hasLive ? priceObj?.source : priceObj?.last_known_source ?? priceObj?.source,
        price_fetched_at: hasLive ? priceObj?.fetched_at : priceObj?.last_known_price_date ?? priceObj?.fetched_at,
        price_error: priceObj?.error,
        price_state: priceObj ? resolvePriceState(priceObj) : undefined,
        price_loading: false,
    };
    if (unitPrice == null) {
        return {
            ...row,
            ...meta,
            market_value: 0,
            unrealized_pnl: 0,
            unrealized_pnl_pct: 0,
            unit_value: null,
        };
    }
    const marketValue = row.quantity * unitPrice;
    const unrealizedPnl = marketValue - row.cost_basis;
    const unrealizedPnlPct = row.cost_basis > 0 ? unrealizedPnl / row.cost_basis : 0;
    return {
        ...row,
        ...meta,
        market_value: marketValue,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_pct: unrealizedPnlPct,
        unit_value: unitPrice,
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
export function applyPricesToAssets(
    assets: AssetPnLRow[],
    priceMap: Map<number, PriceResponse>,
    loadingIds?: Set<number>,
): AssetPnLRow[] {
    return assets.map(row => {
        const assetId = row.asset.id;
        const priceObj = assetId != null ? priceMap.get(assetId) : undefined;
        const updated = applyPriceToAssetRow(row, priceObj);
        return assetId != null && loadingIds?.has(assetId) ? { ...updated, price_loading: true } : updated;
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
