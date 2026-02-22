import {
    Badge, Box,
    Button, Card, Flex,
    Heading, HStack, Progress, Spinner, Tabs, Text
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LuEye, LuHistory } from 'react-icons/lu';
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
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

// Status badge color helper
const getJobStatusColor = (status: string): string => {
    switch (status) {
        case 'idle': return 'gray';
        case 'pending': return 'yellow';
        case 'running': return 'blue';
        case 'completed': return 'green';
        case 'warning': return 'orange';
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

export const SyncJobPanel: React.FC = () => {
    const queryClient = useQueryClient();
    const [jobStatus, setJobStatus] = useState<SyncJobProgress | null>(null);
    const [connectors, setConnectors] = useState<ConnectorsInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState(false);
    const [retryLoading, setRetryLoading] = useState<number | null>(null);
    // Track previous status to detect completion
    const prevStatusRef = useRef<string | null>(null);

    // Per-sync configuration overrides (enable/disable connectors, test mode, since datetime)
    const [syncOverrides, setSyncOverrides] = useState<ConnectorOverride[]>([]);

    // Renormalize confirmation dialog
    const renormalizeConfirm = useConfirmDialog();

    // Job history state
    const [selectedJobId, setSelectedJobId] = useState<number | null>(null);
    const [jobDrawerOpen, setJobDrawerOpen] = useState(false);
    const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState(0);

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

    // Initial load and polling
    useEffect(() => {
        fetchJobStatus();
        fetchConnectors();
    }, [fetchJobStatus, fetchConnectors]);

    // Poll for status updates when job is running (covers both full jobs and retries)
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
        }

        prevStatusRef.current = currentStatus ?? null;
    }, [jobStatus?.status, queryClient]);

    // Start a new sync job
    const startJob = async (renormalize: boolean = false) => {
        setActionLoading(true);
        try {
            // Build request with connector overrides from SyncConfigPanel
            // (includes enable/disable, test_mode, and since_datetime)
            const requestBody: SyncJobStartRequest = {};

            if (syncOverrides.length > 0) {
                requestBody.connector_overrides = syncOverrides;
            }
            if (renormalize) {
                requestBody.renormalize = true;
            }

            const response = await fetch(`${API_URL}/sync-job/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
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
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to start job' });
        } finally {
            setActionLoading(false);
        }
    };

    // Abort the running job
    const abortJob = async () => {
        setActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/sync-job/abort`, {
                method: 'POST'
            });
            if (!response.ok) throw new Error('Failed to abort job');
            await fetchJobStatus();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to abort job' });
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
            case 'idle': return 'gray';
            case 'running': return 'blue';
            case 'completed': return 'green';
            case 'aborted': return 'orange';
            case 'failed': return 'red';
            default: return 'gray';
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
        const percentage = Math.round((jobStatus.connectors_completed.length / jobStatus.total_connectors) * 100);
        // Clamp to 0-100 range to prevent invalid values
        return Math.min(100, Math.max(0, percentage));
    };

    // Get progress bar color based on error state
    const getJobProgressBarColor = (): string => {
        if (!jobStatus) return 'blue';
        if (jobStatus.error_count > 0) return 'orange';
        return 'blue';
    };

    // Get status icon and color for connector status
    const getConnectorStatusIcon = (status: ConnectorSyncStatus): string => {
        switch (status) {
            case 'pending': return '⏳';
            case 'running': return '🔄';
            case 'completed': return '✅';
            case 'warning': return '⚠️';
            case 'failed': return '❌';
            case 'skipped': return '⏭️';
            default: return '•';
        }
    };

    const getConnectorStatusColor = (status: ConnectorSyncStatus): string => {
        switch (status) {
            case 'pending': return 'gray';
            case 'running': return 'blue';
            case 'completed': return 'green';
            case 'warning': return 'orange';
            case 'failed': return 'red';
            case 'skipped': return 'orange';
            default: return 'gray';
        }
    };

    // Handle since datetime override change
    // Get sorted connector statuses
    const getSortedConnectorStatuses = (): ConnectorProgress[] => {
        if (!jobStatus?.connector_statuses) return [];
        return Object.values(jobStatus.connector_statuses).sort((a, b) => {
            // Sort by status priority: running first, then pending, then completed, then warning, then failed, then skipped
            const statusOrder: Record<ConnectorSyncStatus, number> = {
                running: 0,
                pending: 1,
                queued: 2,
                completed: 3,
                warning: 4,
                failed: 5,
                skipped: 6
            };
            return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
        });
    };

    const isRunning = jobStatus?.status === 'running';
    // Count how many connectors are actively queued or running.
    // During a full job many connectors are active; during a single-connector
    // retry only 1 is active.  The panel chrome (progress bar, abort, config
    // disable) should only appear for a full job, not for a single retry.
    const activeConnectorCount = getSortedConnectorStatuses().filter(
        (c) => c.status === 'running' || c.status === 'queued'
    ).length;
    const isFullJobRunning = isRunning && activeConnectorCount > 1;
    const canStart = !isRunning && !actionLoading;
    const hasFailedConnectors = getSortedConnectorStatuses().some(
        (c) => c.status === 'failed' || c.status === 'warning'
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
            <Heading size="lg" mb={6}>Sync Transactions</Heading>

            {error && (
                <Box bg="red.100" color="red.800" p={3} borderRadius="md" mb={4}>
                    Error: {error}
                </Box>
            )}

            <Tabs.Root defaultValue="control">
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="control">
                        🎛️ Control
                    </Tabs.Trigger>
                    <Tabs.Trigger value="history">
                        📜 History
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="control">

                    {/* Sync Configuration Panel (enable/disable connectors, test mode) */}
                    <Box mb={4}>
                        <SyncConfigPanel
                            onOverridesChange={setSyncOverrides}
                            disabled={isFullJobRunning}
                        />
                    </Box>

                    {/* Controls Card */}
                    <Card.Root mb={6}>
                        <Card.Body>
                            <Flex justify="space-between" align="center" wrap="wrap" gap={4}>
                                <Flex align="center" gap={3}>
                                    {jobStatus && (
                                        <>
                                            <Badge
                                                colorPalette={getStatusColor(jobStatus.status)}
                                                size="lg"
                                            >
                                                {jobStatus.status.toUpperCase()}
                                                {jobStatus.abort_requested && ' (Aborting...)'}
                                            </Badge>
                                            {jobStatus.status === 'pending' && (
                                                <Text fontSize="sm" color="gray.500">
                                                    Initializing connectors...
                                                </Text>
                                            )}
                                        </>
                                    )}
                                    {syncOverrides.length > 0 && canStart && (
                                        <Text fontSize="sm" color="blue.400">
                                            {syncOverrides.length} override{syncOverrides.length !== 1 ? 's' : ''} configured
                                        </Text>
                                    )}
                                </Flex>
                                <Flex gap={2}>
                                    {canStart && (
                                        <>
                                            <Button
                                                colorPalette="blue"
                                                onClick={() => startJob(false)}
                                                loading={actionLoading}
                                                disabled={!canStart}
                                            >
                                                Start Sync Job
                                            </Button>
                                            <Button
                                                colorPalette="purple"
                                                variant="outline"
                                                onClick={() => renormalizeConfirm.open()}
                                                loading={actionLoading}
                                                disabled={!canStart}
                                            >
                                                Re-Normalize
                                            </Button>
                                        </>
                                    )}
                                    {isFullJobRunning && (
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
                    {jobStatus && jobStatus.status !== 'idle' && jobStatus.status !== 'pending' && (
                        <Card.Root mb={6}>
                            <Card.Header>
                                <Flex justify="space-between" align="center">
                                    <Flex align="center" gap={2}>
                                        <Heading size="md">
                                            {jobStatus.renormalize ? 'Re-Normalization Progress' : 'Job Progress'}
                                        </Heading>
                                        {jobStatus.renormalize && (
                                            <Badge colorPalette="purple" size="sm">Re-Normalize</Badge>
                                        )}
                                    </Flex>
                                    {hasFailedConnectors && !isFullJobRunning && (
                                        <Text fontSize="sm" color="red.400">
                                            Some connectors failed. Expand cards to retry.
                                        </Text>
                                    )}
                                </Flex>
                            </Card.Header>
                            <Card.Body>
                                {/* Progress Bar (only during full job, not single-connector retry) */}
                                {isFullJobRunning && (
                                    <Box mb={4}>
                                        <Flex justify="space-between" mb={1}>
                                            <Text fontSize="sm">
                                                Processing: {jobStatus.current_connector || 'Initializing...'}
                                            </Text>
                                            <Text fontSize="sm">
                                                {jobStatus.connectors_completed.length} / {jobStatus.total_connectors} connectors
                                            </Text>
                                        </Flex>
                                        <Progress.Root value={getProgressPercent()} max={100} size="sm" colorPalette={getJobProgressBarColor()}>
                                            <Progress.Track>
                                                <Progress.Range />
                                            </Progress.Track>
                                        </Progress.Root>
                                        {jobStatus.error_count > 0 && (
                                            <Text fontSize="xs" color="orange.600" mt={1}>
                                                ⚠️ {jobStatus.error_count} error{jobStatus.error_count !== 1 ? 's' : ''} encountered so far
                                            </Text>
                                        )}
                                    </Box>
                                )}

                                {/* Statistics Grid */}
                                <Flex gap={6} wrap="wrap" mb={4}>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Total Processed</Text>
                                        <Text fontSize="2xl" fontWeight="bold">{jobStatus.total_processed}</Text>
                                    </Box>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">New Entries Added</Text>
                                        <Text fontSize="2xl" fontWeight="bold" color="green.600">
                                            {jobStatus.new_entries_added}
                                        </Text>
                                    </Box>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Entries Updated</Text>
                                        <Text fontSize="2xl" fontWeight="bold" color="blue.600">
                                            {jobStatus.entries_updated ?? 0}
                                        </Text>
                                    </Box>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Duplicates Skipped</Text>
                                        <Text fontSize="2xl" fontWeight="bold" color="gray.500">
                                            {jobStatus.duplicates_skipped}
                                        </Text>
                                    </Box>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Errors</Text>
                                        <Text fontSize="2xl" fontWeight="bold" color={jobStatus.error_count > 0 ? 'red.600' : 'gray.500'}>
                                            {jobStatus.error_count}
                                        </Text>
                                    </Box>
                                </Flex>

                                {/* Timing */}
                                <Flex gap={6} wrap="wrap" mb={4}>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Started</Text>
                                        <Text>{formatDateTime(jobStatus.started_at)}</Text>
                                    </Box>
                                    <Box>
                                        <Text fontSize="sm" color="gray.500">Finished</Text>
                                        <Text>{formatDateTime(jobStatus.finished_at)}</Text>
                                    </Box>
                                </Flex>

                                {/* Per-Connector Progress - Using ConnectorProgressCard */}
                                {jobStatus.connector_statuses &&
                                    Object.keys(jobStatus.connector_statuses).length > 0 && (
                                        <Box>
                                            <Text fontSize="sm" color="gray.500" mb={3}>
                                                Connector Progress
                                            </Text>
                                            <Box
                                                display="grid"
                                                gridTemplateColumns={{ base: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
                                                gap={3}
                                            >
                                                {getSortedConnectorStatuses().map((cp: ConnectorProgress) => (
                                                    <ConnectorProgressCard
                                                        key={cp.connector_id}
                                                        progress={cp}
                                                        isExpanded={cp.status === 'running' || cp.status === 'failed'}
                                                        onRetry={retryConnector}
                                                        retryLoading={retryLoading === cp.connector_id}
                                                        renormalize={jobStatus.renormalize}
                                                    />
                                                ))}
                                            </Box>
                                        </Box>
                                    )}

                                {/* Legacy: Completed Connectors (fallback for backward compatibility) */}
                                {!jobStatus.connector_statuses && jobStatus.connectors_completed.length > 0 && (
                                    <Box mb={4}>
                                        <Text fontSize="sm" color="gray.500" mb={1}>Completed Connectors</Text>
                                        <Flex gap={2} wrap="wrap">
                                            {jobStatus.connectors_completed.map((c: string) => (
                                                <Badge key={c} colorPalette="green">{c}</Badge>
                                            ))}
                                        </Flex>
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
                                                <Text key={idx} color="red.600" mb={1}>{err}</Text>
                                            ))}
                                        </Box>
                                    </Box>
                                )}
                            </Card.Body>
                        </Card.Root>
                    )}
                </Tabs.Content>

                {/* Job History Tab */}
                <Tabs.Content value="history">
                    <Card.Root>
                        <Card.Body>
                            <JobHistoryTable
                                onViewJob={(jobId) => {
                                    setSelectedJobId(jobId);
                                    setJobDrawerOpen(true);
                                }}
                                refreshTrigger={historyRefreshTrigger}
                            />
                        </Card.Body>
                    </Card.Root>
                </Tabs.Content>
            </Tabs.Root>

            {/* Job Detail Drawer */}
            <JobDetailDrawer
                jobId={selectedJobId}
                open={jobDrawerOpen}
                onClose={() => {
                    setJobDrawerOpen(false);
                    setSelectedJobId(null);
                }}
            />

            {/* Re-Normalize Confirmation Dialog */}
            <ConfirmDialog
                isOpen={renormalizeConfirm.isOpen}
                onClose={renormalizeConfirm.close}
                onConfirm={() => startJob(true)}
                title="Re-Normalize Transactions"
                message="This will delete existing normalized transactions and recreate them from stored raw data. Derived data (cost lots, P&L, etc.) will also be removed and must be recalculated."
                confirmLabel="Re-Normalize"
                isDestructive
            />
        </Box>
    );
};
