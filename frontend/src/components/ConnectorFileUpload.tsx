import React, { useState, useCallback, useEffect } from 'react';
import {
    Box,
    Button,
    Flex,
    Text,
    Badge,
    Spinner,
    Stack,
    IconButton,
} from '@chakra-ui/react';
import { LuUpload, LuFile, LuX, LuCheck, LuHistory, LuTrash2, LuTriangleAlert, LuEye, LuPin } from 'react-icons/lu';
import { API_URL } from '../types';
import { FileUploadPreviewModal } from './FileUploadPreviewModal';
import { DefaultFilePreviewModal } from './DefaultFilePreviewModal';

interface FileUploadPreview {
    row_count: number;
    date_range: {
        min_date: string | null;
        max_date: string | null;
    } | null;
    pairs: string[];
    sample_rows: Record<string, unknown>[];
}

// New API-based import history entry
interface ImportHistoryEntry {
    id: number;
    filename: string;
    original_filename: string;
    file_path: string;
    uploaded_at: string;
    processed_at: string | null;
    file_size: number;
    status: string;
    row_count: number;
    new_count: number;
    updated_count: number;
    skipped_count: number;
    error_message: string | null;
    sync_job_connector_run_id: number | null;
    file_exists: boolean;
}

interface ConnectorFileUploadProps {
    connectorId: number;
    connectorType: string;
    disabled?: boolean;
    onUploadComplete: () => void;
    defaultFileName?: string;
}

const formatDate = (isoString: string | null): string => {
    if (!isoString) return 'N/A';
    try {
        return new Date(isoString).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    } catch {
        return isoString;
    }
};

const formatDateTime = (isoString: string): string => {
    try {
        return new Date(isoString).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return isoString;
    }
};

export const ConnectorFileUpload: React.FC<ConnectorFileUploadProps> = ({
    connectorId,
    connectorType,
    disabled = false,
    onUploadComplete,
    defaultFileName,
}) => {
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [preview, setPreview] = useState<FileUploadPreview | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [showPreviewModal, setShowPreviewModal] = useState(false);
    const [showDefaultFilePreview, setShowDefaultFilePreview] = useState(false);

    // Import history from API
    const [importHistory, setImportHistory] = useState<ImportHistoryEntry[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // Preview for existing import
    const [previewingImportId, setPreviewingImportId] = useState<number | null>(null);
    const [importPreview, setImportPreview] = useState<FileUploadPreview | null>(null);
    const [importPreviewLoading, setImportPreviewLoading] = useState(false);

    // Fetch preview for an existing import
    const fetchImportPreview = useCallback(async (importId: number) => {
        setImportPreviewLoading(true);
        try {
            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/import-history/${importId}/preview`
            );
            if (response.ok) {
                const data: FileUploadPreview = await response.json();
                setImportPreview(data);
                setPreviewingImportId(importId);
            } else {
                const err = await response.json();
                setError(err.detail || 'Failed to load preview');
            }
        } catch (err) {
            console.error('Failed to fetch import preview:', err);
            setError('Failed to load preview');
        } finally {
            setImportPreviewLoading(false);
        }
    }, [connectorId]);

    const closeImportPreview = useCallback(() => {
        setPreviewingImportId(null);
        setImportPreview(null);
    }, []);

    // Fetch import history from API
    const fetchImportHistory = useCallback(async () => {
        setHistoryLoading(true);
        try {
            const response = await fetch(`${API_URL}/connectors/${connectorId}/import-history?limit=10`);
            if (response.ok) {
                const data: ImportHistoryEntry[] = await response.json();
                setImportHistory(data);
            }
        } catch (err) {
            console.error('Failed to fetch import history:', err);
        } finally {
            setHistoryLoading(false);
        }
    }, [connectorId]);

    // Fetch history on mount to show count in toggle button
    useEffect(() => {
        fetchImportHistory();
    }, [fetchImportHistory]);

    // Refetch when showHistory becomes true
    useEffect(() => {
        if (showHistory) {
            fetchImportHistory();
        }
    }, [showHistory, fetchImportHistory]);

    // Delete an import history entry
    const handleDeleteImport = useCallback(async (importId: number) => {
        try {
            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/import-history/${importId}`,
                { method: 'DELETE' }
            );
            if (response.ok) {
                setImportHistory((prev) => prev.filter((h) => h.id !== importId));
            }
        } catch (err) {
            console.error('Failed to delete import:', err);
        }
    }, [connectorId]);

    // Cleanup orphaned imports (pending/failed with missing files)
    const handleCleanupOrphans = useCallback(async () => {
        try {
            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/import-history/cleanup`,
                { method: 'POST' }
            );
            if (response.ok) {
                const result = await response.json();
                if (result.deleted_count > 0) {
                    fetchImportHistory();
                }
            }
        } catch (err) {
            console.error('Failed to cleanup orphans:', err);
        }
    }, [connectorId, fetchImportHistory]);

    // This component is now rendered only for file connectors (checked by parent)
    // No need to filter by connector type here

    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Validate file type based on connector
        const isExcelConnector = connectorType.includes('mexc');
        const isCsvConnector = connectorType.includes('okx-funding') || connectorType.includes('okx-trades') || connectorType.includes('degiro');

        if (isExcelConnector && !file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) {
            setError('Only XLSX/XLS files are supported for this connector');
            return;
        }

        if (isCsvConnector && !file.name.endsWith('.csv')) {
            setError('Only CSV files are supported for this connector');
            return;
        }

        // Default: accept both formats
        if (!isExcelConnector && !isCsvConnector) {
            if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls') && !file.name.endsWith('.csv')) {
                setError('Only XLSX/XLS/CSV files are supported');
                return;
            }
        }

        setSelectedFile(file);
        setError(null);
        setPreview(null);

        // Get preview
        setIsLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/upload-file/preview`,
                {
                    method: 'POST',
                    body: formData,
                }
            );

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || 'Failed to preview file');
            }

            const previewData: FileUploadPreview = await response.json();
            setPreview(previewData);
            setShowPreviewModal(true); // Open modal automatically
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to preview file');
            setSelectedFile(null);
        } finally {
            setIsLoading(false);
        }
    }, [connectorId]);

    const handleModalClose = useCallback(() => {
        setShowPreviewModal(false);
    }, []);

    const handleModalConfirm = useCallback(async (asDefault?: boolean) => {
        setShowPreviewModal(false);
        if (!selectedFile) return;

        setIsLoading(true);
        setError(null);
        setSuccessMessage(null);

        try {
            const formData = new FormData();
            formData.append('file', selectedFile);

            const url = asDefault
                ? `${API_URL}/connectors/${connectorId}/upload-file/confirm?as_default=true`
                : `${API_URL}/connectors/${connectorId}/upload-file/confirm`;

            const response = await fetch(
                url,
                {
                    method: 'POST',
                    body: formData,
                }
            );

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || 'Failed to upload file');
            }

            const result = await response.json();

            // Success - clear state, show message, refresh history, and notify parent
            setSelectedFile(null);
            setPreview(null);
            const defaultLabel = asDefault ? ' as default' : '';
            setSuccessMessage(`✅ File "${result.filename}" uploaded${defaultLabel} successfully. It will be processed on the next sync.`);
            setShowHistory(true);
            fetchImportHistory();
            onUploadComplete();

            // Auto-hide success message after 5 seconds
            setTimeout(() => setSuccessMessage(null), 5000);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to upload file');
        } finally {
            setIsLoading(false);
        }
    }, [connectorId, selectedFile, onUploadComplete, fetchImportHistory]);

    const handleCancelUpload = useCallback(() => {
        setSelectedFile(null);
        setPreview(null);
        setError(null);
        setSuccessMessage(null);
    }, []);

    // Count pending imports for indicator
    const pendingImports = importHistory.filter((h) => h.status === 'pending');

    return (
        <Box mt={2} pl={6}>
            {/* File Upload Section - always visible for file connectors */}
            <Box
                p={3}
                borderWidth="1px"
                borderRadius="md"
                borderColor="gray.200"
                bg="gray.50"
            >
                {/* Default File Indicator */}
                {defaultFileName && (
                    <Box
                        mb={3}
                        p={2}
                        bg="teal.50"
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="teal.200"
                    >
                        <Flex align="center" gap={2} minW={0}>
                            <LuPin size={12} style={{ flexShrink: 0 }} />
                            <Text fontSize="xs" color="teal.700" truncate flex="1">
                                Default: <Text as="span" fontWeight="medium">{defaultFileName}</Text>
                            </Text>
                            <IconButton
                                aria-label="Preview default file"
                                size="2xs"
                                variant="ghost"
                                colorPalette="teal"
                                onClick={() => setShowDefaultFilePreview(true)}
                            >
                                <LuEye />
                            </IconButton>
                        </Flex>
                    </Box>
                )}

                {/* Pending Imports Indicator */}
                {pendingImports.length > 0 && (
                    <Box
                        mb={3}
                        p={2}
                        bg="yellow.50"
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="yellow.200"
                    >
                        <Flex align="center" gap={2}>
                            <Badge colorPalette="yellow">{pendingImports.length}</Badge>
                            <Text fontSize="sm" color="yellow.800">
                                {pendingImports.length === 1
                                    ? 'file ready to be processed on next sync'
                                    : 'files ready to be processed on next sync'}
                            </Text>
                        </Flex>
                    </Box>
                )}

                {/* File Selection / Preview */}
                {!selectedFile && !preview && (
                    <Box>
                        <input
                            type="file"
                            accept={(connectorType.includes('okx') || connectorType.includes('degiro')) ? '.csv' : '.xlsx,.xls'}
                            onChange={handleFileSelect}
                            style={{ display: 'none' }}
                            id={`file-input-${connectorId}`}
                            disabled={disabled || isLoading}
                        />
                        <label htmlFor={`file-input-${connectorId}`}>
                            <Flex
                                direction="column"
                                align="center"
                                gap={2}
                                p={4}
                                borderWidth="2px"
                                borderStyle="dashed"
                                borderColor="gray.300"
                                borderRadius="md"
                                cursor={disabled ? 'not-allowed' : 'pointer'}
                                opacity={disabled ? 0.6 : 1}
                                _hover={!disabled ? { borderColor: 'blue.400', bg: 'blue.50' } : undefined}
                                transition="all 0.2s"
                            >
                                <LuUpload size={24} color="gray" />
                                <Text fontSize="sm" color="gray.600">
                                    Upload {(connectorType.includes('okx-funding') || connectorType.includes('okx-trades') || connectorType.includes('degiro')) ? 'CSV file' : 'trades file (.xlsx)'}
                                </Text>
                                <Text fontSize="xs" color="gray.400">
                                    Export from exchange and upload here
                                </Text>
                            </Flex>
                        </label>
                    </Box>
                )}

                {/* Loading State */}
                {isLoading && (
                    <Flex align="center" justify="center" gap={2} py={4}>
                        <Spinner size="sm" />
                        <Text fontSize="sm" color="gray.500">Processing file...</Text>
                    </Flex>
                )}

                {/* Preview - Show only basic file info, modal handles full preview */}
                {preview && selectedFile && !isLoading && (
                    <Stack gap={3}>
                        <Flex align="center" gap={2}>
                            <LuFile size={16} />
                            <Text fontSize="sm" fontWeight="medium">{selectedFile.name}</Text>
                            <Badge colorPalette="blue" size="xs">{preview.row_count} rows</Badge>
                        </Flex>

                        <Flex gap={2}>
                            <Button
                                size="xs"
                                colorPalette="blue"
                                onClick={() => setShowPreviewModal(true)}
                            >
                                <LuEye size={14} />
                                View Preview
                            </Button>
                            <Button
                                size="xs"
                                variant="ghost"
                                onClick={handleCancelUpload}
                                disabled={disabled}
                            >
                                <LuX size={14} />
                                Cancel
                            </Button>
                        </Flex>
                    </Stack>
                )}

                {/* Error */}
                {error && (
                    <Text fontSize="sm" color="red.500" mt={2}>
                        {error}
                    </Text>
                )}

                {/* Success Message */}
                {successMessage && (
                    <Box
                        mt={2}
                        p={2}
                        bg="green.50"
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="green.200"
                    >
                        <Text fontSize="sm" color="green.700">
                            {successMessage}
                        </Text>
                    </Box>
                )}

                {/* Import History Toggle */}
                <Box mt={3}>
                    <Flex align="center" gap={2}>
                        <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => setShowHistory(!showHistory)}
                        >
                            <LuHistory size={14} />
                            {showHistory ? 'Hide' : 'Show'} import history
                            {importHistory.length > 0 && ` (${importHistory.length})`}
                            {historyLoading && <Spinner size="xs" ml={1} />}
                        </Button>
                    </Flex>

                    {showHistory && (
                        <Stack gap={2} mt={2}>
                            {importHistory.length === 0 && !historyLoading && (
                                <Text fontSize="xs" color="gray.500">No import history</Text>
                            )}

                            {importHistory.map((entry) => {
                                const hasOrphanedFile = !entry.file_exists &&
                                    (entry.status === 'pending' || entry.status === 'failed');

                                return (
                                    <Box key={entry.id}>
                                        <Flex
                                            align="center"
                                            gap={2}
                                            fontSize="xs"
                                            color={hasOrphanedFile ? 'orange.600' : 'gray.500'}
                                            p={2}
                                            borderWidth="1px"
                                            borderRadius="sm"
                                            borderColor={hasOrphanedFile ? 'orange.300' : 'gray.200'}
                                            bg={hasOrphanedFile ? 'orange.50' : 'white'}
                                        >
                                            {hasOrphanedFile && (
                                                <LuTriangleAlert size={14} color="orange" />
                                            )}
                                            <Text>{formatDateTime(entry.uploaded_at)}</Text>
                                            <Text fontWeight="medium" flex={1} truncate>
                                                {entry.original_filename}
                                            </Text>
                                            <Badge
                                                size="xs"
                                                colorPalette={
                                                    entry.status === 'completed' ? 'green' :
                                                        entry.status === 'pending' ? 'yellow' :
                                                            entry.status === 'processing' ? 'blue' :
                                                                entry.status === 'default' ? 'teal' : 'red'
                                                }
                                            >
                                                {entry.status}
                                            </Badge>
                                            {entry.status === 'completed' && (
                                                <Badge size="xs" colorPalette="green">
                                                    +{entry.new_count} new
                                                </Badge>
                                            )}
                                            {hasOrphanedFile && (
                                                <Badge size="xs" colorPalette="orange">
                                                    file missing
                                                </Badge>
                                            )}
                                            {/* Preview button for pending/failed with existing file */}
                                            {entry.file_exists && (entry.status === 'pending' || entry.status === 'failed') && (
                                                <IconButton
                                                    aria-label="Preview file"
                                                    size="xs"
                                                    variant="ghost"
                                                    colorPalette="blue"
                                                    onClick={() => fetchImportPreview(entry.id)}
                                                    disabled={importPreviewLoading}
                                                >
                                                    {importPreviewLoading && previewingImportId === entry.id ? (
                                                        <Spinner size="xs" />
                                                    ) : (
                                                        <LuEye size={12} />
                                                    )}
                                                </IconButton>
                                            )}
                                            <IconButton
                                                aria-label="Delete import"
                                                size="xs"
                                                variant="ghost"
                                                colorPalette="red"
                                                onClick={() => handleDeleteImport(entry.id)}
                                                disabled={entry.status === 'processing'}
                                            >
                                                <LuTrash2 size={12} />
                                            </IconButton>
                                        </Flex>

                                        {/* Preview panel for this import */}
                                        {previewingImportId === entry.id && importPreview && (
                                            <Box
                                                mt={2}
                                                ml={4}
                                                p={3}
                                                bg="blue.50"
                                                borderRadius="md"
                                                borderWidth="1px"
                                                borderColor="blue.200"
                                            >
                                                <Flex justify="space-between" align="center" mb={2}>
                                                    <Text fontSize="sm" fontWeight="medium" color="blue.800">
                                                        File Preview: {entry.original_filename}
                                                    </Text>
                                                    <IconButton
                                                        aria-label="Close preview"
                                                        size="xs"
                                                        variant="ghost"
                                                        onClick={closeImportPreview}
                                                    >
                                                        <LuX size={12} />
                                                    </IconButton>
                                                </Flex>

                                                <Stack gap={2} fontSize="xs">
                                                    <Flex gap={4}>
                                                        <Text color="gray.600">
                                                            Rows: <Text as="span" fontWeight="medium">{importPreview.row_count}</Text>
                                                        </Text>
                                                        {importPreview.date_range && (
                                                            <Text color="gray.600">
                                                                Dates: <Text as="span" fontWeight="medium">
                                                                    {formatDate(importPreview.date_range.min_date)} - {formatDate(importPreview.date_range.max_date)}
                                                                </Text>
                                                            </Text>
                                                        )}
                                                    </Flex>

                                                    {importPreview.pairs.length > 0 && (
                                                        <Flex gap={1} wrap="wrap">
                                                            <Text color="gray.600">Pairs:</Text>
                                                            {importPreview.pairs.slice(0, 10).map((pair) => (
                                                                <Badge key={pair} size="xs" colorPalette="gray">
                                                                    {pair}
                                                                </Badge>
                                                            ))}
                                                            {importPreview.pairs.length > 10 && (
                                                                <Text color="gray.500">
                                                                    +{importPreview.pairs.length - 10} more
                                                                </Text>
                                                            )}
                                                        </Flex>
                                                    )}

                                                    {importPreview.sample_rows.length > 0 && (
                                                        <Box>
                                                            <Text color="gray.600" mb={1}>Sample rows:</Text>
                                                            <Box
                                                                bg="white"
                                                                p={2}
                                                                borderRadius="sm"
                                                                maxH="150px"
                                                                overflowY="auto"
                                                                fontFamily="mono"
                                                                fontSize="xs"
                                                            >
                                                                {importPreview.sample_rows.map((row, idx) => (
                                                                    <Text key={idx} color="gray.700" mb={1}>
                                                                        {JSON.stringify(row)}
                                                                    </Text>
                                                                ))}
                                                            </Box>
                                                        </Box>
                                                    )}
                                                </Stack>
                                            </Box>
                                        )}
                                    </Box>
                                );
                            })}

                            {/* Cleanup orphans button */}
                            {importHistory.some(e => !e.file_exists && (e.status === 'pending' || e.status === 'failed')) && (
                                <Button
                                    size="xs"
                                    variant="outline"
                                    colorPalette="orange"
                                    onClick={handleCleanupOrphans}
                                >
                                    <LuTrash2 size={12} />
                                    Clean up orphaned imports
                                </Button>
                            )}
                        </Stack>
                    )}
                </Box>
            </Box>

            {/* Preview Modal */}
            {preview && selectedFile && (
                <FileUploadPreviewModal
                    open={showPreviewModal}
                    onClose={handleModalClose}
                    onConfirm={handleModalConfirm}
                    hasExistingDefault={!!defaultFileName}
                    connectorId={connectorId}
                    fileName={selectedFile.name}
                    fileSize={selectedFile.size}
                    quickPreview={preview}
                    file={selectedFile}
                />
            )}

            {/* Default File Preview Modal */}
            {defaultFileName && (
                <DefaultFilePreviewModal
                    open={showDefaultFilePreview}
                    onClose={() => setShowDefaultFilePreview(false)}
                    connectorId={connectorId}
                    fileName={defaultFileName}
                />
            )}
        </Box>
    );
};

export default ConnectorFileUpload;
