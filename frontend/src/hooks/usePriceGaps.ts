/**
 * usePriceGaps — hooks for price gap detection and backfill.
 *
 * - usePriceGaps: full gap ranges for a single asset
 * - usePriceGapsSummary: lightweight gap counts for multiple assets (badges)
 * - useBackfillPrices: mutation to auto-fetch missing prices
 * - useGapFixJob: server-side job that fixes gaps for many assets, polled for progress
 * - useBulkManualPrices: mutation to create flat-price snapshots for a range
 */
import { useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    API_URL,
} from '../types';
import type {
    GapDetectionResponse,
    GapFixJobState,
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

function invalidatePriceGapQueries(qc: ReturnType<typeof useQueryClient>) {
    qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
    qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
    qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
    qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
}

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

/** `assetIds === null` means all transaction-backed assets. */
async function fetchPriceGapsSummary(
    assetIds: number[] | null,
): Promise<GapSummaryResponse> {
    const qs = assetIds === null ? '' : `?asset_ids=${assetIds.join(',')}`;
    const res = await fetch(`${API_URL}/price-snapshots/gaps/summary${qs}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
}

export function usePriceGapsSummary(
    assetIds: number[] | null,
    enabled = true,
) {
    const result = useQuery<GapSummaryResponse>({
        queryKey: [...PRICE_GAPS_SUMMARY_QUERY_KEY, assetIds === null ? 'all' : assetIds.join(',')],
        queryFn: () => fetchPriceGapsSummary(assetIds),
        enabled: enabled && (assetIds === null || assetIds.length > 0),
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
        onSuccess: () => {
            invalidatePriceGapQueries(qc);
        },
    });
}

// ---------------------------------------------------------------------------
// Gap-fix background job (server-side, polled)
// ---------------------------------------------------------------------------

export const GAP_FIX_JOB_QUERY_KEY = ['price-gap-fix-job'] as const;
const GAP_FIX_JOB_POLL_MS = 1500;

async function jobRequest(path: string, init?: RequestInit): Promise<GapFixJobState> {
    const res = await fetch(`${API_URL}/price-snapshots/gaps/jobs${path}`, init);
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? `HTTP ${res.status}`);
    }
    return res.json();
}

export const isGapFixJobActive = (job: GapFixJobState | null | undefined) =>
    job?.status === 'scanning' || job?.status === 'running';

/**
 * Polls the current gap-fix job while it is active and invalidates gap/price
 * queries once it finishes. `onFinished` fires once per finished job.
 */
export function useGapFixJob(onFinished?: (job: GapFixJobState) => void) {
    const qc = useQueryClient();
    const query = useQuery<GapFixJobState>({
        queryKey: GAP_FIX_JOB_QUERY_KEY,
        queryFn: () => jobRequest('/current'),
        refetchInterval: (q) => (isGapFixJobActive(q.state.data) ? GAP_FIX_JOB_POLL_MS : false),
    });
    const job = query.data ?? null;

    const onFinishedRef = useRef(onFinished);
    onFinishedRef.current = onFinished;
    const wasActive = useRef(false);
    useEffect(() => {
        const active = isGapFixJobActive(job);
        if (wasActive.current && !active && job) {
            invalidatePriceGapQueries(qc);
            onFinishedRef.current?.(job);
        }
        wasActive.current = active;
    }, [job, qc]);

    const setJob = (data: GapFixJobState) => qc.setQueryData(GAP_FIX_JOB_QUERY_KEY, data);

    const start = useMutation<GapFixJobState, Error, { assetIds: number[] | null; quoteAssetId?: number | null }>({
        mutationFn: ({ assetIds, quoteAssetId }) => jobRequest('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asset_ids: assetIds, quote_asset_id: quoteAssetId ?? null }),
        }),
        onSuccess: setJob,
    });
    const cancel = useMutation<GapFixJobState, Error, void>({
        mutationFn: () => jobRequest('/current/cancel', { method: 'POST' }),
        onSuccess: setJob,
    });
    const skip = useMutation<GapFixJobState, Error, number>({
        mutationFn: (assetId) => jobRequest(`/current/skip/${assetId}`, { method: 'POST' }),
        onSuccess: setJob,
    });

    return {
        job,
        isActive: isGapFixJobActive(job),
        start,
        cancel,
        skip,
    };
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
            invalidatePriceGapQueries(qc);
        },
    });
}
