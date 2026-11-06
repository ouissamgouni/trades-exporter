import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Progress, Spinner, type BadgeColorScheme } from '../ui/primitives';
import { FiArrowDown, FiArrowUp, FiChevronDown, FiSkipForward, FiSquare, FiZap } from 'react-icons/fi';
import type { GapFixAssetStatus, GapFixJobAsset, GapFixJobState } from '../../types';
import { usePriceGapsSummary, useGapFixJob } from '../../hooks/usePriceGaps';
import { formatRelativeTime } from '../../utils/dateUtils';
import { toaster } from '../ui/toaster';
import { GapFixPanel } from '../GapFixPanel';
import { AssetNameCell } from './AssetNameCell';

interface PriceGapsTabProps {
    pnlAssetIds: number[];
    quoteAssetId?: number | null;
    focusAssetId?: number | null;
    pnlVersionId?: number;
    onJobFinished?: (job: GapFixJobState) => void;
}

type Scope = 'pnl' | 'all';

interface GapRow {
    asset_id: number;
    symbol: string;
    label?: string | null;
    gap_count: number;
    missing_days: number;
    job?: GapFixJobAsset;
}

const JOB_STATUS_META: Record<GapFixAssetStatus, { label: string; scheme: BadgeColorScheme }> = {
    pending: { label: 'Queued', scheme: 'gray' },
    running: { label: 'Fetching', scheme: 'blue' },
    done: { label: 'Fixed', scheme: 'green' },
    partial: { label: 'Partial', scheme: 'orange' },
    failed: { label: 'Failed', scheme: 'red' },
    skipped: { label: 'Skipped', scheme: 'orange' },
    cancelled: { label: 'Cancelled', scheme: 'gray' },
};

export const PriceGapsTab: React.FC<PriceGapsTabProps> = ({ pnlAssetIds, quoteAssetId, focusAssetId, pnlVersionId, onJobFinished }) => {
    const [scope, setScope] = useState<Scope>('pnl');
    const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
    const [expandedId, setExpandedId] = useState<number | null>(focusAssetId ?? null);
    const [showLog, setShowLog] = useState(false);
    const focusRef = useRef<HTMLTableRowElement | null>(null);

    const { data: summary, isLoading: summaryLoading } = usePriceGapsSummary(scope === 'pnl' ? pnlAssetIds : null);
    const { job, isActive, start, cancel, skip } = useGapFixJob((finished) => {
        const msg = `${finished.fetched_count} fetched, ${finished.failed_count} failed`;
        if (finished.status === 'complete') toaster.success({ title: 'Gap fix complete', description: msg });
        else if (finished.status === 'cancelled') toaster.info({ title: 'Gap fix cancelled', description: msg });
        else if (finished.status === 'error') toaster.error({ title: 'Gap fix failed', description: finished.error ?? msg });
        onJobFinished?.(finished);
    });

    useEffect(() => {
        if (focusAssetId != null) {
            setScope('pnl');
            setExpandedId(focusAssetId);
        }
    }, [focusAssetId]);

    useEffect(() => {
        focusRef.current?.scrollIntoView({ block: 'center' });
    }, [focusAssetId, summary]);

    const jobById = useMemo(() => new Map((job?.assets ?? []).map(a => [a.asset_id, a])), [job]);
    const hasJobResults = !!job && job.status !== 'idle';

    const rows: GapRow[] = useMemo(() => {
        const byId = new Map<number, GapRow>();
        for (const i of summary?.items ?? []) {
            byId.set(i.asset_id, { asset_id: i.asset_id, symbol: i.symbol, label: i.label, gap_count: i.gap_count, missing_days: i.total_missing_days, job: jobById.get(i.asset_id) });
        }
        // Keep job rows visible after their gaps are fixed (they drop out of the summary)
        for (const a of job?.assets ?? []) {
            if (!byId.has(a.asset_id) && (scope === 'all' || pnlAssetIds.includes(a.asset_id))) {
                byId.set(a.asset_id, { asset_id: a.asset_id, symbol: a.symbol, label: a.label, gap_count: a.gap_count, missing_days: a.missing_days, job: a });
            }
        }
        return [...byId.values()].sort((x, y) => (sortDir === 'desc' ? y.missing_days - x.missing_days : x.missing_days - y.missing_days));
    }, [summary, job, jobById, scope, pnlAssetIds, sortDir]);

    const recap = useMemo(() => {
        const items = summary?.items ?? [];
        return {
            assets: items.length,
            ranges: items.reduce((s, i) => s + i.gap_count, 0),
            days: items.reduce((s, i) => s + i.total_missing_days, 0),
        };
    }, [summary]);

    const handleStart = () => {
        start.mutate(
            { assetIds: scope === 'pnl' ? pnlAssetIds : null, quoteAssetId },
            { onError: (err) => toaster.error({ title: 'Could not start gap fix', description: err.message }) },
        );
    };

    const progressPct = job && job.total_missing_days > 0 ? Math.round((job.processed_days / job.total_missing_days) * 100) : 0;
    const currentAsset = job?.current_asset_id != null ? jobById.get(job.current_asset_id) : undefined;

    return (
        <div className="flex h-full flex-col">
            <div className="space-y-3 border-b border-gray-100 bg-gray-50 p-4">
                <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex border border-slate-200" role="group" aria-label="Gap scope">
                        {(['pnl', 'all'] as Scope[]).map(s => (
                            <button
                                key={s}
                                type="button"
                                onClick={() => setScope(s)}
                                disabled={isActive}
                                className={`px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${scope === s ? 'border-blue-500 bg-blue-500 text-white' : 'bg-white text-slate-700 hover:bg-slate-50'}`}
                            >
                                {s === 'pnl' ? 'This P&L' : 'All assets'}
                            </button>
                        ))}
                    </div>
                    <div className="text-xs text-slate-600">
                        {summaryLoading ? (
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
                            <Button size="sm" colorScheme="blue" onClick={handleStart} disabled={recap.assets === 0 || start.isPending || summaryLoading} className="h-7 px-2 text-xs">
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
                            {job.assets.filter(a => a.status === 'skipped').length > 0 && (
                                <span className="text-orange-700">{job.assets.filter(a => a.status === 'skipped').length} asset(s) skipped</span>
                            )}
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

            <div className="flex-1 overflow-y-auto">
                {rows.length === 0 ? (
                    <div className="flex h-[200px] items-center justify-center text-sm text-gray-400">
                        {summaryLoading ? 'Loading…' : 'No price gaps 🎉'}
                    </div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 z-[1] bg-white text-left text-gray-500">
                            <tr className="border-b border-gray-100">
                                <th className="py-2 pl-3">Asset</th>
                                <th className="py-2">Ranges</th>
                                <th className="py-2">
                                    <button type="button" onClick={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))} className="inline-flex items-center gap-1 hover:text-blue-600" aria-label="Sort by missing days">
                                        Missing days {sortDir === 'desc' ? <FiArrowDown size={11} /> : <FiArrowUp size={11} />}
                                    </button>
                                </th>
                                <th className="py-2">Fix status</th>
                                <th className="w-[60px] py-2 pr-3"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => {
                                const isFocus = r.asset_id === focusAssetId;
                                const isExpanded = expandedId === r.asset_id;
                                const meta = r.job ? JOB_STATUS_META[r.job.status] : null;
                                const canSkip = isActive && r.job && (r.job.status === 'pending' || r.job.status === 'running');
                                return (
                                    <React.Fragment key={r.asset_id}>
                                        <tr
                                            ref={isFocus ? focusRef : undefined}
                                            onClick={() => setExpandedId(isExpanded ? null : r.asset_id)}
                                            className={`cursor-pointer border-b border-gray-50 ${isFocus ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                                        >
                                            <td className="max-w-[280px] py-1.5 pl-3">
                                                <AssetNameCell id={r.asset_id} symbol={r.symbol} label={r.label} pnlVersionId={pnlVersionId} />
                                            </td>
                                            <td className="py-1.5">{r.gap_count}</td>
                                            <td className="py-1.5 font-medium">{r.missing_days}</td>
                                            <td className="py-1.5">
                                                {meta ? (
                                                    <div className="flex flex-wrap items-center gap-1">
                                                        <Badge colorScheme={meta.scheme}>
                                                            {r.job!.status === 'running' && <Spinner size="xs" className="mr-1" />}
                                                            {meta.label}
                                                        </Badge>
                                                        {(r.job!.fetched > 0 || r.job!.failed > 0) && (
                                                            <span className="text-gray-500">
                                                                <span className="text-green-700">{r.job!.fetched}</span> / <span className="text-red-700">{r.job!.failed}</span>
                                                            </span>
                                                        )}
                                                        {(r.job!.note || r.job!.last_error) && (
                                                            <span className="max-w-[220px] truncate text-orange-700" title={[r.job!.note, r.job!.last_error].filter(Boolean).join(' — ')}>
                                                                {r.job!.note ?? r.job!.last_error}
                                                            </span>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <span className="text-gray-300">—</span>
                                                )}
                                            </td>
                                            <td className="py-1.5 pr-3">
                                                <div className="flex items-center justify-end gap-0.5">
                                                    {canSkip && (
                                                        <button type="button" aria-label={`Skip ${r.label || r.symbol}`} title="Skip this asset" onClick={(e) => { e.stopPropagation(); skip.mutate(r.asset_id); }} className="p-1 text-gray-500 hover:bg-orange-50 hover:text-orange-600">
                                                            <FiSkipForward size={12} />
                                                        </button>
                                                    )}
                                                    <button type="button" aria-label={isExpanded ? 'Collapse gap details' : 'Expand gap details'} onClick={(e) => { e.stopPropagation(); setExpandedId(isExpanded ? null : r.asset_id); }} className="p-1 text-gray-500 hover:bg-gray-100">
                                                        <span className={`inline-block transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}><FiChevronDown size={12} /></span>
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                        {isExpanded && (
                                            <tr>
                                                <td colSpan={5} className="bg-gray-50 p-3">
                                                    <GapFixPanel assetId={r.asset_id} symbol={r.symbol} />
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
};
