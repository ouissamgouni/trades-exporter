import {
    Badge, Box,
    Button, Card, Flex,
    Heading, Progress, Spinner, Text, Grid, GridItem, Input, IconButton, Collapsible
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_URL, ConnectorProgress, ConnectorsInfo, ConnectorSyncStatus, SyncJobProgress, SyncJobStartResponse, ConnectorDefaultInfo, SyncJobStartRequest, ConnectorSinceOverride } from '../types';
import { toaster } from './ui/toaster';
import { LuChevronDown, LuChevronUp, LuRotateCcw } from 'react-icons/lu';

export const SyncJobPanel: React.FC = () => {
    const queryClient = useQueryClient();
    const [jobStatus, setJobStatus] = useState<SyncJobProgress | null>(null);
    const [connectors, setConnectors] = useState<ConnectorsInfo | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [actionLoading, setActionLoading] = useState(false);
    // Track previous status to detect completion
    const prevStatusRef = useRef<string | null>(null);

    // Incremental sync configuration state
    const [connectorDefaults, setConnectorDefaults] = useState<ConnectorDefaultInfo[]>([]);
    const [sinceOverrides, setSinceOverrides] = useState<Record<number, string | null>>({});
    const [showIncrementalConfig, setShowIncrementalConfig] = useState(false);

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

    // Fetch connector defaults for incremental sync configuration
    const fetchConnectorDefaults = useCallback(async () => {
        try {
            const response = await fetch(`${API_URL}/sync-job/connector-defaults`);
            if (response.ok) {
                const data = await response.json();
                const connectors: ConnectorDefaultInfo[] = data.connectors || [];
                setConnectorDefaults(connectors);
                // Initialize overrides from defaults
                const initialOverrides: Record<number, string | null> = {};
                connectors.forEach(c => {
                    initialOverrides[c.connector_id] = c.default_since_datetime ?? null;
                });
                setSinceOverrides(initialOverrides);
            }
        } catch (err) {
            console.error('Failed to fetch connector defaults:', err);
        }
    }, []);

    // Initial load and polling
    useEffect(() => {
        fetchJobStatus();
        fetchConnectors();
        fetchConnectorDefaults();
    }, [fetchJobStatus, fetchConnectors, fetchConnectorDefaults]);

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

        // Detect transition from running to completed
        if (prevStatus === 'running' && currentStatus === 'completed') {
            console.log('🔄 Sync completed, refreshing transactions...');
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
        }

        prevStatusRef.current = currentStatus ?? null;
    }, [jobStatus?.status, queryClient]);

    // Start a new sync job
    const startJob = async () => {
        setActionLoading(true);
        try {
            // Build request with connector overrides
            const requestBody: SyncJobStartRequest = {};

            // Only include overrides for connectors that support incremental sync
            const incrementalConnectors = connectorDefaults.filter(c => c.supports_incremental_sync);
            if (incrementalConnectors.length > 0) {
                requestBody.connector_overrides = {};
                incrementalConnectors.forEach(c => {
                    const overrideValue = sinceOverrides[c.connector_id];
                    requestBody.connector_overrides![c.connector_id] = {
                        since_datetime: overrideValue ?? null
                    };
                });
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
        return Math.round((jobStatus.connectors_completed.length / jobStatus.total_connectors) * 100);
    };

    // Get status icon and color for connector status
    const getConnectorStatusIcon = (status: ConnectorSyncStatus): string => {
        switch (status) {
            case 'pending': return '⏳';
            case 'running': return '🔄';
            case 'completed': return '✅';
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
            case 'failed': return 'red';
            case 'skipped': return 'orange';
            default: return 'gray';
        }
    };

    // Handle since datetime override change
    const handleSinceChange = (connectorId: number, value: string) => {
        setSinceOverrides(prev => ({
            ...prev,
            [connectorId]: value || null
        }));
    };

    // Reset a connector's since to its default
    const resetToDefault = (connectorId: number) => {
        const connector = connectorDefaults.find(c => c.connector_id === connectorId);
        if (connector) {
            setSinceOverrides(prev => ({
                ...prev,
                [connectorId]: connector.default_since_datetime ?? null
            }));
        }
    };

    // Clear since for full sync
    const clearSince = (connectorId: number) => {
        setSinceOverrides(prev => ({
            ...prev,
            [connectorId]: null
        }));
    };

    // Format datetime for input
    const formatForInput = (dateStr: string | null | undefined): string => {
        if (!dateStr) return '';
        try {
            const date = new Date(dateStr);
            // Format as local datetime-local input value (YYYY-MM-DDTHH:mm)
            return date.toISOString().slice(0, 16);
        } catch {
            return '';
        }
    };

    // Get connectors that support incremental sync
    const incrementalConnectors = connectorDefaults.filter(c => c.supports_incremental_sync);

    // Get sorted connector statuses
    const getSortedConnectorStatuses = (): ConnectorProgress[] => {
        if (!jobStatus?.connector_statuses) return [];
        return Object.values(jobStatus.connector_statuses).sort((a, b) => {
            // Sort by status priority: running first, then pending, then completed, then failed, then skipped
            const statusOrder: Record<ConnectorSyncStatus, number> = {
                'running': 0,
                'pending': 1,
                'completed': 2,
                'failed': 3,
                'skipped': 4
            };
            return statusOrder[a.status] - statusOrder[b.status];
        });
    };

    const isRunning = jobStatus?.status === 'running';
    const canStart = !isRunning && !actionLoading;

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

            {/* Controls Card */}
            <Card.Root mb={6}>
                <Card.Body>
                    <Flex justify="flex-end" align="center" wrap="wrap" gap={4}>
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

                    {connectors && (
                        <Text fontSize="sm" color="gray.600" mt={2}>
                            Available connectors: {connectors.available_connectors.join(', ')}
                        </Text>
                    )}

                    {/* Incremental Sync Configuration */}
                    {incrementalConnectors.length > 0 && !isRunning && (
                        <Box mt={4}>
                            <Collapsible.Root open={showIncrementalConfig} onOpenChange={(details) => setShowIncrementalConfig(details.open)}>
                                <Collapsible.Trigger asChild>
                                    <Button variant="ghost" size="sm" width="100%" justifyContent="space-between">
                                        <Text fontSize="sm" fontWeight="medium">
                                            Incremental Sync Settings ({incrementalConnectors.length} connectors)
                                        </Text>
                                        {showIncrementalConfig ? <LuChevronUp /> : <LuChevronDown />}
                                    </Button>
                                </Collapsible.Trigger>
                                <Collapsible.Content>
                                    <Box mt={3} p={3} bg="gray.50" borderRadius="md">
                                        <Text fontSize="xs" color="gray.600" mb={3}>
                                            Configure the "since" datetime for each connector. Transactions before this datetime will be skipped.
                                            Clear the field for a full sync.
                                        </Text>
                                        <Grid templateColumns="repeat(auto-fill, minmax(300px, 1fr))" gap={3}>
                                            {incrementalConnectors.map(connector => {
                                                const currentValue = sinceOverrides[connector.connector_id];
                                                const hasOverride = currentValue !== connector.default_since_datetime;

                                                return (
                                                    <GridItem key={connector.connector_id}>
                                                        <Box p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor={hasOverride ? 'blue.200' : 'gray.200'}>
                                                            <Flex justify="space-between" align="center" mb={2}>
                                                                <Box>
                                                                    <Text fontWeight="medium" fontSize="sm">{connector.connector_type}</Text>
                                                                    <Text fontSize="xs" color="gray.500">{connector.account_name}</Text>
                                                                </Box>
                                                                {hasOverride && (
                                                                    <Badge colorPalette="blue" size="sm">Modified</Badge>
                                                                )}
                                                            </Flex>
                                                            <Flex gap={2} align="center">
                                                                <Input
                                                                    type="datetime-local"
                                                                    size="sm"
                                                                    value={formatForInput(currentValue)}
                                                                    onChange={(e) => handleSinceChange(connector.connector_id, e.target.value ? new Date(e.target.value).toISOString() : '')}
                                                                    placeholder="Full sync (no filter)"
                                                                />
                                                                <IconButton
                                                                    aria-label="Reset to default"
                                                                    size="sm"
                                                                    variant="ghost"
                                                                    onClick={() => resetToDefault(connector.connector_id)}
                                                                    title="Reset to default (last synced transaction)"
                                                                >
                                                                    <LuRotateCcw />
                                                                </IconButton>
                                                            </Flex>
                                                            {connector.default_since_datetime && (
                                                                <Text fontSize="xs" color="gray.500" mt={1}>
                                                                    Default: {formatDateTime(connector.default_since_datetime)}
                                                                </Text>
                                                            )}
                                                            {!currentValue && (
                                                                <Text fontSize="xs" color="orange.600" mt={1}>
                                                                    ⚠️ Full sync - will fetch all transactions
                                                                </Text>
                                                            )}
                                                        </Box>
                                                    </GridItem>
                                                );
                                            })}
                                        </Grid>
                                    </Box>
                                </Collapsible.Content>
                            </Collapsible.Root>
                        </Box>
                    )}
                </Card.Body>
            </Card.Root>

            {/* Status Card */}
            {jobStatus && (
                <Card.Root mb={6}>
                    <Card.Header>
                        <Flex justify="space-between" align="center">
                            <Heading size="md">Job Status</Heading>
                            <Badge colorPalette={getStatusColor(jobStatus.status)} size="lg">
                                {jobStatus.status.toUpperCase()}
                                {jobStatus.abort_requested && ' (Aborting...)'}
                            </Badge>
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
                                        {jobStatus.connectors_completed.length} / {jobStatus.total_connectors} connectors
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

                        {/* Per-Connector Status */}
                        {jobStatus.connector_statuses && Object.keys(jobStatus.connector_statuses).length > 0 && (
                            <Box mb={4}>
                                <Text fontSize="sm" color="gray.500" mb={2}>Connector Progress</Text>
                                <Grid templateColumns="repeat(auto-fill, minmax(280px, 1fr))" gap={3}>
                                    {getSortedConnectorStatuses().map((cp: ConnectorProgress) => (
                                        <GridItem key={cp.connector_id}>
                                            <Box
                                                p={3}
                                                borderRadius="md"
                                                borderWidth="1px"
                                                borderColor={cp.status === 'running' ? 'blue.300' : cp.status === 'failed' ? 'red.200' : 'gray.200'}
                                                bg={cp.status === 'running' ? 'blue.50' : cp.test_mode ? 'orange.50' : 'white'}
                                            >
                                                <Flex justify="space-between" align="center" mb={2}>
                                                    <Flex align="center" gap={2}>
                                                        <Text fontWeight="medium" fontSize="sm">
                                                            {getConnectorStatusIcon(cp.status)} {cp.connector_name}
                                                        </Text>
                                                        {cp.test_mode && (
                                                            <Badge colorPalette="orange" size="sm">🧪 Test</Badge>
                                                        )}
                                                    </Flex>
                                                    <Badge colorPalette={getConnectorStatusColor(cp.status)} size="sm">
                                                        {cp.status}
                                                    </Badge>
                                                </Flex>
                                                <Text fontSize="xs" color="gray.500" mb={2}>
                                                    {cp.account_name}
                                                </Text>
                                                {(cp.status === 'completed' || cp.status === 'running') && (
                                                    <Flex gap={3} fontSize="xs" wrap="wrap">
                                                        <Text color="green.600">+{cp.new_entries} new</Text>
                                                        <Text color="blue.600">{cp.updated} updated</Text>
                                                        <Text color="gray.500">{cp.duplicates} dups</Text>
                                                        {cp.errors > 0 && (
                                                            <Text color="red.600">{cp.errors} errors</Text>
                                                        )}
                                                    </Flex>
                                                )}
                                                {cp.status === 'failed' && cp.error_message && (
                                                    <Text fontSize="xs" color="red.600" mt={1} lineClamp={2}>
                                                        {cp.error_message}
                                                    </Text>
                                                )}
                                            </Box>
                                        </GridItem>
                                    ))}
                                </Grid>
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
                            <Box bg="red.50" borderColor="red.200" borderWidth={1} p={3} borderRadius="md" mb={4}>
                                <Text fontWeight="bold" color="red.700">Error:</Text>
                                <Text color="red.600">{jobStatus.error_message}</Text>
                            </Box>
                        )}

                        {/* Error List */}
                        {jobStatus.errors.length > 0 && (
                            <Box>
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
        </Box>
    );
};
