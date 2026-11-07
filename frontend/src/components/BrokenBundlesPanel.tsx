/**
 * BrokenBundlesPanel
 *
 * Confirmed bundles that are empty or lost one side (e.g. a transfer whose
 * destination leg was deleted by a connector reset). Suggests standalone
 * transactions that would complete them and offers to delete empty bundles.
 */

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LuLocateFixed, LuPackageX, LuPlus } from 'react-icons/lu';
import { API_URL } from '../types';
import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';
import { toaster } from './ui/toaster';
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

export const BROKEN_BUNDLES_QUERY_KEY = ['brokenBundles'];

export const BrokenBundlesPanel: React.FC<{ onFixed?: () => void }> = ({ onFixed }) => {
    const queryClient = useQueryClient();
    const showInAllTransactions = useShowInAllTransactions();
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const { data: bundles = [], isLoading } = useQuery<BrokenBundle[]>({
        queryKey: BROKEN_BUNDLES_QUERY_KEY,
        queryFn: async () => {
            const res = await fetch(`${API_URL}/bundles/broken`);
            if (!res.ok) throw new Error('Failed to load broken bundles');
            return res.json();
        },
    });

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

    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-600">
                Confirmed bundles that are empty or lost one of their sides — usually because a connector reset
                re-created the transactions with new IDs. Re-attach the matching transaction, or delete empty bundles.
            </p>
            {bundles.map(b => {
                const issue = ISSUE_LABEL[b.issue];
                return (
                    <div key={b.bundle_id} className="border border-slate-200 bg-white p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">📦 Bundle #{b.bundle_id}</span>
                            {b.label && <span className="text-slate-600">{b.label}</span>}
                            {b.pattern && <Badge colorScheme="purple" className="text-[10px]">{b.pattern.replace(/_/g, ' ')}</Badge>}
                            <Badge colorScheme={issue.color} className="text-[10px]">{issue.label}</Badge>
                            {b.transaction_ids.length > 0 && (
                                <span className="text-slate-500">
                                    contains{' '}
                                    {b.transaction_ids.map(id => (
                                        <button
                                            key={id}
                                            type="button"
                                            className="mr-1 font-mono text-blue-600 hover:underline"
                                            title="Show in context"
                                            onClick={() => showInAllTransactions(id)}
                                        >
                                            #{id}
                                        </button>
                                    ))}
                                </span>
                            )}
                            {b.issue === 'empty' && (
                                <Button
                                    variant="outline"
                                    className="ml-auto h-6 gap-1 px-2 text-xs"
                                    disabled={busyKey !== null}
                                    onClick={() => deleteBundle(b.bundle_id)}
                                >
                                    {busyKey === `delete-${b.bundle_id}` ? <Spinner size="xs" /> : <LuPackageX size={12} />}
                                    Delete empty bundle
                                </Button>
                            )}
                        </div>

                        {b.issue !== 'empty' && (
                            b.candidates.length === 0 ? (
                                <div className="mt-1 text-slate-500">
                                    No matching standalone transaction found (same asset, opposite direction, other account, within 24h).
                                </div>
                            ) : (
                                <ul className="mt-1 flex flex-col gap-1">
                                    {b.candidates.map(c => (
                                        <li key={c.transaction_id} className="flex flex-wrap items-center gap-2 bg-blue-50 px-2 py-1">
                                            <span className="font-mono">#{c.transaction_id}</span>
                                            <span>{c.account_name ?? '—'}</span>
                                            <span className="tabular-nums">{c.quantity} {c.asset_symbol}</span>
                                            <span className="text-slate-500">{c.date_time ? formatDateTimeCompact(c.date_time) : ''}</span>
                                            <span className="text-slate-500">{c.reason}</span>
                                            <Badge colorScheme={c.confidence >= 0.9 ? 'green' : 'yellow'} className="text-[10px]">
                                                {Math.round(c.confidence * 100)}%
                                            </Badge>
                                            <button
                                                type="button"
                                                className="text-blue-600 hover:text-blue-800"
                                                title="Show in context"
                                                aria-label={`Show #${c.transaction_id} in context`}
                                                onClick={() => showInAllTransactions(c.transaction_id, c.date_time)}
                                            >
                                                <LuLocateFixed size={12} />
                                            </button>
                                            <Button
                                                className="ml-auto h-6 gap-1 bg-blue-500 px-2 text-xs text-white hover:bg-blue-600"
                                                disabled={busyKey !== null}
                                                onClick={() => addToBundle(b.bundle_id, c.transaction_id)}
                                            >
                                                {busyKey === `add-${b.bundle_id}-${c.transaction_id}` ? <Spinner size="xs" /> : <LuPlus size={12} />}
                                                Add #{c.transaction_id} to bundle #{b.bundle_id}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            )
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default BrokenBundlesPanel;
