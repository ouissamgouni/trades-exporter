/**
 * GapFixJobInline — compact progress + log of the shared price-fetch job, optionally focused on one asset.
 * Every price fetch (one gap, all gaps, an asset, all assets) runs through that single job.
 */
import React, { useState } from 'react';
import { FiSquare } from 'react-icons/fi';
import { Button, Progress, Spinner } from './ui/primitives';
import { useGapFixJob } from '../hooks/usePriceGaps';

interface GapFixJobInlineProps {
    /** Only show the job when it touches this asset; its row and log lines are highlighted */
    assetId?: number;
    className?: string;
}

const STATUS_TEXT: Record<string, string> = {
    pending: 'queued',
    running: 'fetching…',
    done: 'done',
    partial: 'partially fetched',
    failed: 'failed',
    skipped: 'stopped',
    cancelled: 'cancelled',
};

export const GapFixJobInline: React.FC<GapFixJobInlineProps> = ({ assetId, className }) => {
    const { job, isActive, cancel } = useGapFixJob();
    const [showLog, setShowLog] = useState(false);
    if (!job || job.status === 'idle') return null;
    const row = assetId != null ? job.assets.find(a => a.asset_id === assetId) : undefined;
    const inScope = assetId == null || row != null || (isActive && (job.scope_asset_ids == null || job.scope_asset_ids.includes(assetId)));
    if (!inScope) return null;

    const pct = job.total_missing_days > 0 ? Math.round((job.processed_days / job.total_missing_days) * 100) : isActive ? 0 : 100;
    const log = (assetId != null ? job.log.filter(l => l.asset_id === assetId || l.asset_id == null) : job.log).slice(-30);

    return (
        <div className={`border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-[11px] text-slate-700 ${className ?? ''}`} data-testid="gap-fix-job-inline">
            <div className="flex flex-wrap items-center gap-2">
                {isActive && <Spinner size="xs" />}
                <span className="font-semibold">
                    {job.status === 'scanning' ? 'Scanning gaps…' : isActive ? `Fetching prices · ${pct}%` : `Price fetch ${job.status}`}
                </span>
                <span className="text-slate-500">
                    {job.completed_assets}/{job.total_assets} asset{job.total_assets === 1 ? '' : 's'} · {job.fetched_count} fetched · {job.failed_count} failed
                    {(job.queued_requests ?? 0) > 0 && ` · ${job.queued_requests} queued`}
                </span>
                {row && (
                    <span className="border border-slate-200 bg-white px-1.5">
                        This asset: {STATUS_TEXT[row.status] ?? row.status} · {row.fetched}/{row.missing_days}{row.note ? ` · ${row.note}` : ''}
                    </span>
                )}
                <span className="ml-auto flex items-center gap-1">
                    <button type="button" onClick={() => setShowLog(v => !v)} className="text-blue-700 hover:underline">
                        {showLog ? 'Hide log' : 'Log'}
                    </button>
                    {isActive && (
                        <Button size="xs" variant="outline" colorScheme="gray" onClick={() => cancel.mutate()} disabled={cancel.isPending} className="h-5 px-1.5 text-[10px]">
                            <FiSquare size={10} /> <span className="ml-0.5">Cancel</span>
                        </Button>
                    )}
                </span>
            </div>
            {isActive && <Progress value={pct} className="mt-1 h-1" />}
            {showLog && (
                <div className="mt-1 max-h-[160px] overflow-y-auto border border-slate-200 bg-white p-1.5 font-mono text-[10px]">
                    {log.length === 0 ? <span className="text-slate-400">No log entries.</span> : log.map((l, i) => (
                        <div key={i} className={l.level === 'warning' ? 'text-orange-700' : l.level === 'error' ? 'text-red-700' : 'text-slate-600'}>
                            {l.ts.slice(11, 19)} {l.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export default GapFixJobInline;
