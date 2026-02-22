import {
    Badge,
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    IconButton,
    Spinner,
    Table,
    Text,
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useState } from 'react';
import { LuChevronLeft, LuChevronRight, LuEye, LuRefreshCw } from 'react-icons/lu';
import {
    API_URL,
    JobHistoryResponse,
    SyncJobSummary,
    SyncJobStatus,
} from '../types';

interface JobHistoryTableProps {
    onViewJob?: (jobId: number) => void;
    refreshTrigger?: number;
}

const statusColorMap: Record<SyncJobStatus, string> = {
    idle: 'gray',
    pending: 'yellow',
    running: 'blue',
    completed: 'green',
    warning: 'orange',
    aborted: 'orange',
    failed: 'red',
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
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
};

const formatDate = (dateStr?: string): string => {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
};

export const JobHistoryTable: React.FC<JobHistoryTableProps> = ({
    onViewJob,
    refreshTrigger,
}) => {
    const [jobs, setJobs] = useState<SyncJobSummary[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [page, setPage] = useState(0);
    const limit = 10;

    const fetchHistory = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(
                `${API_URL}/sync-job/history?limit=${limit}&offset=${page * limit}`
            );
            if (!response.ok) {
                throw new Error('Failed to fetch job history');
            }
            const data: JobHistoryResponse = await response.json();
            setJobs(data.jobs);
            setTotal(data.total);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [page]);

    useEffect(() => {
        fetchHistory();
    }, [fetchHistory, refreshTrigger]);

    const totalPages = Math.ceil(total / limit);

    if (loading && jobs.length === 0) {
        return (
            <Flex justify="center" align="center" py={8}>
                <Spinner size="lg" />
            </Flex>
        );
    }

    if (error) {
        return (
            <Box p={4} bg="red.50" borderRadius="md">
                <Text color="red.600">Error: {error}</Text>
                <Button size="sm" mt={2} onClick={fetchHistory}>
                    Retry
                </Button>
            </Box>
        );
    }

    if (jobs.length === 0) {
        return (
            <Box textAlign="center" py={8} color="gray.500">
                <Text>No sync jobs found</Text>
                <Text fontSize="sm" mt={1}>
                    Run a sync job to see history here
                </Text>
            </Box>
        );
    }

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={4}>
                <Heading size="sm">Job History</Heading>
                <IconButton
                    aria-label="Refresh"
                    size="sm"
                    variant="ghost"
                    onClick={fetchHistory}
                    disabled={loading}
                >
                    <LuRefreshCw className={loading ? 'animate-spin' : ''} />
                </IconButton>
            </Flex>

            <Table.Root size="sm">
                <Table.Header>
                    <Table.Row>
                        <Table.ColumnHeader>ID</Table.ColumnHeader>
                        <Table.ColumnHeader>Config</Table.ColumnHeader>
                        <Table.ColumnHeader>Status</Table.ColumnHeader>
                        <Table.ColumnHeader>Started</Table.ColumnHeader>
                        <Table.ColumnHeader>Duration</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right">Connectors</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right">Processed</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right">New</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right">Updated</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="right">Errors</Table.ColumnHeader>
                        <Table.ColumnHeader></Table.ColumnHeader>
                    </Table.Row>
                </Table.Header>
                <Table.Body>
                    {jobs.map((job) => (
                        <Table.Row key={job.id}>
                            <Table.Cell fontFamily="mono" fontSize="xs">
                                #{job.id}
                            </Table.Cell>
                            <Table.Cell>
                                <Flex gap={1} wrap="wrap">
                                    <Badge colorPalette={job.renormalize ? 'purple' : 'blue'} size="xs">
                                        {job.renormalize ? 'Re-Normalize' : 'Sync'}
                                    </Badge>
                                    {job.connector_runs?.some(r => r.test_mode) && (
                                        <Badge colorPalette="orange" size="xs">Test</Badge>
                                    )}
                                </Flex>
                            </Table.Cell>
                            <Table.Cell>
                                <Badge colorPalette={statusColorMap[job.status]}>
                                    {job.status}
                                </Badge>
                            </Table.Cell>
                            <Table.Cell fontSize="xs">
                                {formatDate(job.started_at)}
                            </Table.Cell>
                            <Table.Cell fontSize="xs">
                                {formatDuration(job.started_at, job.finished_at)}
                            </Table.Cell>
                            <Table.Cell textAlign="right">
                                {job.connector_runs && job.connector_runs.length > 0 ? (
                                    <Flex gap={1} justify="flex-end" wrap="wrap">
                                        {job.connector_runs.map((run) => (
                                            <Badge
                                                key={run.id}
                                                colorPalette={
                                                    run.status === 'completed' ? 'green' :
                                                        run.status === 'failed' ? 'red' :
                                                            run.status === 'running' ? 'blue' :
                                                                run.status === 'queued' || run.status === 'pending' ? 'gray' :
                                                                    'orange'
                                                }
                                                size="xs"
                                                title={`${run.connector_type || `ID:${run.connector_id}`} - ${run.status}${run.synced_count > 0 ? ` (+${run.synced_count})` : ''}`}
                                            >
                                                {run.connector_type || `ID:${run.connector_id}`}
                                                {run.synced_count > 0 && ` +${run.synced_count}`}
                                                {run.updated_count > 0 && run.synced_count === 0 && ` ↻${run.updated_count}`}
                                                {run.error_count > 0 && ` ✗${run.error_count}`}
                                                {run.synced_count === 0 && run.updated_count === 0 && run.error_count === 0 && (
                                                    run.status === 'queued' || run.status === 'pending' ? ' ⏳' :
                                                        run.status === 'running' ? ' 🔄' :
                                                            run.status === 'skipped' ? ' ⏭' : ''
                                                )}
                                            </Badge>
                                        ))}
                                    </Flex>
                                ) : (
                                    job.total_connectors
                                )}
                            </Table.Cell>
                            <Table.Cell textAlign="right">
                                {job.total_processed.toLocaleString()}
                            </Table.Cell>
                            <Table.Cell textAlign="right" color="green.600">
                                {job.total_new > 0 ? `+${job.total_new}` : '-'}
                            </Table.Cell>
                            <Table.Cell textAlign="right" color="blue.600">
                                {job.total_updated > 0 ? job.total_updated : '-'}
                            </Table.Cell>
                            <Table.Cell textAlign="right" color={job.total_errors > 0 ? 'red.600' : undefined}>
                                {job.total_errors > 0 ? job.total_errors : '-'}
                            </Table.Cell>
                            <Table.Cell>
                                <IconButton
                                    aria-label="View details"
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => onViewJob?.(job.id)}
                                >
                                    <LuEye />
                                </IconButton>
                            </Table.Cell>
                        </Table.Row>
                    ))}
                </Table.Body>
            </Table.Root>

            {/* Pagination */}
            {totalPages > 1 && (
                <Flex justify="space-between" align="center" mt={4}>
                    <Text fontSize="sm" color="gray.500">
                        Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
                    </Text>
                    <HStack gap={2}>
                        <IconButton
                            aria-label="Previous page"
                            size="sm"
                            variant="outline"
                            disabled={page === 0}
                            onClick={() => setPage(page - 1)}
                        >
                            <LuChevronLeft />
                        </IconButton>
                        <Text fontSize="sm">
                            Page {page + 1} of {totalPages}
                        </Text>
                        <IconButton
                            aria-label="Next page"
                            size="sm"
                            variant="outline"
                            disabled={page >= totalPages - 1}
                            onClick={() => setPage(page + 1)}
                        >
                            <LuChevronRight />
                        </IconButton>
                    </HStack>
                </Flex>
            )}
        </Box>
    );
};
