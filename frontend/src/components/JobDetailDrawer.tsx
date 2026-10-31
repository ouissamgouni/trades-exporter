import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';
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
        <div
            className="cursor-pointer border border-slate-200 bg-slate-50 p-3 hover:bg-slate-100"
            onClick={onExpand}
        >
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Badge colorScheme={statusColorMap[run.status] as BadgeColorScheme}>
                        {run.status}
                    </Badge>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-sm font-medium">
                            {run.connector_type || `Connector #${run.connector_id}`}
                        </span>
                        <span className="text-xs text-slate-500">
                            {run.account_name || '-'}
                        </span>
                        <span className="text-xs text-slate-400">
                            ID: {run.connector_id}
                        </span>
                    </div>
                    {run.test_mode && (
                        <Badge colorScheme="purple">
                            Test
                        </Badge>
                    )}
                    {duplicateCount !== null && duplicateCount > 0 && (
                        <Badge colorScheme="orange">
                            ⚠ {duplicateCount} Duplicate{duplicateCount > 1 ? 's' : ''}
                        </Badge>
                    )}
                </div>
                <div className="flex items-center gap-4 text-sm">
                    <div className="flex flex-col items-end gap-0">
                        <span className="text-slate-500">Processed</span>
                        <span className="font-medium">{run.processed_count}</span>
                    </div>
                    <div className="flex flex-col items-end gap-0">
                        <span className="text-green-600">New</span>
                        <span className="font-medium text-green-600">
                            +{run.synced_count}
                        </span>
                    </div>
                    <div className="flex flex-col items-end gap-0">
                        <span className="text-blue-600">Updated</span>
                        <span className="font-medium text-blue-600">
                            {run.updated_count}
                        </span>
                    </div>
                    {run.error_count > 0 && (
                        <div className="flex flex-col items-end gap-0">
                            <span className="text-red-600">Errors</span>
                            <span className="font-medium text-red-600">
                                {run.error_count}
                            </span>
                        </div>
                    )}
                    <LuChevronRight />
                </div>
            </div>
        </div>
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

    const [activeTab, setActiveTab] = useState<'logs' | 'synced' | 'updated' | 'skipped' | 'errors' | 'duplicates'>('logs');

    if (loading) {
        return (
            <div className="flex justify-center py-8">
                <Spinner />
            </div>
        );
    }

    if (error || !detail) {
        return (
            <div>
                <Button size="sm" variant="ghost" onClick={onBack} className="mb-4">
                    ← Back to Job
                </Button>
                <p className="text-red-600">Error: {error || 'Not found'}</p>
            </div>
        );
    }

    return (
        <div>
            <Button size="sm" variant="ghost" onClick={onBack} className="mb-4">
                ← Back to Job
            </Button>

            <div className="mb-4 flex items-start justify-between">
                <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold">
                            {detail.connector_type || `Connector #${detail.connector_id}`}
                        </h2>
                        <Badge colorScheme={statusColorMap[detail.status] as BadgeColorScheme}>
                            {detail.status}
                        </Badge>
                        {detail.test_mode && (
                            <Badge colorScheme="purple">Test Mode</Badge>
                        )}
                    </div>
                    <span className="text-sm text-slate-500">
                        {detail.account_name || '-'}
                    </span>
                </div>
            </div>

            {/* Metrics */}
            <div className="mb-6 bg-slate-50 p-4">
                <div className="flex flex-wrap gap-6">
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">Duration</span>
                        <span className="font-medium">
                            {formatDuration(detail.started_at, detail.finished_at)}
                        </span>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">Processed</span>
                        <span className="font-medium">{detail.processed_count}</span>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">New</span>
                        <span className="font-medium text-green-600">
                            +{detail.synced_count}
                        </span>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">Updated</span>
                        <span className="font-medium text-blue-600">
                            {detail.updated_count}
                        </span>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">Skipped</span>
                        <span className="font-medium">{detail.skipped_count}</span>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <span className="text-xs text-slate-500">Errors</span>
                        <span className={`font-medium ${detail.error_count > 0 ? 'text-red-600' : ''}`}>
                            {detail.error_count}
                        </span>
                    </div>
                    {duplicateCount && duplicateCount.group_count > 0 && (
                        <div className="flex flex-col items-start gap-0">
                            <span className="text-xs text-slate-500">Duplicates</span>
                            <div className="flex items-center gap-1">
                                <span className="font-medium text-orange-600">
                                    ⚠ {duplicateCount.group_count}
                                </span>
                                <span className="text-xs text-slate-400">
                                    ({duplicateCount.transaction_count} txs)
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
                <TabsList>
                    <TabsTrigger value="logs">
                        Logs ({detail.logs.length})
                    </TabsTrigger>
                    <TabsTrigger value="synced">
                        Synced ({detail.synced_ids.length})
                    </TabsTrigger>
                    <TabsTrigger value="updated">
                        Updated ({detail.updated_ids.length})
                    </TabsTrigger>
                    <TabsTrigger value="skipped">
                        Skipped ({detail.skipped_ids.length})
                    </TabsTrigger>
                    {detail.error_details.length > 0 && (
                        <TabsTrigger value="errors">
                            Errors ({detail.error_details.length})
                        </TabsTrigger>
                    )}
                    <TabsTrigger value="duplicates">
                        Duplicates{duplicateCount && duplicateCount.group_count > 0 ? ` (${duplicateCount.group_count})` : ''}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="logs">
                    <div className="max-h-[300px] overflow-y-auto font-mono text-xs">
                        {detail.logs.length === 0 ? (
                            <p className="py-4 text-slate-500">No logs available</p>
                        ) : (
                            detail.logs.map((log, idx) => (
                                <div key={idx} className="flex gap-2 border-b border-slate-100 py-1">
                                    <span className="shrink-0 text-slate-400">
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </span>
                                    <Badge
                                        colorScheme={
                                            log.level === 'ERROR'
                                                ? 'red'
                                                : log.level === 'WARNING'
                                                    ? 'orange'
                                                    : 'gray'
                                        }
                                    >
                                        {log.level}
                                    </Badge>
                                    <span>{log.message}</span>
                                </div>
                            ))
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="synced">
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
                </TabsContent>

                <TabsContent value="updated">
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
                </TabsContent>

                <TabsContent value="skipped">
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
                </TabsContent>

                <TabsContent value="errors">
                    <div className="max-h-[300px] overflow-y-auto">
                        {detail.error_details.map((err, idx) => (
                            <div
                                key={idx}
                                className="mb-2 bg-red-50 p-2"
                            >
                                <p className="font-mono text-xs font-medium">
                                    {err.source_transaction_id}
                                </p>
                                <p className="text-xs text-red-600">
                                    {err.error}
                                </p>
                            </div>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="duplicates">
                    <div className="max-h-[500px] overflow-y-auto">
                        <DuplicateResolutionPanel
                            connectorRunId={detail.id}
                            compactMode={true}
                        />
                    </div>
                </TabsContent>
            </Tabs>

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
        </div>
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
            <div
                className="fixed inset-0 z-[1000] bg-black/40"
                onClick={onClose}
            />

            {/* Drawer Panel: bottom sheet on mobile, right-side panel on sm+ */}
            <div
                className="fixed inset-x-0 bottom-0 top-auto z-[1001] flex max-h-[90vh] w-full max-w-full flex-col overflow-hidden border-t border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[95vw] sm:border-t-0"
                style={{ ['--sheet-w' as string]: `${drawerWidth}px` }}
            >
                {/* Resize Handle (desktop only) */}
                <div
                    className={`absolute bottom-0 left-0 top-0 z-[1] hidden w-1 cursor-col-resize transition-colors hover:bg-blue-200 sm:block ${isResizing ? 'bg-blue-400' : 'bg-transparent'}`}
                    onMouseDown={handleResizeStart}
                />
                {/* Header */}
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold">
                            {mergedJob ? `Job #${mergedJob.id}` : 'Job Details'}
                        </h2>
                        {mergedJob?.renormalize && (
                            <Badge colorScheme="purple">
                                Re-Normalize
                            </Badge>
                        )}
                        {realTimeStatus && (
                            <Badge colorScheme="blue">
                                Live
                            </Badge>
                        )}
                    </div>
                    <Button
                        aria-label="Close"
                        variant="ghost"
                        size="sm"
                        onClick={onClose}
                    >
                        <LuX />
                    </Button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-auto p-4">
                    {loading && (
                        <div className="flex justify-center py-8">
                            <Spinner size="lg" />
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-50 p-4">
                            <p className="text-red-600">Error: {error}</p>
                            <Button size="sm" className="mt-2" onClick={fetchJob}>
                                Retry
                            </Button>
                        </div>
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
                                    <div className="mb-4 flex items-start justify-between">
                                        <div className="flex flex-col items-start gap-1">
                                            <div className="flex items-center gap-2">
                                                <Badge
                                                    colorScheme={statusColorMap[mergedJob.status] as BadgeColorScheme}
                                                >
                                                    {mergedJob.status}
                                                </Badge>
                                                {mergedJob.renormalize && (
                                                    <Badge colorScheme="purple">
                                                        Re-Normalize
                                                    </Badge>
                                                )}
                                                {mergedJob.error_message && (
                                                    <span className="text-sm text-red-600">
                                                        {mergedJob.error_message}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-4 text-xs text-slate-500">
                                                <div className="flex items-center gap-1">
                                                    <LuClock size={12} />
                                                    <span>Started: {formatDateTime(mergedJob.started_at)}</span>
                                                </div>
                                                {mergedJob.finished_at ? (
                                                    <span>
                                                        Duration: {formatDuration(mergedJob.started_at, mergedJob.finished_at)}
                                                    </span>
                                                ) : mergedJob.status === 'running' ? (
                                                    <span>
                                                        Running: {formatDuration(mergedJob.started_at)}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                        <Button
                                            aria-label="Refresh"
                                            size="sm"
                                            variant="ghost"
                                            onClick={fetchJob}
                                        >
                                            <LuRefreshCw />
                                        </Button>
                                    </div>

                                    {/* Summary Metrics */}
                                    <div className="mb-6 bg-slate-50 p-4">
                                        <div className="flex flex-wrap gap-6">
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    Connectors
                                                </span>
                                                <span className="font-medium">
                                                    {mergedJob.total_connectors}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    Processed
                                                </span>
                                                <span className="font-medium">
                                                    {mergedJob.total_processed.toLocaleString()}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    New
                                                </span>
                                                <span className="font-medium text-green-600">
                                                    +{mergedJob.total_new}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    Updated
                                                </span>
                                                <span className="font-medium text-blue-600">
                                                    {mergedJob.total_updated}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    Skipped
                                                </span>
                                                <span className="font-medium">
                                                    {mergedJob.total_skipped}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-start gap-0">
                                                <span className="text-xs text-slate-500">
                                                    Errors
                                                </span>
                                                <span
                                                    className={`font-medium ${mergedJob.total_errors > 0 ? 'text-red-600' : ''}`}
                                                >
                                                    {mergedJob.total_errors}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Connector Runs */}
                                    <h3 className="mb-3 text-sm font-semibold">
                                        Connector Runs
                                    </h3>
                                    <div className="flex flex-col items-stretch gap-2">
                                        {mergedJob.connector_runs.map((run) => (
                                            <ConnectorRunCard
                                                key={run.id}
                                                run={run}
                                                onExpand={() => setSelectedRunId(run.id)}
                                            />
                                        ))}
                                    </div>

                                    {mergedJob.connector_runs.length === 0 && (
                                        <p className="py-4 text-slate-500">
                                            No connector runs found
                                        </p>
                                    )}
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </>
    );
};
