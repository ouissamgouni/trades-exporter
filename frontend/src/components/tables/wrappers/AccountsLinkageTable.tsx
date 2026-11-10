/**
 * AccountsLinkageTable
 *
 * Wrapper around TransactionsTable for transactions with account linkage issues.
 * Fetches issues from /transactions/data-health-check/transfer-issues,
 * groups by transaction_id, and renders TransactionsTable with an
 * "Account Issue" badge column. Fixes happen via inline-edit cells.
 * Supports dismiss per row (icon next to the TX id) and in bulk; `mode="dismissed"`
 * lists dismissed issues with a Restore action instead.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LuEyeOff, LuRotateCcw } from 'react-icons/lu';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { BulkAction, ColumnPlugin, RowAction, TableConfig } from '../types';
import { useShowInContextRowAction } from '../rowActions';
import { presetToVisibility } from '../useTransactionsTable';
import { API_URL, Account, Asset, Transaction, TransactionIssue } from '../../../types';
import { Tooltip } from '../../ui/tooltip';
import { toaster } from '../../ui/toaster';
import { Badge, type BadgeColorScheme, Spinner } from '../../ui/primitives';

// ============================================================================
// Types
// ============================================================================

interface AccountsLinkageTableProps {
    /** Callback when an issue is fixed, dismissed or restored */
    onFixed?: () => void;
    /** 'open' (default) lists active issues; 'dismissed' lists dismissed ones with Restore actions */
    mode?: 'open' | 'dismissed';
}

const dismissFieldFor = (issueType: string) =>
    issueType.includes('_from_') ? 'source_from_account' : issueType.includes('_to_') ? 'source_to_account' : null;

// Issue type configuration for account issues
const ACCOUNT_ISSUE_CONFIG: Record<string, { color: BadgeColorScheme; label: string }> = {
    missing_transfer_from_account: { color: 'blue', label: 'Missing From' },
    missing_transfer_to_account: { color: 'blue', label: 'Missing To' },
    unlinked_transfer_from_account: { color: 'blue', label: 'Unlinked From' },
    unlinked_transfer_to_account: { color: 'blue', label: 'Unlinked To' },
    unlinked_account: { color: 'orange', label: 'Unlinked Account' },
    missing_source_account: { color: 'orange', label: 'Missing Account' },
};

// ============================================================================
// Component
// ============================================================================

export const AccountsLinkageTable: React.FC<AccountsLinkageTableProps> = ({
    onFixed,
    mode = 'open',
}) => {
    const queryClient = useQueryClient();
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [isDismissing, setIsDismissing] = useState(false);
    const isDismissedMode = mode === 'dismissed';
    const showInContextAction = useShowInContextRowAction();

    // Fetch all account linkage issues
    const { data: issuesData, isLoading } = useQuery({
        queryKey: ['accountLinkageIssues', mode],
        queryFn: async () => {
            const allIssues: TransactionIssue[] = [];
            let page = 1;
            let totalPages = 1;

            while (page <= totalPages) {
                const params = new URLSearchParams({
                    page: String(page),
                    per_page: '200',
                });
                if (isDismissedMode) params.set('dismissed_only', 'true');
                const response = await fetch(`${API_URL}/transactions/data-health-check/transfer-issues?${params}`);
                if (!response.ok) throw new Error('Failed to fetch account linkage issues');

                const data = await response.json();
                allIssues.push(...data.issues);
                totalPages = data.pagination.total_pages ?? 1;
                page++;
            }

            return allIssues;
        },
    });

    const issues = issuesData ?? [];

    // Group by transaction_id
    const issuesByTxId = useMemo(() => {
        const map = new Map<number, TransactionIssue[]>();
        for (const issue of issues) {
            const existing = map.get(issue.transaction_id) || [];
            existing.push(issue);
            map.set(issue.transaction_id, existing);
        }
        return map;
    }, [issues]);

    // Unique transaction IDs
    const transactionIds = useMemo(
        () => Array.from(new Set(issues.map(i => i.transaction_id))),
        [issues],
    );

    // Track selection changes from TransactionsTable
    const handleSelectionChange = useCallback((ids: Set<number>) => {
        setSelectedIds(ids);
    }, []);

    const refreshAfterChange = useCallback(() => {
        setSelectedIds(new Set());
        queryClient.invalidateQueries({ queryKey: ['accountLinkageIssues'] });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['dataHealthStatus'] });
        onFixed?.();
    }, [queryClient, onFixed]);

    // Restore (un-dismiss) every dismissed field of the given transactions
    const restoreIssues = useCallback(async (txIds: number[]) => {
        const requests: Promise<Response>[] = [];
        for (const txId of txIds) {
            const fields = new Set((issuesByTxId.get(txId) || []).map(i => dismissFieldFor(i.issue_type)).filter(Boolean));
            for (const field of fields) {
                requests.push(fetch(`${API_URL}/transactions/${txId}/dismiss-transfer-issue/${field}`, { method: 'DELETE' }));
            }
        }
        const results = await Promise.all(requests);
        const failed = results.filter(r => !r.ok).length;
        toaster.create({
            title: failed ? `Restored ${results.length - failed}, ${failed} failed` : `Restored ${results.length} issue(s)`,
            type: failed ? 'warning' : 'success',
        });
        refreshAfterChange();
    }, [issuesByTxId, refreshAfterChange]);

    // Dismiss every open field of a single transaction
    const dismissOne = useCallback(async (txId: number) => {
        const fields = new Set((issuesByTxId.get(txId) || []).map(i => dismissFieldFor(i.issue_type)).filter(Boolean));
        const results = await Promise.all([...fields].map(field => fetch(`${API_URL}/transactions/${txId}/dismiss-transfer-issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field, reason: 'Dismissed from data health table' }),
        })));
        if (results.some(r => !r.ok)) {
            toaster.create({ title: `Failed to dismiss #${txId}`, type: 'error' });
        } else {
            toaster.create({ title: `Dismissed #${txId}`, description: 'Find it again in the Dismissed tab.', type: 'success' });
        }
        refreshAfterChange();
    }, [issuesByTxId, refreshAfterChange]);

    // Bulk dismiss selected transactions
    const handleBulkDismiss = useCallback(async () => {
        if (selectedIds.size === 0) return;
        setIsDismissing(true);

        try {
            // Split selected IDs by field (from vs to) based on their issue type
            const fromIds: number[] = [];
            const toIds: number[] = [];

            for (const txId of selectedIds) {
                const txIssues = issuesByTxId.get(txId) || [];
                for (const issue of txIssues) {
                    if (issue.issue_type.includes('_from_')) {
                        if (!fromIds.includes(txId)) fromIds.push(txId);
                    }
                    if (issue.issue_type.includes('_to_')) {
                        if (!toIds.includes(txId)) toIds.push(txId);
                    }
                }
            }

            const results = await Promise.all([
                ...(fromIds.length > 0 ? [fetch(`${API_URL}/transactions/bulk-dismiss-transfer-issues`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transaction_ids: fromIds,
                        field: 'source_from_account',
                        reason: 'Bulk dismissed from data health panel',
                    }),
                })] : []),
                ...(toIds.length > 0 ? [fetch(`${API_URL}/transactions/bulk-dismiss-transfer-issues`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        transaction_ids: toIds,
                        field: 'source_to_account',
                        reason: 'Bulk dismissed from data health panel',
                    }),
                })] : []),
            ]);

            // Check results
            let totalDismissed = 0;
            const allErrors: string[] = [];
            for (const res of results) {
                if (!res.ok) {
                    allErrors.push(`Request failed: ${res.status}`);
                    continue;
                }
                const data = await res.json();
                totalDismissed += data.dismissed_count ?? 0;
                if (data.errors?.length) allErrors.push(...data.errors);
            }

            if (allErrors.length > 0) {
                toaster.create({
                    title: `Dismissed ${totalDismissed}, but ${allErrors.length} error(s)`,
                    description: allErrors.slice(0, 3).join('; '),
                    type: 'warning',
                });
            } else {
                toaster.create({
                    title: `Dismissed ${totalDismissed} issue(s)`,
                    type: 'success',
                });
            }

            refreshAfterChange();
        } catch (err) {
            toaster.create({
                title: err instanceof Error ? err.message : 'Failed to dismiss issues',
                type: 'error',
            });
        } finally {
            setIsDismissing(false);
        }
    }, [selectedIds, issuesByTxId, refreshAfterChange]);

    // Bulk action as plugin for the main floating bar
    const additionalBulkActions: BulkAction<Transaction>[] = useMemo(() => [
        isDismissedMode
            ? {
                id: 'restore-account-issues',
                label: 'Restore Issues',
                icon: <LuRotateCcw size={12} />,
                colorPalette: 'blue',
                variant: 'outline' as const,
                onClick: async () => { await restoreIssues([...selectedIds]); },
            }
            : {
                id: 'dismiss-account-issues',
                label: 'Dismiss Issues',
                icon: <LuEyeOff size={12} />,
                colorPalette: 'orange',
                variant: 'outline' as const,
                onClick: async () => { await handleBulkDismiss(); },
            },
    ], [isDismissedMode, restoreIssues, selectedIds, handleBulkDismiss]);

    const additionalRowActions: RowAction<Transaction>[] = useMemo(() => [
        showInContextAction,
        isDismissedMode
            ? {
                id: 'restore-issue',
                icon: <LuRotateCcw size={11} />,
                label: 'Restore issue (un-dismiss)',
                placement: 'id' as const,
                colorPalette: 'blue',
                onClick: (tx: Transaction) => restoreIssues([tx.id]),
            }
            : {
                id: 'dismiss-issue',
                icon: <LuEyeOff size={11} />,
                label: 'Dismiss issue (kept in the Dismissed tab)',
                placement: 'id' as const,
                colorPalette: 'orange',
                onClick: (tx: Transaction) => dismissOne(tx.id),
            },
    ], [showInContextAction, isDismissedMode, restoreIssues, dismissOne]);

    // Account issue column plugin
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'account-issue',
            header: 'Account Issue',
            width: '160px',
            render: (tx: Transaction) => {
                const txIssues = issuesByTxId.get(tx.id) || [];
                if (txIssues.length === 0) return null;

                return (
                    <div className="flex flex-col gap-0.5">
                        {txIssues.map((issue, idx) => {
                            const config = ACCOUNT_ISSUE_CONFIG[issue.issue_type] || { color: 'gray' as BadgeColorScheme, label: issue.issue_type };
                            return (
                                <div key={idx} className="flex items-center gap-1">
                                    <Badge colorScheme={config.color} className="text-[7px]">
                                        {config.label}
                                    </Badge>
                                    <Tooltip content={issue.raw_value} openDelay={100}>
                                        <span className="max-w-[80px] truncate text-[7px] text-orange-600">
                                            {issue.raw_value}
                                        </span>
                                    </Tooltip>
                                </div>
                            );
                        })}
                    </div>
                );
            },
        },
    ], [issuesByTxId]);

    // Table configuration — show accounts column for inline-edit fixes
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset: 'compact',
        hiddenColumns: ['bundle', 'taxability', 'feeInBase'],
        shownColumns: ['accounts'],
        features: {
            filters: false,
            selection: true,
            inlineEdit: true,
        },
    }), []);

    const initialColumnVisibility = useMemo(
        () => presetToVisibility('compact', ['bundle', 'taxability', 'feeInBase'], ['accounts']),
        [],
    );

    if (isLoading) {
        return (
            <div className="bg-slate-50 py-10 text-center">
                <Spinner size="lg" className="text-blue-500" />
                <p className="mt-4">Loading account linkage issues...</p>
            </div>
        );
    }

    if (transactionIds.length === 0) {
        return (
            <div className="bg-green-50 p-6 text-center">
                <span className="font-medium text-green-600">
                    {isDismissedMode ? 'No dismissed account issues.' : '✓ No account linkage issues found!'}
                </span>
            </div>
        );
    }

    return (
        <div className="relative">
            <TransactionsTable
                defaultExpandAllDays
                title={isDismissedMode ? 'Dismissed Account Issues' : 'Account Linkage Issues'}
                subtitle={isDismissedMode
                    ? `${transactionIds.length} dismissed transaction${transactionIds.length !== 1 ? 's' : ''} — restore to put them back in the issue list`
                    : `${transactionIds.length} transaction${transactionIds.length !== 1 ? 's' : ''} with unlinked accounts`}
                tableId={isDismissedMode ? 'accountsLinkageDismissed' : 'accountsLinkage'}
                initialColumnVisibility={initialColumnVisibility}
                filters={{
                    ...defaultFilterState,
                    transactionIds,
                    reviewStatus: [],
                }}
                showFilters={false}
                showBundles={false}
                showSuggestions={false}
                compact={true}
                additionalColumns={additionalColumns}
                additionalBulkActions={additionalBulkActions}
                additionalRowActions={additionalRowActions}
                config={tableConfig}
                onDataChange={onFixed}
                onSelectionChange={handleSelectionChange}
            />
        </div>
    );
};

export default AccountsLinkageTable;
