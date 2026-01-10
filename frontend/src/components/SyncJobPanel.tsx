import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    Heading,
    HStack,
    Progress,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuChevronDown, LuChevronUp, LuEye, LuHistory } from 'react-icons/lu';
import {
    API_URL,
    ConnectorOverride,
    ConnectorProgress,
    ConnectorsInfo,
    ConnectorSyncStatus,
    JobHistoryResponse,
    SyncJobProgress,
    SyncJobStartRequest,
    SyncJobStartResponse,
    SyncJobSummary,
} from '../types';
import { ConnectorProgressCard } from './ConnectorProgressCard';
import { JobDetailDrawer } from './JobDetailDrawer';
import { JobHistoryTable } from './JobHistoryTable';
import { SyncConfigPanel } from './SyncConfigPanel';
import { toaster } from './ui/toaster';

// Status badge color helper
const getJobStatusColor = (status: string): string => {
    switch (status) {
        case 'idle': return 'gray';
        case 'running': return 'blue';
        case 'completed': return 'green';
        case 'aborted': return 'orange';
        case 'failed': return 'red';
        default: return 'gray';
    }
};

// Format duration helper
const formatDuration = (startedAt?: string, finishedAt?: string): string => {
    if (!startedAt) return '-';
    const start = new Date(startedAt);
    const end = finishedAt ? new Date(finishedAt) : new Date();
    const durationMs = end.getTime() - start.getTime();
    const seconds = Math.floor(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
};

// Format relative time
const formatRelativeTime = (dateStr?: string): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// Inline recent job row component
interface RecentJobRowProps {
    job: SyncJobSummary;
    onView: () => void;
}

const RecentJobRow: React.FC<RecentJobRowProps> = ({ job, onView }) => (
    <Flex
        align="center"
        justify="space-between"
        p={2}
        borderRadius="md"
        bg="gray.50"
        _dark={{ bg: 'gray.800' }}
        _hover={{ bg: 'gray.100', _dark: { bg: 'gray.700' } }}
        cursor="pointer"
        onClick={onView}
    >
        <HStack gap={3}>
            <Badge colorPalette={getJobStatusColor(job.status)} size="sm">
                {job.status}
            </Badge>
            <Text fontSize="sm" color="gray.500">
                {formatRelativeTime(job.started_at)}
            </Text>
        </HStack>
        <HStack gap={4}>
            <HStack gap={1}>
                <Text fontSize="sm" fontWeight="medium" color="green.600">
                    +{job.total_new}
                </Text>
                <Text fontSize="sm" color="gray.400">/</Text>
                <Text fontSize="sm" fontWeight="medium" color="blue.600">
                    ↻{job.total_updated}
                </Text>
                {job.total_errors > 0 && (
                    <>
                        <Text fontSize="sm" color="gray.400">/</Text>
                        <Text fontSize="sm" fontWeight="medium" color="red.600">
                            ✗{job.total_errors}
                        </Text>
                    </>
                )}
            </HStack>
            <Text fontSize="xs" color="gray.400">
                {formatDuration(job.started_at, job.finished_at)}
            </Text>
            <LuEye size={14} color="gray" />
        </HStack>
    </Flex>
);

export const SyncJobPanel: React.FC = () => {
    const queryClient = useQueryClient();
    const [jobStatus, setJobStatus] = useState<SyncJobProgress | null>(null);
    const [connectors, setConnectors] = useState<ConnectorsInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState(false);
    const [retryLoading, setRetryLoading] = useState<number | null>(null);

    // Per-sync configuration overrides
    const [syncOverrides, setSyncOverrides] = useState<ConnectorOverride[]>([]);

    // Job history state
    const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
    const [jobDrawerOpen, setJobDrawerOpen] = useState(false);
    const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState(0);
    const [recentJobs, setRecentJobs] = useState<SyncJobSummary[]>([]);
    const [showFullHistory, setShowFullHistory] = useState(false);

    // Track previous status to detect completion
    const prevStatusRef = useRef<string | null>(null);

    // Fetch job status
    const fetchJobStatus = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/sync-job/status`);
            if (!response.ok) throw new Error('Failed to fetch job status');
            const data: SyncJobProgress = await response.json();
            setJobStatus(data);
            setError(null);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, []);

    // Fetch available connectors
    const fetchConnectors = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/sync-job/connectors`);
            if (response.ok) {
                const data: ConnectorsInfo = await response.json();
                setConnectors(data);
            }
        } catch (err) {
            console.error('Failed to fetch connectors:', err);
        }
    }, []);

    // Fetch recent jobs for inline summary
    const fetchRecentJobs = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/sync-job/history?limit=5&offset=0`);
            if (response.ok) {
                const data: JobHistoryResponse = await response.json();
                setRecentJobs(data.jobs);
            }
        } catch (err) {
            console.error('Failed to fetch recent jobs:', err);
        }
    }, []);

    // Initial load and polling
    useEffect(() => {
        fetchJobStatus();
        fetchConnectors();
        fetchRecentJobs();
    }, [fetchJobStatus, fetchConnectors, fetchRecentJobs]);

    // Poll for status updates when job is running
    useEffect(() => {
        if (jobStatus?.status === 'running') {
            const interval = setInterval(fetchJobStatus, 500);
            return () => clearInterval(interval);
        }
    }, [jobStatus?.status, fetchJobStatus]);

    // Trigger transaction refresh when sync job completes
    useEffect(() => {
        const currentStatus = jobStatus?.status;
        const prevStatus = prevStatusRef.current;

        // Detect transition from running to completed/failed/aborted
        if (prevStatus === 'running' && (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'aborted')) {
            console.log('🔄 Sync completed, refreshing transactions...');
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            // Refresh job history when job finishes
            setHistoryRefreshTrigger(prev => prev + 1);
            fetchRecentJobs();
        }

        prevStatusRef.current = currentStatus ?? null;
    }, [jobStatus?.status, queryClient]);

    // Start a new sync job
    const startJob = async () => {
        setActionLoading(true);
        try {
            const requestBody: SyncJobStartRequest = {};
            if (syncOverrides.length > 0) {
                requestBody.connector_overrides = syncOverrides;
            }

            const response = await fetch(`${API_URL}/sync-job/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to start job');
            }
            const data: SyncJobStartResponse = await response.json();
            console.log('Job started:', data);
            // Immediately fetch status
            await fetchJobStatus();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to start job',
            });
        } finally {
            setActionLoading(false);
        }
    };

    // Abort the running job
    const abortJob = async () => {
        setActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/sync-job/abort`, {
                method: 'POST',
            });
            if (!response.ok) throw new Error('Failed to abort job');
            await fetchJobStatus();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to abort job',
            });
        } finally {
            setActionLoading(false);
        }
    };

    // Retry a failed connector
    const retryConnector = async (connectorId: number) => {
        setRetryLoading(connectorId);
        try {
            const response = await fetch(`${API_URL}/sync-job/retry/${connectorId}`, {
                method: 'POST',
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to retry connector');
            }
            const data = await response.json();
            console.log('Retry started:', data);
            // Start polling
            await fetchJobStatus();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to retry connector',
            });
        } finally {
            setRetryLoading(null);
        }
    };

    // Status badge color
    const getStatusColor = (status: string): string => {
        switch (status) {
            case 'idle':
                return 'gray';
            case 'running':
                return 'blue';
            case 'completed':
                return 'green';
            case 'aborted':
                return 'orange';
            case 'failed':
                return 'red';
            default:
                return 'gray';
        }
    };

    // Format date/time
    const formatDateTime = (dateStr: string | undefined): string => {
        if (!dateStr) return '-';
        return new Date(dateStr).toLocaleString();
    };

    // Calculate progress percentage
    const getProgressPercent = (): number => {
        if (!jobStatus || jobStatus.total_connectors === 0) return 0;
        return Math.round(
            (jobStatus.connectors_completed.length / jobStatus.total_connectors) * 100
        );
    };

    // Get sorted connector statuses
    const getSortedConnectorStatuses = (): ConnectorProgress[] => {
        if (!jobStatus?.connector_statuses) return [];
        return Object.values(jobStatus.connector_statuses).sort((a, b) => {
            // Sort by status priority: running first, then pending, then completed, then failed, then skipped
            const statusOrder: Record<ConnectorSyncStatus, number> = {
                running: 0,
                pending: 1,
                queued: 2,
                completed: 3,
                failed: 4,
                skipped: 5,
            };
            return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
        });
    };

    const isRunning = jobStatus?.status === 'running';
    const canStart = !isRunning && !actionLoading;
    const hasFailedConnectors = getSortedConnectorStatuses().some(
        (c) => c.status === 'failed'
    );

    if (loading && !jobStatus) {
        return (
            <Box p={6} textAlign="center">
                <Spinner size="lg" />
                <Text mt={2}>Loading sync job status...</Text>
            </Box>
        );
    }

    return (
        <Box p={4}>
            <Heading size="lg" mb={6}>
                Sync Transactions
            </Heading>

            {error && (
                <Box bg="red.100" color="red.800" p={3} borderRadius="md" mb={4}>
                    Error: {error}
                </Box>
            )}

            {/* Sync Configuration Panel */}
            <Box mb={4}>
                <SyncConfigPanel
                    onOverridesChange={setSyncOverrides}
                    disabled={isRunning}
                />
            </Box>

            {/* Controls Card */}
            <Card.Root mb={6}>
                <Card.Body>
                    <Flex justify="space-between" align="center" wrap="wrap" gap={4}>
                        <Flex align="center" gap={3}>
                            {jobStatus && (
                                <Badge
                                    colorPalette={getStatusColor(jobStatus.status)}
                                    size="lg"
                                >
                                    {jobStatus.status.toUpperCase()}
                                    {jobStatus.abort_requested && ' (Aborting...)'}
                                </Badge>
                            )}
                            {syncOverrides.length > 0 && canStart && (
                                <Text fontSize="sm" color="blue.400">
                                    {syncOverrides.length} override
                                    {syncOverrides.length !== 1 ? 's' : ''} configured
                                </Text>
                            )}
                        </Flex>
                        <Flex gap={2}>
                            {canStart && (
                                <Button
                                    colorPalette="blue"
                                    onClick={startJob}
                                    loading={actionLoading}
                                    disabled={!canStart}
                                >
                                    Start Sync Job
                                </Button>
                            )}
                            {isRunning && (
                                <Button
                                    colorPalette="red"
                                    variant="outline"
                                    onClick={abortJob}
                                    loading={actionLoading}
                                >
                                    Abort Job
                                </Button>
                            )}
                        </Flex>
                    </Flex>
                </Card.Body>
            </Card.Root>

            {/* Status Card */}
            {jobStatus && jobStatus.status !== 'idle' && (
                <Card.Root mb={6}>
                    <Card.Header>
                        <Flex justify="space-between" align="center">
                            <Heading size="md">Job Progress</Heading>
                            {hasFailedConnectors && !isRunning && (
                                <Text fontSize="sm" color="red.400">
                                    Some connectors failed. Expand cards to retry.
                                </Text>
                            )}
                        </Flex>
                    </Card.Header>
                    <Card.Body>
                        {/* Progress Bar (when running) */}
                        {isRunning && (
                            <Box mb={4}>
                                <Flex justify="space-between" mb={1}>
                                    <Text fontSize="sm">
                                        Processing: {jobStatus.current_connector || 'Initializing...'}
                                    </Text>
                                    <Text fontSize="sm">
                                        {jobStatus.connectors_completed.length} /{' '}
                                        {jobStatus.total_connectors} connectors
                                    </Text>
                                </Flex>
                                <Progress.Root value={getProgressPercent()} max={100} size="sm">
                                    <Progress.Track>
                                        <Progress.Range />
                                    </Progress.Track>
                                </Progress.Root>
                            </Box>
                        )}

                        {/* Statistics Grid */}
                        <Flex gap={6} wrap="wrap" mb={4}>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Total Processed
                                </Text>
                                <Text fontSize="2xl" fontWeight="bold">
                                    {jobStatus.total_processed}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    New Entries Added
                                </Text>
                                <Text fontSize="2xl" fontWeight="bold" color="green.600">
                                    {jobStatus.new_entries_added}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Entries Updated
                                </Text>
                                <Text fontSize="2xl" fontWeight="bold" color="blue.600">
                                    {jobStatus.entries_updated ?? 0}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Duplicates Skipped
                                </Text>
                                <Text fontSize="2xl" fontWeight="bold" color="gray.500">
                                    {jobStatus.duplicates_skipped}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Errors
                                </Text>
                                <Text
                                    fontSize="2xl"
                                    fontWeight="bold"
                                    color={jobStatus.error_count > 0 ? 'red.600' : 'gray.500'}
                                >
                                    {jobStatus.error_count}
                                </Text>
                            </Box>
                        </Flex>

                        {/* Timing */}
                        <Flex gap={6} wrap="wrap" mb={4}>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Started
                                </Text>
                                <Text>{formatDateTime(jobStatus.started_at)}</Text>
                            </Box>
                            <Box>
                                <Text fontSize="sm" color="gray.500">
                                    Finished
                                </Text>
                                <Text>{formatDateTime(jobStatus.finished_at)}</Text>
                            </Box>
                        </Flex>

                        {/* Per-Connector Progress - Accordion Cards */}
                        {jobStatus.connector_statuses &&
                            Object.keys(jobStatus.connector_statuses).length > 0 && (
                                <Box>
                                    <Text fontSize="sm" color="gray.500" mb={3}>
                                        Connector Progress
                                    </Text>
                                    <Box
                                        css={{
                                            display: 'grid',
                                            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                                            gap: '12px',
                                        }}
                                    >
                                        {getSortedConnectorStatuses().map((cp: ConnectorProgress) => (
                                            <ConnectorProgressCard
                                                key={cp.connector_id}
                                                progress={cp}
                                                isExpanded={cp.status === 'running' || cp.status === 'failed'}
                                                onRetry={retryConnector}
                                                retryLoading={retryLoading === cp.connector_id}
                                            />
                                        ))}
                                    </Box>
                                </Box>
                            )}

                        {/* Error Message */}
                        {jobStatus.error_message && (
                            <Box
                                bg="red.50"
                                borderColor="red.200"
                                borderWidth={1}
                                p={3}
                                borderRadius="md"
                                mt={4}
                            >
                                <Text fontWeight="bold" color="red.700">
                                    Error:
                                </Text>
                                <Text color="red.600">{jobStatus.error_message}</Text>
                            </Box>
                        )}

                        {/* Error List */}
                        {jobStatus.errors.length > 0 && (
                            <Box mt={4}>
                                <Text fontSize="sm" color="gray.500" mb={2}>
                                    Recent Errors ({jobStatus.error_count} total):
                                </Text>
                                <Box
                                    maxH="200px"
                                    overflowY="auto"
                                    bg="gray.50"
                                    p={3}
                                    borderRadius="md"
                                    fontSize="xs"
                                    fontFamily="mono"
                                >
                                    {jobStatus.errors.map((err: string, idx: number) => (
                                        <Text key={idx} color="red.600" mb={1}>
                                            {err}
                                        </Text>
                                    ))}
                                </Box>
                            </Box>
                        )}
                    </Card.Body>
                </Card.Root>
            )}

            {/* Job History Section */}
            <Card.Root mt={6}>
                <Card.Header>
                    <Flex justify="space-between" align="center">
                        <Flex align="center" gap={2}>
                            <LuHistory />
                            <Heading size="sm">Recent Sync Jobs</Heading>
                        </Flex>
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowFullHistory(!showFullHistory)}
                        >
                            {showFullHistory ? (
                                <>
                                    <LuChevronUp />
                                    <Text ml={1}>Show Less</Text>
                                </>
                            ) : (
                                <>
                                    <Text mr={1}>View All</Text>
                                    <LuChevronDown />
                                </>
                            )}
                        </Button>
                    </Flex>
                </Card.Header>
                <Card.Body pt={0}>
                    {!showFullHistory ? (
                        /* Inline Recent Jobs Summary */
                        <Box>
                            {recentJobs.length === 0 ? (
                                <Text color="gray.500" fontSize="sm" textAlign="center" py={4}>
                                    No sync jobs yet. Start your first sync above.
                                </Text>
                            ) : (
                                <Flex direction="column" gap={2}>
                                    {recentJobs.slice(0, 5).map((job) => (
                                        <RecentJobRow
                                            key={job.id}
                                            job={job}
                                            onView={() => {
                                                setSelectedJobId(job.id);
                                                setJobDrawerOpen(true);
                                            }}
                                        />
                                    ))}
                                </Flex>
                            )}
                        </Box>
                    ) : (
                        /* Full Job History Table */
                        <JobHistoryTable
                            onViewJob={(jobId) => {
                                setSelectedJobId(jobId);
                                setJobDrawerOpen(true);
                            }}
                            refreshTrigger={historyRefreshTrigger}
                        />
                    )}
                </Card.Body>
            </Card.Root>

            {/* Job Detail Drawer */}
            <JobDetailDrawer
                jobId={selectedJobId}
                open={jobDrawerOpen}
                onClose={() => {
                    setJobDrawerOpen(false);
                    setSelectedJobId(null);
                }}
            />
        </Box>
    );
};
