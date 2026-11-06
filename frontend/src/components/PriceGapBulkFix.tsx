import React, { useMemo } from 'react';
import { Button, Progress, Spinner } from './ui/primitives';
import { FiSquare, FiZap } from 'react-icons/fi';
import { useGapFixJob, usePriceGapsSummary } from '../hooks/usePriceGaps';
import type { GapFixJobState } from '../types';
import { toaster } from './ui/toaster';

interface PriceGapBulkFixProps {
    quoteAssetId?: number | null;
    onComplete?: (job: GapFixJobState) => void | Promise<void>;
}

/** Compact launcher for the server-side gap-fix job over all transaction-backed assets. */
export const PriceGapBulkFix: React.FC<PriceGapBulkFixProps> = ({ quoteAssetId, onComplete }) => {
    const { data: summary, isLoading } = usePriceGapsSummary(null);
    const { job, isActive, start, cancel } = useGapFixJob((finished) => {
        const msg = `${finished.fetched_count} fetched, ${finished.failed_count} failed`;
        if (finished.status === 'complete') toaster.success({ title: 'Gap fix complete', description: msg });
        else toaster.info({ title: `Gap fix ${finished.status}`, description: finished.error ?? msg });
        onComplete?.(finished);
    });

    const recap = useMemo(() => {
        const items = summary?.items ?? [];
        return {
            assets: items.length,
            ranges: items.reduce((s, i) => s + i.gap_count, 0),
            days: items.reduce((s, i) => s + i.total_missing_days, 0),
        };
    }, [summary]);

    const pct = job && job.total_missing_days > 0 ? Math.round((job.processed_days / job.total_missing_days) * 100) : 0;

    return (
        <div className="min-w-[260px] max-w-[380px]">
            <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-slate-500">
                    {isLoading ? 'Scanning gaps…' : `${recap.ranges} gaps · ${recap.days} d · ${recap.assets} assets`}
                </span>
                {isActive ? (
                    <Button size="md" variant="outline" colorScheme="gray" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                        <FiSquare />
                        <span>Cancel</span>
                    </Button>
                ) : (
                    <Button
                        size="md"
                        colorScheme="blue"
                        disabled={recap.assets === 0 || start.isPending}
                        onClick={() => start.mutate(
                            { assetIds: null, quoteAssetId },
                            { onError: (err) => toaster.error({ title: 'Could not start gap fix', description: err.message }) },
                        )}
                    >
                        {start.isPending ? <Spinner size="xs" /> : <FiZap />}
                        <span>Fix all gaps</span>
                    </Button>
                )}
            </div>
            {isActive && job && (
                <div className="mt-2">
                    <div className="mb-1 flex justify-between gap-2 text-xs text-slate-600">
                        <span className="truncate">
                            {job.status === 'scanning' ? 'Scanning assets…' : `Asset ${Math.min(job.completed_assets + 1, job.total_assets)}/${job.total_assets}${job.current_date ? ` · ${job.current_date}` : ''}`}
                        </span>
                        <span className="whitespace-nowrap">{job.processed_days}/{job.total_missing_days} d</span>
                    </div>
                    <Progress value={pct} max={100} size="sm" colorScheme={job.failed_count > 0 ? 'orange' : 'blue'} />
                    <div className="mt-1 flex gap-3 text-xs">
                        <span className="text-green-600">{job.fetched_count} fetched</span>
                        {job.failed_count > 0 && <span className="text-red-600">{job.failed_count} failed</span>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PriceGapBulkFix;
