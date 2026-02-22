import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    Spinner,
    Tabs,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    API_URL,
    Account,
    ConnectorRunDetail,
    ConnectorSyncStatus,
} from '../types';
import { DuplicateResolutionPanel } from './DuplicateResolutionPanel';
import { TransactionsTable } from './TransactionsTable';
import TransactionDetailDrawer from './TransactionDetailDrawer';
import { defaultFilterState } from './TransactionFilters';

interface ConnectorRunDetailPanelProps {
    runId: number;
    onBack?: () => void;
    accounts?: Account[];
    enablePolling?: boolean;  // Enable real-time polling for running connectors
}

const statusColorMap: Record<ConnectorSyncStatus, string> = {
    pending: 'yellow',
    queued: 'gray',
    running: 'blue',
    completed: 'green',
    failed: 'red',
    skipped: 'yellow',
};

const formatDuration = (startedAt?: string, finishedAt?: string): string => {
    if (!startedAt) return '-';
    const start = new Date(startedAt);
    const end = finishedAt ? new Date(finishedAt) : new Date();
    const durationMs = end.getTime() - start.getTime();
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
};

/**
 * ConnectorRunDetailPanel - Displays detailed information about a connector run.
 * Shows metrics, logs, and transaction lists (synced, updated, skipped, errors).
 * Supports real-time polling for in-progress connector runs.
 */
export const ConnectorRunDetailPanel: React.FC<ConnectorRunDetailPanelProps> = ({
    runId,
    onBack,
    accounts = [],
    enablePolling = false,
}) => {
    const [detail, setDetail] = useState<ConnectorRunDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [duplicateCount, setDuplicateCount] = useState<{
        group_count: number;
        transaction_count: number;
    } | null>(null);
    const [transactionDetailId, setTransactionDetailId] = useState<number | null>(null);
    const [isTransactionDrawerOpen, setIsTransactionDrawerOpen] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const pollingRef = useRef<NodeJS.Timeout | null>(null);

    const fetchDetail = useCallback(async () => {
        try {
            const response = await fetch(
                `${API_URL}/sync-job/connector-runs/${runId}`
            );
            if (!response.ok) throw new Error('Failed to fetch connector run detail');
            const data: ConnectorRunDetail = await response.json();
            setDetail(data);
            setLastUpdated(new Date());
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [runId]);

    const fetchDuplicateCount = useCallback(async () => {
        try {
            const response = await fetch(
                `${API_URL}/data-health/duplicate-count?connector_run_id=${runId}`
            );
            if (response.ok) {
                const data = await response.json();
                setDuplicateCount({
                    group_count: data.duplicate_group_count,
                    transaction_count: data.duplicate_transaction_count,
                });
            }
        } catch (err) {
            console.error('Failed to fetch duplicate count:', err);
        }
    }, [runId]);

    const togglePause = useCallback(() => {
        setIsPaused(prev => !prev);
    }, []);

    const handleManualRefresh = useCallback(() => {
        fetchDetail();
        fetchDuplicateCount();
    }, [fetchDetail, fetchDuplicateCount]);

    // Initial fetch
    useEffect(() => {
        fetchDetail();
        fetchDuplicateCount();
    }, [fetchDetail, fetchDuplicateCount]);

    // Real-time polling when enabled and connector is running
    useEffect(() => {
        if (enablePolling && detail?.status === 'running' && !isPaused) {
            pollingRef.current = setInterval(() => {
                fetchDetail();
            }, 3000);  // Poll every 3 seconds

            return () => {
                if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                }
            };
        }
    }, [enablePolling, detail?.status, isPaused, fetchDetail]);

    // Cleanup polling on unmount
    useEffect(() => {
        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
            }
        };
    }, []);

    if (loading) {
        return (
            <Flex justify="center" py={8}>
                <Spinner />
            </Flex>
        );
    }

    if (error || !detail) {
        return (
            <Box>
                {onBack && (
                    <Button size="sm" variant="ghost" onClick={onBack} mb={4}>
                        ← Back
                    </Button>
                )}
                <Text color="red.600">Error: {error || 'Not found'}</Text>
            </Box>
        );
    }

    return (
        <Box>
            {onBack && (
                <Button size="sm" variant="ghost" onClick={onBack} mb={4}>
                    ← Back
                </Button>
            )}

            <Flex justify="space-between" align="start" mb={4}>
                <VStack align="start" gap={1}>
                    <HStack gap={2}>
                        <Heading size="md">
                            {detail.connector_type || `Connector #${detail.connector_id}`}
                        </Heading>
                        <Badge colorPalette={statusColorMap[detail.status]}>
                            {detail.status}
                        </Badge>
                        {detail.test_mode && (
                            <Badge colorPalette="purple">Test Mode</Badge>
                        )}
                    </HStack>
                    <Text fontSize="sm" color="gray.500">
                        {detail.account_name || '-'}
                    </Text>
                </VStack>
            </Flex>

            {/* Refresh Control Bar - Only show for running connectors when polling is enabled */}
            {enablePolling && detail.status === 'running' && (
                <Box
                    mb={4}
                    p={3}
                    bg={isPaused ? 'yellow.50' : 'blue.50'}
                    borderRadius="md"
                    _dark={{ bg: isPaused ? 'yellow.900' : 'blue.900' }}
                >
                    <Flex justify="space-between" align="center" gap={4}>
                        <HStack gap={2}>
                            <Button
                                size="sm"
                                colorPalette={isPaused ? 'green' : 'yellow'}
                                onClick={togglePause}
                            >
                                {isPaused ? '▶️ Resume' : '⏸️ Pause'}
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={handleManualRefresh}
                                disabled={!isPaused}
                            >
                                🔄 Refresh Now
                            </Button>
                        </HStack>
                        <Text fontSize="xs" color="gray.600" _dark={{ color: 'gray.400' }}>
                            {isPaused ? (
                                'Auto-refresh paused'
                            ) : (
                                lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Auto-refreshing...'
                            )}
                        </Text>
                    </Flex>
                </Box>
            )}

            {/* Metrics */}
            <Box mb={6} p={4} bg="gray.50" borderRadius="md" _dark={{ bg: 'gray.800' }}>
                <Flex gap={6} wrap="wrap">
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">Duration</Text>
                        <Text fontWeight="medium">
                            {formatDuration(detail.started_at, detail.finished_at)}
                        </Text>
                    </VStack>
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">Processed</Text>
                        <Text fontWeight="medium">{detail.processed_count}</Text>
                    </VStack>
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">New</Text>
                        <Text fontWeight="medium" color="green.600">
                            +{detail.synced_count}
                        </Text>
                    </VStack>
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">Updated</Text>
                        <Text fontWeight="medium" color="blue.600">
                            {detail.updated_count}
                        </Text>
                    </VStack>
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">Skipped</Text>
                        <Text fontWeight="medium">{detail.skipped_count}</Text>
                    </VStack>
                    <VStack align="start" gap={0}>
                        <Text fontSize="xs" color="gray.500">Errors</Text>
                        <Text fontWeight="medium" color={detail.error_count > 0 ? 'red.600' : undefined}>
                            {detail.error_count}
                        </Text>
                    </VStack>
                    {duplicateCount && duplicateCount.group_count > 0 && (
                        <VStack align="start" gap={0}>
                            <Text fontSize="xs" color="gray.500">Duplicates</Text>
                            <HStack gap={1}>
                                <Text fontWeight="medium" color="orange.600">
                                    ⚠ {duplicateCount.group_count}
                                </Text>
                                <Text fontSize="xs" color="gray.400">
                                    ({duplicateCount.transaction_count} txs)
                                </Text>
                            </HStack>
                        </VStack>
                    )}
                </Flex>
            </Box>

            <Tabs.Root defaultValue="logs" variant="line" size="sm">
                <Tabs.List>
                    <Tabs.Trigger value="logs">
                        Logs ({detail.logs?.length || 0})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="synced">
                        Synced ({detail.synced_ids?.length || 0})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="updated">
                        Updated ({detail.updated_ids?.length || 0})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="skipped">
                        Skipped ({detail.skipped_ids?.length || 0})
                    </Tabs.Trigger>
                    {detail.error_details && detail.error_details.length > 0 && (
                        <Tabs.Trigger value="errors">
                            Errors ({detail.error_details.length})
                        </Tabs.Trigger>
                    )}
                    <Tabs.Trigger value="duplicates">
                        Duplicates{duplicateCount && duplicateCount.group_count > 0 ? ` (${duplicateCount.group_count})` : ''}
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="logs">
                    <Box maxH="300px" overflowY="auto" fontSize="xs" fontFamily="mono">
                        {!detail.logs || detail.logs.length === 0 ? (
                            <Text color="gray.500" py={4}>No logs available</Text>
                        ) : (
                            detail.logs.map((log, idx) => (
                                <Flex key={idx} gap={2} py={1} borderBottomWidth="1px">
                                    <Text color="gray.400" flexShrink={0}>
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </Text>
                                    <Badge
                                        size="sm"
                                        colorPalette={
                                            log.level === 'ERROR'
                                                ? 'red'
                                                : log.level === 'WARNING'
                                                    ? 'orange'
                                                    : 'gray'
                                        }
                                    >
                                        {log.level}
                                    </Badge>
                                    <Text>{log.message}</Text>
                                </Flex>
                            ))
                        )}
                    </Box>
                </Tabs.Content>

                <Tabs.Content value="synced">
                    <TransactionsTable
                        tableId="connectorRun-synced"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No new transactions"
                        filters={{
                            ...defaultFilterState,
                            connectorRunIds: [String(detail.id)],
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="updated">
                    <TransactionsTable
                        tableId="connectorRun-updated"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No updated transactions"
                        filters={{
                            ...defaultFilterState,
                            connectorRunIds: [String(detail.id)],
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="skipped">
                    <TransactionsTable
                        tableId="connectorRun-skipped"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No skipped transactions"
                        filters={{
                            ...defaultFilterState,
                            connectorRunIds: [String(detail.id)],
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="errors">
                    <Box maxH="300px" overflowY="auto">
                        {!detail.error_details || detail.error_details.length === 0 ? (
                            <Text color="gray.500" py={4}>No errors</Text>
                        ) : (
                            detail.error_details.map((err, idx) => (
                                <Box
                                    key={idx}
                                    p={2}
                                    mb={2}
                                    bg="red.50"
                                    borderRadius="md"
                                    _dark={{ bg: 'red.900' }}
                                >
                                    <Text fontSize="xs" fontFamily="mono" fontWeight="medium">
                                        {err.source_transaction_id}
                                    </Text>
                                    <Text fontSize="xs" color="red.600">
                                        {err.error}
                                    </Text>
                                </Box>
                            ))
                        )}
                    </Box>
                </Tabs.Content>

                <Tabs.Content value="duplicates">
                    <Box maxH="500px" overflowY="auto">
                        <DuplicateResolutionPanel
                            connectorRunId={detail.id}
                            compactMode={true}
                        />
                    </Box>
                </Tabs.Content>
            </Tabs.Root>

            {/* Transaction Detail Drawer */}
            {accounts.length > 0 && (
                <TransactionDetailDrawer
                    transactionId={transactionDetailId}
                    isOpen={isTransactionDrawerOpen}
                    onClose={() => {
                        setIsTransactionDrawerOpen(false);
                        setTransactionDetailId(null);
                    }}
                    accounts={accounts}
                />
            )}
        </Box>
    );
};
