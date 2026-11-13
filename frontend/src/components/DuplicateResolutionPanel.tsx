/**
 * DuplicateResolutionPanel
 * 
 * Panel for reviewing and resolving duplicate transaction groups.
 * Features:
 * - Group-based duplicate detection with smart connector suggestions
 * - Keep/dismiss actions for bulk resolution
 * - Time filter options (week, 30d, 90d, all)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Badge, Button, Spinner } from './ui/primitives';
import { DuplicateGroupTransactionsTable } from './tables/wrappers/DuplicateGroupTransactionsTable';
import {
    FiCheck,
    FiX,
    FiAlertTriangle,
    FiRefreshCw,
    FiChevronDown,
    FiChevronRight,
} from 'react-icons/fi';
import { API_URL } from '../types';
import { toaster } from './ui/toaster';

// =============================================================================
// Types
// =============================================================================

interface TransactionSummary {
    id: number;
    source: string;
    source_transaction_id: string | null;
    date_time: string | null;
    source_asset_symbol: string;
    quantity: number;
    price: number | null;
    total: number | null;
    direction: string | null;
    source_transaction_type: string | null;
    source_price_quote_asset_symbol: string;
    account_id: number | null;
    review_status: string;
    tags: Array<Record<string, any>> | null;
    dup_resolved?: boolean;
    dup_resolution?: 'kept' | 'merged' | 'dismissed';
    dup_resolved_at?: string;
    kept_tx_ids?: number[];
    connector_type?: string;
    run_id?: number;
    synced_at?: string;
}

interface ConnectorBreakdown {
    connector_type: string;
    run_id: number | null;
    count: number;
    transaction_ids: number[];
}

interface DuplicateGroup {
    group_hash: string;
    transaction_count: number;
    transactions: TransactionSummary[];
    connector_breakdown: ConnectorBreakdown[];
    match_criteria: string;
}

interface DuplicateGroupsResponse {
    total_groups: number;
    groups: DuplicateGroup[];
    time_tolerance_seconds: number;
    amount_tolerance_percent: number;
}

type TimeFilter = 'week' | '30d' | '90d' | 'all' | null;

interface QuickAction {
    type: 'connector' | 'run' | 'date';
    label: string;
    description: string;
    affectedGroups: string[];  // group_hash values
    transactionIds: number[];  // all transaction IDs to keep
    count: number;  // total transactions affected
    runDate?: string;  // For run-specific actions
    groupsCount: number;  // Number of groups affected
}

// =============================================================================
// Utility Functions
// =============================================================================

const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'N/A';
    try {
        const date = new Date(dateStr);
        const month = date.toLocaleDateString('en-US', { month: 'short' });
        const day = date.getDate();
        const time = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
        return `${month} ${day}, ${time}`;
    } catch {
        return dateStr.slice(0, 16);
    }
};

const formatNumber = (num: number | null): string => {
    if (num === null) return 'N/A';
    // For whole numbers or very close to whole numbers, show no decimals
    if (Math.abs(num - Math.round(num)) < 0.000001) return Math.round(num).toString();
    // For large numbers, show minimal decimals
    if (num >= 1) return num.toFixed(Math.min(2, 8 - Math.floor(Math.log10(num))));
    // For small numbers, show appropriate precision
    if (num >= 0.0001) return num.toFixed(6);
    return num.toExponential(2);
};

// =============================================================================
// Sub-Components
// =============================================================================

interface SmartSuggestionProps {
    breakdown: ConnectorBreakdown;
    onSelectAll: () => void;
}

const SmartSuggestion: React.FC<SmartSuggestionProps> = ({ breakdown, onSelectAll }) => (
    <Button
        size="sm"
        variant="outline"
        colorScheme="blue"
        onClick={onSelectAll}
    >
        <FiCheck />
        Keep all {breakdown.count} from {breakdown.connector_type}
        {breakdown.run_id && ` (run #${breakdown.run_id})`}
    </Button>
);

interface DuplicateGroupRowProps {
    group: DuplicateGroup;
    onResolve: (groupHash: string, action: 'keep_selected' | 'dismiss_selected', txIds: number[], allTxIds: number[]) => Promise<any>;
    onGroupUpdated: (updatedGroup: DuplicateGroup, allResolved: boolean) => void;
}

const DuplicateGroupRow: React.FC<DuplicateGroupRowProps> = ({ group, onResolve, onGroupUpdated }) => {
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [preselectIds, setPreselectIds] = useState<number[] | undefined>(undefined);
    const [tableKey, setTableKey] = useState(0);
    const [isResolving, setIsResolving] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);

    const allResolved = group.transactions.every(tx => tx.dup_resolved);

    // Auto-collapse if all resolved
    useEffect(() => {
        if (allResolved) {
            setIsCollapsed(true);
        }
    }, [allResolved]);

    const selectAllFromConnector = (breakdown: ConnectorBreakdown) => {
        setPreselectIds(breakdown.transaction_ids);
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

        setIsResolving(true);
        try {
            const response = await onResolve(
                group.group_hash,
                action,
                Array.from(selectedIds),
                group.transactions.map(tx => tx.id)
            );

            // Check if group is fully resolved
            const updatedGroup = response.updated_group;
            const allResolved = updatedGroup?.transactions.every((tx: TransactionSummary) => tx.dup_resolved) || false;

            toaster.create({
                title: allResolved ? 'Group fully resolved!' : 'Resolution successful',
                description: `${action === 'keep_selected' ? 'Kept' : 'Dismissed'} ${selectedIds.size} transaction(s)${allResolved ? ' - Group completed' : ''}`,
                type: 'success',
            });

            // Trigger parent to update this specific group
            if (updatedGroup) {
                onGroupUpdated(updatedGroup, allResolved);
            }

            // Clear selection
            setSelectedIds(new Set());
            setPreselectIds(undefined);
            setTableKey(0);
        } catch (error) {
            toaster.create({
                title: 'Resolution failed',
                description: error instanceof Error ? error.message : 'Unknown error',
                type: 'error',
            });
        } finally {
            setIsResolving(false);
        }
    };

    // Calculate summary info for card header
    const firstTx = group.transactions[0];
    const unresolvedCount = group.transactions.filter(tx => !tx.dup_resolved).length;
    const sourceCount = group.connector_breakdown.length;
    const assetPair = `${firstTx.source_asset_symbol}/${firstTx.source_price_quote_asset_symbol}`;
    const direction = firstTx.direction || 'unknown';
    const quantity = formatNumber(firstTx.quantity);
    const price = formatNumber(firstTx.price);

    return (
        <div
            className={`mb-2 border p-2 ${allResolved ? 'border-green-300 bg-green-50' : 'border-orange-200 bg-orange-50/40'}`}
        >
            {/* Header - Badge-based summary starting with duplicate count */}
            <div className={`flex flex-wrap items-center justify-between gap-1 ${isCollapsed ? '' : 'mb-2'}`}>
                <div className="flex flex-wrap items-center gap-1">
                    {allResolved && (
                        <Badge colorScheme="green">
                            ✓ Resolved
                        </Badge>
                    )}
                    <Badge colorScheme="orange">
                        {group.transaction_count} Duplicates
                    </Badge>
                    <Badge colorScheme="purple">
                        {assetPair}
                    </Badge>
                    <Badge colorScheme={direction === 'inflow' ? 'green' : 'red'}>
                        {direction}
                    </Badge>
                    <Badge colorScheme="green">
                        {quantity} @ {price}
                    </Badge>
                    <Badge colorScheme="blue">
                        {sourceCount} source{sourceCount !== 1 ? 's' : ''}
                    </Badge>
                    {unresolvedCount > 0 && (
                        <Badge colorScheme="orange">
                            {unresolvedCount} unresolved
                        </Badge>
                    )}
                    <Badge colorScheme="gray" className="font-mono">
                        {group.group_hash.substring(0, 8)}
                    </Badge>
                </div>
                <div className="flex items-center gap-2">
                    {!allResolved && (
                        <Badge colorScheme="blue">
                            {selectedIds.size} selected
                        </Badge>
                    )}
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        aria-label={isCollapsed ? "Expand" : "Collapse"}
                    >
                        {isCollapsed ? '▼' : '▲'}
                    </Button>
                </div>
            </div>

            {/* Collapsible content */}
            {!isCollapsed && (
                <>
                    {/* Smart Suggestions */}
                    {group.connector_breakdown.length > 1 && (
                        <div className="mb-3 bg-blue-50 p-2">
                            <p className="mb-2 text-xs font-bold text-blue-700">
                                Smart Suggestions:
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {group.connector_breakdown.map((breakdown, idx) => (
                                    <SmartSuggestion
                                        key={idx}
                                        breakdown={breakdown}
                                        onSelectAll={() => selectAllFromConnector(breakdown)}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Transaction List - Table-based UX with selection */}
                    <div className="mb-3">
                        <DuplicateGroupTransactionsTable
                            key={tableKey}
                            transactionIds={group.transactions.map(tx => tx.id)}
                            onSelectionChange={setSelectedIds}
                            preselectIds={preselectIds}
                        />
                    </div>

                    {/* Action Buttons */}
                    {!allResolved && (
                        <div className="flex justify-end gap-2">
                            <Button
                                size="sm"
                                colorScheme="green"
                                onClick={() => handleResolve('keep_selected')}
                                disabled={selectedIds.size === 0 || isResolving}
                                loading={isResolving}
                            >
                                <FiCheck />
                                Keep Selected
                            </Button>
                            <Button
                                size="sm"
                                colorScheme="gray"
                                onClick={() => handleResolve('dismiss_selected')}
                                disabled={selectedIds.size === 0 || isResolving}
                                loading={isResolving}
                            >
                                <FiX />
                                Dismiss Selected
                            </Button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// =============================================================================
// Main Component
// =============================================================================

interface DuplicateResolutionPanelProps {
    accountId?: number;
    connectorRunId?: number;  // Filter to specific connector run
    compactMode?: boolean;    // Reduced padding and smaller fonts for drawer view
}

export const DuplicateResolutionPanel: React.FC<DuplicateResolutionPanelProps> = ({
    accountId,
    connectorRunId,
    compactMode = false,
}) => {
    const [loading, setLoading] = useState(false);
    const [response, setResponse] = useState<DuplicateGroupsResponse | null>(null);
    // Use 'all' as default when in compact mode (sync job panel) to show all duplicates
    const [timeFilter, setTimeFilter] = useState<TimeFilter>(compactMode ? 'all' : '30d');
    const [confirmAction, setConfirmAction] = useState<QuickAction | null>(null);
    const [bulkResolving, setBulkResolving] = useState(false);
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set([]));

    const fetchDuplicates = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (accountId) params.append('account_id', accountId.toString());
            if (connectorRunId) params.append('connector_run_id', connectorRunId.toString());
            if (timeFilter) params.append('time_filter', timeFilter);

            const res = await fetch(`${API_URL}/data-health/duplicate-groups?${params}`);
            if (!res.ok) throw new Error('Failed to fetch duplicate groups');
            const data: DuplicateGroupsResponse = await res.json();
            setResponse(data);
        } catch (error) {
            toaster.create({
                title: 'Failed to load duplicates',
                description: error instanceof Error ? error.message : 'Unknown error',
                type: 'error',
            });
        } finally {
            setLoading(false);
        }
    }, [accountId, connectorRunId, timeFilter]);

    useEffect(() => {
        fetchDuplicates();
    }, [fetchDuplicates]);

    const handleResolve = async (
        groupHash: string,
        action: 'keep_selected' | 'dismiss_selected',
        selectedIds: number[],
        allTransactionIds: number[]
    ) => {
        const res = await fetch(`${API_URL}/data-health/resolve-duplicate-group`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                group_hash: groupHash,
                action,
                selected_transaction_ids: selectedIds,
                all_transaction_ids: allTransactionIds,
            }),
        });

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.detail || 'Failed to resolve duplicate group');
        }

        const result = await res.json();
        return result;
    };

    const handleGroupUpdated = (updatedGroup: DuplicateGroup, allResolved: boolean) => {
        setResponse(prevResponse => {
            if (!prevResponse) return prevResponse;

            // Update the group in place
            const updatedGroups = prevResponse.groups.map(g =>
                g.group_hash === updatedGroup.group_hash ? updatedGroup : g
            );

            // Calculate updated counts
            const unresolvedGroups = updatedGroups.filter(g =>
                !g.transactions.every(tx => tx.dup_resolved)
            );

            return {
                ...prevResponse,
                groups: updatedGroups,
                total_groups: unresolvedGroups.length,
            };
        });
    };

    // Calculate quick actions from unresolved groups
    const quickActions = useMemo<QuickAction[]>(() => {
        if (!response || response.total_groups === 0) return [];

        const actions: QuickAction[] = [];
        const unresolvedGroups = response.groups.filter(g =>
            !g.transactions.every(tx => tx.dup_resolved)
        );

        // Group by connector type
        const connectorMap = new Map<string, { groups: string[], txIds: number[], runIds: Set<number> }>();
        // Group by run ID
        const runMap = new Map<string, { groups: string[], txIds: number[], connector: string, runDate?: string }>();

        unresolvedGroups.forEach(group => {
            group.connector_breakdown.forEach(breakdown => {
                const connectorType = breakdown.connector_type;
                const runId = breakdown.run_id;

                // Connector-based grouping
                if (!connectorMap.has(connectorType)) {
                    connectorMap.set(connectorType, { groups: [], txIds: [], runIds: new Set() });
                }
                const connectorEntry = connectorMap.get(connectorType)!;
                if (!connectorEntry.groups.includes(group.group_hash)) {
                    connectorEntry.groups.push(group.group_hash);
                }
                connectorEntry.txIds.push(...breakdown.transaction_ids);
                if (runId) {
                    connectorEntry.runIds.add(runId);
                }

                // Run-based grouping
                if (runId) {
                    const runKey = `${connectorType}:${runId}`;
                    if (!runMap.has(runKey)) {
                        // Get earliest synced_at date for this run
                        const runTxs = group.transactions.filter(tx => tx.run_id === runId);
                        const runDate = runTxs.length > 0 && runTxs[0].synced_at ? runTxs[0].synced_at : undefined;
                        runMap.set(runKey, { groups: [], txIds: [], connector: connectorType, runDate });
                    }
                    const runEntry = runMap.get(runKey)!;
                    if (!runEntry.groups.includes(group.group_hash)) {
                        runEntry.groups.push(group.group_hash);
                    }
                    runEntry.txIds.push(...breakdown.transaction_ids);
                }
            });
        });

        // Create run-specific actions first (show if 2+ groups or 5+ transactions)
        runMap.forEach((data, runKey) => {
            if (data.groups.length >= 2 || data.txIds.length >= 5) {
                const runId = runKey.split(':')[1];
                actions.push({
                    type: 'run',
                    label: `${data.connector} run #${runId}`,
                    description: data.runDate ? formatDate(data.runDate) : '',
                    affectedGroups: data.groups,
                    transactionIds: data.txIds,
                    count: data.txIds.length,
                    runDate: data.runDate,
                    groupsCount: data.groups.length,
                });
            }
        });

        // Create connector-level actions ONLY if there are multiple runs
        // (to avoid redundancy with run-specific actions)
        connectorMap.forEach((data, connector) => {
            // Only show connector action if:
            // 1. Has multiple runs, AND
            // 2. Meets threshold (2+ groups or 5+ transactions)
            if (data.runIds.size > 1 && (data.groups.length >= 2 || data.txIds.length >= 5)) {
                actions.push({
                    type: 'connector',
                    label: connector,
                    description: `${data.runIds.size} runs`,
                    affectedGroups: data.groups,
                    transactionIds: data.txIds,
                    count: data.txIds.length,
                    groupsCount: data.groups.length,
                });
            }
        });

        // Sort by count (most impact first)
        return actions.sort((a, b) => b.count - a.count);
    }, [response]);

    const handleBulkResolve = async (action: QuickAction) => {
        setBulkResolving(true);
        let successCount = 0;
        let failCount = 0;

        try {
            // Process each affected group
            for (const groupHash of action.affectedGroups) {
                const group = response?.groups.find(g => g.group_hash === groupHash);
                if (!group) continue;

                // Find transaction IDs in this group that match the action
                const txIdsToKeep = group.transactions
                    .filter(tx => !tx.dup_resolved && action.transactionIds.includes(tx.id))
                    .map(tx => tx.id);

                if (txIdsToKeep.length === 0) continue;

                try {
                    const result = await handleResolve(
                        groupHash,
                        'keep_selected',
                        txIdsToKeep,
                        group.transactions.map(tx => tx.id)
                    );
                    const updatedGroup = result.updated_group;
                    const allResolved = updatedGroup?.transactions.every((tx: TransactionSummary) => tx.dup_resolved) || false;

                    if (updatedGroup) {
                        handleGroupUpdated(updatedGroup, allResolved);
                    }
                    successCount++;
                } catch (error) {
                    console.error(`Failed to resolve group ${groupHash}:`, error);
                    failCount++;
                }
            }

            toaster.create({
                title: 'Bulk resolution complete',
                description: `Successfully resolved ${successCount} groups${failCount > 0 ? `, ${failCount} failed` : ''}`,
                type: failCount > 0 ? 'warning' : 'success',
            });
        } catch (error) {
            toaster.create({
                title: 'Bulk resolution failed',
                description: error instanceof Error ? error.message : 'Unknown error',
                type: 'error',
            });
        } finally {
            setBulkResolving(false);
            setConfirmAction(null);
        }
    };

    const calculatePreview = (action: QuickAction | null) => {
        if (!action || !response) return [];

        return action.affectedGroups.map(groupHash => {
            const group = response.groups.find(g => g.group_hash === groupHash);
            if (!group) return null;

            const kept = group.transactions.filter(tx =>
                !tx.dup_resolved && action.transactionIds.includes(tx.id)
            );
            const merged = group.transactions.filter(tx =>
                !tx.dup_resolved && !action.transactionIds.includes(tx.id)
            );

            return {
                group,
                kept,
                merged,
            };
        }).filter(Boolean) as Array<{
            group: DuplicateGroup;
            kept: TransactionSummary[];
            merged: TransactionSummary[];
        }>;
    };

    const preview = calculatePreview(confirmAction);

    // Auto-expand first group in preview when modal opens
    useEffect(() => {
        if (confirmAction && preview.length > 0) {
            setExpandedGroups(new Set([preview[0].group.group_hash]));
        } else if (!confirmAction) {
            setExpandedGroups(new Set([]));
        }
    }, [confirmAction]);

    return (
        <div className={compactMode ? 'p-1' : 'p-3'}>
            {/* Time Filter */}
            {!compactMode && (
                <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs font-bold">
                        Time Range:
                    </span>
                    {(['week', '30d', '90d', 'all'] as TimeFilter[]).map(filter => (
                        <Button
                            key={filter}
                            size="sm"
                            variant={timeFilter === filter ? 'solid' : 'outline'}
                            colorScheme="blue"
                            onClick={() => setTimeFilter(filter)}
                        >
                            {filter === 'week'
                                ? 'Last Week'
                                : filter === '30d'
                                    ? '30 Days'
                                    : filter === '90d'
                                        ? '90 Days'
                                        : 'All Time'}
                        </Button>
                    ))}
                </div>
            )}

            {/* Quick Actions */}
            {!compactMode && quickActions.length > 0 && (
                <div className="mb-2 border border-purple-200 bg-purple-50 p-1.5">
                    <div className="mb-0.5 flex items-center px-0.5">
                        <span className="text-xs font-bold text-purple-700">
                            ⚡ Quick Actions
                        </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {quickActions.map((action, idx) => (
                            <Button
                                key={idx}
                                size="sm"
                                colorScheme="gray"
                                variant="outline"
                                className="border-purple-300 text-purple-700 hover:bg-purple-50"
                                onClick={() => setConfirmAction(action)}
                                disabled={loading || bulkResolving}
                            >
                                <div className="flex items-center gap-0.5">
                                    <FiCheck size={10} />
                                    <span className="text-xs">{action.label}</span>
                                    <Badge colorScheme="purple">
                                        {action.groupsCount}g
                                    </Badge>
                                    <Badge colorScheme="purple">
                                        {action.count}tx
                                    </Badge>
                                    {action.description && (
                                        <Badge colorScheme="gray">
                                            {action.description}
                                        </Badge>
                                    )}
                                </div>
                            </Button>
                        ))}
                    </div>
                </div>
            )}

            {/* Stats */}
            {response && (
                <div className={`${compactMode ? 'mb-1 p-1.5' : 'mb-2 p-2'} bg-blue-50 text-xs`}>
                    <div className="flex gap-4">
                        <div className="flex flex-col items-start gap-0">
                            <span className="text-lg font-bold text-blue-700">
                                {response.total_groups}
                            </span>
                            <span className="text-xs text-blue-600">
                                Unresolved Groups
                            </span>
                        </div>
                        <div className="flex flex-col items-start gap-0">
                            <span className="text-lg font-bold text-green-700">
                                {response.groups.length - response.total_groups}
                            </span>
                            <span className="text-xs text-green-600">
                                Resolved Groups
                            </span>
                        </div>
                        <div className="flex flex-col items-start gap-0">
                            <span className="text-xs text-slate-700">
                                Time Tolerance: ±{response.time_tolerance_seconds}s
                            </span>
                            <span className="text-xs text-slate-700">
                                Amount Tolerance: ±{response.amount_tolerance_percent}%
                            </span>
                        </div>
                    </div>
                </div>
            )}

            {/* Loading State */}
            {loading && !response && (
                <div className="flex h-[200px] items-center justify-center">
                    <Spinner size="lg" />
                </div>
            )}

            {/* Empty State */}
            {!loading && response && response.total_groups === 0 && (
                <div className="flex h-[200px] flex-col items-center justify-center bg-green-50">
                    <FiCheck size={48} color="green" />
                    <p className="mt-3 text-lg font-bold text-green-700">
                        No Duplicates Found
                    </p>
                    <p className="text-sm text-green-600">
                        All transactions appear to be unique
                    </p>
                </div>
            )}

            {/* Duplicate Groups */}
            {response && response.groups.length > 0 && (
                <div className="flex flex-col items-stretch gap-0">
                    {response.groups.map(group => (
                        <DuplicateGroupRow
                            key={group.group_hash}
                            group={group}
                            onResolve={handleResolve}
                            onGroupUpdated={handleGroupUpdated}
                        />
                    ))}
                </div>
            )}

            {/* Bulk Resolution Confirmation Modal */}
            <RadixDialog.Root open={confirmAction !== null} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/50" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[900px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white p-4 shadow-lg">
                        <RadixDialog.Title className="mb-3 text-base font-semibold">Confirm Bulk Resolution</RadixDialog.Title>

                        <div className="flex flex-col items-stretch gap-3">
                            {/* Action Summary */}
                            <div className="border border-purple-200 bg-purple-50 p-3">
                                <div className="mb-1 flex items-center gap-2">
                                    <span className="text-sm font-bold text-purple-700">
                                        Action:
                                    </span>
                                    <Badge colorScheme="purple">
                                        Keep {confirmAction?.label}
                                    </Badge>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-slate-600">
                                    <Badge colorScheme="purple">
                                        {confirmAction?.groupsCount} groups
                                    </Badge>
                                    <Badge colorScheme="green">
                                        {preview.reduce((sum, p) => sum + p.kept.length, 0)} kept
                                    </Badge>
                                    <Badge colorScheme="orange">
                                        {preview.reduce((sum, p) => sum + p.merged.length, 0)} merged
                                    </Badge>
                                </div>
                            </div>

                            {/* Per-Group Preview */}
                            <div>
                                <p className="mb-2 text-sm font-bold">
                                    Groups Preview:
                                </p>
                                <div className="flex max-h-[400px] flex-col items-stretch gap-2 overflow-y-auto">
                                    {preview.map((groupPreview, idx) => {
                                        const isExpanded = expandedGroups.has(groupPreview.group.group_hash);
                                        const firstTx = groupPreview.group.transactions[0];
                                        const assetPair = `${firstTx.source_asset_symbol}/${firstTx.source_price_quote_asset_symbol}`;
                                        const direction = firstTx.direction || 'unknown';

                                        return (
                                            <div
                                                key={groupPreview.group.group_hash}
                                                className="border border-slate-200 bg-white"
                                            >
                                                {/* Group Header */}
                                                <div
                                                    className="flex cursor-pointer items-center justify-between p-2 hover:bg-slate-50"
                                                    onClick={() => {
                                                        setExpandedGroups(prev => {
                                                            const next = new Set(prev);
                                                            if (next.has(groupPreview.group.group_hash)) {
                                                                next.delete(groupPreview.group.group_hash);
                                                            } else {
                                                                next.add(groupPreview.group.group_hash);
                                                            }
                                                            return next;
                                                        });
                                                    }}
                                                >
                                                    <div className="flex flex-wrap items-center gap-1">
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            aria-label="Toggle group"
                                                        >
                                                            {isExpanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                                                        </Button>
                                                        <Badge colorScheme="gray" className="font-mono">
                                                            #{idx + 1}
                                                        </Badge>
                                                        <Badge colorScheme="purple">
                                                            {assetPair}
                                                        </Badge>
                                                        <Badge colorScheme={direction === 'inflow' ? 'green' : 'red'}>
                                                            {direction}
                                                        </Badge>
                                                        <Badge colorScheme="orange">
                                                            {groupPreview.group.transaction_count} dup
                                                        </Badge>
                                                    </div>
                                                    <div className="flex items-center gap-1">
                                                        <Badge colorScheme="green">
                                                            ✓ {groupPreview.kept.length}
                                                        </Badge>
                                                        <Badge colorScheme="orange">
                                                            → {groupPreview.merged.length}
                                                        </Badge>
                                                    </div>
                                                </div>

                                                {/* Expanded Content */}
                                                {isExpanded && (
                                                    <div className="p-2 pt-0">
                                                        <div className="flex gap-2">
                                                            {/* Kept Column */}
                                                            <div className="flex-1 border border-green-200 bg-green-50 p-2">
                                                                <div className="mb-2 flex items-center gap-1">
                                                                    <Badge colorScheme="green">
                                                                        ✓ KEPT
                                                                    </Badge>
                                                                    <span className="text-xs text-green-700">
                                                                        {groupPreview.kept.length}
                                                                    </span>
                                                                </div>
                                                                <div className="flex flex-col items-stretch gap-1">
                                                                    {groupPreview.kept.slice(0, 3).map(tx => (
                                                                        <div key={tx.id} className="bg-white p-1.5">
                                                                            <div className="flex flex-wrap items-center gap-1 text-xs">
                                                                                <Badge colorScheme="purple">
                                                                                    {tx.connector_type}
                                                                                </Badge>
                                                                                {tx.run_id && (
                                                                                    <Badge colorScheme="purple">
                                                                                        #{tx.run_id}
                                                                                    </Badge>
                                                                                )}
                                                                                <Badge colorScheme="blue">
                                                                                    {formatDate(tx.date_time)}
                                                                                </Badge>
                                                                                <Badge colorScheme="green">
                                                                                    {formatNumber(tx.quantity)}
                                                                                </Badge>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                    {groupPreview.kept.length > 3 && (
                                                                        <p className="text-center text-xs text-slate-500">
                                                                            +{groupPreview.kept.length - 3} more...
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            </div>

                                                            {/* Merged Column */}
                                                            <div className="flex-1 border border-orange-200 bg-orange-50 p-2">
                                                                <div className="mb-2 flex items-center gap-1">
                                                                    <Badge colorScheme="orange">
                                                                        → MERGED
                                                                    </Badge>
                                                                    <span className="text-xs text-orange-700">
                                                                        {groupPreview.merged.length}
                                                                    </span>
                                                                </div>
                                                                <div className="flex flex-col items-stretch gap-1">
                                                                    {groupPreview.merged.slice(0, 3).map(tx => (
                                                                        <div key={tx.id} className="bg-white p-1.5">
                                                                            <div className="flex flex-wrap items-center gap-1 text-xs">
                                                                                <Badge colorScheme="purple">
                                                                                    {tx.connector_type}
                                                                                </Badge>
                                                                                {tx.run_id && (
                                                                                    <Badge colorScheme="purple">
                                                                                        #{tx.run_id}
                                                                                    </Badge>
                                                                                )}
                                                                                <Badge colorScheme="blue">
                                                                                    {formatDate(tx.date_time)}
                                                                                </Badge>
                                                                                <Badge colorScheme="green">
                                                                                    {formatNumber(tx.quantity)}
                                                                                </Badge>
                                                                            </div>
                                                                        </div>
                                                                    ))}
                                                                    {groupPreview.merged.length > 3 && (
                                                                        <p className="text-center text-xs text-slate-500">
                                                                            +{groupPreview.merged.length - 3} more...
                                                                        </p>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Info Footer */}
                            <div className="border border-blue-200 bg-blue-50 p-2 text-xs text-blue-700">
                                ℹ️ Merged transactions will be marked as duplicates and linked to the kept transactions.
                            </div>
                        </div>

                        <div className="mt-4 flex justify-end gap-3">
                            <Button
                                variant="outline"
                                onClick={() => setConfirmAction(null)}
                                disabled={bulkResolving}
                            >
                                Cancel
                            </Button>
                            <Button
                                colorScheme="gray"
                                className="border-purple-300 bg-purple-600 text-white hover:bg-purple-700"
                                onClick={() => confirmAction && handleBulkResolve(confirmAction)}
                                loading={bulkResolving}
                            >
                                <FiCheck />
                                Confirm & Resolve {confirmAction?.groupsCount} Groups
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>
        </div>
    );
};
