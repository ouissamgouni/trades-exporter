import { Badge, type BadgeColorScheme, Button, Progress, type ProgressColorScheme } from './ui/primitives';
import React, { useState } from 'react';
import { ConnectorProgress, ConnectorSyncStatus } from '../types';
import { ConnectorLogViewer } from './ConnectorLogViewer';
import { ConnectorRunDetailDrawer } from './ConnectorRunDetailDrawer';

interface ConnectorProgressCardProps {
    progress: ConnectorProgress;
    isExpanded?: boolean;
    onRetry?: (connectorId: number) => void;
    retryLoading?: boolean;
    renormalize?: boolean;
    showAccountName?: boolean;
}

const getStatusIcon = (status: ConnectorSyncStatus): string => {
    switch (status) {
        case 'queued':
        case 'pending':
            return '⏳';
        case 'running':
            return '🔄';
        case 'completed':
            return '✅';
        case 'warning':
            return '⚠️';
        case 'failed':
            return '❌';
        case 'skipped':
            return '⏭️';
        default:
            return '•';
    }
};

const getStatusColor = (status: ConnectorSyncStatus): BadgeColorScheme => {
    switch (status) {
        case 'queued':
        case 'pending':
            return 'gray';
        case 'running':
            return 'blue';
        case 'completed':
            return 'green';
        case 'warning':
            return 'orange';
        case 'failed':
            return 'red';
        case 'skipped':
            return 'orange';
        default:
            return 'gray';
    }
};

const getOperationProgress = (progress: ConnectorProgress): number => {
    if (!progress.operation_total || progress.operation_total === 0) return 0;
    const percentage = Math.round((progress.operation_progress / progress.operation_total) * 100);
    // Clamp to 0-100 range to prevent invalid values
    return Math.min(100, Math.max(0, percentage));
};

const getProgressBarColor = (status: ConnectorSyncStatus, errorCount: number): ProgressColorScheme => {
    if (status === 'failed') return 'red';
    if (status === 'running' && errorCount > 0) return 'orange';
    if (status === 'running') return 'blue';
    if (status === 'completed' && errorCount > 0) return 'orange';
    if (status === 'completed') return 'green';
    if (status === 'warning') return 'orange';
    return 'blue';
};

const formatDuration = (startedAt?: string, finishedAt?: string): string => {
    if (!startedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
    const durationMs = end - start;

    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
    return `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;
};

export const ConnectorProgressCard: React.FC<ConnectorProgressCardProps> = ({
    progress,
    isExpanded: initialExpanded = false,
    onRetry,
    retryLoading = false,
    renormalize = false,
    showAccountName = false,
}) => {
    const [expanded, setExpanded] = useState(initialExpanded);
    const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
    const isRunning = progress.status === 'running';
    const isFailed = progress.status === 'failed';
    const hasWarning = progress.status === 'warning';
    const canRetry = (isFailed || hasWarning) && onRetry;
    const hasConnectorRunId = progress.connector_run_id != null;

    // Get counts - handle both new and legacy field names
    const newCount = progress.new_count ?? progress.new_entries ?? 0;
    const updatedCount = progress.updated_count ?? progress.updated ?? 0;
    const skippedCount = progress.skipped_count ?? progress.duplicates ?? 0;
    const errorCount = progress.errors ?? 0;
    const connectorName = progress.connector_type ?? progress.connector_name ?? 'Unknown';

    return (
        <div
            className={`overflow-hidden border ${isRunning
                    ? 'border-blue-300 bg-blue-50'
                    : isFailed
                        ? 'border-red-300 bg-red-50'
                        : hasWarning
                            ? 'border-orange-300 bg-orange-50'
                            : progress.status === 'completed'
                                ? 'border-green-300 bg-white'
                                : progress.test_mode
                                    ? 'border-slate-200 bg-orange-50'
                                    : renormalize
                                        ? 'border-slate-200 bg-purple-50'
                                        : 'border-slate-200 bg-white'
                }`}
        >
            {/* Header - always visible */}
            <div
                className="cursor-pointer p-3 hover:bg-slate-50"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="mb-1 flex items-center justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="text-lg">{getStatusIcon(progress.status)}</span>
                        <span className="truncate font-medium">
                            {connectorName}
                        </span>
                        {showAccountName && (
                            <span className="truncate text-xs text-slate-400">
                                {progress.account_name}
                            </span>
                        )}
                        {progress.test_mode && (
                            <Badge colorScheme="orange">
                                🧪 Test
                            </Badge>
                        )}
                        {renormalize && (
                            <Badge colorScheme="purple">
                                🔄 Re-Normalize
                            </Badge>
                        )}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                        {(progress.status === 'completed' || progress.status === 'running') && (
                            <span className="text-xs text-slate-500">
                                {formatDuration(progress.started_at, progress.finished_at)}
                            </span>
                        )}
                        <Badge colorScheme={getStatusColor(progress.status)}>
                            {progress.status}
                        </Badge>
                        <span className="text-sm text-slate-500">
                            {expanded ? '▼' : '▶'}
                        </span>
                    </div>
                </div>

                {!showAccountName && (
                    <span className="block text-xs text-slate-500">
                        {progress.account_name}
                    </span>
                )}
                <span className="mb-2 block text-xs text-slate-400">
                    ID: {progress.connector_id}
                </span>

                {/* Progress bar for running connector */}
                {isRunning && progress.operation_total > 0 && (
                    <div className="mb-2">
                        <div className="mb-1 flex justify-between">
                            <span className={`text-xs ${errorCount > 0 ? 'text-orange-600' : 'text-blue-600'}`}>
                                {progress.current_operation || 'Processing...'}
                            </span>
                            <span className="text-xs text-slate-400">
                                {progress.operation_progress}/{progress.operation_total}
                            </span>
                        </div>
                        <Progress
                            value={getOperationProgress(progress)}
                            max={100}
                            size="sm"
                            colorScheme={getProgressBarColor(progress.status, errorCount)}
                        />
                        {errorCount > 0 && (
                            <span className="mt-1 block text-xs text-orange-600">
                                ⚠️ {errorCount} error{errorCount !== 1 ? 's' : ''} encountered
                            </span>
                        )}
                    </div>
                )}

                {/* Stats summary */}
                {(progress.status === 'completed' || progress.status === 'running' || progress.processed > 0 || progress.fetched_count > 0) && (
                    <div className="flex flex-wrap gap-3 text-xs">
                        {progress.status === 'running' && progress.fetched_count > 0 && (
                            <span className="text-purple-500">📥 {progress.fetched_count} fetched</span>
                        )}
                        <span className="text-green-400">+{newCount} new</span>
                        <span className="text-blue-400">{updatedCount} updated</span>
                        <span className="text-slate-500">{skippedCount} dups</span>
                        {(errorCount > 0 || progress.error) && (
                            <span className="text-red-400">
                                {errorCount || 1} error{errorCount !== 1 ? 's' : ''}
                            </span>
                        )}
                    </div>
                )}

                {/* Error message preview */}
                {isFailed && progress.error && (
                    <span className="mt-2 line-clamp-2 block text-xs text-red-400">
                        {progress.error.split('\n')[0]}
                    </span>
                )}
            </div>

            {/* Expanded content */}
            {expanded && (
                <div className="border-t border-slate-200 p-3 pt-0">
                    {/* Detailed stats */}
                    <div className="mb-4 flex flex-wrap gap-4">
                        {progress.status === 'running' && (
                            <div>
                                <span className="block text-xs text-slate-500">
                                    Fetched
                                </span>
                                <span className="block text-lg font-bold text-purple-500">
                                    {progress.fetched_count ?? 0}
                                </span>
                            </div>
                        )}
                        <div>
                            <span className="block text-xs text-slate-500">
                                Processed
                            </span>
                            <span className="block text-lg font-bold">
                                {progress.processed}
                            </span>
                        </div>
                        <div>
                            <span className="block text-xs text-slate-500">
                                New
                            </span>
                            <span className="block text-lg font-bold text-green-400">
                                {newCount}
                            </span>
                        </div>
                        <div>
                            <span className="block text-xs text-slate-500">
                                Updated
                            </span>
                            <span className="block text-lg font-bold text-blue-400">
                                {updatedCount}
                            </span>
                        </div>
                        <div>
                            <span className="block text-xs text-slate-500">
                                Duplicates
                            </span>
                            <span className="block text-lg font-bold text-slate-500">
                                {skippedCount}
                            </span>
                        </div>
                    </div>

                    {/* Error display */}
                    {isFailed && progress.error && (
                        <div className="mb-4 border border-red-200 bg-red-50 p-3">
                            <span className="mb-2 block font-bold text-red-700">
                                Error Details:
                            </span>
                            <pre className="max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words border border-red-100 bg-white p-2 font-mono text-xs text-red-600">
                                {progress.error}
                            </pre>
                        </div>
                    )}

                    {/* Retry button */}
                    {canRetry && (
                        <div className="mb-4">
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRetry(progress.connector_id);
                                }}
                                loading={retryLoading}
                            >
                                🔄 Retry Connector
                            </Button>
                        </div>
                    )}

                    {/* View Details button */}
                    {hasConnectorRunId && (
                        <div className="mb-4">
                            <Button
                                size="sm"
                                variant="outline"
                                colorScheme="blue"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setDetailDrawerOpen(true);
                                }}
                            >
                                📊 View Details
                            </Button>
                        </div>
                    )}

                    {/* Logs */}
                    {progress.logs && progress.logs.length > 0 && (
                        <div>
                            <span className="mb-2 block text-xs text-slate-500">
                                Logs
                            </span>
                            <ConnectorLogViewer logs={progress.logs} maxHeight="150px" />
                        </div>
                    )}
                </div>
            )}

            {/* Connector Run Detail Drawer - Use custom resizable drawer */}
            {hasConnectorRunId && detailDrawerOpen && (
                <ConnectorRunDetailDrawer
                    runId={progress.connector_run_id!}
                    open={detailDrawerOpen}
                    onClose={() => setDetailDrawerOpen(false)}
                    enablePolling={isRunning}
                />
            )}
        </div>
    );
};
