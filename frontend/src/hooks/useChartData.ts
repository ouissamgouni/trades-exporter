/**
 * useChartData — hooks for PnL chart data.
 *
 * Uses TanStack React Query for automatic caching, deduplication and
 * background refetching — data survives tab switches without re-fetching.
 */
import { useQuery, useQueries } from '@tanstack/react-query';
import { API_URL } from '../types';

// ---------------------------------------------------------------------------
// Response types (mirror backend Pydantic schemas)
// ---------------------------------------------------------------------------

export interface TimelineBreakdownItem {
    asset_id: number;
    symbol: string;
    label?: string | null;
    value_in_base: number;
    qty: number;
    cost_basis_in_base: number;
    realized_pnl_to_date: number;
}

export interface TimelinePoint {
    date: string; // YYYY-MM-DD
    total_value_in_base: number;
    cost_basis_in_base: number;
    unrealized_pnl: number;
    cumulative_realized_pnl: number;
    cumulative_income: number;
    breakdown: TimelineBreakdownItem[];
}

export interface PortfolioTimelineResponse {
    version_id: number;
    granularity: string;
    points: TimelinePoint[];
}

// ---------------------------------------------------------------------------
// Fee summary types
// ---------------------------------------------------------------------------

export interface FeeBreakdownItem {
    key: string;
    key_id: number;
    fees_in_base: number;
}

export interface FeePeriodBucket {
    period: string;
    total_fees_in_base: number;
    count: number;
    breakdown: FeeBreakdownItem[];
}

export interface FeeSummaryByPeriodResponse {
    version_id: number;
    granularity: string;
    group_by: string;
    periods: FeePeriodBucket[];
}

// ---------------------------------------------------------------------------
// Common filter params
// ---------------------------------------------------------------------------

export interface ChartFilterParams {
    granularity?: 'daily' | 'weekly' | 'monthly';
    dateFrom?: string;
    dateTo?: string;
    assetIds?: number[];
    accountIds?: number[];
    categoryIds?: number[];
}

function buildQueryString(params: ChartFilterParams, extra?: Record<string, string>): string {
    const sp = new URLSearchParams();
    if (params.granularity) sp.set('granularity', params.granularity);
    if (params.dateFrom) sp.set('date_from', params.dateFrom);
    if (params.dateTo) sp.set('date_to', params.dateTo);
    if (params.assetIds?.length) sp.set('asset_ids', params.assetIds.join(','));
    if (params.accountIds?.length) sp.set('account_ids', params.accountIds.join(','));
    if (params.categoryIds?.length) sp.set('category_ids', params.categoryIds.join(','));
    if (extra) {
        for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `?${qs}` : '';
}

/** Stable key fragment from filter params */
function filterKey(params: ChartFilterParams): (string | undefined)[] {
    return [
        params.granularity,
        params.dateFrom,
        params.dateTo,
        params.assetIds?.join(','),
        params.accountIds?.join(','),
        params.categoryIds?.join(','),
    ];
}

// ---------------------------------------------------------------------------
// usePortfolioTimeline  (React Query)
// ---------------------------------------------------------------------------

export function usePortfolioTimeline(
    versionId: number | null,
    params: ChartFilterParams = {},
    enabled = true,
) {
    const result = useQuery<PortfolioTimelineResponse>({
        queryKey: ['portfolio-timeline', versionId, ...filterKey(params)],
        queryFn: async ({ signal }) => {
            const qs = buildQueryString(params);
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/portfolio-timeline${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000, // 5 min — timeline data is heavy and rarely changes
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// useFeeSummaryByPeriod  (React Query)
// ---------------------------------------------------------------------------

export function useFeeSummaryByPeriod(
    versionId: number | null,
    params: ChartFilterParams & { groupBy?: 'asset' | 'account' | 'category' | 'none' } = {},
    enabled = true,
) {
    const result = useQuery<FeeSummaryByPeriodResponse>({
        queryKey: ['fee-summary', versionId, params.groupBy, ...filterKey(params)],
        queryFn: async ({ signal }) => {
            const extra: Record<string, string> = {};
            if (params.groupBy) extra.group_by = params.groupBy;
            const qs = buildQueryString(params, extra);
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/fee-summary-by-period${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// Metrics types (replaces period-summary)
// ---------------------------------------------------------------------------

export interface PerformerItem {
    id: number;
    name: string;
    label?: string | null;
    group_type: 'asset' | 'account' | 'category';
    total_return: number;
    roi_pct: number;
    unrealized_pnl: number;
    market_value: number;
    cost_basis: number;
    total_fees: number;
    efficiency: number;
}

export interface MetricsRangeData {
    total_return: number;
    roi_pct: number;
    current_value: number;
    cost_basis: number;
    unrealized_pnl: number;
    realized_pnl: number;
    taxable_realized_pnl: number;
    realized_in_period: number;
    cost_basis_in_period: number;
    unrealized_in_period: number;
    fees_in_period: number;
    total_invested?: number;
    top_performers: PerformerItem[];
    flop_performers: PerformerItem[];
}

export interface MetricsSummary {
    current_value: number;
    cost_basis: number;
    unrealized_pnl: number;
    realized_pnl: number;
    taxable_realized_pnl: number;
    deferred_gain?: number;
    total_fees: number;
    fee_entry_count: number;
    total_invested?: number;
}

export type RangeKey = 'all' | '3y' | '1y' | '6m' | '3m' | '1m' | '1w';

export interface VersionMetricsResponse {
    version_id: number;
    summary: MetricsSummary;
    ranges: Partial<Record<RangeKey, MetricsRangeData>>;
}

// ---------------------------------------------------------------------------
// Book metrics types (cost-lot-based, no prices needed)
// ---------------------------------------------------------------------------

export interface BookSummary {
    cost_basis: number;
    realized_pnl: number;
    taxable_realized_pnl: number;
    deferred_gain?: number;
    total_fees: number;
    fee_entry_count: number;
    total_invested: number;
    total_income: number;
    total_withholding: number;
    income_event_count: number;
}

export interface BookRangeData {
    cost_basis: number;
    realized_pnl: number;
    taxable_realized_pnl: number;
    deferred_gain?: number;
    realized_in_period: number;
    cost_basis_in_period: number;
    fees_in_period: number;
    total_invested: number;
    income_in_period: number;
    withholding_in_period: number;
}

export interface BookMetricsResponse {
    version_id: number;
    summary: BookSummary;
    ranges: Partial<Record<RangeKey, BookRangeData>>;
}

// ---------------------------------------------------------------------------
// Live metrics types (price-dependent)
// ---------------------------------------------------------------------------

export interface LiveSummary {
    current_value: number;
    unrealized_pnl: number;
}

export interface LiveRangeData {
    current_value: number;
    unrealized_pnl: number;
    unrealized_in_period: number;
    total_return: number;
    roi_pct: number;
}

export interface LiveMetricsResponse {
    version_id: number;
    summary: LiveSummary;
    ranges: Partial<Record<RangeKey, LiveRangeData>>;
}

// ---------------------------------------------------------------------------
// Performers response type
// ---------------------------------------------------------------------------

export interface PerformersResponse {
    version_id: number;
    period: string;
    group_type: string;
    top_performers: PerformerItem[];
    flop_performers: PerformerItem[];
    total_count: number;
}

// ---------------------------------------------------------------------------
// Asset period delta types & hook
// ---------------------------------------------------------------------------

export interface AssetPeriodDelta {
    asset_id: number;
    symbol: string;
    label?: string | null;
    total_return: number;
    roi_pct: number;
    unrealized_change: number;
    realized_in_period: number;
    cost_change: number;
    market_value_change: number;
}

export interface AssetPeriodDeltasResponse {
    version_id: number;
    period: string;
    deltas: AssetPeriodDelta[];
}

export function useAssetPeriodDeltas(
    versionId: number | null,
    period: string,
    enabled = true,
) {
    const result = useQuery<AssetPeriodDeltasResponse>({
        queryKey: ['asset-period-deltas', versionId, period],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            sp.set('period', period);
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/asset-period-deltas?${sp.toString()}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId && period !== 'all',
        staleTime: 5 * 60_000,
    });

    // Build Map<assetId, AssetPeriodDelta> for O(1) lookups
    const deltaMap = result.data?.deltas
        ? new Map(result.data.deltas.map(d => [d.asset_id, d]))
        : new Map<number, AssetPeriodDelta>();

    return {
        data: result.data ?? null,
        deltaMap,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
    };
}



// ---------------------------------------------------------------------------
// useVersionMetrics  (React Query)
// ---------------------------------------------------------------------------

export type GroupBy = 'asset' | 'account' | 'category';

export interface VersionMetricsParams {
    groupBy?: GroupBy;
    topN?: number;
    dimensionId?: number | null;
    assetIds?: number[];
    accountIds?: number[];
    categoryIds?: number[];
}

export function useVersionMetrics(
    versionId: number | null,
    params: VersionMetricsParams = {},
    enabled = true,
) {
    const result = useQuery<VersionMetricsResponse>({
        queryKey: [
            'version-metrics', versionId,
            params.groupBy,
            params.topN,
            params.dimensionId,
            params.assetIds?.join(','),
            params.accountIds?.join(','),
            params.categoryIds?.join(','),
        ],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            if (params.groupBy) sp.set('group_by', params.groupBy);
            if (params.topN) sp.set('top_n', String(params.topN));
            if (params.dimensionId != null) sp.set('dimension_id', String(params.dimensionId));
            if (params.assetIds?.length) sp.set('asset_ids', params.assetIds.join(','));
            if (params.accountIds?.length) sp.set('account_ids', params.accountIds.join(','));
            if (params.categoryIds?.length) sp.set('category_ids', params.categoryIds.join(','));
            const qs = sp.toString() ? `?${sp.toString()}` : '';
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/metrics${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// useBookMetrics  (React Query)
// ---------------------------------------------------------------------------

export interface BookMetricsParams {
    assetIds?: number[];
    accountIds?: number[];
    categoryIds?: number[];
}

export function useBookMetrics(
    versionId: number | null,
    params: BookMetricsParams = {},
    enabled = true,
) {
    const result = useQuery<BookMetricsResponse>({
        queryKey: [
            'book-metrics', versionId,
            params.assetIds?.join(','),
            params.accountIds?.join(','),
            params.categoryIds?.join(','),
        ],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            if (params.assetIds?.length) sp.set('asset_ids', params.assetIds.join(','));
            if (params.accountIds?.length) sp.set('account_ids', params.accountIds.join(','));
            if (params.categoryIds?.length) sp.set('category_ids', params.categoryIds.join(','));
            const qs = sp.toString() ? `?${sp.toString()}` : '';
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/metrics/book${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// useLiveMetrics  (React Query)
// ---------------------------------------------------------------------------

export interface LiveMetricsParams {
    assetIds?: number[];
    accountIds?: number[];
    categoryIds?: number[];
    /** Include in queryKey so React Query refetches when live prices arrive */
    pricesReady?: boolean;
}

export function useLiveMetrics(
    versionId: number | null,
    params: LiveMetricsParams = {},
    enabled = true,
) {
    const result = useQuery<LiveMetricsResponse>({
        queryKey: [
            'live-metrics', versionId,
            params.assetIds?.join(','),
            params.accountIds?.join(','),
            params.categoryIds?.join(','),
            params.pricesReady ?? false,
        ],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            if (params.assetIds?.length) sp.set('asset_ids', params.assetIds.join(','));
            if (params.accountIds?.length) sp.set('account_ids', params.accountIds.join(','));
            if (params.categoryIds?.length) sp.set('category_ids', params.categoryIds.join(','));
            const qs = sp.toString() ? `?${sp.toString()}` : '';
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/metrics/live${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 2 * 60_000, // 2 min — prices change more frequently
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// useVersionPerformers  (React Query)
// ---------------------------------------------------------------------------

export interface PerformersParams {
    period?: string;
    groupBy?: GroupBy;
    topN?: number;
    dimensionId?: number | null;
    assetIds?: number[];
    accountIds?: number[];
    categoryIds?: number[];
    /** Include in queryKey so React Query refetches when live prices arrive */
    pricesReady?: boolean;
}

export function useVersionPerformers(
    versionId: number | null,
    params: PerformersParams = {},
    enabled = true,
) {
    const result = useQuery<PerformersResponse>({
        queryKey: [
            'version-performers', versionId,
            params.period,
            params.groupBy,
            params.topN,
            params.dimensionId,
            params.assetIds?.join(','),
            params.accountIds?.join(','),
            params.categoryIds?.join(','),
            params.pricesReady ?? false,
        ],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            if (params.period) sp.set('period', params.period);
            if (params.groupBy) sp.set('group_by', params.groupBy);
            if (params.topN) sp.set('top_n', String(params.topN));
            if (params.dimensionId != null) sp.set('dimension_id', String(params.dimensionId));
            if (params.assetIds?.length) sp.set('asset_ids', params.assetIds.join(','));
            if (params.accountIds?.length) sp.set('account_ids', params.accountIds.join(','));
            if (params.categoryIds?.length) sp.set('category_ids', params.categoryIds.join(','));
            const qs = sp.toString() ? `?${sp.toString()}` : '';
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/performers${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}


// ---------------------------------------------------------------------------
// Benchmark series types & hook
// ---------------------------------------------------------------------------

export interface BenchmarkPreset {
    ticker: string;
    label: string;
}

/** Whitelisted benchmark indices (must match backend BENCHMARK_PRESETS) */
export const BENCHMARK_PRESETS: BenchmarkPreset[] = [
    { ticker: '^GSPC', label: 'S&P 500' },
    { ticker: '^IXIC', label: 'NASDAQ' },
    { ticker: '^STOXX50E', label: 'Euro Stoxx 50' },
    { ticker: 'BTC-USD', label: 'Bitcoin' },
    { ticker: 'ETH-USD', label: 'Ethereum' },
    { ticker: 'GC=F', label: 'Gold' },
];

export interface BenchmarkPoint {
    date: string;
    close: number;
}

export interface BenchmarkSeriesResponse {
    ticker: string;
    label: string;
    points: BenchmarkPoint[];
}

/**
 * Fetch daily close prices for an external benchmark index.
 *
 * @param ticker  Yahoo Finance ticker (must be in BENCHMARK_PRESETS)
 * @param startDate  YYYY-MM-DD
 * @param endDate    YYYY-MM-DD
 * @param enabled    Whether to fetch (false = skip)
 */
export function useBenchmarkSeries(
    ticker: string | null,
    startDate: string | null,
    endDate: string | null,
    enabled = true,
) {
    const result = useQuery<BenchmarkSeriesResponse>({
        queryKey: ['benchmark-series', ticker, startDate, endDate],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            sp.set('ticker', ticker!);
            sp.set('start_date', startDate!);
            sp.set('end_date', endDate!);
            const res = await fetch(`${API_URL}/pnl/benchmark-series?${sp.toString()}`, { signal });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`HTTP ${res.status}: ${body}`);
            }
            return res.json();
        },
        enabled: enabled && !!ticker && !!startDate && !!endDate,
        staleTime: 10 * 60_000, // 10 min — external data
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
    };
}

/**
 * Fetch daily close prices for multiple benchmark indices in parallel.
 * Uses React Query's useQueries to run independent queries per ticker.
 */
export function useMultiBenchmarkSeries(
    tickers: string[],
    startDate: string | null,
    endDate: string | null,
    enabled = true,
) {
    const results = useQueries({
        queries: tickers.map(ticker => ({
            queryKey: ['benchmark-series', ticker, startDate, endDate],
            queryFn: async ({ signal }: { signal: AbortSignal }) => {
                const sp = new URLSearchParams();
                sp.set('ticker', ticker);
                sp.set('start_date', startDate!);
                sp.set('end_date', endDate!);
                const res = await fetch(`${API_URL}/pnl/benchmark-series?${sp.toString()}`, { signal });
                if (!res.ok) {
                    const body = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status}: ${body}`);
                }
                return res.json() as Promise<BenchmarkSeriesResponse>;
            },
            enabled: enabled && !!ticker && !!startDate && !!endDate,
            staleTime: 10 * 60_000,
        })),
    });

    return results.map((r, i) => ({
        ticker: tickers[i],
        data: r.data ?? null,
        isLoading: r.isLoading,
        error: r.error ? (r.error as Error).message : null,
    }));
}

// ---------------------------------------------------------------------------
// Income Events types & hooks
// ---------------------------------------------------------------------------

export interface IncomeAssetRef {
    id: number;
    symbol: string | null;
    label: string | null;
}

export interface IncomeEventItem {
    id: number;
    income_type: string;
    asset: IncomeAssetRef;
    attributed_asset: IncomeAssetRef | null;
    gross_amount_in_base: number;
    withholding_amount_in_base: number;
    net_amount_in_base: number;
    withholding_jurisdiction: string | null;
    withholding_rate: number | null;
    income_at: string | null;
    notes: string | null;
    transaction_id: number | null;
    unit_id: number | null;
    account_id: number | null;
    account_name: string | null;
}

export interface IncomeEventsResponse {
    items: IncomeEventItem[];
    total: number;
    page: number;
    limit: number;
}

export interface IncomeFilterOption {
    value: string;
    label: string;
    count: number;
}

export interface IncomeFilterOptionsResponse {
    assets: IncomeFilterOption[];
    income_types: IncomeFilterOption[];
    jurisdictions: IncomeFilterOption[];
    accounts: IncomeFilterOption[];
    date_range: { min: string; max: string } | null;
}

export interface IncomeEventsParams {
    assetId?: number;
    incomeType?: string;
    accountId?: number;
    jurisdiction?: string;
    dateFrom?: string;
    dateTo?: string;
    sortBy?: 'date' | 'amount';
    order?: 'asc' | 'desc';
    page?: number;
    limit?: number;
}

export function useIncomeEvents(
    versionId: number | null,
    params: IncomeEventsParams = {},
    enabled = true,
) {
    const result = useQuery<IncomeEventsResponse>({
        queryKey: [
            'income-events', versionId,
            params.assetId, params.incomeType, params.accountId,
            params.jurisdiction, params.dateFrom, params.dateTo,
            params.sortBy, params.order, params.page, params.limit,
        ],
        queryFn: async ({ signal }) => {
            const sp = new URLSearchParams();
            if (params.assetId != null) sp.set('asset_id', String(params.assetId));
            if (params.incomeType) sp.set('income_type', params.incomeType);
            if (params.accountId != null) sp.set('account_id', String(params.accountId));
            if (params.jurisdiction) sp.set('jurisdiction', params.jurisdiction);
            if (params.dateFrom) sp.set('date_from', params.dateFrom);
            if (params.dateTo) sp.set('date_to', params.dateTo);
            if (params.sortBy) sp.set('sort_by', params.sortBy);
            if (params.order) sp.set('order', params.order);
            if (params.page != null) sp.set('page', String(params.page));
            if (params.limit != null) sp.set('limit', String(params.limit));
            const qs = sp.toString() ? `?${sp.toString()}` : '';
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/income-events${qs}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

export function useIncomeFilterOptions(
    versionId: number | null,
    enabled = true,
) {
    const result = useQuery<IncomeFilterOptionsResponse>({
        queryKey: ['income-filter-options', versionId],
        queryFn: async ({ signal }) => {
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/income-events/filter-options`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: enabled && !!versionId,
        staleTime: 5 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
    };
}
