/**
 * usePriceGaps — hooks for price gap detection and backfill.
 *
 * - usePriceGaps: full gap ranges for a single asset
 * - usePriceGapsSummary: lightweight gap counts for multiple assets (badges)
 * - useBackfillPrices: mutation to auto-fetch missing prices
 * - useBackfillAllPriceGaps: scan and fix all transaction-backed gaps with progress
 * - useBulkManualPrices: mutation to create flat-price snapshots for a range
 */
import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
    API_URL,
} from '../types';
import type {
    GapRange,
    GapDetectionResponse,
    GapSummaryResponse,
    GapCandidatesResponse,
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
// All transaction-backed gap candidates
// ---------------------------------------------------------------------------

async function fetchPriceGapCandidates(
    quoteAssetId?: number | null,
): Promise<GapCandidatesResponse> {
    const sp = new URLSearchParams();
    if (quoteAssetId != null) sp.set('quote_asset_id', String(quoteAssetId));

    const suffix = sp.toString() ? `?${sp.toString()}` : '';
    const res = await fetch(`${API_URL}/price-snapshots/gaps/candidates${suffix}`);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return res.json();
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
        onSuccess: () => {
            invalidatePriceGapQueries(qc);
        },
    });
}

export type BackfillAllPriceGapsStatus = 'idle' | 'scanning' | 'running' | 'complete' | 'error';

export interface BackfillAllPriceGapsProgress {
    status: BackfillAllPriceGapsStatus;
    assetsWithGaps: number;
    totalRanges: number;
    completedRanges: number;
    totalMissingDays: number;
    fetchedCount: number;
    failedCount: number;
    currentAssetSymbol?: string;
    currentRange?: string;
    error?: string;
}

const INITIAL_BACKFILL_ALL_PROGRESS: BackfillAllPriceGapsProgress = {
    status: 'idle',
    assetsWithGaps: 0,
    totalRanges: 0,
    completedRanges: 0,
    totalMissingDays: 0,
    fetchedCount: 0,
    failedCount: 0,
};

const formatRangeLabel = (gap: GapRange) => `${gap.start_date} to ${gap.end_date}`;

export function useBackfillAllPriceGaps(quoteAssetId?: number | null) {
    const qc = useQueryClient();
    const [progress, setProgress] = useState<BackfillAllPriceGapsProgress>(INITIAL_BACKFILL_ALL_PROGRESS);

    const reset = useCallback(() => {
        setProgress(INITIAL_BACKFILL_ALL_PROGRESS);
    }, []);

    const run = useCallback(async (): Promise<BackfillAllPriceGapsProgress> => {
        setProgress({ ...INITIAL_BACKFILL_ALL_PROGRESS, status: 'scanning' });

        try {
            const candidates = await fetchPriceGapCandidates(quoteAssetId);
            const workItems: Array<{ assetId: number; symbol: string; gap: GapRange }> = [];

            for (const item of candidates.items) {
                for (const gap of item.gaps) {
                    workItems.push({ assetId: item.asset_id, symbol: item.symbol, gap });
                }
            }

            const scannedProgress: BackfillAllPriceGapsProgress = {
                ...INITIAL_BACKFILL_ALL_PROGRESS,
                status: workItems.length > 0 ? 'running' : 'complete',
                assetsWithGaps: candidates.items.length,
                totalRanges: workItems.length,
                totalMissingDays: workItems.reduce((sum, item) => sum + item.gap.missing_days_count, 0),
            };

            setProgress(scannedProgress);

            if (workItems.length === 0) {
                invalidatePriceGapQueries(qc);
                return scannedProgress;
            }

            let nextProgress = scannedProgress;
            for (let index = 0; index < workItems.length; index += 1) {
                const item = workItems[index];
                const currentRange = formatRangeLabel(item.gap);
                setProgress(prev => ({
                    ...prev,
                    currentAssetSymbol: item.symbol,
                    currentRange,
                }));

                const result = await postBackfill({
                    asset_id: item.assetId,
                    date_from: item.gap.start_date,
                    date_to: item.gap.end_date,
                    quote_asset_id: quoteAssetId ?? null,
                });

                nextProgress = {
                    ...nextProgress,
                    completedRanges: index + 1,
                    fetchedCount: nextProgress.fetchedCount + result.fetched.length,
                    failedCount: nextProgress.failedCount + result.failed.length,
                    currentAssetSymbol: item.symbol,
                    currentRange,
                };
                setProgress(nextProgress);
            }

            const completeProgress = {
                ...nextProgress,
                status: 'complete' as const,
                currentAssetSymbol: undefined,
                currentRange: undefined,
            };
            setProgress(completeProgress);
            invalidatePriceGapQueries(qc);
            return completeProgress;
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            setProgress(prev => ({ ...prev, status: 'error', error: message }));
            throw err;
        }
    }, [quoteAssetId, qc]);

    const progressPercent = progress.totalRanges > 0
        ? Math.round((progress.completedRanges / progress.totalRanges) * 100)
        : progress.status === 'complete'
            ? 100
            : 0;

    return {
        progress,
        progressPercent,
        isRunning: progress.status === 'scanning' || progress.status === 'running',
        run,
        reset,
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
