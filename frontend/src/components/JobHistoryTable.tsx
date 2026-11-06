import React, { useCallback, useEffect, useState } from 'react';
import { FiXOctagon } from 'react-icons/fi';
import { LuChevronLeft, LuChevronRight, LuEye, LuRefreshCw } from 'react-icons/lu';
import {
    API_URL,
    JobHistoryResponse,
    SyncJobSummary,
    SyncJobStatus,
} from '../types';
import { Badge, type BadgeColorScheme, Button, Heading, ResponsiveTable, Spinner } from './ui/primitives';
import { toaster } from './ui/toaster';
import { abortSyncJob } from '../utils/syncJobApi';

interface JobHistoryTableProps {
    onViewJob?: (jobId: number) => void;
    onJobAborted?: () => void;
    refreshTrigger?: number;
}

const statusColorMap: Record<SyncJobStatus, BadgeColorScheme> = {
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
    onJobAborted,
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

    const [abortingId, setAbortingId] = useState<number | null>(null);
    const handleAbort = async (jobId: number) => {
        setAbortingId(jobId);
        try {
            const result = await abortSyncJob(jobId);
            toaster.success({ title: `Job #${jobId} aborted`, description: result.message });
            await fetchHistory();
            onJobAborted?.();
        } catch (err) {
            toaster.error({ title: 'Abort failed', description: err instanceof Error ? err.message : 'Failed to abort job' });
        } finally {
            setAbortingId(null);
        }
    };

    const totalPages = Math.ceil(total / limit);

    if (loading && jobs.length === 0) {
        return (
            <div className="flex items-center justify-center py-8">
                <Spinner size="lg" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="bg-red-50 p-4">
                <span className="block text-red-600">Error: {error}</span>
                <Button size="sm" className="mt-2" onClick={fetchHistory}>
                    Retry
                </Button>
            </div>
        );
    }

    if (jobs.length === 0) {
        return (
            <div className="py-8 text-center text-slate-500">
                <span className="block">No sync jobs found</span>
                <span className="mt-1 block text-sm">
                    Run a sync job to see history here
                </span>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-4 flex items-center justify-between">
                <Heading className="text-sm">Job History</Heading>
                <Button
                    aria-label="Refresh"
                    size="sm"
                    variant="ghost"
                    onClick={fetchHistory}
                    disabled={loading}
                >
                    <LuRefreshCw className={loading ? 'animate-spin' : ''} />
                </Button>
            </div>

            <ResponsiveTable>
                <table className="w-full min-w-[720px] text-sm">
                    <thead>
                        <tr className="bg-slate-50 text-left">
                            <th className="px-2 py-1">ID</th>
                            <th className="px-2 py-1">Config</th>
                            <th className="px-2 py-1">Status</th>
                            <th className="px-2 py-1">Started</th>
                            <th className="px-2 py-1">Duration</th>
                            <th className="px-2 py-1 text-right">Connectors</th>
                            <th className="px-2 py-1 text-right">Processed</th>
                            <th className="px-2 py-1 text-right">New</th>
                            <th className="px-2 py-1 text-right">Updated</th>
                            <th className="px-2 py-1 text-right">Errors</th>
                            <th className="px-2 py-1"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {jobs.map((job) => (
                            <tr key={job.id} className={`border-b border-slate-100 ${job.is_orphaned ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-slate-50'}`}>
                                <td className="px-2 py-1 font-mono text-xs">
                                    #{job.id}
                                </td>
                                <td className="px-2 py-1">
                                    <div className="flex flex-wrap gap-1">
                                        <Badge colorScheme={job.renormalize ? 'purple' : 'blue'}>
                                            {job.renormalize ? 'Re-Normalize' : 'Sync'}
                                        </Badge>
                                        {job.connector_runs?.some(r => r.test_mode) && (
                                            <Badge colorScheme="orange">Test</Badge>
                                        )}
                                    </div>
                                </td>
                                <td className="px-2 py-1">
                                    <div className="flex flex-wrap items-center gap-1">
                                        <Badge colorScheme={statusColorMap[job.status]}>
                                            {job.status}
                                        </Badge>
                                        {job.is_orphaned && (
                                            <Badge colorScheme="red" title="No worker is running this job; it blocks new syncs until aborted">
                                                stuck
                                            </Badge>
                                        )}
                                    </div>
                                </td>
                                <td className="px-2 py-1 text-xs">
                                    {formatDate(job.started_at)}
                                </td>
                                <td className="px-2 py-1 text-xs">
                                    {job.finished_at || job.status === 'running' || job.status === 'pending'
                                        ? formatDuration(job.started_at, job.finished_at)
                                        : '-'}
                                </td>
                                <td className="px-2 py-1 text-right">
                                    {job.connector_runs && job.connector_runs.length > 0 ? (
                                        <div className="flex flex-wrap justify-end gap-1">
                                            {job.connector_runs.map((run) => (
                                                <Badge
                                                    key={run.id}
                                                    colorScheme={
                                                        run.status === 'completed' ? 'green' :
                                                            run.status === 'failed' ? 'red' :
                                                                run.status === 'running' ? 'blue' :
                                                                    run.status === 'queued' || run.status === 'pending' ? 'gray' :
                                                                        'orange'
                                                    }
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
                                        </div>
                                    ) : (
                                        job.total_connectors
                                    )}
                                </td>
                                <td className="px-2 py-1 text-right">
                                    {job.total_processed.toLocaleString()}
                                </td>
                                <td className="px-2 py-1 text-right text-green-600">
                                    {job.total_new > 0 ? `+${job.total_new}` : '-'}
                                </td>
                                <td className="px-2 py-1 text-right text-blue-600">
                                    {job.total_updated > 0 ? job.total_updated : '-'}
                                </td>
                                <td className={`px-2 py-1 text-right ${job.total_errors > 0 ? 'text-red-600' : ''}`}>
                                    {job.total_errors > 0 ? job.total_errors : '-'}
                                </td>
                                <td className="px-2 py-1">
                                    <div className="flex items-center justify-end gap-1">
                                        {job.is_orphaned && (
                                            <Button
                                                aria-label={`Abort stuck job #${job.id}`}
                                                title="Abort stuck job"
                                                size="sm"
                                                variant="ghost"
                                                colorScheme="red"
                                                loading={abortingId === job.id}
                                                onClick={() => handleAbort(job.id)}
                                            >
                                                <FiXOctagon />
                                            </Button>
                                        )}
                                        <Button
                                            aria-label="View details"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => onViewJob?.(job.id)}
                                        >
                                            <LuEye />
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </ResponsiveTable>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="mt-4 flex items-center justify-between">
                    <span className="text-sm text-slate-500">
                        Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total}
                    </span>
                    <div className="flex items-center gap-2">
                        <Button
                            aria-label="Previous page"
                            size="sm"
                            variant="outline"
                            disabled={page === 0}
                            onClick={() => setPage(page - 1)}
                        >
                            <LuChevronLeft />
                        </Button>
                        <span className="text-sm">
                            Page {page + 1} of {totalPages}
                        </span>
                        <Button
                            aria-label="Next page"
                            size="sm"
                            variant="outline"
                            disabled={page >= totalPages - 1}
                            onClick={() => setPage(page + 1)}
                        >
                            <LuChevronRight />
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};
