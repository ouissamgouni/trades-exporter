import {
    Badge,
    Box,
    Button,
    Collapsible,
    Flex,
    Progress,
    Text,
} from '@chakra-ui/react';
import React, { useState } from 'react';
import { ConnectorProgress, ConnectorSyncStatus } from '../types';
import { ConnectorLogViewer } from './ConnectorLogViewer';
import { PipelineStageIndicator } from './PipelineStageIndicator';

interface ConnectorProgressCardProps {
    progress: ConnectorProgress;
    isExpanded?: boolean;
    onRetry?: (connectorId: number) => void;
    retryLoading?: boolean;
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
        case 'failed':
            return '❌';
        case 'skipped':
            return '⏭️';
        default:
            return '•';
    }
};

const getStatusColor = (status: ConnectorSyncStatus): string => {
    switch (status) {
        case 'queued':
        case 'pending':
            return 'gray';
        case 'running':
            return 'blue';
        case 'completed':
            return 'green';
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
    return Math.round((progress.operation_progress / progress.operation_total) * 100);
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
}) => {
    const [expanded, setExpanded] = useState(initialExpanded);
    const isRunning = progress.status === 'running';
    const isFailed = progress.status === 'failed';
    const canRetry = isFailed && onRetry;

    // Get counts - handle both new and legacy field names
    const newCount = progress.new_count ?? progress.new_entries ?? 0;
    const updatedCount = progress.updated_count ?? progress.updated ?? 0;
    const skippedCount = progress.skipped_count ?? progress.duplicates ?? 0;
    const errorCount = progress.errors ?? 0;
    const connectorName = progress.connector_type ?? progress.connector_name ?? 'Unknown';

    return (
        <Box
            borderWidth="1px"
            borderRadius="md"
            borderColor={
                isRunning
                    ? 'blue.300'
                    : isFailed
                        ? 'red.300'
                        : progress.status === 'completed'
                            ? 'green.300'
                            : 'gray.200'
            }
            bg={
                isRunning
                    ? 'blue.50'
                    : isFailed
                        ? 'red.50'
                        : progress.test_mode
                            ? 'orange.50'
                            : 'white'
            }
            overflow="hidden"
        >
            {/* Header - always visible */}
            <Box
                p={3}
                cursor="pointer"
                onClick={() => setExpanded(!expanded)}
                _hover={{ bg: 'gray.50' }}
            >
                <Flex justify="space-between" align="center" mb={2}>
                    <Flex align="center" gap={2}>
                        <Text fontSize="lg">{getStatusIcon(progress.status)}</Text>
                        <Text fontWeight="medium">
                            {connectorName}
                        </Text>
                        {progress.test_mode && (
                            <Badge colorPalette="orange" size="sm">
                                🧪 Test
                            </Badge>
                        )}
                    </Flex>
                    <Flex align="center" gap={2}>
                        {(progress.status === 'completed' || progress.status === 'running') && (
                            <Text fontSize="xs" color="gray.500">
                                {formatDuration(progress.started_at, progress.finished_at)}
                            </Text>
                        )}
                        <Badge colorPalette={getStatusColor(progress.status)} size="sm">
                            {progress.status}
                        </Badge>
                        <Text color="gray.500" fontSize="sm">
                            {expanded ? '▼' : '▶'}
                        </Text>
                    </Flex>
                </Flex>

                <Text fontSize="xs" color="gray.500" mb={2}>
                    {progress.account_name}
                </Text>

                {/* Progress bar for running connector */}
                {isRunning && progress.operation_total > 0 && (
                    <Box mb={2}>
                        <Flex justify="space-between" mb={1}>
                            <Text fontSize="xs" color="blue.600">
                                {progress.current_operation || 'Processing...'}
                            </Text>
                            <Text fontSize="xs" color="gray.400">
                                {progress.operation_progress}/{progress.operation_total}
                            </Text>
                        </Flex>
                        <Progress.Root
                            value={getOperationProgress(progress)}
                            max={100}
                            size="sm"
                            colorPalette="blue"
                        >
                            <Progress.Track>
                                <Progress.Range />
                            </Progress.Track>
                        </Progress.Root>
                    </Box>
                )}

                {/* Stats summary */}
                {(progress.status === 'completed' || progress.status === 'running' || progress.processed > 0) && (
                    <Flex gap={3} fontSize="xs" wrap="wrap">
                        <Text color="green.400">+{newCount} new</Text>
                        <Text color="blue.400">{updatedCount} updated</Text>
                        <Text color="gray.500">{skippedCount} dups</Text>
                        {(errorCount > 0 || progress.error) && (
                            <Text color="red.400">
                                {errorCount || 1} error{errorCount !== 1 ? 's' : ''}
                            </Text>
                        )}
                    </Flex>
                )}

                {/* Error message preview */}
                {isFailed && progress.error && (
                    <Text fontSize="xs" color="red.400" mt={2} lineClamp={1}>
                        {progress.error}
                    </Text>
                )}
            </Box>

            {/* Expanded content */}
            <Collapsible.Root open={expanded}>
                <Collapsible.Content>
                    <Box p={3} pt={0} borderTopWidth="1px" borderColor="gray.200">
                        {/* Pipeline stages */}
                        {(isRunning || progress.status === 'completed') && (
                            <Box mb={4}>
                                <PipelineStageIndicator
                                    currentStage={progress.pipeline_stage}
                                    stageStats={progress.stage_stats}
                                />
                            </Box>
                        )}

                        {/* Detailed stats */}
                        <Flex gap={4} mb={4} wrap="wrap">
                            <Box>
                                <Text fontSize="xs" color="gray.500">
                                    Processed
                                </Text>
                                <Text fontSize="lg" fontWeight="bold">
                                    {progress.processed}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="xs" color="gray.500">
                                    New
                                </Text>
                                <Text fontSize="lg" fontWeight="bold" color="green.400">
                                    {newCount}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="xs" color="gray.500">
                                    Updated
                                </Text>
                                <Text fontSize="lg" fontWeight="bold" color="blue.400">
                                    {updatedCount}
                                </Text>
                            </Box>
                            <Box>
                                <Text fontSize="xs" color="gray.500">
                                    Duplicates
                                </Text>
                                <Text fontSize="lg" fontWeight="bold" color="gray.500">
                                    {skippedCount}
                                </Text>
                            </Box>
                        </Flex>

                        {/* Error display */}
                        {isFailed && progress.error && (
                            <Box
                                bg="red.50"
                                borderColor="red.200"
                                borderWidth={1}
                                p={3}
                                borderRadius="md"
                                mb={4}
                            >
                                <Text fontWeight="bold" color="red.700" mb={1}>
                                    Error:
                                </Text>
                                <Text color="red.600" fontSize="sm">
                                    {progress.error}
                                </Text>
                            </Box>
                        )}

                        {/* Retry button */}
                        {canRetry && (
                            <Box mb={4}>
                                <Button
                                    size="sm"
                                    colorPalette="blue"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRetry(progress.connector_id);
                                    }}
                                    loading={retryLoading}
                                >
                                    🔄 Retry Connector
                                </Button>
                            </Box>
                        )}

                        {/* Logs */}
                        {progress.logs && progress.logs.length > 0 && (
                            <Box>
                                <Text fontSize="xs" color="gray.500" mb={2}>
                                    Logs
                                </Text>
                                <ConnectorLogViewer logs={progress.logs} maxHeight="150px" />
                            </Box>
                        )}
                    </Box>
                </Collapsible.Content>
            </Collapsible.Root>
        </Box>
    );
};
