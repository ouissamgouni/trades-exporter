import {
    Badge,
    type BadgeColorScheme,
    Button,
    Heading,
    Spinner,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Text,
} from './ui/primitives';
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

const statusColorMap: Record<ConnectorSyncStatus, BadgeColorScheme> = {
    pending: 'yellow',
    queued: 'gray',
    running: 'blue',
    completed: 'green',
    failed: 'red',
    skipped: 'yellow',
    warning: 'orange',
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
    const [activeTab, setActiveTab] = useState<'logs' | 'synced' | 'updated' | 'skipped' | 'invalid' | 'errors' | 'duplicates'>('logs');
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
            <div className="flex justify-center py-8">
                <Spinner />
            </div>
        );
    }

    if (error || !detail) {
        return (
            <div>
                {onBack && (
                    <Button size="sm" variant="ghost" onClick={onBack} className="mb-4">
                        ← Back
                    </Button>
                )}
                <Text className="text-red-600">Error: {error || 'Not found'}</Text>
            </div>
        );
    }

    return (
        <div>
            {onBack && (
                <Button size="sm" variant="ghost" onClick={onBack} className="mb-4">
                    ← Back
                </Button>
            )}

            <div className="mb-4 flex items-start justify-between">
                <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-2">
                        <Heading as="h2" className="text-base">
                            {detail.connector_type || `Connector #${detail.connector_id}`}
                        </Heading>
                        <Badge colorScheme={statusColorMap[detail.status]}>
                            {detail.status}
                        </Badge>
                        {detail.test_mode && (
                            <Badge colorScheme="purple">Test Mode</Badge>
                        )}
                    </div>
                    <Text className="text-sm text-gray-500">
                        {detail.account_name || '-'}
                    </Text>
                </div>
            </div>

            {/* Refresh Control Bar - Only show for running connectors when polling is enabled */}
            {enablePolling && detail.status === 'running' && (
                <div className={`mb-4 p-3 ${isPaused ? 'bg-yellow-50' : 'bg-blue-50'}`}>
                    <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                colorScheme={isPaused ? 'green' : 'gray'}
                                className={isPaused ? '' : 'bg-yellow-500 hover:bg-yellow-600'}
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
                        </div>
                        <Text className="text-xs text-gray-600">
                            {isPaused ? (
                                'Auto-refresh paused'
                            ) : (
                                lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Auto-refreshing...'
                            )}
                        </Text>
                    </div>
                </div>
            )}

            {/* Metrics */}
            <div className="mb-6 bg-gray-50 p-4">
                <div className="flex flex-wrap gap-6">
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Duration</Text>
                        <Text className="font-medium">
                            {formatDuration(detail.started_at, detail.finished_at)}
                        </Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Processed</Text>
                        <Text className="font-medium">{detail.processed_count}</Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">New</Text>
                        <Text className="font-medium text-green-600">
                            +{detail.synced_count}
                        </Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Updated</Text>
                        <Text className="font-medium text-blue-600">
                            {detail.updated_count}
                        </Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Skipped</Text>
                        <Text className="font-medium">{detail.skipped_count}</Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Rejected</Text>
                        <Text className={`font-medium ${(detail.rejected_count ?? 0) > 0 ? 'text-red-600' : ''}`} title="Transactions of this run auto-rejected (e.g. spam) or rejected later">
                            {detail.rejected_count ?? detail.invalid_count ?? 0}
                        </Text>
                    </div>
                    <div className="flex flex-col items-start gap-0">
                        <Text className="text-xs text-gray-500">Errors</Text>
                        <Text className={`font-medium ${detail.error_count > 0 ? 'text-red-600' : ''}`}>
                            {detail.error_count}
                        </Text>
                    </div>
                    {duplicateCount && duplicateCount.group_count > 0 && (
                        <div className="flex flex-col items-start gap-0">
                            <Text className="text-xs text-gray-500">Duplicates</Text>
                            <div className="flex items-center gap-1">
                                <Text className="font-medium text-orange-600">
                                    ⚠ {duplicateCount.group_count}
                                </Text>
                                <Text className="text-xs text-gray-400">
                                    ({duplicateCount.transaction_count} txs)
                                </Text>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
                <TabsList>
                    <TabsTrigger value="logs">
                        Logs ({detail.logs?.length || 0})
                    </TabsTrigger>
                    <TabsTrigger value="synced">
                        Synced ({detail.synced_ids?.length || 0})
                    </TabsTrigger>
                    <TabsTrigger value="updated">
                        Updated ({detail.updated_ids?.length || 0})
                    </TabsTrigger>
                    <TabsTrigger value="skipped">
                        Skipped ({detail.skipped_ids?.length || 0})
                    </TabsTrigger>
                    <TabsTrigger value="invalid">
                        Rejected ({detail.rejected_count ?? detail.invalid_count ?? 0})
                    </TabsTrigger>
                    {detail.error_details && detail.error_details.length > 0 && (
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
                        {!detail.logs || detail.logs.length === 0 ? (
                            <Text className="block py-4 text-gray-500">No logs available</Text>
                        ) : (
                            detail.logs.map((log, idx) => (
                                <div key={idx} className="flex gap-2 border-b py-1">
                                    <Text className="shrink-0 text-gray-400">
                                        {new Date(log.timestamp).toLocaleTimeString()}
                                    </Text>
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
                                    <Text>{log.message}</Text>
                                </div>
                            ))
                        )}
                    </div>
                </TabsContent>

                <TabsContent value="synced">
                    <TransactionsTable
                        defaultExpandAllDays
                        tableId="connectorRun-synced"
                        expandInvalidRows
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
                            connectorRunOutcome: 'synced',
                        }}
                        onDataChange={fetchDetail}
                    />
                </TabsContent>

                <TabsContent value="updated">
                    <TransactionsTable
                        defaultExpandAllDays
                        tableId="connectorRun-updated"
                        expandInvalidRows
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
                            connectorRunOutcome: 'updated',
                        }}
                        onDataChange={fetchDetail}
                    />
                </TabsContent>

                <TabsContent value="skipped">
                    <TransactionsTable
                        defaultExpandAllDays
                        tableId="connectorRun-skipped"
                        expandInvalidRows
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
                            connectorRunOutcome: 'skipped',
                        }}
                        onDataChange={fetchDetail}
                    />
                </TabsContent>

                <TabsContent value="invalid">
                    <TransactionsTable
                        defaultExpandAllDays
                        tableId="connectorRun-invalid"
                        title=""
                        subtitle=""
                        showFilters={false}
                        showBundles={false}
                        showSuggestions={false}
                        compact={true}
                        expandInvalidRows
                        emptyMessage="No rejected transactions"
                        filters={{
                            ...defaultFilterState,
                            reviewStatus: ['invalid'],
                            connectorRunIds: [String(detail.id)],
                            connectorRunOutcome: 'all',
                        }}
                        onDataChange={fetchDetail}
                    />
                </TabsContent>

                <TabsContent value="errors">
                    <div className="max-h-[300px] overflow-y-auto">
                        {!detail.error_details || detail.error_details.length === 0 ? (
                            <Text className="block py-4 text-gray-500">No errors</Text>
                        ) : (
                            detail.error_details.map((err, idx) => (
                                <div
                                    key={idx}
                                    className="mb-2 bg-red-50 p-2"
                                >
                                    <Text className="block font-mono text-xs font-medium">
                                        {err.source_transaction_id}
                                    </Text>
                                    <Text className="block text-xs text-red-600">
                                        {err.error}
                                    </Text>
                                </div>
                            ))
                        )}
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
        </div>
    );
};
