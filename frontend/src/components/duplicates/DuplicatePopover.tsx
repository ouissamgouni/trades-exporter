/**
 * DuplicatePopover
 *
 * Popover displaying duplicate group details for a transaction.
 * Lazy-fetches full transaction details on open, then shows them
 * in the same badge-based card layout with checkbox selection and
 * Keep Selected / Dismiss Selected actions as the Data Health panel.
 */

import React, { useCallback, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { Badge, Button, Spinner } from '../ui/primitives';
import { FiCheck, FiX } from 'react-icons/fi';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, TransactionSummary } from '../../types';
import { toaster } from '../ui/toaster';
import { DuplicateGroupTransactionsTable } from '../tables/wrappers/DuplicateGroupTransactionsTable';

/** Extended TransactionSummary with duplicate resolution fields from API */
interface DuplicateTransactionSummary extends TransactionSummary {
    dup_resolved?: boolean;
    dup_resolution?: string;
    dup_resolved_at?: string;
    connector_type?: string;
    run_id?: number;
    source_asset_symbol: string;
    source_price_quote_asset_symbol?: string;
    review_status?: string;
    tags?: any[];
    synced_at?: string;
    kept_tx_ids?: number[];
}

interface ConnectorBreakdown {
    connector_type: string;
    run_id: number | null;
    count: number;
    transaction_ids: number[];
}

interface DuplicatePopoverProps {
    /** Group hash for this duplicate group */
    groupHash: string;
    /** All transaction IDs in this group (from the suspicion map) */
    transactionIds: number[];
    /** Human-readable match criteria */
    matchCriteria: string;
    /** Whether the popover is open (controlled) */
    open: boolean;
    /** Callback for open state change */
    onOpenChange: (open: boolean) => void;
    /** Callback when a transaction is clicked (e.g., open detail drawer) */
    onTransactionClick?: (txId: number) => void;
    /** The trigger element */
    children: React.ReactNode;
}

interface DuplicateGroupDetail {
    group_hash: string;
    transaction_count: number;
    transactions: DuplicateTransactionSummary[];
    match_criteria: string;
    connector_breakdown: ConnectorBreakdown[];
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export const DuplicatePopover: React.FC<DuplicatePopoverProps> = ({
    groupHash,
    transactionIds,
    matchCriteria,
    open,
    onOpenChange,
    onTransactionClick,
    children,
}) => {
    const queryClient = useQueryClient();
    const [groupDetail, setGroupDetail] = useState<DuplicateGroupDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [resolving, setResolving] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    // preselectIds + tableKey: changing tableKey remounts the table so smart suggestions take effect
    const [preselectIds, setPreselectIds] = useState<number[] | undefined>(undefined);
    const [tableKey, setTableKey] = useState(0);

    const fetchGroupDetail = useCallback(async () => {
        if (groupDetail) return; // already fetched
        setLoading(true);
        try {
            const response = await fetch(`${API_URL}/data-health/duplicate-groups`);
            if (!response.ok) throw new Error('Failed to fetch duplicate groups');
            const data = await response.json();

            const group = data.groups?.find(
                (g: DuplicateGroupDetail) => g.group_hash === groupHash
            );
            if (group) {
                setGroupDetail(group);
            }
        } catch (err) {
            console.error('Failed to fetch duplicate group details:', err);
        } finally {
            setLoading(false);
        }
    }, [groupHash, groupDetail]);

    const handleOpenChange = (nextOpen: boolean) => {
        onOpenChange(nextOpen);
        if (nextOpen) {
            fetchGroupDetail();
        } else {
            setSelectedIds(new Set()); // reset selection on close
            setPreselectIds(undefined);
            setTableKey(0);
        }
    };

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectAllFromConnector = (breakdown: ConnectorBreakdown) => {
        const ids = breakdown.transaction_ids;
        setPreselectIds(ids);
        setTableKey(k => k + 1);
    };

    const handleResolve = async (action: 'keep_selected' | 'dismiss_selected') => {
        if (selectedIds.size === 0) {
            toaster.create({
                title: 'No transactions selected',
                description: 'Please select at least one transaction',
                type: 'warning',
            });
            return;
        }

        setResolving(true);
        try {
            const res = await fetch(`${API_URL}/data-health/resolve-duplicate-group`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    group_hash: groupHash,
                    action,
                    selected_transaction_ids: Array.from(selectedIds),
                    all_transaction_ids: transactionIds,
                }),
            });

            if (!res.ok) {
                const error = await res.json();
                throw new Error(error.detail || 'Failed to resolve duplicate group');
            }

            toaster.success({
                title: 'Duplicate resolved',
                description: `${action === 'keep_selected' ? 'Kept' : 'Dismissed'} ${selectedIds.size} transaction(s)`,
            });

            // Invalidate related queries
            queryClient.invalidateQueries({ queryKey: ['duplicateSuspicions'] });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['filterOptions'] });

            onOpenChange(false);
            setGroupDetail(null);
            setSelectedIds(new Set());
            setPreselectIds(undefined);
            setTableKey(0);
        } catch (err) {
            console.error('Resolve error:', err);
            toaster.error({
                title: 'Resolution failed',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setResolving(false);
        }
    };

    const transactions = groupDetail?.transactions ?? [];
    const unresolvedTxs = transactions.filter(tx => !tx.dup_resolved);
    const allResolved = transactions.length > 0 && unresolvedTxs.length === 0;

    // Summary from the first transaction
    const firstTx = transactions[0];
    const connectorBreakdown = groupDetail?.connector_breakdown ?? [];
    const sourceCount = connectorBreakdown.length;

    return (
        <RadixPopover.Root open={open} onOpenChange={handleOpenChange}>
            <RadixPopover.Trigger asChild>
                {children}
            </RadixPopover.Trigger>
            <RadixPopover.Portal>
                <RadixPopover.Content
                    side="right"
                    align="start"
                    sideOffset={4}
                    className={`w-[840px] border bg-white p-0 shadow-lg ${allResolved ? 'border-green-300' : 'border-orange-200'}`}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                    <RadixPopover.Arrow className="fill-white" />

                    {/* Header – badge row matching DuplicateGroupRow */}
                    <div className={`border-b p-2 ${allResolved ? 'border-green-200 bg-green-50' : 'border-orange-100 bg-orange-50'}`}>
                        <div className="flex items-center justify-between">
                            <div className="flex flex-1 flex-wrap items-center gap-1">
                                {allResolved && (
                                    <Badge colorScheme="green" className="px-1.5 py-0.5 text-[10px]">
                                        ✓ Resolved
                                    </Badge>
                                )}
                                {loading || !firstTx ? (
                                    <>
                                        <Badge colorScheme="orange" className="px-1.5 py-0.5 text-[10px]">
                                            {transactionIds.length} Duplicates
                                        </Badge>
                                        <Badge colorScheme="gray" className="font-mono text-[10px]">
                                            {groupHash.substring(0, 8)}
                                        </Badge>
                                    </>
                                ) : (
                                    <>
                                        <Badge colorScheme="orange" className="px-1.5 py-0.5 text-[10px]">
                                            {transactions.length} Duplicates
                                        </Badge>
                                        <Badge colorScheme="purple" className="text-[10px]">
                                            {firstTx.source_asset_symbol}/{firstTx.source_price_quote_asset_symbol}
                                        </Badge>
                                        {firstTx.direction && (
                                            <Badge
                                                colorScheme={firstTx.direction === 'inflow' ? 'green' : 'red'}
                                                className="text-[10px]"
                                            >
                                                {firstTx.direction}
                                            </Badge>
                                        )}
                                        <Badge colorScheme="gray" className="bg-teal-100 text-[10px] text-teal-700">
                                            {firstTx.quantity} @ {firstTx.price}
                                        </Badge>
                                        {sourceCount > 0 && (
                                            <Badge colorScheme="blue" className="text-[10px]">
                                                {sourceCount} source{sourceCount !== 1 ? 's' : ''}
                                            </Badge>
                                        )}
                                        {unresolvedTxs.length > 0 && unresolvedTxs.length < transactions.length && (
                                            <Badge colorScheme="orange" className="text-[10px]">
                                                {unresolvedTxs.length} unresolved
                                            </Badge>
                                        )}
                                        <Badge colorScheme="gray" className="font-mono text-[10px]">
                                            {groupHash.substring(0, 8)}
                                        </Badge>
                                    </>
                                )}
                            </div>
                            {!allResolved && selectedIds.size > 0 && (
                                <Badge colorScheme="blue" className="ml-1 text-[10px]">
                                    {selectedIds.size} selected
                                </Badge>
                            )}
                        </div>
                    </div>

                    {/* Content */}
                    <div className="max-h-[380px] overflow-y-auto p-2">
                        {loading ? (
                            <div className="flex justify-center py-4">
                                <Spinner size="sm" />
                                <span className="ml-2 text-xs text-slate-500">
                                    Loading details…
                                </span>
                            </div>
                        ) : transactions.length > 0 ? (
                            <>
                                {/* Smart Suggestions – same as DuplicateGroupRow */}
                                {connectorBreakdown.length > 1 && !allResolved && (
                                    <div className="mb-2 bg-blue-50 p-2">
                                        <span className="mb-1.5 block text-xs font-bold text-blue-700">
                                            Smart Suggestions:
                                        </span>
                                        <div className="flex flex-wrap gap-1.5">
                                            {connectorBreakdown.map((breakdown, idx) => (
                                                <Button
                                                    key={idx}
                                                    size="sm"
                                                    variant="outline"
                                                    colorScheme="blue"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        selectAllFromConnector(breakdown);
                                                    }}
                                                >
                                                    <FiCheck />
                                                    Keep all {breakdown.count} from {breakdown.connector_type}
                                                    {breakdown.run_id != null && ` (run #${breakdown.run_id})`}
                                                </Button>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Transaction List via TransactionsTable with selection */}
                                <div>
                                    <DuplicateGroupTransactionsTable
                                        key={tableKey}
                                        transactionIds={transactions.map(tx => tx.id)}
                                        onTransactionClick={onTransactionClick}
                                        onSelectionChange={setSelectedIds}
                                        preselectIds={preselectIds}
                                    />
                                </div>
                            </>
                        ) : (
                            <span className="text-xs italic text-slate-500">
                                {transactionIds.length} transactions in group (details loading…)
                            </span>
                        )}
                    </div>

                    {/* Action Buttons – Keep Selected / Dismiss Selected */}
                    {!loading && !allResolved && (
                        <div className="border-t border-slate-100 p-2">
                            <div className="flex justify-end gap-2">
                                <Button
                                    size="sm"
                                    colorScheme="green"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleResolve('keep_selected');
                                    }}
                                    disabled={selectedIds.size === 0 || resolving}
                                    loading={resolving}
                                >
                                    <FiCheck />
                                    Keep Selected
                                </Button>
                                <Button
                                    size="sm"
                                    colorScheme="gray"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleResolve('dismiss_selected');
                                    }}
                                    disabled={selectedIds.size === 0 || resolving}
                                    loading={resolving}
                                >
                                    <FiX />
                                    Dismiss Selected
                                </Button>
                            </div>
                        </div>
                    )}
                </RadixPopover.Content>
            </RadixPopover.Portal>
        </RadixPopover.Root>
    );
};

export default DuplicatePopover;
