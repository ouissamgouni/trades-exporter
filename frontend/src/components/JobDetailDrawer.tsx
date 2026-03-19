import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    IconButton,
    Spinner,
    Tabs,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    LuChevronRight,
    LuClock,
    LuRefreshCw,
    LuX,
} from 'react-icons/lu';
import {
    API_URL,
    Account,
    ConnectorProgress,
    ConnectorRunDetail,
    ConnectorRunSummary,
    ConnectorSyncStatus,
    SyncJobDetail,
    SyncJobProgress,
    SyncJobStatus,
} from '../types';
import { TransactionIdList } from './RawDataViewer';
import { DuplicateResolutionPanel } from './DuplicateResolutionPanel';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState } from './TransactionFilters';
import TransactionDetailDrawer from './TransactionDetailDrawer';

interface JobDetailDrawerProps {
    jobId: number | null;
    open: boolean;
    onClose: () => void;
    connectorIdFilter?: number;  // Optional: filter to specific connector
}

const statusColorMap: Record<SyncJobStatus | ConnectorSyncStatus, string> = {
    idle: 'gray',
    pending: 'yellow',
    queued: 'gray',
    running: 'blue',
    completed: 'green',
    warning: 'orange',
    aborted: 'orange',
    failed: 'red',
    skipped: 'yellow',
};

const formatDateTime = (dateStr?: string): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString();
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
 * Merge real-time connector status into DB connector run summary.
 * Maps field names from real-time API to DB API format.
 */
const mergeRealTimeIntoConnectorRun = (
    dbRun: ConnectorRunSummary,
    realTimeStatus: ConnectorProgress
): ConnectorRunSummary => {
    return {
        ...dbRun,
        status: realTimeStatus.status as ConnectorSyncStatus,
        started_at: realTimeStatus.started_at || dbRun.started_at,
        finished_at: realTimeStatus.finished_at || dbRun.finished_at,
        // Map real-time field names to DB field names
        processed_count: realTimeStatus.processed,
        synced_count: realTimeStatus.new_count,
        updated_count: realTimeStatus.updated_count,
        skipped_count: realTimeStatus.skipped_count,
        error_count: realTimeStatus.error_count ?? 0,
    };
};

interface ConnectorRunCardProps {
    run: ConnectorRunSummary;
    onExpand: () => void;
}

const ConnectorRunCard: React.FC<ConnectorRunCardProps> = ({ run, onExpand }) => {
    const [duplicateCount, setDuplicateCount] = useState<number | null>(null);

    useEffect(() => {
        const fetchDuplicateCount = async () => {
            try {
                const response = await fetch(
                    `${API_URL}/data-health/duplicate-count?connector_run_id=${run.id}`
                );
                if (response.ok) {
                    const data = await response.json();
                    if (data.duplicate_group_count > 0) {
                        setDuplicateCount(data.duplicate_group_count);
                    }
                }
            } catch (err) {
                console.error('Failed to fetch duplicate count:', err);
            }
        };

        fetchDuplicateCount();
    }, [run.id]);

    return (
        <Box
            p={3}
            borderWidth="1px"
            borderRadius="md"
            bg="gray.50"
            _dark={{ bg: 'gray.800' }}
            cursor="pointer"
            onClick={onExpand}
            _hover={{ bg: 'gray.100', _dark: { bg: 'gray.700' } }}
        >
            <Flex justify="space-between" align="center">
                <HStack gap={3}>
                    <Badge colorPalette={statusColorMap[run.status]}>
                        {run.status}
                    </Badge>
                    <VStack align="start" gap={0}>
                        <Text fontWeight="medium" fontSize="sm">
                            {run.connector_type || `Connector #${run.connector_id}`}
                        </Text>
                        <Text fontSize="xs" color="gray.500">
                            {run.account_name || '-'}
                        </Text>
                        <Text fontSize="xs" color="gray.400">
                            ID: {run.connector_id}
                        </Text>
                    </VStack>
                    {run.test_mode && (
                        <Badge colorPalette="purple" size="sm">
                            Test
                        </Badge>
                    )}
                    {duplicateCount !== null && duplicateCount > 0 && (
                        <Badge colorPalette="orange" size="sm">
                            ⚠ {duplicateCount} Duplicate{duplicateCount > 1 ? 's' : ''}
                        </Badge>
                    )}
                </HStack>
                <HStack gap={4} fontSize="sm">
                    <VStack align="end" gap={0}>
                        <Text color="gray.500">Processed</Text>
                        <Text fontWeight="medium">{run.processed_count}</Text>
                    </VStack>
                    <VStack align="end" gap={0}>
                        <Text color="green.600">New</Text>
                        <Text fontWeight="medium" color="green.600">
                            +{run.synced_count}
                        </Text>
                    </VStack>
                    <VStack align="end" gap={0}>
                        <Text color="blue.600">Updated</Text>
                        <Text fontWeight="medium" color="blue.600">
                            {run.updated_count}
                        </Text>
                    </VStack>
                    {run.error_count > 0 && (
                        <VStack align="end" gap={0}>
                            <Text color="red.600">Errors</Text>
                            <Text fontWeight="medium" color="red.600">
                                {run.error_count}
                            </Text>
                        </VStack>
                    )}
                    <LuChevronRight />
                </HStack>
            </Flex>
        </Box>
    );
};

interface ConnectorRunDetailViewProps {
    runId: number;
    onBack: () => void;
    accounts: Account[];
}

const ConnectorRunDetailView: React.FC<ConnectorRunDetailViewProps> = ({
    runId,
    onBack,
    accounts,
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

    const fetchDetail = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(
                `${API_URL}/sync-job/connector-runs/${runId}`
            );
            if (!response.ok) throw new Error('Failed to fetch connector run detail');
            const data: ConnectorRunDetail = await response.json();
            setDetail(data);
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

    useEffect(() => {
        fetchDetail();
        fetchDuplicateCount();
    }, [fetchDetail, fetchDuplicateCount]);

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
                <Button size="sm" variant="ghost" onClick={onBack} mb={4}>
                    ← Back to Job
                </Button>
                <Text color="red.600">Error: {error || 'Not found'}</Text>
            </Box>
        );
    }

    return (
        <Box>
            <Button size="sm" variant="ghost" onClick={onBack} mb={4}>
                ← Back to Job
            </Button>

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
                        Logs ({detail.logs.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="synced">
                        Synced ({detail.synced_ids.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="updated">
                        Updated ({detail.updated_ids.length})
                    </Tabs.Trigger>
                    <Tabs.Trigger value="skipped">
                        Skipped ({detail.skipped_ids.length})
                    </Tabs.Trigger>
                    {detail.error_details.length > 0 && (
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
                        {detail.logs.length === 0 ? (
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
                        tableId="jobDetail-synced"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No new transactions"
                        filters={{
                            ...defaultFilterState,
                            reviewStatus: [],
                            connectorRunIds: [String(detail.id)],
                            connectorRunOutcome: 'synced',
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="updated">
                    <TransactionsTable
                        tableId="jobDetail-updated"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No updated transactions"
                        filters={{
                            ...defaultFilterState,
                            reviewStatus: [],
                            connectorRunIds: [String(detail.id)],
                            connectorRunOutcome: 'updated',
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="skipped">
                    <TransactionsTable
                        tableId="jobDetail-skipped"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        emptyMessage="No skipped transactions"
                        filters={{
                            ...defaultFilterState,
                            reviewStatus: [],
                            connectorRunIds: [String(detail.id)],
                            connectorRunOutcome: 'skipped',
                        }}
                        onDataChange={fetchDetail}
                    />
                </Tabs.Content>

                <Tabs.Content value="errors">
                    <Box maxH="300px" overflowY="auto">
                        {detail.error_details.map((err, idx) => (
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
                        ))}
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
            <TransactionDetailDrawer
                transactionId={transactionDetailId}
                isOpen={isTransactionDrawerOpen}
                onClose={() => {
                    setIsTransactionDrawerOpen(false);
                    setTransactionDetailId(null);
                }}
                accounts={accounts}
            />
        </Box>
    );
};

export const JobDetailDrawer: React.FC<JobDetailDrawerProps> = ({
    jobId,
    open,
    onClose,
}) => {
    const [job, setJob] = useState<SyncJobDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
    const [realTimeStatus, setRealTimeStatus] = useState<SyncJobProgress | null>(null);
    const [accounts, setAccounts] = useState<Account[]>([]);
    const pollingRef = useRef<NodeJS.Timeout | null>(null);

    // Resizable width state
    const [drawerWidth, setDrawerWidth] = useState<number>(() => {
        const saved = localStorage.getItem('jobDetailDrawerWidth');
        return saved ? parseInt(saved, 10) : 900;
    });
    const [isResizing, setIsResizing] = useState(false);
    const resizeStartX = useRef<number>(0);
    const resizeStartWidth = useRef<number>(0);

    // Fetch job details from database
    const fetchJob = useCallback(async () => {
        setLoading(true);
        setError(null);
        setSelectedRunId(null);
        try {
            let response;
            if (jobId) {
                // Fetch specific job
                response = await fetch(`${API_URL}/sync-job/jobs/${jobId}`);
            } else {
                // Fetch latest job from history
                const historyResponse = await fetch(`${API_URL}/sync-job/history?limit=1&offset=0`);
                if (historyResponse.ok) {
                    const historyData = await historyResponse.json();
                    if (historyData.jobs && historyData.jobs.length > 0) {
                        const latestJobId = historyData.jobs[0].id;
                        response = await fetch(`${API_URL}/sync-job/jobs/${latestJobId}`);
                    } else {
                        setError('No jobs found');
                        setLoading(false);
                        return;
                    }
                } else {
                    setError('Failed to fetch job history');
                    setLoading(false);
                    return;
                }
            }
            if (!response.ok) throw new Error('Failed to fetch job detail');
            const data: SyncJobDetail = await response.json();
            setJob(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [jobId]);

    // Fetch real-time status for active job
    const fetchRealTimeStatus = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/sync-job/status`);
            if (!response.ok) return;
            const data: SyncJobProgress = await response.json();
            // Only use real-time status if this is the currently active job
            if (data.job_id === jobId && data.status === 'running') {
                setRealTimeStatus(data);
            } else {
                setRealTimeStatus(null);
            }
        } catch (err) {
            console.error('Failed to fetch real-time status:', err);
        }
    }, [jobId]);

    // Fetch accounts
    const fetchAccounts = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/accounts?limit=1000`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
    }, []);

    // Resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setIsResizing(true);
        resizeStartX.current = e.clientX;
        resizeStartWidth.current = drawerWidth;
    }, [drawerWidth]);

    const handleResizeMove = useCallback((e: MouseEvent) => {
        if (!isResizing) return;
        const deltaX = resizeStartX.current - e.clientX;
        const newWidth = Math.max(600, Math.min(window.innerWidth * 0.95, resizeStartWidth.current + deltaX));
        setDrawerWidth(newWidth);
    }, [isResizing]);

    const handleResizeEnd = useCallback(() => {
        if (!isResizing) return;
        setIsResizing(false);
        localStorage.setItem('jobDetailDrawerWidth', drawerWidth.toString());
    }, [isResizing, drawerWidth]);

    // Add/remove resize event listeners
    useEffect(() => {
        if (isResizing) {
            document.addEventListener('mousemove', handleResizeMove);
            document.addEventListener('mouseup', handleResizeEnd);
            return () => {
                document.removeEventListener('mousemove', handleResizeMove);
                document.removeEventListener('mouseup', handleResizeEnd);
            };
        }
    }, [isResizing, handleResizeMove, handleResizeEnd]);

    useEffect(() => {
        if (open) {
            fetchJob();
            fetchRealTimeStatus();
            fetchAccounts();
        }
    }, [open, jobId, fetchJob, fetchRealTimeStatus, fetchAccounts]);

    // Poll for real-time status updates when viewing a running job
    useEffect(() => {
        if (open && job?.status === 'running') {
            // Initial fetch
            fetchRealTimeStatus();
            // Start polling every 1 second
            pollingRef.current = setInterval(fetchRealTimeStatus, 1000);
            return () => {
                if (pollingRef.current) {
                    clearInterval(pollingRef.current);
                    pollingRef.current = null;
                }
            };
        } else {
            // Stop polling if job is not running
            if (pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
            }
            setRealTimeStatus(null);
        }
    }, [open, job?.status, fetchRealTimeStatus]);

    // Compute merged job data (DB + real-time for active job)
    const mergedJob: SyncJobDetail | null = React.useMemo(() => {
        if (!job) return null;
        if (!realTimeStatus || realTimeStatus.job_id !== jobId) return job;

        // Merge real-time stats into job
        const mergedConnectorRuns = job.connector_runs.map((run) => {
            const realTimeConnector = realTimeStatus.connector_statuses?.[run.connector_id];
            if (realTimeConnector) {
                return mergeRealTimeIntoConnectorRun(run, realTimeConnector);
            }
            return run;
        });

        return {
            ...job,
            status: realTimeStatus.status as SyncJobStatus,
            total_processed: realTimeStatus.total_processed,
            total_new: realTimeStatus.new_entries_added,
            total_updated: realTimeStatus.entries_updated,
            total_skipped: realTimeStatus.duplicates_skipped,
            total_errors: realTimeStatus.error_count,
            connector_runs: mergedConnectorRuns,
        };
    }, [job, realTimeStatus, jobId]);

    if (!open) return null;

    return (
        <>
            {/* Backdrop */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={1000}
                onClick={onClose}
            />

            {/* Drawer Panel */}
            <Box
                position="fixed"
                top={0}
                right={0}
                bottom={0}
                width={`${drawerWidth}px`}
                maxW="95vw"
                bg="white"
                _dark={{ bg: 'gray.900' }}
                boxShadow="xl"
                zIndex={1001}
                overflow="hidden"
                display="flex"
                flexDirection="column"
            >
                {/* Resize Handle */}
                <Box
                    position="absolute"
                    left={0}
                    top={0}
                    bottom={0}
                    width="4px"
                    cursor="col-resize"
                    bg={isResizing ? 'blue.400' : 'transparent'}
                    _hover={{ bg: 'blue.200' }}
                    transition="background-color 0.2s"
                    onMouseDown={handleResizeStart}
                    zIndex={1}
                />
                {/* Resize Handle */}
                <Box
                    position="absolute"
                    left={0}
                    top={0}
                    bottom={0}
                    width="4px"
                    cursor="col-resize"
                    bg={isResizing ? 'blue.400' : 'transparent'}
                    _hover={{ bg: 'blue.200' }}
                    transition="background-color 0.2s"
                    onMouseDown={handleResizeStart}
                    zIndex={1}
                />
                {/* Header */}
                <Flex
                    px={4}
                    py={3}
                    borderBottomWidth="1px"
                    align="center"
                    justify="space-between"
                >
                    <HStack gap={2}>
                        <Heading size="md">
                            {mergedJob ? `Job #${mergedJob.id}` : 'Job Details'}
                        </Heading>
                        {mergedJob?.renormalize && (
                            <Badge colorPalette="purple" size="sm">
                                Re-Normalize
                            </Badge>
                        )}
                        {realTimeStatus && (
                            <Badge colorPalette="blue" size="sm">
                                Live
                            </Badge>
                        )}
                    </HStack>
                    <IconButton
                        aria-label="Close"
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                    >
                        <LuX />
                    </IconButton>
                </Flex>

                {/* Body */}
                <Box flex={1} overflow="auto" p={4}>
                    {loading && (
                        <Flex justify="center" py={8}>
                            <Spinner size="lg" />
                        </Flex>
                    )}

                    {error && (
                        <Box p={4} bg="red.50" borderRadius="md">
                            <Text color="red.600">Error: {error}</Text>
                            <Button size="sm" mt={2} onClick={fetchJob}>
                                Retry
                            </Button>
                        </Box>
                    )}

                    {!loading && !error && mergedJob && (
                        <>
                            {selectedRunId ? (
                                <ConnectorRunDetailView
                                    runId={selectedRunId}
                                    onBack={() => setSelectedRunId(null)}
                                    accounts={accounts}
                                />
                            ) : (
                                <>
                                    {/* Job Header */}
                                    <Flex justify="space-between" align="start" mb={4}>
                                        <VStack align="start" gap={1}>
                                            <HStack gap={2}>
                                                <Badge
                                                    colorPalette={statusColorMap[mergedJob.status]}
                                                    size="lg"
                                                >
                                                    {mergedJob.status}
                                                </Badge>
                                                {mergedJob.renormalize && (
                                                    <Badge colorPalette="purple" size="sm">
                                                        Re-Normalize
                                                    </Badge>
                                                )}
                                                {mergedJob.error_message && (
                                                    <Text fontSize="sm" color="red.600">
                                                        {mergedJob.error_message}
                                                    </Text>
                                                )}
                                            </HStack>
                                            <HStack gap={4} fontSize="xs" color="gray.500">
                                                <HStack gap={1}>
                                                    <LuClock size={12} />
                                                    <Text>Started: {formatDateTime(mergedJob.started_at)}</Text>
                                                </HStack>
                                                {mergedJob.finished_at ? (
                                                    <Text>
                                                        Duration: {formatDuration(mergedJob.started_at, mergedJob.finished_at)}
                                                    </Text>
                                                ) : mergedJob.status === 'running' ? (
                                                    <Text>
                                                        Running: {formatDuration(mergedJob.started_at)}
                                                    </Text>
                                                ) : null}
                                            </HStack>
                                        </VStack>
                                        <IconButton
                                            aria-label="Refresh"
                                            size="sm"
                                            variant="ghost"
                                            onClick={fetchJob}
                                        >
                                            <LuRefreshCw />
                                        </IconButton>
                                    </Flex>

                                    {/* Summary Metrics */}
                                    <Box
                                        mb={6}
                                        p={4}
                                        bg="gray.50"
                                        borderRadius="md"
                                        _dark={{ bg: 'gray.800' }}
                                    >
                                        <Flex gap={6} wrap="wrap">
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    Connectors
                                                </Text>
                                                <Text fontWeight="medium">
                                                    {mergedJob.total_connectors}
                                                </Text>
                                            </VStack>
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    Processed
                                                </Text>
                                                <Text fontWeight="medium">
                                                    {mergedJob.total_processed.toLocaleString()}
                                                </Text>
                                            </VStack>
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    New
                                                </Text>
                                                <Text fontWeight="medium" color="green.600">
                                                    +{mergedJob.total_new}
                                                </Text>
                                            </VStack>
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    Updated
                                                </Text>
                                                <Text fontWeight="medium" color="blue.600">
                                                    {mergedJob.total_updated}
                                                </Text>
                                            </VStack>
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    Skipped
                                                </Text>
                                                <Text fontWeight="medium">
                                                    {mergedJob.total_skipped}
                                                </Text>
                                            </VStack>
                                            <VStack align="start" gap={0}>
                                                <Text fontSize="xs" color="gray.500">
                                                    Errors
                                                </Text>
                                                <Text
                                                    fontWeight="medium"
                                                    color={mergedJob.total_errors > 0 ? 'red.600' : undefined}
                                                >
                                                    {mergedJob.total_errors}
                                                </Text>
                                            </VStack>
                                        </Flex>
                                    </Box>

                                    {/* Connector Runs */}
                                    <Heading size="sm" mb={3}>
                                        Connector Runs
                                    </Heading>
                                    <VStack align="stretch" gap={2}>
                                        {mergedJob.connector_runs.map((run) => (
                                            <ConnectorRunCard
                                                key={run.id}
                                                run={run}
                                                onExpand={() => setSelectedRunId(run.id)}
                                            />
                                        ))}
                                    </VStack>

                                    {mergedJob.connector_runs.length === 0 && (
                                        <Text color="gray.500" py={4}>
                                            No connector runs found
                                        </Text>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </Box>
            </Box>
        </>
    );
};
