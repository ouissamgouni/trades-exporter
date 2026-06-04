/**
 * usePnLData
 *
 * Core PnL data operations: calculation, version loading, balance fetching,
 * accounts/categories loading, and related effects.
 *
 * Dispatches to PnLContext reducer — no direct useState.
 */

import { useCallback, useEffect } from 'react';
import { API_URL, PriceResponse, Account, DimensionWithCategories } from '../types';
import type { BalanceEntry } from '../types';
import { toaster } from '../components/ui/toaster';
import { usePnL } from '../components/pnl/PnLContext';
import { usePnLCalculationStatus } from './usePnLCalculationStatus';
import { applyPriceToAssetRow, buildPriceMap, computeSummaryTotals } from '../components/pnl/pnlCalculations';
import { PNL_STATUS, VERSION_STATUS } from '../components/pnl/pnlState';
import type {
    PnLVersionResponse,
    AggregatedBalanceItem,
    AssetPnLRow,
    AccountBalanceBreakdown,
    PerAccountBalanceItem,
    PnLSummary,
} from '../components/pnl/types';


interface UsePnLDataOptions {
    isActive: boolean;
    onOpenHealthCheck?: () => void;
    fetchPrices: (balances: BalanceEntry[], baseCurrency: string) => Promise<void>;
}

export function usePnLData({ isActive, onOpenHealthCheck, fetchPrices }: UsePnLDataOptions) {
    const {
        state,
        dispatch,
        versionsQuery,
        queryClient,
        isCalculatingRef,
        skipHealthCheckRef,
        balancesJustLoadedRef,
        loadVersionByIdRef,
        hasAutoLoaded,
        fetchLiveBalances,
    } = usePnL();

    const { config, currentVersionId, showUnsettledNegative, prices, loadingPriceAssetIds, status } = state;

    const availableVersions = versionsQuery.data ?? [];
    const isLoadingVersions = versionsQuery.isLoading;

    const getResponseErrorMessage = useCallback(async (response: Response, fallback: string): Promise<string> => {
        const body = await response.json().catch(() => null);
        if (body && typeof body === 'object' && 'detail' in body) {
            const detail = (body as { detail?: unknown }).detail;
            if (typeof detail === 'string') return detail;
        }
        return `${fallback} (${response.status} ${response.statusText})`;
    }, []);

    // ══════════════════════════════════════════════════════════
    // Core callbacks
    // ══════════════════════════════════════════════════════════

    // Load aggregated balances (group_by_asset=true)
    const loadBalances = useCallback(async (versionId: number, includeUnsettledNegative: boolean = false): Promise<AggregatedBalanceItem[]> => {
        dispatch({ type: 'SET_IS_LOADING_BALANCES', value: true });
        try {
            const params = new URLSearchParams({
                group_by_asset: 'true',
                include_unsettled_negative: includeUnsettledNegative.toString(),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`);
            if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to load balances'));
            const balances: AggregatedBalanceItem[] = await response.json();
            console.log('Loaded aggregated balances:', balances.length, 'includeUnsettledNegative:', includeUnsettledNegative);

            const totalUnsettled = balances.reduce((sum, b) => sum + (b.unsettled_negative_count || 0), 0);
            dispatch({ type: 'SET_TOTAL_UNSETTLED_NEGATIVE_COUNT', count: totalUnsettled });
            return balances;
        } catch (err) {
            console.error('Failed to load balances:', err);
            toaster.error({
                title: 'Balance Load Failed',
                description: err instanceof Error ? err.message : 'Failed to load balances',
            });
            throw err;
        } finally {
            dispatch({ type: 'SET_IS_LOADING_BALANCES', value: false });
        }
    }, [dispatch, getResponseErrorMessage]);

    // Transform aggregated balances to AssetPnLRow array
    const transformBalances = useCallback((balances: AggregatedBalanceItem[]): AssetPnLRow[] => {
        return balances.map((balance) => ({
            asset: balance.asset,
            account_ids: balance.account_ids || [],
            category_ids: balance.category_ids || [],
            quantity: balance.qty,
            market_value: 0,
            cost_basis: balance.cost_basis_in_base,
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
        }));
    }, []);

    // Load per-account balances for expandable rows
    const loadAccountBalances = useCallback(async (versionId: number): Promise<Map<number, AccountBalanceBreakdown[]>> => {
        dispatch({ type: 'SET_IS_LOADING_ACCOUNT_BALANCES', value: true });
        try {
            const params = new URLSearchParams({
                group_by_asset: 'false',
                include_unsettled_negative: 'true',
            });
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`);
            if (!response.ok) throw new Error(await getResponseErrorMessage(response, 'Failed to load account balances'));
            const balances: PerAccountBalanceItem[] = await response.json();
            console.log('Loaded per-account balances:', balances.length);

            const balanceMap = new Map<number, AccountBalanceBreakdown[]>();
            for (const balance of balances) {
                const assetId = balance.asset.id;
                if (assetId == null) continue;
                const breakdown: AccountBalanceBreakdown = {
                    account_id: balance.account_id,
                    account_name: balance.account_name,
                    qty: balance.qty,
                    cost_basis_in_base: balance.cost_basis_in_base,
                    avg_unit_cost_in_base: balance.avg_unit_cost_in_base,
                    lot_count: balance.lot_count,
                };
                if (!balanceMap.has(assetId)) balanceMap.set(assetId, []);
                balanceMap.get(assetId)!.push(breakdown);
            }

            dispatch({ type: 'SET_ACCOUNT_BALANCES', balances: balanceMap });
            return balanceMap;
        } catch (err) {
            console.error('Failed to load account balances:', err);
            return new Map();
        } finally {
            dispatch({ type: 'SET_IS_LOADING_ACCOUNT_BALANCES', value: false });
        }
    }, [dispatch]);

    // Helper: map PnLVersionResponse to summary data
    type SummaryData = {
        total_realized_pnl: number;
        total_fees_in_base?: number;
        fee_entry_count?: number;
        unit_ids?: number[];
        cost_lot_ids?: number[];
        warning_ids?: number[];
        realized_pnl_ids?: number[];
        fee_ids?: number[];
        cost_lot_event_ids?: number[];
    };

    const mapToSummaryData = useCallback((calcResult: PnLVersionResponse): SummaryData => ({
        total_realized_pnl: calcResult.total_realized_pnl,
        total_fees_in_base: calcResult.total_fees_in_base ?? 0,
        fee_entry_count: calcResult.fee_entry_count ?? 0,
        unit_ids: calcResult.calculation_unit_ids,
        cost_lot_ids: calcResult.cost_lot_ids,
        warning_ids: calcResult.warning_ids,
        realized_pnl_ids: calcResult.realized_pnl_ids,
        fee_ids: calcResult.fee_ids,
        cost_lot_event_ids: calcResult.cost_lot_event_ids,
    }), []);

    // Transform summary data + asset rows into PnLSummary and set state
    const transformResult = useCallback((result: SummaryData, assetRows: AssetPnLRow[]) => {
        const totalPortfolioValue = assetRows.reduce((sum, a) => sum + a.cost_basis, 0);
        const totalUnrealizedPnL = assetRows.reduce((sum, a) => sum + a.unrealized_pnl, 0);
        const totalFees = result.total_fees_in_base ?? assetRows.reduce((sum, a) => sum + a.total_fees, 0);
        const feeEntryCount = result.fee_entry_count ?? 0;

        const newSummary: PnLSummary = {
            total_portfolio_value: totalPortfolioValue,
            total_unrealized_pnl: totalUnrealizedPnL,
            total_realized_pnl: result.total_realized_pnl,
            total_fees: totalFees,
            fee_entry_count: feeEntryCount,
            warning_count: result.warning_ids?.length ?? 0,
            error_count: 0,
            taxable_realized_pnl: 0,
            non_taxable_realized_pnl: 0,
            units_count: result.unit_ids?.length ?? 0,
            lots_created_count: result.cost_lot_ids?.length ?? 0,
            consumed_slices_count: 0,
        };
        dispatch({ type: 'SET_SUMMARY', summary: newSummary });
        dispatch({ type: 'SET_PNL_ASSETS', assets: assetRows });
    }, [dispatch]);

    // Config change handler
    const handleConfigChange = useCallback((partial: Partial<typeof config>) => {
        dispatch({ type: 'PATCH_CONFIG', partial });
    }, [dispatch]);

    // Mode change handler
    const handleModeChange = useCallback((newMode: 'load' | 'new') => {
        dispatch({ type: 'SET_CALCULATION_MODE', mode: newMode });
    }, [dispatch]);

    // Invalidate versions query
    const refreshVersionsList = useCallback(() => {
        queryClient.invalidateQueries({ queryKey: ['pnl-versions'] });
    }, [queryClient]);

    // ══════════════════════════════════════════════════════════
    // runCalculation
    // ══════════════════════════════════════════════════════════

    const runCalculation = useCallback(async () => {
        // Guard against concurrent calculations
        if (isCalculatingRef.current) return;

        // Pre-calculation health check
        if (!skipHealthCheckRef.current) {
            try {
                let healthUrl = `${API_URL}/transactions/data-health-check/status`;
                if (config.account_ids && config.account_ids.length > 0) {
                    healthUrl += `?account_ids=${config.account_ids.join(',')}`;
                }
                const healthResponse = await fetch(healthUrl);

                if (!healthResponse.ok) {
                    toaster.create({ title: 'Health Check Failed', description: 'Unable to verify data health. You can try calculating anyway.', type: 'warning', duration: 5000 });
                    dispatch({ type: 'SET_HEALTH_CHECK_ISSUE_COUNT', count: 0 });
                    dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: true });
                    return;
                }

                const healthData = await healthResponse.json();
                if (healthData && healthData.has_issues) {
                    const issueCount = healthData.total_issues;
                    dispatch({ type: 'SET_HEALTH_CHECK_ISSUE_COUNT', count: issueCount });
                    toaster.create({ title: 'Data Health Issues Detected', description: `Found ${issueCount} data issue${issueCount !== 1 ? 's' : ''}. P&L calculation may be incomplete or inaccurate.`, type: 'warning', duration: 5000 });
                    dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: true });
                    return;
                }
            } catch (err) {
                console.error('Health check failed:', err);
                toaster.create({ title: 'Health Check Error', description: 'Error checking data health. You can try calculating anyway.', type: 'warning', duration: 5000 });
                dispatch({ type: 'SET_HEALTH_CHECK_ISSUE_COUNT', count: 0 });
                dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: true });
                return;
            }
        }

        skipHealthCheckRef.current = false;
        isCalculatingRef.current = true;
        dispatch({ type: 'SET_IS_CALCULATING', value: true });
        dispatch({ type: 'SET_ERROR', error: null });
        dispatch({ type: 'SET_STATUS', status: PNL_STATUS.CALCULATING });

        try {
            const requestBody: Record<string, unknown> = {
                lot_method: config.lot_method,
                lot_mode: config.lot_mode,
                base_currency_symbol: config.base_currency_symbol,
                residual_tolerance_pct: config.residual_tolerance_pct,
                allow_negative_balances: config.allow_negative_balances,
                compute_residuals: config.compute_residuals,
                crypto_swap_taxable_by_default: config.crypto_swap_taxable_by_default,
                fee_taxable_by_default: config.fee_taxable_by_default,
            };
            if (config.account_ids && config.account_ids.length > 0) {
                requestBody.account_ids = config.account_ids;
            }

            const calcResponse = await fetch(`${API_URL}/pnl/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!calcResponse.ok) {
                const errorData = await calcResponse.json();
                throw new Error(errorData.detail || 'Failed to calculate P&L');
            }

            const calcResult: PnLVersionResponse = await calcResponse.json();
            const versionId = calcResult.version_id;

            console.log('P&L Calculation Result:', { version_id: versionId, status: calcResult.status, total_realized_pnl: calcResult.total_realized_pnl });

            balancesJustLoadedRef.current = true;
            dispatch({
                type: 'SET_CURRENT_VERSION',
                versionId,
                status: calcResult.status === VERSION_STATUS.DRAFT ? VERSION_STATUS.DRAFT : VERSION_STATUS.COMMITTED,
                createdAt: calcResult.created_at ?? new Date().toISOString(),
            });

            dispatch({
                type: 'SET_ID_COUNTS',
                counts: {
                    unitCount: calcResult.calculation_unit_ids?.length ?? 0,
                    lotCount: calcResult.cost_lot_ids?.length ?? 0,
                    consumedCount: 0,
                    realizedCount: calcResult.realized_pnl_ids?.length ?? 0,
                    feeCount: calcResult.fee_ids?.length ?? 0,
                    warningCount: calcResult.warning_ids?.length ?? 0,
                    settlementCount: 0,
                    eventCount: calcResult.cost_lot_event_ids?.length ?? 0,
                },
            });

            // Fetch warning type counts (fire-and-forget)
            fetch(`${API_URL}/pnl/versions/${versionId}/warnings/type-counts`)
                .then(r => r.ok ? r.json() : {})
                .then(data => dispatch({ type: 'SET_WARNING_TYPE_COUNTS', counts: data }))
                .catch(() => dispatch({ type: 'SET_WARNING_TYPE_COUNTS', counts: {} }));

            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            loadAccountBalances(versionId);

            const summaryData = mapToSummaryData(calcResult);
            console.log('Initial P&L Data Loaded:', { api_total_realized_pnl: summaryData.total_realized_pnl, asset_count: assetRows.length });

            transformResult(summaryData, assetRows);
            dispatch({ type: 'SET_STATUS', status: PNL_STATUS.PREVIEW });
            dispatch({ type: 'SET_CURRENT_VIEW', view: 'assets' });

            if (assetRows.length > 0) {
                const balanceEntries: BalanceEntry[] = balances.map(b => ({
                    asset: b.asset,
                    qty: b.qty,
                    cost_basis_in_base: b.cost_basis_in_base,
                    avg_unit_cost_in_base: b.avg_unit_cost_in_base,
                    lot_count: b.lot_count,
                }));
                fetchPrices(balanceEntries, config.base_currency_symbol);
            }
        } catch (err) {
            dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Unknown error' });
            dispatch({ type: 'SET_STATUS', status: PNL_STATUS.ERROR });
        } finally {
            dispatch({ type: 'SET_IS_CALCULATING', value: false });
            isCalculatingRef.current = false;
        }
    }, [config, dispatch, transformResult, loadBalances, transformBalances, fetchPrices, mapToSummaryData, loadAccountBalances, showUnsettledNegative, isCalculatingRef, skipHealthCheckRef, balancesJustLoadedRef]);

    // ══════════════════════════════════════════════════════════
    // loadVersionById
    // ══════════════════════════════════════════════════════════

    const loadVersionById = useCallback(async (versionId: number) => {
        dispatch({ type: 'SET_IS_CALCULATING', value: true });
        dispatch({ type: 'SET_ERROR', error: null });

        try {
            dispatch({ type: 'SET_WARNINGS', warnings: [] });
            dispatch({ type: 'SET_PRICES', prices: [] });
            dispatch({ type: 'SET_LAST_PRICE_REFRESH', date: null });

            const versionResponse = await fetch(`${API_URL}/pnl/versions/${versionId}`);
            if (!versionResponse.ok) throw new Error('Failed to fetch version');
            const versionData: PnLVersionResponse = await versionResponse.json();

            balancesJustLoadedRef.current = true;
            dispatch({
                type: 'SET_CURRENT_VERSION',
                versionId,
                status: versionData.status === VERSION_STATUS.DRAFT ? VERSION_STATUS.DRAFT : VERSION_STATUS.COMMITTED,
                createdAt: versionData.created_at ?? null,
            });

            dispatch({
                type: 'PATCH_CONFIG',
                partial: {
                    lot_method: versionData.lot_method as any,
                    lot_mode: versionData.lot_mode as any,
                    base_currency_id: versionData.base_currency_id ?? config.base_currency_id,
                    base_currency_symbol: versionData.base_currency_symbol ?? config.base_currency_symbol,
                    compute_residuals: versionData.compute_residuals ?? config.compute_residuals,
                },
            });

            dispatch({
                type: 'SET_ID_COUNTS',
                counts: {
                    unitCount: versionData.calculation_unit_ids?.length ?? 0,
                    lotCount: versionData.cost_lot_ids?.length ?? 0,
                    consumedCount: 0,
                    realizedCount: versionData.realized_pnl_ids?.length ?? 0,
                    feeCount: versionData.fee_ids?.length ?? 0,
                    warningCount: versionData.warning_ids?.length ?? 0,
                    settlementCount: 0,
                    eventCount: versionData.cost_lot_event_ids?.length ?? 0,
                },
            });

            // Fetch warning type counts (fire-and-forget)
            fetch(`${API_URL}/pnl/versions/${versionId}/warnings/type-counts`)
                .then(r => r.ok ? r.json() : {})
                .then(data => dispatch({ type: 'SET_WARNING_TYPE_COUNTS', counts: data }))
                .catch(() => dispatch({ type: 'SET_WARNING_TYPE_COUNTS', counts: {} }));

            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            loadAccountBalances(versionId);

            const summaryData = mapToSummaryData(versionData);
            transformResult(summaryData, assetRows);
            dispatch({ type: 'SET_STATUS', status: versionData.status === VERSION_STATUS.COMMITTED ? PNL_STATUS.PERSISTED : PNL_STATUS.PREVIEW });
            dispatch({ type: 'SET_CURRENT_VIEW', view: 'assets' });

            if (assetRows.length > 0) {
                const balanceEntries: BalanceEntry[] = balances.map(b => ({
                    asset: b.asset,
                    qty: b.qty,
                    cost_basis_in_base: b.cost_basis_in_base,
                    avg_unit_cost_in_base: b.avg_unit_cost_in_base,
                    lot_count: b.lot_count,
                }));
                fetchPrices(balanceEntries, versionData.base_currency_symbol ?? config.base_currency_symbol);
            }

            toaster.success({ title: 'Version Loaded', description: `Loaded version ${versionId} (${versionData.status})` });
        } catch (err) {
            dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to load version' });
            dispatch({ type: 'SET_STATUS', status: PNL_STATUS.ERROR });
            toaster.error({ title: 'Load Failed', description: err instanceof Error ? err.message : 'Failed to load version' });
        } finally {
            dispatch({ type: 'SET_IS_CALCULATING', value: false });
        }
    }, [dispatch, transformResult, loadBalances, transformBalances, fetchPrices, config.base_currency_symbol, config.base_currency_id, config.compute_residuals, mapToSummaryData, loadAccountBalances, showUnsettledNegative, balancesJustLoadedRef]);

    // Keep loadVersionByIdRef in sync
    useEffect(() => {
        loadVersionByIdRef.current = loadVersionById;
    }, [loadVersionById, loadVersionByIdRef]);

    // ══════════════════════════════════════════════════════════
    // Polling hook
    // ══════════════════════════════════════════════════════════

    const {
        status: calcServiceStatus,
        isStale: isCalcStale,
        isCalculating: isCalcServiceCalculating,
        staleSince,
        staleReasons,
        currentVersionId: serviceVersionId,
        lastCalculatedAt,
        error: calcServiceError,
        triggerRefresh: triggerPnLRefresh,
        refetchStatus,
    } = usePnLCalculationStatus({
        isActive,
        onNewVersion: (versionId) => {
            loadVersionByIdRef.current?.(versionId);
            refreshVersionsList();
        },
    });

    // ══════════════════════════════════════════════════════════
    // commitVersion
    // ══════════════════════════════════════════════════════════

    const commitVersion = useCallback(async () => {
        if (!currentVersionId) return;
        dispatch({ type: 'SET_IS_PERSISTING', value: true });
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/commit`, { method: 'POST' });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to save P&L');
            }
            dispatch({ type: 'SET_VERSION_STATUS', status: VERSION_STATUS.COMMITTED });
            dispatch({ type: 'SET_STATUS', status: PNL_STATUS.PERSISTED });
            toaster.success({ title: 'P&L Saved', description: `Version ${currentVersionId} has been saved.` });
            refreshVersionsList();
        } catch (err) {
            toaster.error({ title: 'Save Failed', description: err instanceof Error ? err.message : 'Unknown error' });
        } finally {
            dispatch({ type: 'SET_IS_PERSISTING', value: false });
        }
    }, [currentVersionId, dispatch, refreshVersionsList]);

    // ══════════════════════════════════════════════════════════
    // Delete version
    // ══════════════════════════════════════════════════════════

    const handleDeleteVersion = useCallback(async (versionId: number) => {
        dispatch({ type: 'SET_IS_DELETING', value: true });
        try {
            await fetch(`${API_URL}/pnl/versions/${versionId}`, { method: 'DELETE' });
            refreshVersionsList();
            if (currentVersionId === versionId) {
                dispatch({ type: 'SET_CURRENT_VERSION', versionId: null, status: null, createdAt: null });
                dispatch({ type: 'SET_STATUS', status: PNL_STATUS.IDLE });
            }
        } finally {
            dispatch({ type: 'SET_IS_DELETING', value: false });
        }
    }, [currentVersionId, dispatch, refreshVersionsList]);

    // ══════════════════════════════════════════════════════════
    // Health check handlers
    // ══════════════════════════════════════════════════════════

    const handleContinueAnyway = useCallback(() => {
        skipHealthCheckRef.current = true;
        dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: false });
        runCalculation();
    }, [runCalculation, dispatch, skipHealthCheckRef]);

    const handleFixIssues = useCallback(() => {
        dispatch({ type: 'SET_SHOW_HEALTH_CONFIRM', value: false });
        onOpenHealthCheck?.();
    }, [onOpenHealthCheck, dispatch]);

    // ══════════════════════════════════════════════════════════
    // Effects
    // ══════════════════════════════════════════════════════════

    // Update config when base currency changes
    useEffect(() => {
        dispatch({ type: 'PATCH_CONFIG', partial: { base_currency_symbol: state.config.base_currency_symbol, base_currency_id: state.config.base_currency_id } });
    }, [state.config.base_currency_symbol, state.config.base_currency_id]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fetch accounts on mount
    useEffect(() => {
        if (!isActive) return;
        const fetchAccounts = async () => {
            dispatch({ type: 'SET_IS_LOADING_ACCOUNTS', value: true });
            try {
                const response = await fetch(`${API_URL}/accounts/`);
                if (response.ok) {
                    const data: Account[] = await response.json();
                    dispatch({ type: 'SET_ACCOUNTS', accounts: data });
                }
            } catch (err) {
                console.error('Failed to fetch accounts:', err);
            } finally {
                dispatch({ type: 'SET_IS_LOADING_ACCOUNTS', value: false });
            }
        };
        fetchAccounts();
    }, [isActive, dispatch]);

    // Fetch categories on mount
    useEffect(() => {
        if (!isActive) return;
        const fetchCategories = async () => {
            dispatch({ type: 'SET_IS_LOADING_CATEGORIES', value: true });
            try {
                const response = await fetch(`${API_URL}/categories/by-dimension`);
                if (response.ok) {
                    const data: DimensionWithCategories[] = await response.json();
                    dispatch({ type: 'SET_DIMENSIONS', dimensions: data });
                }
            } catch (err) {
                console.error('Failed to fetch categories:', err);
            } finally {
                dispatch({ type: 'SET_IS_LOADING_CATEGORIES', value: false });
            }
        };
        fetchCategories();
    }, [isActive, dispatch]);

    // Default performerDimensionId to first dimension
    useEffect(() => {
        if (state.performerDimensionId === null && state.dimensions.length > 0) {
            dispatch({ type: 'SET_PERFORMER_DIMENSION_ID', id: state.dimensions[0].id });
        }
    }, [state.dimensions, state.performerDimensionId, dispatch]);

    // Update URL when account filter changes
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (config.account_ids && config.account_ids.length > 0) {
            params.set('accounts', config.account_ids.join(','));
        } else {
            params.delete('accounts');
        }
        const newUrl = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
    }, [config.account_ids]);

    // Auto-fetch live balances when assets are loaded
    useEffect(() => {
        if (state.pnlAssets.length > 0 && status !== PNL_STATUS.IDLE && status !== PNL_STATUS.CALCULATING) {
            fetchLiveBalances();
        }
    }, [state.pnlAssets.length > 0 && status !== PNL_STATUS.IDLE && status !== PNL_STATUS.CALCULATING]); // eslint-disable-line react-hooks/exhaustive-deps

    // Reload balances when unsettled negative filter changes
    useEffect(() => {
        if (isCalculatingRef.current) return;
        if (balancesJustLoadedRef.current) {
            balancesJustLoadedRef.current = false;
            return;
        }
        if (currentVersionId) {
            loadBalances(currentVersionId, showUnsettledNegative).then(balances => {
                const assetRows = transformBalances(balances);

                const fullPriceMap = buildPriceMap(prices);

                const assetsWithPrices = assetRows.map(row => {
                    const assetId = row.asset.id;
                    const priceObj = assetId != null ? fullPriceMap.get(assetId) : undefined;
                    const isPriceLoading = assetId != null && loadingPriceAssetIds.has(assetId);
                    const updated = applyPriceToAssetRow(row, priceObj);
                    return { ...updated, price_loading: isPriceLoading };
                });

                dispatch({ type: 'SET_PNL_ASSETS', assets: assetsWithPrices });

                const { totalUnrealized, totalMarketValue } = computeSummaryTotals(assetsWithPrices);
                const totalCostBasis = assetsWithPrices.reduce((sum, a) => sum + a.cost_basis, 0);

                dispatch({
                    type: 'SET_SUMMARY',
                    summary: state.summary ? {
                        ...state.summary,
                        total_unrealized_pnl: totalUnrealized,
                        total_portfolio_value: totalMarketValue > 0 ? totalMarketValue : totalCostBasis,
                    } : null,
                });
            }).catch(err => {
                dispatch({ type: 'SET_ERROR', error: err instanceof Error ? err.message : 'Failed to load balances' });
                dispatch({ type: 'SET_STATUS', status: PNL_STATUS.ERROR });
            });
        }
    }, [showUnsettledNegative, currentVersionId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Auto-load latest version on first mount
    useEffect(() => {
        if (hasAutoLoaded.current) return;
        if (!isActive) return;
        if (isLoadingVersions) return;

        if (serviceVersionId && status === PNL_STATUS.IDLE) {
            hasAutoLoaded.current = true;
            loadVersionById(serviceVersionId);
            return;
        }

        if (availableVersions.length > 0 && status === PNL_STATUS.IDLE) {
            hasAutoLoaded.current = true;
            loadVersionById(availableVersions[0].version_id);
            return;
        }

        // Nothing to load — mark as done so UI shows empty state
        if (status === PNL_STATUS.IDLE) {
            hasAutoLoaded.current = true;
        }
    }, [isActive, serviceVersionId, availableVersions, isLoadingVersions, status, loadVersionById]); // eslint-disable-line react-hooks/exhaustive-deps

    return {
        // Core operations
        runCalculation,
        loadVersionById,
        commitVersion,
        handleDeleteVersion,
        refreshVersionsList,
        handleConfigChange,
        handleModeChange,
        handleContinueAnyway,
        handleFixIssues,
        loadAccountBalances,

        // Polling status
        calcServiceStatus,
        isCalcStale,
        isCalcServiceCalculating,
        staleReasons,
        serviceVersionId,
        lastCalculatedAt,
        triggerPnLRefresh,
        calcServiceError,
    };
}
