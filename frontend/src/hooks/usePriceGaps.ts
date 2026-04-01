/**
 * usePriceGaps — hooks for price gap detection and backfill.
 *
 * - usePriceGaps: full gap ranges for a single asset
 * - usePriceGapsSummary: lightweight gap counts for multiple assets (badges)
 * - useBackfillPrices: mutation to auto-fetch missing prices
 * - useBulkManualPrices: mutation to create flat-price snapshots for a range
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    API_URL,
    GapDetectionResponse,
    GapSummaryResponse,
    BackfillRequest,
    BackfillResponse,
    BulkManualRequest,
    BulkManualResponse,
} from '../types';
import { PRICE_TIMESERIES_QUERY_KEY, PRICE_HEALTH_QUERY_KEY } from './usePriceHealth';

// ---------------------------------------------------------------------------
// Query Keys
// ---------------------------------------------------------------------------

export const PRICE_GAPS_QUERY_KEY = ['price-gaps'] as const;
export const PRICE_GAPS_SUMMARY_QUERY_KEY = ['price-gaps-summary'] as const;

// ---------------------------------------------------------------------------
// Single-asset gap detection
// ---------------------------------------------------------------------------

async function fetchPriceGaps(
    assetId: number,
    dateFrom?: string,
    dateTo?: string,
): Promise<GapDetectionResponse> {
    const sp = new URLSearchParams();
    sp.set('asset_id', String(assetId));
    if (dateFrom) sp.set('date_from', dateFrom);
    if (dateTo) sp.set('date_to', dateTo);

    const res = await fetch(`${API_URL}/price-snapshots/gaps?${sp.toString()}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export function usePriceGaps(
    assetId: number | null | undefined,
    dateFrom?: string,
    dateTo?: string,
    enabled = true,
) {
    const result = useQuery<GapDetectionResponse>({
        queryKey: [...PRICE_GAPS_QUERY_KEY, assetId, dateFrom, dateTo],
        queryFn: () => fetchPriceGaps(assetId!, dateFrom, dateTo),
        enabled: enabled && assetId != null,
        staleTime: 2 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// Multi-asset gap summary (lightweight)
// ---------------------------------------------------------------------------

async function fetchPriceGapsSummary(
    assetIds: number[],
): Promise<GapSummaryResponse> {
    const res = await fetch(
        `${API_URL}/price-snapshots/gaps/summary?asset_ids=${assetIds.join(',')}`,
    );
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export function usePriceGapsSummary(
    assetIds: number[],
    enabled = true,
) {
    const result = useQuery<GapSummaryResponse>({
        queryKey: [...PRICE_GAPS_SUMMARY_QUERY_KEY, assetIds.join(',')],
        queryFn: () => fetchPriceGapsSummary(assetIds),
        enabled: enabled && assetIds.length > 0,
        staleTime: 2 * 60_000,
    });

    return {
        data: result.data ?? null,
        isLoading: result.isLoading,
        error: result.error ? (result.error as Error).message : null,
        refetch: result.refetch,
    };
}

// ---------------------------------------------------------------------------
// Backfill mutation (auto-fetch missing prices)
// ---------------------------------------------------------------------------

async function postBackfill(req: BackfillRequest): Promise<BackfillResponse> {
    const res = await fetch(`${API_URL}/price-snapshots/backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export function useBackfillPrices() {
    const qc = useQueryClient();
    return useMutation<BackfillResponse, Error, BackfillRequest>({
        mutationFn: postBackfill,
        onSuccess: (_data, variables) => {
            qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
        },
    });
}

// ---------------------------------------------------------------------------
// Bulk manual mutation (flat price for a range)
// ---------------------------------------------------------------------------

async function postBulkManual(req: BulkManualRequest): Promise<BulkManualResponse> {
    const res = await fetch(`${API_URL}/price-snapshots/bulk-manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export function useBulkManualPrices() {
    const qc = useQueryClient();
    return useMutation<BulkManualResponse, Error, BulkManualRequest>({
        mutationFn: postBulkManual,
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
            qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
        },
    });
}
