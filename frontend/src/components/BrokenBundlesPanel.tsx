/**
 * BrokenBundlesPanel
 *
 * Confirmed bundles that are empty or lost one side (e.g. a transfer whose
 * destination leg was deleted by a connector reset). Uses the same card grid and
 * pagination as the bundles listing, shows only broken bundles, and offers
 * completion candidates or deletion of empty bundles.
 */

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LuLocateFixed, LuPackageX, LuPlus, LuRefreshCw, LuTriangleAlert } from 'react-icons/lu';
import { API_URL } from '../types';
import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';
import { toaster } from './ui/toaster';
import { PaginationBar } from './BundleTable';
import { useShowInAllTransactions } from '../hooks/useShowInAllTransactions';
import { formatDateTimeCompact } from '../utils/dateUtils';

interface CompletionCandidate {
    transaction_id: number;
    date_time: string | null;
    account_id: number | null;
    account_name: string | null;
    asset_symbol: string;
    quantity: number;
    confidence: number;
    reason: string;
}

interface BrokenBundle {
    bundle_id: number;
    label: string | null;
    pattern: string | null;
    created_at: string | null;
    issue: 'empty' | 'missing_inflow' | 'missing_outflow';
    transaction_ids: number[];
    candidates: CompletionCandidate[];
}

const ISSUE_LABEL: Record<BrokenBundle['issue'], { label: string; color: BadgeColorScheme }> = {
    empty: { label: 'Empty', color: 'gray' },
    missing_inflow: { label: 'Missing incoming side', color: 'orange' },
    missing_outflow: { label: 'Missing outgoing side', color: 'orange' },
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export const BROKEN_BUNDLES_QUERY_KEY = ['brokenBundles'];

export function useBrokenBundles() {
    return useQuery<BrokenBundle[]>({
        queryKey: BROKEN_BUNDLES_QUERY_KEY,
        queryFn: async () => {
            const res = await fetch(`${API_URL}/bundles/broken`);
            if (!res.ok) throw new Error('Failed to load broken bundles');
            return res.json();
        },
        staleTime: 30_000,
    });
}

/** Broken bundles that have at least one standalone transaction able to complete them. */
export function useCompletableBundleCount(): number {
    const { data = [] } = useBrokenBundles();
    return data.filter(b => b.candidates.length > 0).length;
}

interface BrokenBundlesPanelProps {
    onFixed?: () => void;
    /** Only list bundles with completion candidates; renders nothing when there are none (Bundles tab). */
    onlyCompletable?: boolean;
}

export const BrokenBundlesPanel: React.FC<BrokenBundlesPanelProps> = ({ onFixed, onlyCompletable = false }) => {
    const queryClient = useQueryClient();
    const showInAllTransactions = useShowInAllTransactions();
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [pageSize, setPageSize] = useState(10);
    const [page, setPage] = useState(0); // 0-indexed

    const { data: allBundles = [], isLoading } = useBrokenBundles();
    const bundles = onlyCompletable ? allBundles.filter(b => b.candidates.length > 0) : allBundles;

    const refresh = () => {
        queryClient.invalidateQueries({ queryKey: BROKEN_BUNDLES_QUERY_KEY });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
        onFixed?.();
    };

    const addToBundle = async (bundleId: number, txId: number) => {
        setBusyKey(`add-${bundleId}-${txId}`);
        try {
            const res = await fetch(`${API_URL}/bundles/${bundleId}/add-transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: [txId] }),
            });
            const data = res.ok ? await res.json() : null;
            if (!data?.added_count) throw new Error(`#${txId} could not be added (already in a bundle?)`);
            toaster.create({ title: `Added #${txId} to bundle #${bundleId}`, type: 'success' });
            refresh();
        } catch (err) {
            toaster.create({ title: err instanceof Error ? err.message : 'Failed to add transaction', type: 'error' });
        } finally {
            setBusyKey(null);
        }
    };

    const deleteBundle = async (bundleId: number) => {
        setBusyKey(`delete-${bundleId}`);
        try {
            const res = await fetch(`${API_URL}/bundles/${bundleId}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to delete bundle');
            toaster.create({ title: `Deleted empty bundle #${bundleId}`, type: 'success' });
            refresh();
        } catch (err) {
            toaster.create({ title: err instanceof Error ? err.message : 'Failed to delete bundle', type: 'error' });
        } finally {
            setBusyKey(null);
        }
    };

    if (onlyCompletable && bundles.length === 0) return null;
    if (isLoading) {
        return <div className="flex justify-center py-8"><Spinner size="md" /></div>;
    }
    if (bundles.length === 0) {
        return (
            <div className="bg-green-50 p-6 text-center">
                <span className="font-medium text-green-600">✓ No broken bundles</span>
            </div>
        );
    }

    const totalPages = Math.max(1, Math.ceil(bundles.length / pageSize));
    const safePage = Math.min(page, totalPages - 1);
    const pagedBundles = bundles.slice(safePage * pageSize, (safePage + 1) * pageSize);
    const rangeStart = safePage * pageSize + 1;
    const rangeEnd = Math.min((safePage + 1) * pageSize, bundles.length);
    const emptyCount = bundles.filter(b => b.issue === 'empty').length;

    const handlePageSize = (size: number) => {
        setPageSize(size);
        setPage(0);
    };

    return (
        <div className="flex flex-col gap-3">
            {/* Data Health CTA */}
            <div className="flex flex-wrap items-start justify-between gap-3 border border-orange-200 bg-orange-50 p-3">
                <div className="flex min-w-0 items-start gap-2">
                    <LuTriangleAlert size={16} className="mt-0.5 shrink-0 text-orange-600" />
                    <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-semibold text-orange-900">
                            {onlyCompletable
                                ? `💡 ${bundles.length} bundle${bundles.length !== 1 ? 's' : ''} can be completed`
                                : `${bundles.length} broken bundle${bundles.length !== 1 ? 's' : ''}`}
                            {emptyCount > 0 && <span className="font-normal text-orange-800"> · {emptyCount} empty</span>}
                        </span>
                        <p className="text-xs text-orange-900">
                            {onlyCompletable
                                ? 'These confirmed bundles miss one side, and a standalone transaction matches it (same asset, opposite direction, other account, within 24h).'
                                : 'Confirmed bundles that are empty or lost one of their sides, usually because a connector reset re-created the transactions with new IDs. Re-attach the matching transaction, or delete empty bundles.'}
                        </p>
                    </div>
                </div>
                <Button variant="outline" size="sm" onClick={refresh} disabled={busyKey !== null}>
                    <LuRefreshCw size={12} />
                    <span className="ml-1">Refresh</span>
                </Button>
            </div>

            <PaginationBar
                page={safePage}
                setPage={setPage}
                pageSize={pageSize}
                setPageSize={(value: React.SetStateAction<number>) => {
                    const next = typeof value === 'function' ? value(pageSize) : value;
                    handlePageSize(next);
                }}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                totalItems={bundles.length}
                totalPages={totalPages}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                className="mb-1"
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                {pagedBundles.map(b => {
                    const issue = ISSUE_LABEL[b.issue];
                    return (
                        <div
                            key={b.bundle_id}
                            className="flex flex-col gap-2 border border-slate-200 bg-white p-3 text-xs shadow-sm transition-colors hover:border-orange-200 hover:shadow-md"
                        >
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-sm font-semibold">📦 #{b.bundle_id}</span>
                                <Badge colorScheme={issue.color} className="text-[10px]">{issue.label}</Badge>
                                {b.pattern && (
                                    <Badge colorScheme="purple" className="text-[10px]">{b.pattern.replace(/_/g, ' ')}</Badge>
                                )}
                            </div>

                            {b.label && <span className="truncate text-[11px] font-medium" title={b.label}>{b.label}</span>}

                            {b.transaction_ids.length > 0 && (
                                <div className="flex flex-wrap items-center gap-x-1 text-[10px] text-slate-500">
                                    <span>contains</span>
                                    {b.transaction_ids.map(id => (
                                        <button
                                            key={id}
                                            type="button"
                                            className="font-mono text-blue-600 hover:underline"
                                            title="Show in context"
                                            onClick={() => showInAllTransactions(id)}
                                        >
                                            #{id}
                                        </button>
                                    ))}
                                </div>
                            )}

                            {b.issue === 'empty' ? (
                                <Button
                                    variant="outline"
                                    className="mt-auto h-6 w-full gap-1 px-2 text-xs"
                                    disabled={busyKey !== null}
                                    onClick={() => deleteBundle(b.bundle_id)}
                                >
                                    {busyKey === `delete-${b.bundle_id}` ? <Spinner size="xs" /> : <LuPackageX size={12} />}
                                    Delete empty bundle
                                </Button>
                            ) : b.candidates.length === 0 ? (
                                <div className="mt-auto text-[10px] text-slate-500">
                                    No matching standalone transaction found (same asset, opposite direction, other account, within 24h).
                                </div>
                            ) : (
                                <ul className="mt-auto flex flex-col gap-1.5">
                                    {b.candidates.map(c => (
                                        <li key={c.transaction_id} className="flex flex-col gap-1 bg-blue-50 p-2">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                                <span className="font-mono">#{c.transaction_id}</span>
                                                <span className="tabular-nums">{c.quantity} {c.asset_symbol}</span>
                                                <Badge colorScheme={c.confidence >= 0.9 ? 'green' : 'yellow'} className="text-[10px]">
                                                    {Math.round(c.confidence * 100)}%
                                                </Badge>
                                                <button
                                                    type="button"
                                                    className="ml-auto text-blue-600 hover:text-blue-800"
                                                    title="Show in context"
                                                    aria-label={`Show #${c.transaction_id} in context`}
                                                    onClick={() => showInAllTransactions(c.transaction_id, c.date_time)}
                                                >
                                                    <LuLocateFixed size={12} />
                                                </button>
                                            </div>
                                            <div className="text-[10px] text-slate-600">
                                                {c.account_name ?? '—'}
                                                {c.date_time ? ` · ${formatDateTimeCompact(c.date_time)}` : ''}
                                            </div>
                                            <div className="text-[10px] text-slate-500">{c.reason}</div>
                                            <Button
                                                className="h-6 w-full gap-1 bg-blue-500 px-2 text-xs text-white hover:bg-blue-600"
                                                disabled={busyKey !== null}
                                                onClick={() => addToBundle(b.bundle_id, c.transaction_id)}
                                            >
                                                {busyKey === `add-${b.bundle_id}-${c.transaction_id}` ? <Spinner size="xs" /> : <LuPlus size={12} />}
                                                Add #{c.transaction_id} to bundle #{b.bundle_id}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    );
                })}
            </div>

            <PaginationBar
                page={safePage}
                setPage={setPage}
                pageSize={pageSize}
                setPageSize={(value: React.SetStateAction<number>) => {
                    const next = typeof value === 'function' ? value(pageSize) : value;
                    handlePageSize(next);
                }}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                totalItems={bundles.length}
                totalPages={totalPages}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                className="mt-1"
            />
        </div>
    );
};
