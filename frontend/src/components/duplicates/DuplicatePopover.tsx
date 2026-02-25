/**
 * DuplicatePopover
 *
 * Popover displaying duplicate group details for a transaction.
 * Lazy-fetches full transaction details on open, then shows them
 * in the same badge-based card layout with checkbox selection and
 * Keep Selected / Dismiss Selected actions as the Data Health panel.
 */

import React, { useCallback, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Checkbox,
    Flex,
    HStack,
    Popover,
    Portal,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import { FiCheck, FiX } from 'react-icons/fi';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, TransactionSummary } from '../../types';
import { toaster } from '../ui/toaster';

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
// Utility helpers (same as DuplicateResolutionPanel)
// ---------------------------------------------------------------------------

const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return 'N/A';
    try {
        const date = new Date(dateStr);
        const month = date.toLocaleDateString('en-US', { month: 'short' });
        const day = date.getDate();
        const time = date.toLocaleTimeString('en-US', {
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
        });
        return `${month} ${day}, ${time}`;
    } catch {
        return dateStr.slice(0, 16);
    }
};

const formatNumber = (num: number | null | undefined): string => {
    if (num == null) return 'N/A';
    if (Math.abs(num - Math.round(num)) < 0.000001) return Math.round(num).toString();
    if (num >= 1) return num.toFixed(Math.min(2, 8 - Math.floor(Math.log10(num))));
    if (num >= 0.0001) return num.toFixed(6);
    return num.toExponential(2);
};

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

    const handleOpenChange = (details: { open: boolean }) => {
        onOpenChange(details.open);
        if (details.open) {
            fetchGroupDetail();
        } else {
            setSelectedIds(new Set()); // reset selection on close
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

            onOpenChange(false);
            setGroupDetail(null);
            setSelectedIds(new Set());
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
        <Popover.Root
            open={open}
            onOpenChange={handleOpenChange}
            positioning={{ placement: 'right-start' }}
        >
            <Popover.Trigger asChild>
                {children}
            </Popover.Trigger>
            <Portal>
                <Popover.Positioner>
                    <Popover.Content
                        width="420px"
                        shadow="lg"
                        borderWidth={1}
                        borderColor={allResolved ? 'green.300' : 'orange.200'}
                        bg="white"
                        p={0}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                        <Popover.Arrow>
                            <Popover.ArrowTip />
                        </Popover.Arrow>

                        {/* Header – badge row matching DuplicateGroupRow */}
                        <Box p={2} bg={allResolved ? 'green.50' : 'orange.25'} borderBottomWidth={1} borderColor={allResolved ? 'green.200' : 'orange.100'}>
                            <Flex justify="space-between" align="center">
                                <HStack gap={1} flexWrap="wrap" flex={1}>
                                    {allResolved && (
                                        <Badge colorPalette="green" fontSize="2xs" px={1.5} py={0.5} variant="solid">
                                            ✓ Resolved
                                        </Badge>
                                    )}
                                    {loading || !firstTx ? (
                                        <>
                                            <Badge colorPalette="orange" fontSize="2xs" px={1.5} py={0.5}>
                                                {transactionIds.length} Duplicates
                                            </Badge>
                                            <Badge colorPalette="gray" variant="outline" fontSize="2xs" fontFamily="mono">
                                                {groupHash.substring(0, 8)}
                                            </Badge>
                                        </>
                                    ) : (
                                        <>
                                            <Badge colorPalette="orange" fontSize="2xs" px={1.5} py={0.5}>
                                                {transactions.length} Duplicates
                                            </Badge>
                                            <Badge colorPalette="purple" variant="subtle" fontSize="2xs">
                                                {firstTx.source_asset_symbol}/{firstTx.source_price_quote_asset_symbol}
                                            </Badge>
                                            {firstTx.direction && (
                                                <Badge
                                                    colorPalette={firstTx.direction === 'inflow' ? 'green' : 'red'}
                                                    variant="subtle"
                                                    fontSize="2xs"
                                                >
                                                    {firstTx.direction}
                                                </Badge>
                                            )}
                                            <Badge colorPalette="teal" variant="solid" fontSize="2xs">
                                                {formatNumber(firstTx.quantity)} @ {formatNumber(firstTx.price)}
                                            </Badge>
                                            {sourceCount > 0 && (
                                                <Badge colorPalette="blue" variant="solid" fontSize="2xs">
                                                    {sourceCount} source{sourceCount !== 1 ? 's' : ''}
                                                </Badge>
                                            )}
                                            {unresolvedTxs.length > 0 && unresolvedTxs.length < transactions.length && (
                                                <Badge colorPalette="orange" variant="outline" fontSize="2xs">
                                                    {unresolvedTxs.length} unresolved
                                                </Badge>
                                            )}
                                            <Badge colorPalette="gray" variant="outline" fontSize="2xs" fontFamily="mono">
                                                {groupHash.substring(0, 8)}
                                            </Badge>
                                        </>
                                    )}
                                </HStack>
                                {!allResolved && selectedIds.size > 0 && (
                                    <Badge colorPalette="blue" variant="subtle" fontSize="2xs" ml={1}>
                                        {selectedIds.size} selected
                                    </Badge>
                                )}
                            </Flex>
                        </Box>

                        {/* Content */}
                        <Box p={2} maxH="380px" overflowY="auto">
                            {loading ? (
                                <Flex justify="center" py={4}>
                                    <Spinner size="sm" />
                                    <Text fontSize="xs" color="gray.500" ml={2}>
                                        Loading details…
                                    </Text>
                                </Flex>
                            ) : transactions.length > 0 ? (
                                <>
                                    {/* Smart Suggestions – same as DuplicateGroupRow */}
                                    {connectorBreakdown.length > 1 && !allResolved && (
                                        <Box mb={2} p={2} bg="blue.50" borderRadius="md">
                                            <Text fontSize="xs" fontWeight="bold" mb={1.5} color="blue.700">
                                                Smart Suggestions:
                                            </Text>
                                            <Flex gap={1.5} flexWrap="wrap">
                                                {connectorBreakdown.map((breakdown, idx) => (
                                                    <Button
                                                        key={idx}
                                                        size="xs"
                                                        variant="outline"
                                                        colorPalette="blue"
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
                                            </Flex>
                                        </Box>
                                    )}

                                    {/* Transaction List with checkboxes */}
                                    <VStack gap={2} align="stretch">
                                        {transactions.map(tx => (
                                            <Box
                                                key={tx.id}
                                                borderWidth="1px"
                                                borderColor={selectedIds.has(tx.id) ? 'blue.300' : 'gray.200'}
                                                borderRadius="md"
                                                p={2}
                                                bg={selectedIds.has(tx.id) ? 'blue.50' : 'white'}
                                            >
                                                <Flex gap={2} align="flex-start">
                                                    {/* Checkbox */}
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
                                                        {/* Connector Info – purple box */}
                                                        <HStack gap={1} flexWrap="wrap">
                                                            <Box borderWidth="1px" borderColor="purple.200" borderRadius="md" px={1.5} py={0.5} bg="purple.50">
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

                                                        {/* Transaction Details – blue box */}
                                                        <Box borderWidth="1px" borderColor="blue.200" borderRadius="md" px={1.5} py={0.5} bg="blue.50">
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
                                </>
                            ) : (
                                <Text fontSize="xs" color="gray.500" fontStyle="italic">
                                    {transactionIds.length} transactions in group (details loading…)
                                </Text>
                            )}
                        </Box>

                        {/* Action Buttons – Keep Selected / Dismiss Selected */}
                        {!loading && !allResolved && (
                            <Box p={2} borderTopWidth={1} borderColor="gray.100">
                                <Flex justify="flex-end" gap={2}>
                                    <Button
                                        size="xs"
                                        colorPalette="green"
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
                                        size="xs"
                                        colorPalette="gray"
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
                                </Flex>
                            </Box>
                        )}
                    </Popover.Content>
                </Popover.Positioner>
            </Portal>
        </Popover.Root>
    );
};

export default DuplicatePopover;
