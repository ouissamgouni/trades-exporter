import React, { useState } from 'react';
import { FiSquare, FiZap } from 'react-icons/fi';
import { Button, Progress, Spinner } from './ui/primitives';
import { useGapFixJob } from '../hooks/usePriceGaps';
import { formatRelativeTime } from '../utils/dateUtils';
import { toaster } from './ui/toaster';

export interface GapRecap {
    assets: number;
    ranges: number;
    days: number;
}

interface GapFixJobBarProps {
    fix: ReturnType<typeof useGapFixJob>;
    recap: GapRecap;
    recapLoading: boolean;
    /** null = all assets */
    scopeAssetIds: number[] | null;
    quoteAssetId?: number | null;
    leading?: React.ReactNode;
}

export const GapFixJobBar: React.FC<GapFixJobBarProps> = ({ fix, recap, recapLoading, scopeAssetIds, quoteAssetId, leading }) => {
    const { job, isActive, start, cancel } = fix;
    const [showLog, setShowLog] = useState(false);
    const hasJobResults = !!job && job.status !== 'idle';

    const handleStart = () => {
        start.mutate(
            { assetIds: scopeAssetIds, quoteAssetId },
            { onError: (err) => toaster.error({ title: 'Could not start gap fix', description: err.message }) },
        );
    };

    const progressPct = job && job.total_missing_days > 0 ? Math.round((job.processed_days / job.total_missing_days) * 100) : 0;
    const currentAsset = job?.current_asset_id != null ? job.assets.find(a => a.asset_id === job.current_asset_id) : undefined;
    const skippedCount = job ? job.assets.filter(a => a.status === 'skipped').length : 0;

    return (
        <div className="mb-2 space-y-2 border border-gray-100 bg-gray-50 p-3">
            <div className="flex flex-wrap items-center gap-3">
                {leading}
                <div className="text-xs text-slate-600">
                    {recapLoading ? (
                        <span className="inline-flex items-center gap-1"><Spinner size="xs" /> Scanning gaps…</span>
                    ) : recap.assets === 0 ? (
                        <span>No gaps found</span>
                    ) : (
                        <span>
                            <strong>{recap.ranges}</strong> gap range{recap.ranges !== 1 ? 's' : ''} · <strong>{recap.days}</strong> missing day{recap.days !== 1 ? 's' : ''} · <strong>{recap.assets}</strong> asset{recap.assets !== 1 ? 's' : ''}
                        </span>
                    )}
                </div>
                <div className="ml-auto flex items-center gap-2">
                    {isActive ? (
                        <Button size="sm" variant="outline" colorScheme="gray" onClick={() => cancel.mutate()} disabled={cancel.isPending} className="h-7 px-2 text-xs">
                            <FiSquare size={12} />
                            <span className="ml-1">Cancel</span>
                        </Button>
                    ) : (
                        <Button size="sm" colorScheme="blue" onClick={handleStart} disabled={recap.assets === 0 || start.isPending || recapLoading} className="h-7 px-2 text-xs">
                            {start.isPending ? <Spinner size="xs" /> : <FiZap size={12} />}
                            <span className="ml-1">Fix {recap.ranges} gap{recap.ranges !== 1 ? 's' : ''} ({recap.days} d)</span>
                        </Button>
                    )}
                </div>
            </div>

            {hasJobResults && job && (
                <div className={`border px-3 py-2 text-xs ${job.status === 'error' ? 'border-red-200 bg-red-50' : 'border-blue-100 bg-blue-50'}`}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="truncate text-slate-700">
                            {job.status === 'scanning' && 'Scanning assets for gaps…'}
                            {job.status === 'running' && (
                                <>Asset {Math.min(job.completed_assets + 1, job.total_assets)}/{job.total_assets}{currentAsset ? ` · ${currentAsset.label || currentAsset.symbol}` : ''}{job.current_date ? ` · ${job.current_date}` : ''}</>
                            )}
                            {job.status === 'complete' && `Finished ${job.finished_at ? formatRelativeTime(job.finished_at) : ''}`}
                            {job.status === 'cancelled' && 'Cancelled'}
                            {job.status === 'error' && <span className="text-red-700">{job.error}</span>}
                        </span>
                        <span className="whitespace-nowrap text-slate-500">{job.processed_days}/{job.total_missing_days} days</span>
                    </div>
                    <Progress value={progressPct} max={100} size="sm" colorScheme={job.failed_count > 0 ? 'orange' : 'blue'} />
                    <div className="mt-1 flex flex-wrap gap-3 text-slate-600">
                        <span className="text-green-700">{job.fetched_count} fetched</span>
                        {job.failed_count > 0 && <span className="text-red-700">{job.failed_count} failed</span>}
                        {skippedCount > 0 && <span className="text-orange-700">{skippedCount} asset(s) skipped</span>}
                        {job.log.length > 0 && (
                            <button type="button" className="ml-auto text-blue-700 underline" onClick={() => setShowLog(v => !v)}>
                                {showLog ? 'Hide log' : `Show log (${job.log.length})`}
                            </button>
                        )}
                    </div>
                    {showLog && (
                        <div className="mt-2 max-h-[160px] overflow-y-auto border border-slate-200 bg-white p-2 font-mono text-[10px]">
                            {[...job.log].reverse().map((l, i) => (
                                <div key={i} className={l.level === 'warning' ? 'text-orange-700' : l.level === 'error' ? 'text-red-700' : 'text-slate-600'}>
                                    {new Date(l.ts).toLocaleTimeString()} {l.message}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default GapFixJobBar;
