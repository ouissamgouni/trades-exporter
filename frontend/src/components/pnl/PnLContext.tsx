/**
 * PnL Context
 *
 * Provides PnLState + dispatch to all PnL sub-components.
 * Also exposes:
 *  - derived values (assets, displayAssets, scorecardSummary, balanceHealth, etc.)
 *  - React Query results (versionsQuery, heroTimeline, versionMetrics)
 *  - live balance data from useBalance hook
 *  - queryClient for cache invalidation
 *
 * This replaces the 100+ threaded props pattern.
 */

import React, { createContext, useContext, useReducer, useMemo, useRef, useCallback, useEffect } from 'react';
import { useQueryClient, useQuery, type UseQueryResult, type RefetchOptions, type QueryObserverResult } from '@tanstack/react-query';
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
import { useBaseCurrency } from '../BaseCurrencySelector';
import { parsePnLFocus } from '../../utils/pnlFocus';
import { Account, API_URL, PriceResponse, DimensionWithCategories, AccountBalance, liveEntryKey } from '../../types';
import { useBalance } from '../../hooks/useBalance';
import { useAssets } from '../../hooks/useAssets';
import { usePortfolioTimeline, useVersionMetrics, useBookMetrics, useLiveMetrics, useVersionPerformers } from '../../hooks/useChartData';
import type { PortfolioTimelineResponse, VersionMetricsResponse, BookMetricsResponse, LiveMetricsResponse, PerformersResponse } from '../../hooks/useChartData';
import { computeDelta } from './deltaUtils';
import { publishLiveBalanceSnapshot } from '../../hooks/useLiveBalanceSnapshot';
import type { BalanceHealthData } from './SummaryCards';
import type { VersionListItem, AssetPnLRow, AccountBalanceBreakdown, UnmappedLiveAsset } from './types';
import {
    type PnLState,
    type PnLAction,
    pnlReducer,
    createInitialPnLState,
} from './pnlState';


// ═══════════════════════════════════════════════════════════════════════════
// Context Shape
// ═══════════════════════════════════════════════════════════════════════════

export interface PnLContextValue {
    // State + dispatch
    state: PnLState;
    dispatch: React.Dispatch<PnLAction>;

    // Derived data (useMemo in provider — avoids re-computation in consumers)
    assets: AssetPnLRow[];                                    // merged pnlAssets + allDbAssets placeholders
    displayAssets: AssetPnLRow[];                             // assets after mismatch filter
    scorecardSummary: {
        portfolioValue: number;
        costBasis: number;
        unrealizedPnl: number;
        realizedPnl: number;
        taxableRealizedPnl: number;
        totalFees: number;
        feeEntryCount: number;
    } | null;
    balanceHealth: BalanceHealthData | undefined;
    assetBalanceMap: Map<string, number>;                     // symbol → P&L qty
    unmappedLiveAssets: UnmappedLiveAsset[];
    availableAccountIds: Set<number>;
    availableCategoryIds: Set<number>;

    // React Query results
    versionsQuery: UseQueryResult<VersionListItem[]>;
    heroTimeline: {
        data: PortfolioTimelineResponse | null;
        isLoading: boolean;
        error: string | null;
        refetch: (options?: RefetchOptions) => Promise<QueryObserverResult<PortfolioTimelineResponse>>;
    };
    versionMetrics: {
        data: VersionMetricsResponse | null;
        isLoading: boolean;
        error: string | null;
        refetch: (options?: RefetchOptions) => Promise<QueryObserverResult<VersionMetricsResponse>>;
    };
    bookMetrics: {
        data: BookMetricsResponse | null;
        isLoading: boolean;
        error: string | null;
    };
    liveMetrics: {
        data: LiveMetricsResponse | null;
        isLoading: boolean;
        error: string | null;
    };
    performers: {
        data: PerformersResponse | null;
        isLoading: boolean;
        error: string | null;
    };
    pricesReady: boolean;
    queryClient: ReturnType<typeof useQueryClient>;

    // Live balance data (from useBalance hook)
    liveBalanceMap: Map<string, number>;                     // symbol → total live qty
    liveAccountBalanceMap: Map<string, Map<number, number>>; // symbol → accountId → live qty
    liveAccountBalances: AccountBalance[];
    liveFetchedAccountIds: Set<number>;
    liveAccountErrors: Map<number, string[]>;
    liveBalanceLoading: boolean;
    fetchLiveBalances: () => void;
    clearLiveBalances: () => void;

    // Refs (needed by callbacks in components)
    isCalculatingRef: React.MutableRefObject<boolean>;
    skipHealthCheckRef: React.MutableRefObject<boolean>;
    balancesJustLoadedRef: React.MutableRefObject<boolean>;
    loadVersionByIdRef: React.MutableRefObject<((versionId: number) => Promise<void>) | undefined>;
    hasAutoLoaded: React.MutableRefObject<boolean>;

    // Settings
    baseCurrency: string;
    baseCurrencyId: number | null;
    allDbAssets: ReturnType<typeof useAssets>['assets'];
}


// ═══════════════════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════════════════

const PnLContext = createContext<PnLContextValue | null>(null);


// ═══════════════════════════════════════════════════════════════════════════
// Hook
// ═══════════════════════════════════════════════════════════════════════════

export function usePnL(): PnLContextValue {
    const ctx = useContext(PnLContext);
    if (!ctx) throw new Error('usePnL must be used within <PnLProvider>');
    return ctx;
}


// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

interface PnLProviderProps {
    isActive: boolean;
    subtab?: 'portfolio' | 'tax';
    children: React.ReactNode;
}

export const PnLProvider: React.FC<PnLProviderProps> = ({ isActive, subtab, children }) => {
    const { baseCurrency, baseCurrencyId } = useBaseCurrency();
    const queryClient = useQueryClient();

    // Read account_ids from URL on init (for shareable links)
    const getInitialAccountIds = useCallback((): number[] => {
        const params = new URLSearchParams(window.location.search);
        const urlAccounts = params.get('accounts');
        if (urlAccounts) {
            const ids = urlAccounts.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) return ids;
        }
        return [];
    }, []);

    const [state, dispatch] = useReducer(
        pnlReducer,
        { baseCurrency, baseCurrencyId, initialAccountIds: getInitialAccountIds() },
        (args) => createInitialPnLState(args.baseCurrency, args.baseCurrencyId, args.initialAccountIds, subtab),
    );

    // Apply ?focus_asset= / ?focus_account= deep links (global search "Open in P&L"), then drop them from the URL.
    const inRouter = useInRouterContext();
    // inRouter never changes for a mounted component, so the conditional hook calls are stable.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const location = inRouter ? useLocation() : null;
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const navigate = inRouter ? useNavigate() : null;
    useEffect(() => {
        if (!location || !navigate) return;
        const { focus, rest } = parsePnLFocus(location.search);
        if (!focus) return;
        if (focus.kind === 'asset') {
            dispatch({ type: 'DRILL_INTO', assetId: focus.id, assetSymbol: focus.symbol, assetLabel: focus.label ?? undefined });
        } else {
            dispatch({ type: 'SET_ACCOUNT_SCOPE', accounts: [{ id: focus.id, name: focus.name }] });
        }
        navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true });
    }, [location, navigate]);

    // Keep pnlActiveTab in sync when the `subtab` prop changes externally
    // (route navigation, browser back/forward) after initial mount.
    useEffect(() => {
        if (subtab && subtab !== state.pnlActiveTab) {
            dispatch({ type: 'SET_PNL_ACTIVE_TAB', tab: subtab });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [subtab]);

    // ── Refs ──
    const isCalculatingRef = useRef(false);
    const skipHealthCheckRef = useRef(false);
    const balancesJustLoadedRef = useRef(false);
    const loadVersionByIdRef = useRef<(versionId: number) => Promise<void>>();
    const hasAutoLoaded = useRef(false);

    // ── External hooks ──
    const { assets: allDbAssets } = useAssets();

    const {
        accountBalances: liveAccountBalancesRaw,
        isLoading: liveBalanceLoading,
        fetchGlobalBalance: fetchLiveBalances,
        clear: clearLiveBalances,
    } = useBalance();

    // ── React Query ──
    const versionsQuery = useQuery<VersionListItem[]>({
        queryKey: ['pnl-versions'],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/pnl/versions?limit=50`);
            if (!response.ok) throw new Error('Failed to fetch versions');
            return response.json();
        },
        enabled: isActive,
        staleTime: 30_000,
    });

    const heroTimeline = usePortfolioTimeline(
        state.currentVersionId,
        { granularity: 'daily' },
        !!state.currentVersionId,
    );

    const versionMetrics = useVersionMetrics(
        state.currentVersionId,
        {
            groupBy: state.performerGroupBy,
            topN: 25,
            dimensionId: state.performerGroupBy === 'category' ? state.performerDimensionId : undefined,
        },
        !!state.currentVersionId,
    );

    // ── Prices ready: true once first price refresh cycle completes ──
    const hasSeenRefreshing = useRef(false);
    if (state.isRefreshingPrices) hasSeenRefreshing.current = true;
    const pricesReady = hasSeenRefreshing.current && !state.isRefreshingPrices;

    // ── Split metrics hooks ──
    const bookMetrics = useBookMetrics(
        state.currentVersionId,
        {},
        !!state.currentVersionId,
    );

    const liveMetrics = useLiveMetrics(
        state.currentVersionId,
        { pricesReady },
        !!state.currentVersionId,
    );

    const performersQuery = useVersionPerformers(
        state.currentVersionId,
        {
            period: state.timeframeRange,
            groupBy: state.performerGroupBy,
            topN: 500,
            dimensionId: state.performerGroupBy === 'category' ? state.performerDimensionId : undefined,
            pricesReady,
        },
        !!state.currentVersionId,
    );

    // ── Derived: live balance maps ──
    const liveBalanceMap = useMemo(() => {
        if (liveAccountBalancesRaw.length === 0) return new Map<string, number>();
        const map = new Map<string, number>();
        for (const ab of liveAccountBalancesRaw) {
            for (const cb of ab.connector_balances) {
                for (const entry of cb.entries) {
                    const sym = liveEntryKey(entry);
                    map.set(sym, (map.get(sym) ?? 0) + (parseFloat(entry.total) || 0));
                }
            }
        }
        return map;
    }, [liveAccountBalancesRaw]);

    const liveAccountBalanceMap = useMemo(() => {
        if (liveAccountBalancesRaw.length === 0) return new Map<string, Map<number, number>>();
        const map = new Map<string, Map<number, number>>();
        for (const ab of liveAccountBalancesRaw) {
            for (const cb of ab.connector_balances) {
                for (const entry of cb.entries) {
                    const sym = liveEntryKey(entry);
                    if (!map.has(sym)) map.set(sym, new Map());
                    const acctMap = map.get(sym)!;
                    acctMap.set(ab.account_id, (acctMap.get(ab.account_id) ?? 0) + (parseFloat(entry.total) || 0));
                }
            }
        }
        return map;
    }, [liveAccountBalancesRaw]);

    const liveFetchedAccountIds = useMemo(() => {
        return new Set(liveAccountBalancesRaw.map(ab => ab.account_id));
    }, [liveAccountBalancesRaw]);

    useEffect(() => {
        if (liveBalanceMap.size > 0) publishLiveBalanceSnapshot(liveBalanceMap, liveAccountBalanceMap, liveFetchedAccountIds);
    }, [liveBalanceMap, liveAccountBalanceMap, liveFetchedAccountIds]);

    const liveAccountErrors = useMemo(() => {
        const map = new Map<number, string[]>();
        for (const ab of liveAccountBalancesRaw) {
            const errors = ab.connector_balances
                .filter(cb => cb.error != null)
                .map(cb => cb.error!);
            if (errors.length > 0) map.set(ab.account_id, errors);
        }
        return map;
    }, [liveAccountBalancesRaw]);

    // ── Derived: merged assets ──
    const assets = useMemo((): AssetPnLRow[] => {
        if (state.pnlAssets.length === 0) return [];
        const pnlAssetIds = new Set(state.pnlAssets.map(a => a.asset.id).filter(Boolean));
        const pnlSymbols = new Set(state.pnlAssets.map(a => a.asset.symbol?.toUpperCase()).filter(Boolean));
        const nonPnlRows: AssetPnLRow[] = allDbAssets
            .filter(dbAsset => {
                if (dbAsset.asset_id != null && pnlAssetIds.has(dbAsset.asset_id)) return false;
                if (dbAsset.symbol && pnlSymbols.has(dbAsset.symbol.toUpperCase())) return false;
                return true;
            })
            .map(dbAsset => ({
                asset: { id: dbAsset.asset_id ?? null, symbol: dbAsset.symbol, label: dbAsset.label ?? null },
                account_ids: [],
                category_ids: [],
                quantity: 0,
                market_value: 0,
                cost_basis: 0,
                unrealized_pnl: 0,
                unrealized_pnl_pct: 0,
                realized_pnl: 0,
                taxable_realized_pnl: 0,
                total_fees: 0,
                lot_count: 0,
                realized_event_count: 0,
                warning_count: 0,
                has_lots: false,
            }));
        return [...state.pnlAssets, ...nonPnlRows];
    }, [state.pnlAssets, allDbAssets]);

    // ── Derived: scorecard summary (prefers settled+market split, falls back to combined) ──
    const scorecardSummary = useMemo(() => {
        const ss = bookMetrics.data?.summary;
        const mm = liveMetrics.data?.summary;
        if (ss) {
            return {
                portfolioValue: mm?.current_value ?? 0,
                costBasis: ss.cost_basis,
                unrealizedPnl: mm?.unrealized_pnl ?? 0,
                realizedPnl: ss.realized_pnl,
                taxableRealizedPnl: ss.taxable_realized_pnl ?? 0,
                deferredGain: ss.deferred_gain ?? 0,
                totalFees: ss.total_fees,
                feeEntryCount: ss.fee_entry_count,
            };
        }
        const ms = versionMetrics.data?.summary;
        if (ms) {
            return {
                portfolioValue: ms.current_value,
                costBasis: ms.cost_basis,
                unrealizedPnl: ms.unrealized_pnl,
                realizedPnl: ms.realized_pnl,
                taxableRealizedPnl: ms.taxable_realized_pnl ?? 0,
                deferredGain: ms.deferred_gain ?? 0,
                totalFees: ms.total_fees,
                feeEntryCount: ms.fee_entry_count,
            };
        }
        if (state.summary && assets.length > 0) {
            return {
                portfolioValue: assets.reduce((s, a) => s + (a.market_value || 0), 0),
                costBasis: assets.reduce((s, a) => s + a.cost_basis, 0),
                unrealizedPnl: state.summary.total_unrealized_pnl,
                realizedPnl: state.summary.total_realized_pnl,
                taxableRealizedPnl: state.summary.taxable_realized_pnl ?? 0,
                totalFees: state.summary.total_fees,
                feeEntryCount: state.summary.fee_entry_count,
            };
        }
        return null;
    }, [bookMetrics.data, liveMetrics.data, versionMetrics.data, state.summary, assets]);

    // ── Derived: balance health ──
    const balanceHealth: BalanceHealthData | undefined = useMemo(() => {
        if (state.pnlAssets.length === 0 || liveBalanceMap.size === 0) return undefined;
        const issues: { symbol: string; delta: number; pct: number }[] = [];
        let totalCompared = 0;
        for (const row of state.pnlAssets) {
            const sym = row.asset.symbol?.toUpperCase() ?? '';
            const liveQty = liveBalanceMap.get(sym);
            const d = computeDelta(row.quantity, liveQty);
            if (!d) continue;
            totalCompared++;
            if (!d.matched && Math.abs(d.pct) > state.deltaThreshold / 100) {
                issues.push({ symbol: sym, delta: d.delta, pct: d.pct });
            }
        }
        issues.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));
        const assetsTotal = state.pnlAssets.length;
        const assetsFetched = totalCompared;
        const uncoveredAssets: string[] = [];
        for (const row of state.pnlAssets) {
            const sym = row.asset.symbol?.toUpperCase() ?? '';
            if (sym && !liveBalanceMap.has(sym)) uncoveredAssets.push(sym);
        }
        uncoveredAssets.sort();
        const failedAssets: string[] = [];
        for (const [acctId, errors] of liveAccountErrors.entries()) {
            const acct = state.accounts.find(a => a.id === acctId);
            failedAssets.push(acct ? `${acct.name}: ${errors[0]}` : `Account #${acctId}: ${errors[0]}`);
        }
        return { mismatchCount: issues.length, totalCompared, issues, assetsFetched, assetsTotal, failedAssets, uncoveredAssets };
    }, [state.pnlAssets, liveBalanceMap, state.deltaThreshold, state.accounts, liveFetchedAccountIds, liveAccountErrors]);

    // ── Derived: asset balance map ──
    const assetBalanceMap = useMemo(() => {
        const map = new Map<string, number>();
        for (const row of state.pnlAssets) {
            const sym = row.asset.symbol?.toUpperCase() ?? '';
            if (sym) map.set(sym, row.quantity);
        }
        return map;
    }, [state.pnlAssets]);

    // ── Derived: display assets (mismatch filter) ──
    const displayAssets = useMemo(() => {
        if (!state.showMismatchedOnly) return assets;
        return assets.filter(row => {
            const sym = row.asset.symbol?.toUpperCase() ?? '';
            const liveQty = liveBalanceMap.get(sym);
            if (liveQty === undefined) return false;
            const d = computeDelta(row.quantity, liveQty);
            return d !== null && !d.matched && Math.abs(d.pct) > state.deltaThreshold / 100;
        });
    }, [assets, state.showMismatchedOnly, liveBalanceMap, state.deltaThreshold]);

    // ── Derived: unmapped live assets ──
    const unmappedLiveAssets = useMemo<UnmappedLiveAsset[]>(() => {
        if (liveBalanceMap.size === 0 || assets.length === 0) return [];
        const pnlSymbols = new Set(assets.map(a => a.asset.symbol?.toUpperCase()).filter(Boolean));
        const unmapped: UnmappedLiveAsset[] = [];
        for (const [sym, qty] of liveBalanceMap) {
            if (!pnlSymbols.has(sym)) {
                // Build per-account breakdown from raw account balances
                const accounts: { accountName: string; connectorType: string; chain: string | null; qty: number }[] = [];
                let assetId: number | null = null;
                let contractAddress: string | null = null;
                let spamReason: string | null = null;
                for (const ab of liveAccountBalancesRaw) {
                    for (const cb of ab.connector_balances) {
                        for (const entry of cb.entries) {
                            if (liveEntryKey(entry) === sym) {
                                assetId = assetId ?? entry.asset_id ?? null;
                                contractAddress = contractAddress ?? entry.contract_address ?? null;
                                spamReason = spamReason ?? entry.spam_reason ?? null;
                                accounts.push({
                                    accountName: ab.account_name,
                                    connectorType: cb.connector_type,
                                    chain: entry.chain ?? cb.chain,
                                    qty: parseFloat(entry.total) || 0,
                                });
                            }
                        }
                    }
                }
                unmapped.push({ symbol: sym, totalQty: qty, marketValue: null, accounts, assetId, contractAddress, spamReason });
            }
        }
        return unmapped.sort((a, b) => b.totalQty - a.totalQty);
    }, [liveBalanceMap, assets, liveAccountBalancesRaw]);

    // ── Derived: available account/category IDs ──
    const availableAccountIds = useMemo(() => {
        const ids = new Set<number>();
        assets.forEach(asset => asset.account_ids.forEach(id => ids.add(id)));
        return ids;
    }, [assets]);

    const availableCategoryIds = useMemo(() => {
        const ids = new Set<number>();
        assets.forEach(asset => asset.category_ids.forEach(id => ids.add(id)));
        return ids;
    }, [assets]);

    // ── Build context value ──
    const value = useMemo<PnLContextValue>(() => ({
        state,
        dispatch,
        assets,
        displayAssets,
        scorecardSummary,
        balanceHealth,
        assetBalanceMap,
        unmappedLiveAssets,
        availableAccountIds,
        availableCategoryIds,
        versionsQuery,
        heroTimeline,
        versionMetrics,
        bookMetrics,
        liveMetrics,
        performers: performersQuery,
        pricesReady,
        queryClient,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveAccountBalances: liveAccountBalancesRaw,
        liveFetchedAccountIds,
        liveAccountErrors,
        liveBalanceLoading,
        fetchLiveBalances,
        clearLiveBalances,
        isCalculatingRef,
        skipHealthCheckRef,
        balancesJustLoadedRef,
        loadVersionByIdRef,
        hasAutoLoaded,
        baseCurrency,
        baseCurrencyId,
        allDbAssets,
    }), [
        state,
        assets,
        displayAssets,
        scorecardSummary,
        balanceHealth,
        assetBalanceMap,
        unmappedLiveAssets,
        availableAccountIds,
        availableCategoryIds,
        versionsQuery,
        heroTimeline,
        versionMetrics,
        bookMetrics,
        liveMetrics,
        performersQuery,
        pricesReady,
        queryClient,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveAccountBalancesRaw,
        liveFetchedAccountIds,
        liveAccountErrors,
        liveBalanceLoading,
        fetchLiveBalances,
        clearLiveBalances,
        baseCurrency,
        baseCurrencyId,
        allDbAssets,
    ]);

    return <PnLContext.Provider value={value}>{children}</PnLContext.Provider>;
};

export default PnLContext;
