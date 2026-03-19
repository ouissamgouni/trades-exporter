/**
 * usePriceHealth — hooks for the Price Health Dashboard.
 *
 * - usePriceHealth: fetches per-asset health summary (staleness, flat-line, status)
 * - usePriceTimeseries: fetches raw price timeseries for selected assets (charting)
 */
import { useQuery } from '@tanstack/react-query';
import { API_URL, PriceHealthResponse, PriceTimeseriesResponse } from '../types';

// ---------------------------------------------------------------------------
// Price Health
// ---------------------------------------------------------------------------

export const PRICE_HEALTH_QUERY_KEY = ['price-health'] as const;

async function fetchPriceHealth(): Promise<PriceHealthResponse> {
    const res = await fetch(`${API_URL}/price-snapshots/health`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export interface UsePriceHealthReturn {
    data: PriceHealthResponse | null;
    isLoading: boolean;
    error: string | null;
    refetch: () => void;
}

export function usePriceHealth(enabled = true): UsePriceHealthReturn {
    const result = useQuery<PriceHealthResponse>({
        queryKey: PRICE_HEALTH_QUERY_KEY,
        queryFn: fetchPriceHealth,
        enabled,
        staleTime: 60_000, // 1min — same as useAssets
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// Price Timeseries
// ---------------------------------------------------------------------------

export const PRICE_TIMESERIES_QUERY_KEY = ['price-timeseries'] as const;

interface UsePriceTimeseriesParams {
    assetIds: number[];
    quoteAssetId?: number | null;
    source?: string;
    dateFrom?: string;
    dateTo?: string;
}

async function fetchPriceTimeseries(params: UsePriceTimeseriesParams): Promise<PriceTimeseriesResponse> {
    const sp = new URLSearchParams();
    sp.set('asset_ids', params.assetIds.join(','));
    if (params.quoteAssetId) sp.set('quote_asset_id', String(params.quoteAssetId));
    if (params.source) sp.set('source', params.source);
    if (params.dateFrom) sp.set('date_from', params.dateFrom);
    if (params.dateTo) sp.set('date_to', params.dateTo);

    const res = await fetch(`${API_URL}/price-snapshots/timeseries?${sp.toString()}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export interface UsePriceTimeseriesReturn {
    data: PriceTimeseriesResponse | null;
    isLoading: boolean;
    error: string | null;
}

export function usePriceTimeseries(
    params: UsePriceTimeseriesParams,
    enabled = true,
): UsePriceTimeseriesReturn {
    const result = useQuery<PriceTimeseriesResponse>({
        queryKey: [...PRICE_TIMESERIES_QUERY_KEY, params.assetIds.join(','), params.quoteAssetId, params.source, params.dateFrom, params.dateTo],
        queryFn: () => fetchPriceTimeseries(params),
        enabled: enabled && params.assetIds.length > 0,
        staleTime: 2 * 60_000, // 2min
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
    };
}
