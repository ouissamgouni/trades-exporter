import React from 'react';
import { Button, Progress, Spinner } from './ui/primitives';
import { FiZap } from 'react-icons/fi';
import { useBackfillAllPriceGaps } from '../hooks/usePriceGaps';
import type { BackfillAllPriceGapsProgress } from '../hooks/usePriceGaps';
import { toaster } from './ui/toaster';

interface PriceGapBulkFixProps {
    quoteAssetId?: number | null;
    onComplete?: (progress: BackfillAllPriceGapsProgress) => void | Promise<void>;
    compact?: boolean;
}

export const PriceGapBulkFix: React.FC<PriceGapBulkFixProps> = ({
    quoteAssetId,
    onComplete,
    compact = false,
}) => {
    const { progress, progressPercent, isRunning, run } = useBackfillAllPriceGaps(quoteAssetId);
    const hasProgress = progress.status !== 'idle';

    const handleRun = async () => {
        try {
            const result = await run();
            if (result.totalRanges === 0) {
                toaster.info({ title: 'No gaps found', description: 'All transaction-backed assets are covered.' });
            } else if (result.failedCount > 0) {
                toaster.info({ title: 'Partial gap fix', description: `Fetched ${result.fetchedCount}, failed ${result.failedCount}` });
            } else {
                toaster.success({ title: 'All gaps fixed', description: `Fetched ${result.fetchedCount} price(s)` });
            }
            await onComplete?.(result);
        } catch (err) {
            toaster.error({ title: 'Gap fix failed', description: err instanceof Error ? err.message : 'Unknown error' });
        }
    };

    return (
        <div style={{ minWidth: compact ? '220px' : '280px', maxWidth: compact ? '100%' : '380px' }}>
            <div className={`flex items-center gap-2 ${compact ? 'justify-start' : 'justify-end'}`}>
                <Button
                    size={compact ? 'sm' : 'md'}
                    colorScheme="blue"
                    onClick={handleRun}
                    disabled={isRunning}
                >
                    {isRunning ? <Spinner size="xs" /> : <FiZap />}
                    <span>{isRunning ? 'Fixing gaps' : 'Fix all gaps'}</span>
                </Button>
            </div>

            {hasProgress && (
                <div className="mt-2">
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className={`truncate text-xs ${progress.status === 'error' ? 'text-red-600' : 'text-slate-600'}`}>
                            {progress.status === 'scanning'
                                ? 'Scanning transaction assets...'
                                : progress.status === 'running'
                                    ? `${progress.currentAssetSymbol ?? 'Asset'} · ${progress.currentRange ?? ''}`
                                    : progress.status === 'complete'
                                        ? 'Gap fix complete'
                                        : progress.error ?? 'Gap fix failed'}
                        </span>
                        <span className="whitespace-nowrap text-xs text-slate-500">
                            {progress.completedRanges}/{progress.totalRanges}
                        </span>
                    </div>
                    <Progress
                        value={progressPercent}
                        max={100}
                        size="sm"
                        colorScheme={progress.status === 'error' || progress.failedCount > 0 ? 'orange' : 'blue'}
                    />
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
                        <span>{progress.assetsWithGaps} asset{progress.assetsWithGaps !== 1 ? 's' : ''}</span>
                        <span>{progress.totalMissingDays} missing day{progress.totalMissingDays !== 1 ? 's' : ''}</span>
                        <span className="text-green-600">{progress.fetchedCount} fetched</span>
                        {progress.failedCount > 0 && <span className="text-red-600">{progress.failedCount} failed</span>}
                    </div>
                </div>
            )}
        </div>
    );
};

export default PriceGapBulkFix;
