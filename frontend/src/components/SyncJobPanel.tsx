import { Badge, Button, Progress, Spinner, type BadgeColorScheme } from './ui/primitives';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuEye, LuHistory } from 'react-icons/lu';
import {
    API_URL,
    AccountSummary,
    ConnectorOverride,
    ConnectorProgress,
    ConnectorsInfo,
    ConnectorSyncStatus,
    EnabledConnector,
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
import { SyncRecapDialog } from './SyncRecapDialog';
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

// Background classes for accordion type/group headers, keyed by the closed
// status-color set produced by getAggregateInfo() below.
const TYPE_HEADER_BG: Record<string, string> = {
    gray: 'bg-slate-50',
    blue: 'bg-blue-50',
    red: 'bg-red-50',
    orange: 'bg-orange-50',
    green: 'bg-green-50',
};

export const SyncJobPanel: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
    const queryClient = useQueryClient();
    const [activeTab, setActiveTab] = useState<'control' | 'history'>('control');
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

    // Accordion state for progress cards grouping
    const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    // Initialize both as "all expanded" on first render
    const typesInitialized = useRef(false);

    // Stable callback for config data from SyncConfigPanel (avoids re-render loop)
    const handleConfigDataChange = useCallback((connectors: EnabledConnector[], accounts: AccountSummary[]) => {
        setConfigConnectors(connectors);
        setConfigAccounts(accounts);
    }, []);

    // Recap dialog state (replaces old renormalize confirm)
    const [recapOpen, setRecapOpen] = useState(false);
    const [recapRenormalize, setRecapRenormalize] = useState(false);
    const [configConnectors, setConfigConnectors] = useState<EnabledConnector[]>([]);
    const [configAccounts, setConfigAccounts] = useState<AccountSummary[]>([]);

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

    // Initial load and refresh when tab becomes active
    const hasLoadedRef = useRef(false);
    useEffect(() => {
        if (!isActive) return;
        // Always fetch on first mount; after that, refetch when tab becomes active again
        fetchJobStatus();
        fetchConnectors();
        hasLoadedRef.current = true;
    }, [isActive, fetchJobStatus, fetchConnectors]);

    // Poll for status updates when job is running — only while tab is active
    useEffect(() => {
        if (jobStatus?.status === 'running' && isActive) {
            const interval = setInterval(fetchJobStatus, 2000);
            return () => clearInterval(interval);
        }
    }, [jobStatus?.status, isActive, fetchJobStatus]);

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
            const requestBody: SyncJobStartRequest = { trigger_source: 'manual' };

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
            <div className="p-6 text-center">
                <Spinner size="lg" />
                <p className="mt-2">Loading sync job status...</p>
            </div>
        );
    }

    return (
        <div className="p-4">
            <h1 className="mb-6 text-xl font-semibold">Sync Transactions</h1>

            {error && (
                <div className="mb-4 bg-red-100 p-3 text-red-800">
                    Error: {error}
                </div>
            )}

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'control' | 'history')}>
                <TabsList className="mb-4">
                    <TabsTrigger value="control">
                        🎛️ Control
                    </TabsTrigger>
                    <TabsTrigger value="history">
                        📜 History
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="control">

                    {/* Sync Configuration Panel (enable/disable connectors, test mode) */}
                    <div className="mb-4">
                        <SyncConfigPanel
                            onOverridesChange={setSyncOverrides}
                            onConfigDataChange={handleConfigDataChange}
                            disabled={isFullJobRunning}
                        />
                    </div>

                    {/* Controls Card */}
                    <div className="mb-6 border border-slate-200 bg-white p-4 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                {jobStatus && (
                                    <>
                                        <Badge colorScheme={getStatusColor(jobStatus.status) as BadgeColorScheme}>
                                            {jobStatus.status.toUpperCase()}
                                            {jobStatus.abort_requested && ' (Aborting...)'}
                                        </Badge>
                                        {jobStatus.status === 'pending' && (
                                            <span className="text-sm text-slate-500">
                                                Initializing connectors...
                                            </span>
                                        )}
                                    </>
                                )}
                                {syncOverrides.length > 0 && canStart && (
                                    <span className="text-sm text-blue-400">
                                        {syncOverrides.length} override{syncOverrides.length !== 1 ? 's' : ''} configured
                                    </span>
                                )}
                            </div>
                            <div className="flex gap-2">
                                {canStart && (
                                    <>
                                        <Button
                                            colorScheme="blue"
                                            onClick={() => { setRecapRenormalize(false); setRecapOpen(true); }}
                                            loading={actionLoading}
                                            disabled={!canStart}
                                        >
                                            Start Sync Job
                                        </Button>
                                        <Button
                                            colorScheme="gray"
                                            variant="outline"
                                            className="border-purple-300 text-purple-700 hover:bg-purple-50"
                                            onClick={() => { setRecapRenormalize(true); setRecapOpen(true); }}
                                            loading={actionLoading}
                                            disabled={!canStart}
                                        >
                                            Re-Normalize
                                        </Button>
                                    </>
                                )}
                                {isFullJobRunning && (
                                    <Button
                                        colorScheme="red"
                                        variant="outline"
                                        onClick={abortJob}
                                        loading={actionLoading}
                                    >
                                        Abort Job
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Status Card */}
                    {jobStatus && jobStatus.status !== 'idle' && jobStatus.status !== 'pending' && (
                        <div className="mb-6 border border-slate-200 bg-white shadow-sm">
                            <div className="border-b border-slate-200 px-4 py-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-base font-semibold">
                                            {jobStatus.renormalize ? 'Re-Normalization Progress' : 'Job Progress'}
                                        </h2>
                                        {jobStatus.renormalize && (
                                            <Badge colorScheme="purple">Re-Normalize</Badge>
                                        )}
                                    </div>
                                    {hasFailedConnectors && !isFullJobRunning && (
                                        <span className="text-sm text-red-400">
                                            Some connectors failed. Expand cards to retry.
                                        </span>
                                    )}
                                </div>
                            </div>
                            <div className="p-4">
                                {/* Progress Bar (only during full job, not single-connector retry) */}
                                {isFullJobRunning && (
                                    <div className="mb-4">
                                        <div className="mb-1 flex justify-between">
                                            <span className="text-sm">
                                                Processing: {jobStatus.current_connector || 'Initializing...'}
                                            </span>
                                            <span className="text-sm">
                                                {jobStatus.connectors_completed.length} / {jobStatus.total_connectors} connectors
                                            </span>
                                        </div>
                                        <Progress value={getProgressPercent()} max={100} size="sm" colorScheme={getJobProgressBarColor() as 'blue' | 'orange'} />
                                        {jobStatus.error_count > 0 && (
                                            <p className="mt-1 text-xs text-orange-600">
                                                ⚠️ {jobStatus.error_count} error{jobStatus.error_count !== 1 ? 's' : ''} encountered so far
                                            </p>
                                        )}
                                    </div>
                                )}

                                {/* Statistics Grid */}
                                <div className="mb-4 flex flex-wrap gap-6">
                                    <div>
                                        <p className="text-sm text-slate-500">Total Processed</p>
                                        <p className="text-2xl font-bold">{jobStatus.total_processed}</p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-slate-500">New Entries Added</p>
                                        <p className="text-2xl font-bold text-green-600">
                                            {jobStatus.new_entries_added}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-slate-500">Entries Updated</p>
                                        <p className="text-2xl font-bold text-blue-600">
                                            {jobStatus.entries_updated ?? 0}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-slate-500">Duplicates Skipped</p>
                                        <p className="text-2xl font-bold text-slate-500">
                                            {jobStatus.duplicates_skipped}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-slate-500">Errors</p>
                                        <p className={`text-2xl font-bold ${jobStatus.error_count > 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                            {jobStatus.error_count}
                                        </p>
                                    </div>
                                </div>

                                {/* Timing */}
                                <div className="mb-4 flex flex-wrap gap-6">
                                    <div>
                                        <p className="text-sm text-slate-500">Started</p>
                                        <p>{formatDateTime(jobStatus.started_at)}</p>
                                    </div>
                                    <div>
                                        <p className="text-sm text-slate-500">Finished</p>
                                        <p>{formatDateTime(jobStatus.finished_at)}</p>
                                    </div>
                                </div>

                                {/* Per-Connector Progress - Grouped by Type → Group with Accordion */}
                                {jobStatus.connector_statuses &&
                                    Object.keys(jobStatus.connector_statuses).length > 0 && (
                                        <div>
                                            <p className="mb-3 text-sm text-slate-500">
                                                Connector Progress
                                            </p>
                                            {(() => {
                                                const sorted = getSortedConnectorStatuses();
                                                // Build nested grouping: type → group → connectors (flat, no per-account grid)
                                                const typeMap = new Map<string, Map<string, ConnectorProgress[]>>();
                                                const typeLabels: Record<string, string> = {
                                                    cex: '🏦 Exchanges',
                                                    dex: '🔗 DEX',
                                                    wallet: '💼 Wallets',
                                                    broker: '📊 Brokers',
                                                    bank: '🏛️ Banks',
                                                    investment: '📈 Investments',
                                                };
                                                for (const cp of sorted) {
                                                    const t = cp.account_type || 'other';
                                                    const g = cp.account_group || 'Ungrouped';
                                                    if (!typeMap.has(t)) typeMap.set(t, new Map());
                                                    const groupMap = typeMap.get(t)!;
                                                    if (!groupMap.has(g)) groupMap.set(g, []);
                                                    groupMap.get(g)!.push(cp);
                                                }
                                                const typeOrder = ['cex', 'dex', 'wallet', 'broker', 'bank', 'investment', 'other'];
                                                const sortedTypes = Array.from(typeMap.keys()).sort(
                                                    (a, b) => (typeOrder.indexOf(a) === -1 ? 99 : typeOrder.indexOf(a)) - (typeOrder.indexOf(b) === -1 ? 99 : typeOrder.indexOf(b))
                                                );
                                                const hasManyTypes = sortedTypes.length > 1;

                                                // Initialize accordion state on first data
                                                if (!typesInitialized.current && sorted.length > 0) {
                                                    typesInitialized.current = true;
                                                    setExpandedTypes(new Set(sortedTypes));
                                                    const allGroupKeys = new Set<string>();
                                                    for (const [t, gm] of typeMap) {
                                                        for (const g of gm.keys()) allGroupKeys.add(`${t}:${g}`);
                                                    }
                                                    setExpandedGroups(allGroupKeys);
                                                }

                                                // Helper to compute aggregate status for a set of connectors
                                                const getAggregateInfo = (cps: ConnectorProgress[]) => {
                                                    const total = cps.length;
                                                    const completed = cps.filter(c => c.status === 'completed').length;
                                                    const failed = cps.filter(c => c.status === 'failed').length;
                                                    const running = cps.filter(c => c.status === 'running').length;
                                                    const warning = cps.filter(c => c.status === 'warning').length;
                                                    const pending = cps.filter(c => c.status === 'pending' || c.status === 'queued').length;
                                                    const skipped = cps.filter(c => c.status === 'skipped').length;
                                                    const totalNew = cps.reduce((s, c) => s + (c.new_count ?? c.new_entries ?? 0), 0);
                                                    const totalErrors = cps.reduce((s, c) => s + (c.errors ?? 0), 0);

                                                    let icon = '⏳';
                                                    let color = 'gray';
                                                    if (running > 0) { icon = '🔄'; color = 'blue'; }
                                                    else if (failed > 0) { icon = '❌'; color = 'red'; }
                                                    else if (warning > 0) { icon = '⚠️'; color = 'orange'; }
                                                    else if (completed === total) { icon = '✅'; color = 'green'; }
                                                    else if (skipped === total) { icon = '⏭️'; color = 'gray'; }

                                                    return { total, completed, failed, running, warning, pending, skipped, totalNew, totalErrors, icon, color };
                                                };

                                                return sortedTypes.map(typeKey => {
                                                    const groupMap = typeMap.get(typeKey)!;
                                                    const groupEntries = Array.from(groupMap.entries());
                                                    const hasManyGroups = groupEntries.length > 1 || (groupEntries.length === 1 && groupEntries[0][0] !== 'Ungrouped');
                                                    const allTypeConnectors = groupEntries.flatMap(([, cps]) => cps);
                                                    const typeInfo = getAggregateInfo(allTypeConnectors);
                                                    const isTypeExpanded = expandedTypes.has(typeKey);

                                                    return (
                                                        <div key={typeKey} className="mb-3">
                                                            {/* Type accordion header */}
                                                            {hasManyTypes && (
                                                                <div
                                                                    className={`mb-1 flex cursor-pointer items-center justify-between px-2 py-1.5 transition-opacity hover:opacity-85 ${TYPE_HEADER_BG[typeInfo.color] ?? 'bg-slate-50'}`}
                                                                    onClick={() => setExpandedTypes(prev => {
                                                                        const next = new Set(prev);
                                                                        if (next.has(typeKey)) next.delete(typeKey); else next.add(typeKey);
                                                                        return next;
                                                                    })}
                                                                >
                                                                    <div className="flex items-center gap-2">
                                                                        <span className="text-xs text-slate-400">{isTypeExpanded ? '▼' : '▶'}</span>
                                                                        <span className="text-sm font-semibold text-slate-700">
                                                                            {typeLabels[typeKey] || typeKey}
                                                                        </span>
                                                                        <span className="text-xs text-slate-500">
                                                                            {typeInfo.icon} {typeInfo.completed}/{typeInfo.total}
                                                                        </span>
                                                                    </div>
                                                                    <div className="flex items-center gap-2">
                                                                        {typeInfo.totalNew > 0 && (
                                                                            <span className="text-xs text-green-500">+{typeInfo.totalNew}</span>
                                                                        )}
                                                                        {typeInfo.totalErrors > 0 && (
                                                                            <span className="text-xs text-red-500">{typeInfo.totalErrors} err</span>
                                                                        )}
                                                                        {typeInfo.running > 0 && (
                                                                            <Badge colorScheme="blue">{typeInfo.running} running</Badge>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            )}

                                                            {(!hasManyTypes || isTypeExpanded) && (
                                                                <>
                                                                    {groupEntries.map(([groupName, groupConnectors]) => {
                                                                        const groupKey = `${typeKey}:${groupName}`;
                                                                        const isGroupExpanded = expandedGroups.has(groupKey);
                                                                        const groupInfo = getAggregateInfo(groupConnectors);

                                                                        return (
                                                                            <div key={groupName} className={`mb-2 ${hasManyTypes ? 'ml-2' : ''}`}>
                                                                                {/* Group accordion header */}
                                                                                {hasManyGroups && (
                                                                                    <div
                                                                                        className="mb-1 flex cursor-pointer items-center justify-between px-2 py-1 hover:bg-slate-50"
                                                                                        onClick={() => setExpandedGroups(prev => {
                                                                                            const next = new Set(prev);
                                                                                            if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
                                                                                            return next;
                                                                                        })}
                                                                                    >
                                                                                        <div className="flex items-center gap-2">
                                                                                            <span className="text-xs text-slate-400">{isGroupExpanded ? '▼' : '▶'}</span>
                                                                                            <span className="text-xs font-medium text-slate-600">
                                                                                                {groupName}
                                                                                            </span>
                                                                                            <span className="text-xs text-slate-400">
                                                                                                {groupInfo.icon} {groupInfo.completed}/{groupInfo.total}
                                                                                            </span>
                                                                                        </div>
                                                                                        <div className="flex items-center gap-2">
                                                                                            {groupInfo.totalNew > 0 && (
                                                                                                <span className="text-xs text-green-500">+{groupInfo.totalNew}</span>
                                                                                            )}
                                                                                            {groupInfo.totalErrors > 0 && (
                                                                                                <span className="text-xs text-red-500">{groupInfo.totalErrors} err</span>
                                                                                            )}
                                                                                        </div>
                                                                                    </div>
                                                                                )}

                                                                                {(!hasManyGroups || isGroupExpanded) && (
                                                                                    <div
                                                                                        className={`grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3 ${hasManyGroups ? 'ml-2' : ''}`}
                                                                                    >
                                                                                        {groupConnectors.map((cp) => (
                                                                                            <ConnectorProgressCard
                                                                                                key={cp.connector_id}
                                                                                                progress={cp}
                                                                                                isExpanded={cp.status === 'failed' || cp.status === 'warning'}
                                                                                                showAccountName={hasManyGroups || groupConnectors.length > 1}
                                                                                                onRetry={retryConnector}
                                                                                                retryLoading={retryLoading === cp.connector_id}
                                                                                                renormalize={jobStatus.renormalize}
                                                                                            />
                                                                                        ))}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        );
                                                                    })}
                                                                </>
                                                            )}
                                                        </div>
                                                    );
                                                });
                                            })()}
                                        </div>
                                    )}

                                {/* Legacy: Completed Connectors (fallback for backward compatibility) */}
                                {!jobStatus.connector_statuses && jobStatus.connectors_completed.length > 0 && (
                                    <div className="mb-4">
                                        <p className="mb-1 text-sm text-slate-500">Completed Connectors</p>
                                        <div className="flex flex-wrap gap-2">
                                            {jobStatus.connectors_completed.map((c: string) => (
                                                <Badge key={c} colorScheme="green">{c}</Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {/* Error Message */}
                                {jobStatus.error_message && (
                                    <div className="mt-4 border border-red-200 bg-red-50 p-3">
                                        <p className="font-bold text-red-700">
                                            Error:
                                        </p>
                                        <p className="text-red-600">{jobStatus.error_message}</p>
                                    </div>
                                )}

                                {/* Error List */}
                                {jobStatus.errors.length > 0 && (
                                    <div className="mt-4">
                                        <p className="mb-2 text-sm text-slate-500">
                                            Recent Errors ({jobStatus.error_count} total):
                                        </p>
                                        <div className="max-h-[200px] overflow-y-auto bg-slate-50 p-3 font-mono text-xs">
                                            {jobStatus.errors.map((err: string, idx: number) => (
                                                <p key={idx} className="mb-1 text-red-600">{err}</p>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </TabsContent>

                {/* Job History Tab */}
                <TabsContent value="history">
                    <div className="border border-slate-200 bg-white shadow-sm">
                        <div className="p-4">
                            <JobHistoryTable
                                onViewJob={(jobId) => {
                                    setSelectedJobId(jobId);
                                    setJobDrawerOpen(true);
                                }}
                                refreshTrigger={historyRefreshTrigger}
                            />
                        </div>
                    </div>
                </TabsContent>
            </Tabs>

            {/* Job Detail Drawer */}
            <JobDetailDrawer
                jobId={selectedJobId}
                open={jobDrawerOpen}
                onClose={() => {
                    setJobDrawerOpen(false);
                    setSelectedJobId(null);
                }}
            />

            {/* Sync Recap / Confirmation Dialog */}
            <SyncRecapDialog
                isOpen={recapOpen}
                onClose={() => setRecapOpen(false)}
                onConfirm={() => {
                    setRecapOpen(false);
                    startJob(recapRenormalize);
                }}
                connectors={configConnectors}
                accounts={configAccounts}
                overrides={syncOverrides}
                renormalize={recapRenormalize}
                loading={actionLoading}
            />
        </div>
    );
};
