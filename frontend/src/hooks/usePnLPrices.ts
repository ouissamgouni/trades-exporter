/**
 * usePnLPrices
 *
 * Cached-first price loading: stored prices are applied immediately, then live
 * prices are fetched for assets whose stored price is missing or older than today
 * (or for all assets when forced).
 *
 * Dispatches to PnLContext reducer — no direct useState.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, PriceResponse } from '../types';
import type { BalanceEntry } from '../types';
import { usePnL } from '../components/pnl/PnLContext';
import { buildPriceMap, applyPricesToAssets, computeSummaryTotals } from '../components/pnl/pnlCalculations';
import type { AssetPnLRow } from '../components/pnl/types';
import { parseApiDate } from '../utils/dateUtils';

/** Higher than the backend max_timeout_seconds (10 s) so the server can fall back to its DB cache first. */
const PRICE_FETCH_TIMEOUT_MS = 15_000;
/** The batch call groups assets per price source; slow sources still go one by one server-side. */
const BATCH_PRICE_FETCH_TIMEOUT_MS = 120_000;

export interface FetchPricesOptions {
    /** Bypass the cached-first step and the recent-snapshot cache; refresh every asset live. */
    force?: boolean;
}

function needsLiveRefresh(p: PriceResponse | undefined): boolean {
    if (!p || p.price == null) return true;
    const fetched = parseApiDate(p.fetched_at);
    if (!fetched) return true;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    return fetched.getTime() < startOfToday.getTime();
}

function rowsToBalanceEntries(rows: AssetPnLRow[]): BalanceEntry[] {
    return rows.map(a => ({
        asset: a.asset,
        qty: a.quantity,
        cost_basis_in_base: a.cost_basis,
        avg_unit_cost_in_base: a.quantity > 0 ? a.cost_basis / a.quantity : 0,
        lot_count: a.lot_count,
        has_open_position: a.has_open_position,
        price_fetch_eligible: a.price_fetch_eligible,
        valuation_status: a.valuation_status,
        valuation_note: a.valuation_note,
    }));
}

export function usePnLPrices() {
    const { state, dispatch, assets, versionMetrics } = usePnL();
    const { config, prices, loadingPriceAssetIds } = state;
    const queryClient = useQueryClient();

    const loadingIdsRef = useRef(state.loadingPriceAssetIds);
    loadingIdsRef.current = state.loadingPriceAssetIds;

    const priceUrl = useCallback((assetId: number, baseCurrency: string, force: boolean) =>
        `${API_URL}/pnl/prices/${assetId}?base_currency=${encodeURIComponent(baseCurrency)}&use_fallback=${config.use_price_fallback}&staleness_window_days=${config.price_staleness_window_days}&max_timeout_seconds=10&force_live=${force}`,
        [config.use_price_fallback, config.price_staleness_window_days]);

    const fetchLivePrice = useCallback(async (asset: BalanceEntry['asset'], baseCurrency: string, force: boolean) => {
        const assetId = asset.id!;
        try {
            const response = await fetch(priceUrl(assetId, baseCurrency, force), { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) });
            if (!response.ok) throw new Error(`Price request failed (${response.status})`);
            const data: PriceResponse = await response.json();
            dispatch({ type: 'UPSERT_PRICE', assetId, price: data });
        } catch (err) {
            console.error(`Fetch failed for asset ${assetId}`, err);
            const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
            // The reducer carries forward the previously known price for this asset
            dispatch({
                type: 'UPSERT_PRICE',
                assetId,
                price: {
                    asset: { id: assetId, symbol: asset.symbol, label: asset.label },
                    price: null,
                    price_quote: baseCurrency,
                    error: isTimeout ? 'Request timed out' : (err instanceof Error ? err.message : 'Unknown error'),
                    fetched_at: new Date().toISOString(),
                    price_state: 'failed',
                },
            });
        } finally {
            dispatch({ type: 'REMOVE_LOADING_PRICE_ASSET_ID', id: assetId });
        }
    }, [dispatch, priceUrl]);

    // One request for many assets so the backend can batch per price source (avoids CoinGecko 429s)
    const fetchLivePricesBatch = useCallback(async (entries: BalanceEntry[], baseCurrency: string, force: boolean) => {
        const assetIds = entries.map(b => b.asset.id!);
        try {
            const response = await fetch(`${API_URL}/pnl/prices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: assetIds,
                    base_currency: baseCurrency,
                    use_fallback: config.use_price_fallback,
                    staleness_window_days: config.price_staleness_window_days,
                    max_timeout_seconds: 10,
                    force_live: force,
                }),
                signal: AbortSignal.timeout(BATCH_PRICE_FETCH_TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`Price request failed (${response.status})`);
            const data: { prices: PriceResponse[] } = await response.json();
            for (const p of data.prices) {
                if (p.asset.id != null) dispatch({ type: 'UPSERT_PRICE', assetId: p.asset.id, price: p });
            }
        } catch (err) {
            console.error('Batch price fetch failed', err);
            const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';
            for (const b of entries) {
                dispatch({
                    type: 'UPSERT_PRICE',
                    assetId: b.asset.id!,
                    price: {
                        asset: { id: b.asset.id!, symbol: b.asset.symbol, label: b.asset.label },
                        price: null,
                        price_quote: baseCurrency,
                        error: isTimeout ? 'Request timed out' : (err instanceof Error ? err.message : 'Unknown error'),
                        fetched_at: new Date().toISOString(),
                        price_state: 'failed',
                    },
                });
            }
        } finally {
            for (const id of assetIds) dispatch({ type: 'REMOVE_LOADING_PRICE_ASSET_ID', id });
        }
    }, [dispatch, config.use_price_fallback, config.price_staleness_window_days]);

    const loadCachedPrices = useCallback(async (assetIds: number[], baseCurrency: string): Promise<PriceResponse[]> => {
        try {
            const response = await fetch(`${API_URL}/pnl/prices/cached`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: assetIds,
                    base_currency: baseCurrency,
                    staleness_window_days: config.price_staleness_window_days,
                }),
            });
            if (!response.ok) throw new Error(`Cached price request failed (${response.status})`);
            return await response.json();
        } catch (err) {
            console.error('Cached price load failed', err);
            return [];
        }
    }, [config.price_staleness_window_days]);

    const fetchPrices = useCallback(async (balances: BalanceEntry[], baseCurrency: string, options: FetchPricesOptions = {}) => {
        const force = !!options.force;
        const priceable = (balances ?? []).filter(b => b.price_fetch_eligible !== false && b.asset.id != null);
        if (priceable.length === 0) return;

        dispatch({ type: 'SET_IS_REFRESHING_PRICES', value: true });
        dispatch({ type: 'SET_LAST_PRICE_REFRESH', date: new Date() });

        try {
            let toRefresh = priceable;
            if (!force) {
                const cached = await loadCachedPrices(priceable.map(b => b.asset.id!), baseCurrency);
                const cachedById = new Map<number, PriceResponse>();
                for (const p of cached) {
                    if (p.asset.id == null) continue;
                    cachedById.set(p.asset.id, p);
                    if (p.price != null) dispatch({ type: 'UPSERT_PRICE', assetId: p.asset.id, price: p });
                }
                toRefresh = priceable.filter(b => needsLiveRefresh(cachedById.get(b.asset.id!)));
            }

            dispatch({
                type: 'SET_LOADING_PRICE_ASSET_IDS',
                ids: new Set([...loadingIdsRef.current, ...toRefresh.map(b => b.asset.id!)]),
            });

            if (toRefresh.length > 0) await fetchLivePricesBatch(toRefresh, baseCurrency, force);
        } finally {
            dispatch({ type: 'SET_IS_REFRESHING_PRICES', value: false });
        }
    }, [dispatch, loadCachedPrices, fetchLivePricesBatch]);

    // Refresh a single asset price (after manual price entry, or from a row's refresh button)
    const refreshSinglePrice = useCallback(async (assetId: number, options: FetchPricesOptions = {}) => {
        const row = assets.find(a => a.asset.id === assetId);
        const asset = row?.asset ?? { id: assetId, symbol: `#${assetId}` };
        dispatch({ type: 'SET_LOADING_PRICE_ASSET_IDS', ids: new Set([...loadingIdsRef.current, assetId]) });
        await fetchLivePrice(asset, config.base_currency_symbol, !!options.force);
    }, [assets, config.base_currency_symbol, dispatch, fetchLivePrice]);

    // Remove a warning by ID (used after manual price fixes the issue)
    const removeWarning = useCallback((warningId: string) => {
        dispatch({ type: 'SET_WARNINGS', warnings: state.warnings.filter(w => w.id !== warningId) });
        dispatch({
            type: 'SET_SUMMARY',
            summary: state.summary ? {
                ...state.summary,
                warning_count: Math.max(0, (state.summary.warning_count ?? 0) - 1),
            } : null,
        });
    }, [dispatch, state.warnings, state.summary]);

    // Callback for manual price added from PriceStatusList or WarningsPanel
    const handlePriceAdded = useCallback((assetId: number, warningId?: string) => {
        refreshSinglePrice(assetId);
        if (warningId) removeWarning(warningId);
    }, [refreshSinglePrice, removeWarning]);

    // Only assets with cost lots need pricing (has_lots=false rows have zero quantity)
    const priceableRows = useCallback(
        () => assets.filter(a => a.has_lots !== false && a.price_fetch_eligible !== false),
        [assets],
    );

    // Manual "Refresh all" — forces a live fetch for every priceable asset
    const handleRefreshPrices = useCallback(async () => {
        const rows = priceableRows();
        if (rows.length === 0) return;
        await fetchPrices(rowsToBalanceEntries(rows), config.base_currency_symbol, { force: true });
        versionMetrics.refetch();
        queryClient.invalidateQueries({ queryKey: ['portfolio-timeline'] });
    }, [priceableRows, config.base_currency_symbol, fetchPrices, versionMetrics, queryClient]);

    const retryFailedPrices = useCallback(async () => {
        const failedIds = new Set(
            prices.filter(p => p.price == null && !p.skipped).map(p => p.asset.id).filter((id): id is number => id != null),
        );
        const rows = priceableRows().filter(a => a.asset.id != null && failedIds.has(a.asset.id));
        if (rows.length === 0) return;
        await fetchPrices(rowsToBalanceEntries(rows), config.base_currency_symbol, { force: true });
        versionMetrics.refetch();
    }, [prices, priceableRows, config.base_currency_symbol, fetchPrices, versionMetrics]);

    // Refs for values read inside effects that should NOT trigger re-runs
    const pnlAssetsRef = useRef(state.pnlAssets);
    pnlAssetsRef.current = state.pnlAssets;
    const summaryRef = useRef(state.summary);
    summaryRef.current = state.summary;

    // --- Effect: Recompute unrealized P&L using current prices ---
    useEffect(() => {
        if (prices.length === 0) return;
        dispatch({
            type: 'SET_PNL_ASSETS',
            assets: applyPricesToAssets(pnlAssetsRef.current, buildPriceMap(prices), loadingPriceAssetIds),
        });
    }, [prices, loadingPriceAssetIds, dispatch]);

    // --- Effect: Recalculate summary unrealized P&L when assets change ---
    useEffect(() => {
        if (assets.length === 0) return;
        const { totalUnrealized, totalMarketValue } = computeSummaryTotals(assets);
        const currentSummary = summaryRef.current;
        dispatch({
            type: 'SET_SUMMARY',
            summary: currentSummary ? {
                ...currentSummary,
                total_unrealized_pnl: totalUnrealized,
                total_portfolio_value: totalMarketValue > 0 ? totalMarketValue : currentSummary.total_portfolio_value,
            } : null,
        });
    }, [assets, dispatch]);

    return {
        fetchPrices,
        refreshSinglePrice,
        handlePriceAdded,
        handleRefreshPrices,
        retryFailedPrices,
        removeWarning,
    };
}
