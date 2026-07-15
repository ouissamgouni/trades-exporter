import React, { useState, useCallback, useEffect } from 'react';
import { Button, Badge, Spinner } from './ui/primitives';
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
        <div className="mt-2 pl-6">
            {/* File Upload Section - always visible for file connectors */}
            <div className="border border-slate-200 bg-slate-50 p-3">
                {/* Default File Indicator */}
                {defaultFileName && (
                    <div className="mb-3 border border-teal-200 bg-teal-50 p-2">
                        <div className="flex min-w-0 items-center gap-2">
                            <LuPin size={12} style={{ flexShrink: 0 }} />
                            <span className="flex-1 truncate text-xs text-teal-700">
                                Default: <span className="font-medium">{defaultFileName}</span>
                            </span>
                            <Button
                                aria-label="Preview default file"
                                size="sm"
                                variant="ghost"
                                colorScheme="gray"
                                className="text-teal-600 hover:bg-teal-50"
                                onClick={() => setShowDefaultFilePreview(true)}
                            >
                                <LuEye size={12} />
                            </Button>
                        </div>
                    </div>
                )}

                {/* Pending Imports Indicator */}
                {pendingImports.length > 0 && (
                    <div className="mb-3 border border-yellow-200 bg-yellow-50 p-2">
                        <div className="flex items-center gap-2">
                            <Badge colorScheme="yellow">{pendingImports.length}</Badge>
                            <span className="text-sm text-yellow-800">
                                {pendingImports.length === 1
                                    ? 'file ready to be processed on next sync'
                                    : 'files ready to be processed on next sync'}
                            </span>
                        </div>
                    </div>
                )}

                {/* File Selection / Preview */}
                {!selectedFile && !preview && (
                    <div>
                        <input
                            type="file"
                            accept={(connectorType.includes('okx') || connectorType.includes('degiro')) ? '.csv' : '.xlsx,.xls'}
                            onChange={handleFileSelect}
                            className="hidden"
                            id={`file-input-${connectorId}`}
                            disabled={disabled || isLoading}
                        />
                        <label htmlFor={`file-input-${connectorId}`}>
                            <div
                                className={`flex flex-col items-center gap-2 border-2 border-dashed border-slate-300 p-4 transition-colors ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-blue-400 hover:bg-blue-50'
                                    }`}
                            >
                                <LuUpload size={24} color="gray" />
                                <span className="text-sm text-slate-600">
                                    Upload {(connectorType.includes('okx-funding') || connectorType.includes('okx-trades') || connectorType.includes('degiro')) ? 'CSV file' : 'trades file (.xlsx)'}
                                </span>
                                <span className="text-xs text-slate-400">
                                    Export from exchange and upload here
                                </span>
                            </div>
                        </label>
                    </div>
                )}

                {/* Loading State */}
                {isLoading && (
                    <div className="flex items-center justify-center gap-2 py-4">
                        <Spinner size="sm" />
                        <span className="text-sm text-slate-500">Processing file...</span>
                    </div>
                )}

                {/* Preview - Show only basic file info, modal handles full preview */}
                {preview && selectedFile && !isLoading && (
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <LuFile size={16} />
                            <span className="text-sm font-medium">{selectedFile.name}</span>
                            <Badge colorScheme="blue">{preview.row_count} rows</Badge>
                        </div>

                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                colorScheme="blue"
                                onClick={() => setShowPreviewModal(true)}
                            >
                                <LuEye size={14} />
                                View Preview
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleCancelUpload}
                                disabled={disabled}
                            >
                                <LuX size={14} />
                                Cancel
                            </Button>
                        </div>
                    </div>
                )}

                {/* Error */}
                {error && (
                    <p className="mt-2 text-sm text-red-500">
                        {error}
                    </p>
                )}

                {/* Success Message */}
                {successMessage && (
                    <div className="mt-2 border border-green-200 bg-green-50 p-2">
                        <p className="text-sm text-green-700">
                            {successMessage}
                        </p>
                    </div>
                )}

                {/* Import History Toggle */}
                <div className="mt-3">
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setShowHistory(!showHistory)}
                        >
                            <LuHistory size={14} />
                            {showHistory ? 'Hide' : 'Show'} import history
                            {importHistory.length > 0 && ` (${importHistory.length})`}
                            {historyLoading && <Spinner size="xs" className="ml-1" />}
                        </Button>
                    </div>

                    {showHistory && (
                        <div className="mt-2 flex flex-col gap-2">
                            {importHistory.length === 0 && !historyLoading && (
                                <span className="text-xs text-slate-500">No import history</span>
                            )}

                            {importHistory.map((entry) => {
                                const hasOrphanedFile = !entry.file_exists &&
                                    (entry.status === 'pending' || entry.status === 'failed');

                                return (
                                    <div key={entry.id}>
                                        <div
                                            className={`flex items-center gap-2 border p-2 text-xs ${hasOrphanedFile
                                                ? 'border-orange-300 bg-orange-50 text-orange-600'
                                                : 'border-slate-200 bg-white text-slate-500'
                                                }`}
                                        >
                                            {hasOrphanedFile && (
                                                <LuTriangleAlert size={14} color="orange" />
                                            )}
                                            <span>{formatDateTime(entry.uploaded_at)}</span>
                                            <span className="flex-1 truncate font-medium">
                                                {entry.original_filename}
                                            </span>
                                            <Badge
                                                colorScheme={
                                                    entry.status === 'completed' ? 'green' :
                                                        entry.status === 'pending' ? 'yellow' :
                                                            entry.status === 'processing' ? 'blue' :
                                                                entry.status === 'default' ? 'purple' : 'red'
                                                }
                                            >
                                                {entry.status}
                                            </Badge>
                                            {entry.status === 'completed' && (
                                                <Badge colorScheme="green">
                                                    +{entry.new_count} new
                                                </Badge>
                                            )}
                                            {hasOrphanedFile && (
                                                <Badge colorScheme="orange">
                                                    file missing
                                                </Badge>
                                            )}
                                            {/* Preview button for pending/failed with existing file */}
                                            {entry.file_exists && (entry.status === 'pending' || entry.status === 'failed') && (
                                                <Button
                                                    aria-label="Preview file"
                                                    size="sm"
                                                    variant="ghost"
                                                    colorScheme="blue"
                                                    onClick={() => fetchImportPreview(entry.id)}
                                                    disabled={importPreviewLoading}
                                                >
                                                    {importPreviewLoading && previewingImportId === entry.id ? (
                                                        <Spinner size="xs" />
                                                    ) : (
                                                        <LuEye size={12} />
                                                    )}
                                                </Button>
                                            )}
                                            <Button
                                                aria-label="Delete import"
                                                size="sm"
                                                variant="ghost"
                                                colorScheme="red"
                                                onClick={() => handleDeleteImport(entry.id)}
                                                disabled={entry.status === 'processing'}
                                            >
                                                <LuTrash2 size={12} />
                                            </Button>
                                        </div>

                                        {/* Preview panel for this import */}
                                        {previewingImportId === entry.id && importPreview && (
                                            <div className="ml-4 mt-2 border border-blue-200 bg-blue-50 p-3">
                                                <div className="mb-2 flex items-center justify-between">
                                                    <span className="text-sm font-medium text-blue-800">
                                                        File Preview: {entry.original_filename}
                                                    </span>
                                                    <Button
                                                        aria-label="Close preview"
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={closeImportPreview}
                                                    >
                                                        <LuX size={12} />
                                                    </Button>
                                                </div>

                                                <div className="flex flex-col gap-2 text-xs">
                                                    <div className="flex gap-4">
                                                        <span className="text-slate-600">
                                                            Rows: <span className="font-medium">{importPreview.row_count}</span>
                                                        </span>
                                                        {importPreview.date_range && (
                                                            <span className="text-slate-600">
                                                                Dates: <span className="font-medium">
                                                                    {formatDate(importPreview.date_range.min_date)} - {formatDate(importPreview.date_range.max_date)}
                                                                </span>
                                                            </span>
                                                        )}
                                                    </div>

                                                    {importPreview.pairs.length > 0 && (
                                                        <div className="flex flex-wrap gap-1">
                                                            <span className="text-slate-600">Pairs:</span>
                                                            {importPreview.pairs.slice(0, 10).map((pair) => (
                                                                <Badge key={pair} colorScheme="gray">
                                                                    {pair}
                                                                </Badge>
                                                            ))}
                                                            {importPreview.pairs.length > 10 && (
                                                                <span className="text-slate-500">
                                                                    +{importPreview.pairs.length - 10} more
                                                                </span>
                                                            )}
                                                        </div>
                                                    )}

                                                    {importPreview.sample_rows.length > 0 && (
                                                        <div>
                                                            <span className="mb-1 block text-slate-600">Sample rows:</span>
                                                            <div className="max-h-[150px] overflow-y-auto bg-white p-2 font-mono text-xs">
                                                                {importPreview.sample_rows.map((row, idx) => (
                                                                    <p key={idx} className="mb-1 text-slate-700">
                                                                        {JSON.stringify(row)}
                                                                    </p>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* Cleanup orphans button */}
                            {importHistory.some(e => !e.file_exists && (e.status === 'pending' || e.status === 'failed')) && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    colorScheme="gray"
                                    className="border-orange-300 text-orange-700 hover:bg-orange-50"
                                    onClick={handleCleanupOrphans}
                                >
                                    <LuTrash2 size={12} />
                                    Clean up orphaned imports
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </div>

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
        </div>
    );
};

export default ConnectorFileUpload;
