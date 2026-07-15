/**
 * usePnLPrices
 *
 * Manages price fetching, single-price refresh, and the recompute-unrealized
 * effect that updates asset rows when prices arrive.
 *
 * Dispatches to PnLContext reducer — no direct useState.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, PriceResponse } from '../types';
import type { BalanceEntry } from '../types';
import { toaster } from '../components/ui/toaster';
import { usePnL } from '../components/pnl/PnLContext';
import { buildPriceMap, applyPricesToAssets, computeSummaryTotals } from '../components/pnl/pnlCalculations';


export function usePnLPrices() {
    const { state, dispatch, assets, versionMetrics } = usePnL();
    const { config, prices, loadingPriceAssetIds } = state;
    const queryClient = useQueryClient();

    // Ref for loadingPriceAssetIds read inside async closures.
    const loadingIdsRef = useRef(state.loadingPriceAssetIds);
    loadingIdsRef.current = state.loadingPriceAssetIds;

    // Ref for prices read inside async closures (to carry forward last_known on client timeout).
    const pricesRef = useRef(state.prices);
    pricesRef.current = state.prices;

    /** Max time (ms) to wait for a single price fetch before aborting.
     *  Set higher than the backend max_timeout_seconds (10 s) so the server
     *  has time to fall back to its DB cache before the client aborts. */
    const PRICE_FETCH_TIMEOUT_MS = 15_000;

    // Fetch prices for all assets in balances (individually with concurrency control)
    const fetchPrices = useCallback(async (balances: BalanceEntry[], baseCurrency: string) => {
        if (!balances || balances.length === 0) return;

        const priceableBalances = balances.filter(b => b.price_fetch_eligible !== false);
        const assetIds = priceableBalances.map(b => b.asset.id).filter((id): id is number => id !== undefined);
        if (assetIds.length === 0) return;

        dispatch({ type: 'SET_IS_REFRESHING_PRICES', value: true });
        dispatch({ type: 'SET_LOADING_PRICE_ASSET_IDS', ids: new Set(assetIds) });
        dispatch({ type: 'SET_LAST_PRICE_REFRESH', date: new Date() });

        const fetchSinglePrice = async (assetId: number) => {
            try {
                const response = await fetch(
                    `${API_URL}/pnl/prices/${assetId}?base_currency=${encodeURIComponent(baseCurrency)}&use_fallback=${config.use_price_fallback}&staleness_window_days=${config.price_staleness_window_days}&max_timeout_seconds=10`,
                    { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) },
                );
                if (!response.ok) throw new Error('Failed to fetch price');
                const data: PriceResponse = await response.json();

                dispatch({ type: 'UPSERT_PRICE', assetId, price: data });
            } catch (err) {
                console.error(`Fetch failed for asset ${assetId}`, err);
                const isTimeout = err instanceof DOMException && err.name === 'TimeoutError';

                // Carry forward last-known price from a prior successful fetch
                const prev = pricesRef.current.find(p => p.asset.id === assetId);
                const lastKnownPrice = prev?.price ?? prev?.last_known_price ?? null;
                const lastKnownDate = prev?.fetched_at ?? prev?.last_known_price_date ?? null;
                const lastKnownSource = prev?.source ?? prev?.last_known_source ?? null;

                const errorItem: PriceResponse = {
                    asset: { id: assetId, symbol: 'Unknown' },
                    price: null,
                    price_quote: baseCurrency,
                    error: isTimeout ? 'Request timed out' : (err instanceof Error ? err.message : 'Unknown error'),
                    fetched_at: new Date().toISOString(),
                    last_known_price: lastKnownPrice,
                    last_known_price_date: lastKnownDate,
                    last_known_source: lastKnownSource,
                };
                const balance = priceableBalances.find(b => b.asset.id === assetId);
                if (balance) errorItem.asset.symbol = balance.asset.symbol;

                dispatch({ type: 'UPSERT_PRICE', assetId, price: errorItem });
            } finally {
                dispatch({ type: 'REMOVE_LOADING_PRICE_ASSET_ID', id: assetId });
            }
        };

        // Concurrency control (5 parallel requests)
        const CONCURRENCY = 5;
        const queue = [...assetIds];
        const active: Promise<void>[] = [];

        try {
            while (queue.length > 0 || active.length > 0) {
                while (queue.length > 0 && active.length < CONCURRENCY) {
                    const id = queue.shift();
                    if (id !== undefined) {
                        const promise = fetchSinglePrice(id).then(() => {
                            active.splice(active.indexOf(promise), 1);
                        });
                        active.push(promise);
                    }
                }
                if (active.length > 0) {
                    await Promise.race(active);
                }
            }
        } finally {
            dispatch({ type: 'SET_IS_REFRESHING_PRICES', value: false });
        }
    }, [config.use_price_fallback, config.price_staleness_window_days, dispatch]);

    // Refresh a single asset price (used after manual price entry)
    const refreshSinglePrice = useCallback(async (assetId: number) => {
        try {
            dispatch({
                type: 'SET_LOADING_PRICE_ASSET_IDS',
                ids: new Set([...loadingIdsRef.current, assetId]),
            });

            const response = await fetch(
                `${API_URL}/pnl/prices/${assetId}?base_currency=${encodeURIComponent(config.base_currency_symbol)}&use_fallback=${config.use_price_fallback}&staleness_window_days=${config.price_staleness_window_days}&max_timeout_seconds=10`,
                { signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS) },
            );
            if (!response.ok) throw new Error('Failed to fetch price');
            const data: PriceResponse = await response.json();

            dispatch({ type: 'UPSERT_PRICE', assetId, price: data });
        } catch (err) {
            console.error(`Refresh failed for asset ${assetId}`, err);
        } finally {
            dispatch({ type: 'REMOVE_LOADING_PRICE_ASSET_ID', id: assetId });
        }
    }, [config.base_currency_symbol, config.use_price_fallback, config.price_staleness_window_days, dispatch]);

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

    // Manual refresh button handler
    const handleRefreshPrices = useCallback(async () => {
        if (assets && assets.length > 0) {
            // Only refresh assets that have cost lots — DB-only assets with
            // has_lots=false have zero quantity and don't need pricing.
            const priceable = assets.filter(a => a.has_lots !== false && a.price_fetch_eligible !== false);
            if (priceable.length === 0) return;
            const balanceEntries: BalanceEntry[] = priceable.map(a => ({
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
            await fetchPrices(balanceEntries, config.base_currency_symbol);
            versionMetrics.refetch();
            queryClient.invalidateQueries({ queryKey: ['portfolio-timeline'] });
        }
    }, [assets, config.base_currency_symbol, fetchPrices, versionMetrics, queryClient]);

    // Retry only failed prices, then trigger the same post-refresh logic
    const retryFailedPrices = useCallback(async () => {
        const failedIds = pricesRef.current
            .filter(p => !!p.error || (p.price == null && !(p as any)._isNa))
            .map(p => p.asset.id)
            .filter((id): id is number => id !== undefined);
        if (failedIds.length === 0 || !assets || assets.length === 0) return;

        const priceable = assets.filter(a => a.has_lots !== false && a.price_fetch_eligible !== false && failedIds.includes(a.asset.id!));
        if (priceable.length === 0) return;
        const balanceEntries: BalanceEntry[] = priceable.map(a => ({
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
        await fetchPrices(balanceEntries, config.base_currency_symbol);
        versionMetrics.refetch();
    }, [assets, config.base_currency_symbol, fetchPrices, versionMetrics]);

    // Refs for values read inside effects that should NOT trigger re-runs
    const pnlAssetsRef = useRef(state.pnlAssets);
    pnlAssetsRef.current = state.pnlAssets;
    const summaryRef = useRef(state.summary);
    summaryRef.current = state.summary;

    // --- Effect: Recompute unrealized P&L using live prices ---
    useEffect(() => {
        if (prices.length === 0) return;
        const priceMap = buildPriceMap(prices);
        dispatch({
            type: 'SET_PNL_ASSETS',
            assets: applyPricesToAssets(pnlAssetsRef.current, priceMap),
        });
    }, [prices, dispatch]);

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

