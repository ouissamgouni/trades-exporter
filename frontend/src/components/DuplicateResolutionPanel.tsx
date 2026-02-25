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
import {
    Badge,
    Box,
    Button,
    Collapsible,
    Dialog,
    Flex,
    Heading,
    HStack,
    IconButton,
    Portal,
    Spinner,
    Table,
    Text,
    VStack,
    Checkbox,
} from '@chakra-ui/react';
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
        size="xs"
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
    const [isResolving, setIsResolving] = useState(false);
    const [isCollapsed, setIsCollapsed] = useState(false);

    const allResolved = group.transactions.every(tx => tx.dup_resolved);

    // Auto-collapse if all resolved
    useEffect(() => {
        if (allResolved) {
            setIsCollapsed(true);
        }
    }, [allResolved]);

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    const selectAllFromConnector = (breakdown: ConnectorBreakdown) => {
        setSelectedIds(new Set(breakdown.transaction_ids));
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
        <Box
            borderWidth="1px"
            borderRadius="md"
            p={2}
            mb={2}
            bg={allResolved ? "green.50" : "orange.25"}
            borderColor={allResolved ? "green.300" : "orange.200"}
        >
            {/* Header - Badge-based summary starting with duplicate count */}
            <Flex justify="space-between" align="center" mb={isCollapsed ? 0 : 2} flexWrap="wrap" gap={1}>
                <HStack gap={1} flexWrap="wrap">
                    {allResolved && (
                        <Badge colorPalette="green" fontSize="2xs" px={1.5} py={0.5} variant="solid">
                            ✓ Resolved
                        </Badge>
                    )}
                    <Badge colorPalette="orange" fontSize="2xs" px={1.5} py={0.5}>
                        {group.transaction_count} Duplicates
                    </Badge>
                    <Badge colorPalette="purple" variant="subtle" fontSize="2xs">
                        {assetPair}
                    </Badge>
                    <Badge
                        colorPalette={direction === 'inflow' ? 'green' : 'red'}
                        variant="subtle"
                        fontSize="2xs"
                    >
                        {direction}
                    </Badge>
                    <Badge colorPalette="teal" variant="solid" fontSize="2xs">
                        {quantity} @ {price}
                    </Badge>
                    <Badge colorPalette="blue" variant="solid" fontSize="2xs">
                        {sourceCount} source{sourceCount !== 1 ? 's' : ''}
                    </Badge>
                    {unresolvedCount > 0 && (
                        <Badge colorPalette="orange" variant="outline" fontSize="2xs">
                            {unresolvedCount} unresolved
                        </Badge>
                    )}
                    <Badge colorPalette="gray" variant="outline" fontSize="2xs" fontFamily="mono">
                        {group.group_hash.substring(0, 8)}
                    </Badge>
                </HStack>
                <HStack>
                    {!allResolved && (
                        <Badge colorPalette="blue" variant="subtle" fontSize="2xs">
                            {selectedIds.size} selected
                        </Badge>
                    )}
                    <IconButton
                        size="xs"
                        variant="ghost"
                        onClick={() => setIsCollapsed(!isCollapsed)}
                        aria-label={isCollapsed ? "Expand" : "Collapse"}
                    >
                        {isCollapsed ? '▼' : '▲'}
                    </IconButton>
                </HStack>
            </Flex>

            {/* Collapsible content */}
            {!isCollapsed && (
                <>
                    {/* Smart Suggestions */}
                    {group.connector_breakdown.length > 1 && (
                        <Box mb={3} p={2} bg="blue.50" borderRadius="md">
                            <Text fontSize="xs" fontWeight="bold" mb={2} color="blue.700">
                                Smart Suggestions:
                            </Text>
                            <Flex gap={2} flexWrap="wrap">
                                {group.connector_breakdown.map((breakdown, idx) => (
                                    <SmartSuggestion
                                        key={idx}
                                        breakdown={breakdown}
                                        onSelectAll={() => selectAllFromConnector(breakdown)}
                                    />
                                ))}
                            </Flex>
                        </Box>
                    )}

                    {/* Transaction List - Always Expanded */}
                    <VStack gap={2} align="stretch" mb={3}>
                        {group.transactions.map(tx => (
                            <Box
                                key={tx.id}
                                borderWidth="1px"
                                borderColor={selectedIds.has(tx.id) ? 'blue.300' : 'gray.200'}
                                borderRadius="md"
                                p={2}
                                bg={selectedIds.has(tx.id) ? 'blue.50' : 'white'}
                            >
                                <Flex gap={2} align="flex-start">
                                    {/* Checkbox - FIXED with proper Chakra v3 children */}
                                    <Box pt={0.5}>
                                        <Checkbox.Root
                                            checked={selectedIds.has(tx.id)}
                                            onCheckedChange={() => toggleSelection(tx.id)}
                                            disabled={tx.dup_resolved}
                                            size="sm"
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control>
                                                <Checkbox.Indicator />
                                            </Checkbox.Control>
                                        </Checkbox.Root>
                                    </Box>

                                    {/* Content */}
                                    <Flex direction="column" flex="1" gap={1}>
                                        {/* Connector Info with parent badge */}
                                        <HStack gap={1} flexWrap="wrap">
                                            <Box borderWidth="1px" borderColor="purple.200" borderRadius="md" px={2} py={1} bg="purple.50">
                                                <HStack gap={1} flexWrap="wrap">
                                                    <Badge colorPalette="purple" size="xs" variant="solid">
                                                        {tx.connector_type || tx.source}
                                                    </Badge>
                                                    {tx.run_id && (
                                                        <Badge colorPalette="purple" size="xs" variant="subtle">
                                                            run #{tx.run_id}
                                                        </Badge>
                                                    )}
                                                    {tx.synced_at && (
                                                        <Badge colorPalette="purple" size="xs" variant="subtle">
                                                            {formatDate(tx.synced_at)}
                                                        </Badge>
                                                    )}
                                                </HStack>
                                            </Box>
                                            {tx.dup_resolved && tx.dup_resolution && (
                                                <Badge
                                                    colorPalette={
                                                        tx.dup_resolution === 'kept'
                                                            ? 'green'
                                                            : tx.dup_resolution === 'merged'
                                                                ? 'orange'
                                                                : 'gray'
                                                    }
                                                    size="xs"
                                                    variant="solid"
                                                >
                                                    {tx.dup_resolution.toUpperCase()}
                                                </Badge>
                                            )}
                                        </HStack>

                                        {/* Transaction Details - Compact with parent badge */}
                                        <Box borderWidth="1px" borderColor="blue.200" borderRadius="md" px={2} py={1} bg="blue.50">
                                            <Flex gap={1} flexWrap="wrap" align="center" fontSize="xs">
                                                <Badge colorPalette="cyan" size="xs" variant="solid">
                                                    {formatDate(tx.date_time)}
                                                </Badge>
                                                <Badge colorPalette="blue" size="xs" variant="solid">
                                                    {tx.source_asset_symbol}/{tx.source_price_quote_asset_symbol}
                                                </Badge>
                                                <Badge colorPalette="teal" size="xs" variant="solid">
                                                    {formatNumber(tx.quantity)} @ {formatNumber(tx.price)}
                                                </Badge>
                                                {tx.source_transaction_type && (
                                                    <Badge colorPalette="cyan" size="xs" variant="solid">
                                                        {tx.source_transaction_type}
                                                    </Badge>
                                                )}
                                                {tx.source_transaction_id && (
                                                    <Badge colorPalette="gray" size="xs" variant="solid">
                                                        ID: {tx.source_transaction_id}
                                                    </Badge>
                                                )}
                                                <Badge
                                                    colorPalette={
                                                        tx.review_status === 'pending'
                                                            ? 'yellow'
                                                            : tx.review_status === 'invalid'
                                                                ? 'red'
                                                                : 'green'
                                                    }
                                                    size="xs"
                                                    variant="solid"
                                                >
                                                    {tx.review_status}
                                                </Badge>
                                            </Flex>
                                        </Box>

                                        {/* Resolution Status with Details */}
                                        {tx.dup_resolved && tx.dup_resolution && (
                                            <HStack gap={1}>
                                                <Badge
                                                    colorPalette={
                                                        tx.dup_resolution === 'kept' ? 'green' :
                                                            tx.dup_resolution === 'merged' ? 'orange' : 'gray'
                                                    }
                                                    size="xs"
                                                    variant="solid"
                                                >
                                                    ✓ {tx.dup_resolution.toUpperCase()}
                                                </Badge>
                                                {tx.dup_resolved_at && (
                                                    <Badge colorPalette="gray" size="xs" variant="outline">
                                                        {formatDate(tx.dup_resolved_at)}
                                                    </Badge>
                                                )}
                                                {tx.dup_resolution === 'merged' && tx.kept_tx_ids && tx.kept_tx_ids.length > 0 && (
                                                    <Badge colorPalette="blue" size="xs" variant="outline">
                                                        → IDs: {tx.kept_tx_ids.join(', ')}
                                                    </Badge>
                                                )}
                                            </HStack>
                                        )}
                                    </Flex>
                                </Flex>
                            </Box>
                        ))}
                    </VStack>

                    {/* Action Buttons */}
                    {!allResolved && (
                        <Flex justify="flex-end" gap={2}>
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
                        </Flex>
                    )}
                </>
            )}
        </Box>
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
        <Box p={compactMode ? 1 : 3}>
            {/* Time Filter */}
            {!compactMode && (
                <HStack mb={2} gap={2}>
                    <Text fontSize="2xs" fontWeight="bold">
                        Time Range:
                    </Text>
                    {(['week', '30d', '90d', 'all'] as TimeFilter[]).map(filter => (
                        <Button
                            key={filter}
                            size="xs"
                            variant={timeFilter === filter ? 'solid' : 'outline'}
                            colorScheme="blue"
                            onClick={() => setTimeFilter(filter)}
                            fontSize="2xs"
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
                </HStack>
            )}

            {/* Quick Actions */}
            {!compactMode && quickActions.length > 0 && (
                <Box mb={2} p={1.5} bg="purple.50" borderRadius="md" borderWidth="1px" borderColor="purple.200">
                    <HStack mb={0.5} px={0.5}>
                        <Text fontSize="2xs" fontWeight="bold" color="purple.700">
                            ⚡ Quick Actions
                        </Text>
                    </HStack>
                    <Flex gap={1} flexWrap="wrap">
                        {quickActions.map((action, idx) => (
                            <Button
                                key={idx}
                                size="xs"
                                colorScheme="purple"
                                variant="outline"
                                onClick={() => setConfirmAction(action)}
                                disabled={loading || bulkResolving}
                                px={1.5}
                                py={0.5}
                                h="auto"
                                fontSize="2xs"
                            >
                                <HStack gap={0.5}>
                                    <FiCheck size={10} />
                                    <Text fontSize="2xs">{action.label}</Text>
                                    <Badge colorPalette="purple" variant="solid" fontSize="2xs" px={1}>
                                        {action.groupsCount}g
                                    </Badge>
                                    <Badge colorPalette="purple" variant="subtle" fontSize="2xs" px={1}>
                                        {action.count}tx
                                    </Badge>
                                    {action.description && (
                                        <Badge colorPalette="gray" variant="subtle" fontSize="2xs" px={1}>
                                            {action.description}
                                        </Badge>
                                    )}
                                </HStack>
                            </Button>
                        ))}
                    </Flex>
                </Box>
            )}

            {/* Stats */}
            {response && (
                <Box mb={compactMode ? 1 : 2} p={compactMode ? 1.5 : 2} bg="blue.50" borderRadius="md"
                    fontSize={compactMode ? '2xs' : '2xs'}
                >
                    <Flex gap={4}>
                        <VStack align="start" gap={0}>
                            <Text fontSize="lg" fontWeight="bold" color="blue.700">
                                {response.total_groups}
                            </Text>
                            <Text fontSize="2xs" color="blue.600">
                                Unresolved Groups
                            </Text>
                        </VStack>
                        <VStack align="start" gap={0}>
                            <Text fontSize="lg" fontWeight="bold" color="green.700">
                                {response.groups.length - response.total_groups}
                            </Text>
                            <Text fontSize="2xs" color="green.600">
                                Resolved Groups
                            </Text>
                        </VStack>
                        <VStack align="start" gap={0}>
                            <Text fontSize="2xs" color="gray.700">
                                Time Tolerance: ±{response.time_tolerance_seconds}s
                            </Text>
                            <Text fontSize="2xs" color="gray.700">
                                Amount Tolerance: ±{response.amount_tolerance_percent}%
                            </Text>
                        </VStack>
                    </Flex>
                </Box>
            )}

            {/* Loading State */}
            {loading && !response && (
                <Flex justify="center" align="center" h="200px">
                    <Spinner size="xl" />
                </Flex>
            )}

            {/* Empty State */}
            {!loading && response && response.total_groups === 0 && (
                <Flex
                    direction="column"
                    align="center"
                    justify="center"
                    h="200px"
                    bg="green.50"
                    borderRadius="md"
                >
                    <FiCheck size={48} color="green" />
                    <Text fontSize="lg" fontWeight="bold" mt={3} color="green.700">
                        No Duplicates Found
                    </Text>
                    <Text fontSize="sm" color="green.600">
                        All transactions appear to be unique
                    </Text>
                </Flex>
            )}

            {/* Duplicate Groups */}
            {response && response.groups.length > 0 && (
                <VStack gap={0} align="stretch">
                    {response.groups.map(group => (
                        <DuplicateGroupRow
                            key={group.group_hash}
                            group={group}
                            onResolve={handleResolve}
                            onGroupUpdated={handleGroupUpdated}
                        />
                    ))}
                </VStack>
            )}

            {/* Bulk Resolution Confirmation Modal */}
            <Dialog.Root
                open={confirmAction !== null}
                onOpenChange={(e) => { if (!e.open) setConfirmAction(null); }}
                size="xl"
            >
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxW="900px">
                            <Dialog.Header>
                                <Dialog.Title>Confirm Bulk Resolution</Dialog.Title>
                            </Dialog.Header>

                            <Dialog.Body>
                                <VStack align="stretch" gap={3}>
                                    {/* Action Summary */}
                                    <Box p={3} bg="purple.50" borderRadius="md" borderWidth="1px" borderColor="purple.200">
                                        <HStack gap={2} mb={1}>
                                            <Text fontSize="sm" fontWeight="bold" color="purple.700">
                                                Action:
                                            </Text>
                                            <Badge colorPalette="purple" fontSize="sm" variant="solid">
                                                Keep {confirmAction?.label}
                                            </Badge>
                                        </HStack>
                                        <HStack gap={2} fontSize="xs" color="gray.600">
                                            <Badge colorPalette="purple" variant="subtle" fontSize="xs">
                                                {confirmAction?.groupsCount} groups
                                            </Badge>
                                            <Badge colorPalette="green" variant="subtle" fontSize="xs">
                                                {preview.reduce((sum, p) => sum + p.kept.length, 0)} kept
                                            </Badge>
                                            <Badge colorPalette="orange" variant="subtle" fontSize="xs">
                                                {preview.reduce((sum, p) => sum + p.merged.length, 0)} merged
                                            </Badge>
                                        </HStack>
                                    </Box>

                                    {/* Per-Group Preview */}
                                    <Box>
                                        <Text fontSize="sm" fontWeight="bold" mb={2}>
                                            Groups Preview:
                                        </Text>
                                        <VStack align="stretch" gap={2} maxH="400px" overflowY="auto">
                                            {preview.map((groupPreview, idx) => {
                                                const isExpanded = expandedGroups.has(groupPreview.group.group_hash);
                                                const firstTx = groupPreview.group.transactions[0];
                                                const assetPair = `${firstTx.source_asset_symbol}/${firstTx.source_price_quote_asset_symbol}`;
                                                const direction = firstTx.direction || 'unknown';

                                                return (
                                                    <Box
                                                        key={groupPreview.group.group_hash}
                                                        borderWidth="1px"
                                                        borderRadius="md"
                                                        borderColor="gray.200"
                                                        bg="white"
                                                    >
                                                        {/* Group Header */}
                                                        <Flex
                                                            p={2}
                                                            justify="space-between"
                                                            align="center"
                                                            cursor="pointer"
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
                                                            _hover={{ bg: "gray.50" }}
                                                        >
                                                            <HStack gap={1} flexWrap="wrap">
                                                                <IconButton
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    aria-label="Toggle group"
                                                                >
                                                                    {isExpanded ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                                                                </IconButton>
                                                                <Badge colorPalette="gray" fontSize="xs" fontFamily="mono">
                                                                    #{idx + 1}
                                                                </Badge>
                                                                <Badge colorPalette="purple" fontSize="xs" variant="subtle">
                                                                    {assetPair}
                                                                </Badge>
                                                                <Badge colorPalette={direction === 'inflow' ? 'green' : 'red'} fontSize="xs" variant="subtle">
                                                                    {direction}
                                                                </Badge>
                                                                <Badge colorPalette="orange" fontSize="xs">
                                                                    {groupPreview.group.transaction_count} dup
                                                                </Badge>
                                                            </HStack>
                                                            <HStack gap={1}>
                                                                <Badge colorPalette="green" fontSize="xs" variant="solid">
                                                                    ✓ {groupPreview.kept.length}
                                                                </Badge>
                                                                <Badge colorPalette="orange" fontSize="xs" variant="solid">
                                                                    → {groupPreview.merged.length}
                                                                </Badge>
                                                            </HStack>
                                                        </Flex>

                                                        {/* Expanded Content */}
                                                        {isExpanded && (
                                                            <Box p={2} pt={0}>
                                                                <Flex gap={2}>
                                                                    {/* Kept Column */}
                                                                    <Box flex={1} p={2} bg="green.50" borderRadius="md" borderWidth="1px" borderColor="green.200">
                                                                        <HStack gap={1} mb={2}>
                                                                            <Badge colorPalette="green" fontSize="xs" variant="solid">
                                                                                ✓ KEPT
                                                                            </Badge>
                                                                            <Text fontSize="xs" color="green.700">
                                                                                {groupPreview.kept.length}
                                                                            </Text>
                                                                        </HStack>
                                                                        <VStack align="stretch" gap={1}>
                                                                            {groupPreview.kept.slice(0, 3).map(tx => (
                                                                                <Box key={tx.id} p={1.5} bg="white" borderRadius="sm">
                                                                                    <HStack gap={1} flexWrap="wrap" fontSize="2xs">
                                                                                        <Badge colorPalette="purple" size="xs">
                                                                                            {tx.connector_type}
                                                                                        </Badge>
                                                                                        {tx.run_id && (
                                                                                            <Badge colorPalette="purple" size="xs" variant="subtle">
                                                                                                #{tx.run_id}
                                                                                            </Badge>
                                                                                        )}
                                                                                        <Badge colorPalette="cyan" size="xs">
                                                                                            {formatDate(tx.date_time)}
                                                                                        </Badge>
                                                                                        <Badge colorPalette="teal" size="xs">
                                                                                            {formatNumber(tx.quantity)}
                                                                                        </Badge>
                                                                                    </HStack>
                                                                                </Box>
                                                                            ))}
                                                                            {groupPreview.kept.length > 3 && (
                                                                                <Text fontSize="2xs" color="gray.500" textAlign="center">
                                                                                    +{groupPreview.kept.length - 3} more...
                                                                                </Text>
                                                                            )}
                                                                        </VStack>
                                                                    </Box>

                                                                    {/* Merged Column */}
                                                                    <Box flex={1} p={2} bg="orange.50" borderRadius="md" borderWidth="1px" borderColor="orange.200">
                                                                        <HStack gap={1} mb={2}>
                                                                            <Badge colorPalette="orange" fontSize="xs" variant="solid">
                                                                                → MERGED
                                                                            </Badge>
                                                                            <Text fontSize="xs" color="orange.700">
                                                                                {groupPreview.merged.length}
                                                                            </Text>
                                                                        </HStack>
                                                                        <VStack align="stretch" gap={1}>
                                                                            {groupPreview.merged.slice(0, 3).map(tx => (
                                                                                <Box key={tx.id} p={1.5} bg="white" borderRadius="sm">
                                                                                    <HStack gap={1} flexWrap="wrap" fontSize="2xs">
                                                                                        <Badge colorPalette="purple" size="xs">
                                                                                            {tx.connector_type}
                                                                                        </Badge>
                                                                                        {tx.run_id && (
                                                                                            <Badge colorPalette="purple" size="xs" variant="subtle">
                                                                                                #{tx.run_id}
                                                                                            </Badge>
                                                                                        )}
                                                                                        <Badge colorPalette="cyan" size="xs">
                                                                                            {formatDate(tx.date_time)}
                                                                                        </Badge>
                                                                                        <Badge colorPalette="teal" size="xs">
                                                                                            {formatNumber(tx.quantity)}
                                                                                        </Badge>
                                                                                    </HStack>
                                                                                </Box>
                                                                            ))}
                                                                            {groupPreview.merged.length > 3 && (
                                                                                <Text fontSize="2xs" color="gray.500" textAlign="center">
                                                                                    +{groupPreview.merged.length - 3} more...
                                                                                </Text>
                                                                            )}
                                                                        </VStack>
                                                                    </Box>
                                                                </Flex>
                                                            </Box>
                                                        )}
                                                    </Box>
                                                );
                                            })}
                                        </VStack>
                                    </Box>

                                    {/* Info Footer */}
                                    <Box p={2} bg="blue.50" borderRadius="md" fontSize="xs" color="blue.700" borderWidth="1px" borderColor="blue.200">
                                        ℹ️ Merged transactions will be marked as duplicates and linked to the kept transactions.
                                    </Box>
                                </VStack>
                            </Dialog.Body>

                            <Dialog.Footer>
                                <Flex gap={3}>
                                    <Button
                                        variant="outline"
                                        onClick={() => setConfirmAction(null)}
                                        disabled={bulkResolving}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        colorScheme="purple"
                                        onClick={() => confirmAction && handleBulkResolve(confirmAction)}
                                        loading={bulkResolving}
                                    >
                                        <FiCheck />
                                        Confirm & Resolve {confirmAction?.groupsCount} Groups
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>
        </Box>
    );
};
