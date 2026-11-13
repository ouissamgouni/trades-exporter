import React, { useState, useEffect, useMemo } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { LuCheck, LuTriangleAlert, LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { FileUploadDetailedPreview, API_URL } from '../types';
import { Badge, Button, Spinner, Text } from './ui/primitives';

// Color palette for group_id linking between raw and normalized panels
const GROUP_COLORS = [
    { bg: 'bg-blue-50', hover: 'bg-blue-100' },
    { bg: 'bg-green-50', hover: 'bg-green-100' },
    { bg: 'bg-purple-50', hover: 'bg-purple-100' },
    { bg: 'bg-orange-50', hover: 'bg-orange-100' },
    { bg: 'bg-pink-50', hover: 'bg-pink-100' },
    { bg: 'bg-teal-50', hover: 'bg-teal-100' },
    { bg: 'bg-yellow-50', hover: 'bg-yellow-100' },
    { bg: 'bg-cyan-50', hover: 'bg-cyan-100' },
];

// Transaction type → badge color scheme (matches TransactionRow.tsx)
const getTypeColor = (type: string): 'blue' | 'purple' | 'green' | 'yellow' | 'orange' | 'gray' => {
    const t = type.toLowerCase();
    if (t === 'trade') return 'blue';
    if (t === 'transfer' || t === 'deposit') return 'purple';
    if (t === 'dividend') return 'green';
    if (t === 'cost') return 'orange';
    if (t === 'margin') return 'yellow';
    return 'gray';
};


interface FileUploadPreviewModalProps {
    open: boolean;
    onClose: () => void;
    onConfirm: (asDefault?: boolean) => void;
    hasExistingDefault?: boolean;
    connectorId: number;
    fileName: string;
    fileSize: number;
    quickPreview: {
        row_count: number;
        date_range: {
            min_date: string | null;
            max_date: string | null;
        } | null;
        pairs?: string[];
        currencies?: string[];
        sample_rows: Record<string, unknown>[];
    };
    file: File;
}

export const FileUploadPreviewModal: React.FC<FileUploadPreviewModalProps> = ({
    open,
    onClose,
    onConfirm,
    hasExistingDefault = false,
    connectorId,
    fileName,
    fileSize,
    quickPreview,
    file,
}) => {
    const [saveAsDefault, setSaveAsDefault] = useState(false);
    const [detailedPreview, setDetailedPreview] = useState<FileUploadDetailedPreview | null>(null);
    const [loadingDetailed, setLoadingDetailed] = useState(false);
    const [detailedError, setDetailedError] = useState<string | null>(null);
    const [showErrors, setShowErrors] = useState(false);
    const [loadAllNormalized, setLoadAllNormalized] = useState(false);
    const [loadAllRaw, setLoadAllRaw] = useState(false);

    const rawScrollRef = React.useRef<HTMLDivElement>(null);
    const normalizedScrollRef = React.useRef<HTMLDivElement>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [hoveredGroupId, setHoveredGroupId] = useState<string | null>(null);

    // Build a stable color map for group_ids
    const groupColorMap = useMemo(() => {
        if (!detailedPreview) return new Map<string, number>();
        const map = new Map<string, number>();
        let colorIdx = 0;
        // Collect group_ids from raw rows
        for (const row of detailedPreview.sample_rows) {
            const gid = row.group_id as string | undefined;
            if (gid && !map.has(gid)) {
                map.set(gid, colorIdx % GROUP_COLORS.length);
                colorIdx++;
            }
        }
        // Also from normalized
        for (const tx of detailedPreview.sample_normalized) {
            if (tx.group_id && !map.has(tx.group_id)) {
                map.set(tx.group_id, colorIdx % GROUP_COLORS.length);
                colorIdx++;
            }
        }
        return map;
    }, [detailedPreview]);

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return 'N/A';
        return new Date(dateStr).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    };

    const loadDetailedPreview = async (loadAllRows = false, mode: 'both' | 'raw' | 'normalized' = 'both') => {
        setLoadingDetailed(true);
        setDetailedError(null);

        if (mode === 'normalized' || mode === 'both') {
            setLoadAllNormalized(loadAllRows);
        }
        if (mode === 'raw' || mode === 'both') {
            setLoadAllRaw(loadAllRows);
        }

        try {
            const formData = new FormData();
            formData.append('file', file);

            const maxSamples = loadAllRows ? 0 : 10;
            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/upload-file/preview-detailed?max_samples=${maxSamples}`,
                {
                    method: 'POST',
                    body: formData,
                }
            );

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to load detailed preview');
            }

            const data = await response.json();
            setDetailedPreview(data);
        } catch (err) {
            setDetailedError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoadingDetailed(false);
        }
    };

    // Auto-load 10 samples when modal opens
    useEffect(() => {
        if (open && !detailedPreview) {
            loadDetailedPreview(false, 'both');
        }
    }, [open]);

    // Synchronized scrolling
    const handleScroll = (source: 'raw' | 'normalized') => {
        if (isSyncing) return;

        setIsSyncing(true);
        const sourceRef = source === 'raw' ? rawScrollRef : normalizedScrollRef;
        const targetRef = source === 'raw' ? normalizedScrollRef : rawScrollRef;

        if (sourceRef.current && targetRef.current) {
            targetRef.current.scrollTop = sourceRef.current.scrollTop;
        }

        setTimeout(() => setIsSyncing(false), 50);
    };

    const assets = quickPreview.pairs || quickPreview.currencies || [];

    return (
        <RadixDialog.Root open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] flex max-h-[95vh] w-full max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col bg-white shadow-xl">
                    <div className="border-b border-gray-100 px-5 py-4">
                        <RadixDialog.Title className="text-base font-semibold">File Upload Preview</RadixDialog.Title>
                    </div>

                    <div className="flex-1 overflow-y-auto px-5 py-4">
                        {/* Summary Header */}
                        <div className="mb-4 bg-gray-50 p-4">
                            <div className="mb-2 flex items-center justify-between">
                                <Text className="text-lg font-bold">{fileName}</Text>
                                <Text className="text-sm text-gray-600">{formatFileSize(fileSize)}</Text>
                            </div>

                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <Badge colorScheme="green">
                                        <LuCheck /> {quickPreview.row_count} rows
                                    </Badge>
                                    {detailedPreview && (
                                        <>
                                            <Badge colorScheme="blue">
                                                {detailedPreview.normalized_count} normalized
                                            </Badge>
                                            {detailedPreview.normalization_errors.length > 0 && (
                                                <Badge colorScheme="red">
                                                    <LuTriangleAlert /> {detailedPreview.normalization_errors.length} errors
                                                </Badge>
                                            )}
                                        </>
                                    )}
                                </div>

                                {quickPreview.date_range && (
                                    <Text className="text-sm text-gray-600">
                                        📅 {formatDate(quickPreview.date_range.min_date)} → {formatDate(quickPreview.date_range.max_date)}
                                    </Text>
                                )}

                                {assets.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        <Text className="text-sm text-gray-600">💰</Text>
                                        {assets.slice(0, 10).map((asset) => (
                                            <Badge key={asset} colorScheme="gray" className="text-[10px]">
                                                {asset}
                                            </Badge>
                                        ))}
                                        {assets.length > 10 && (
                                            <Text className="text-xs text-gray-500">+{assets.length - 10} more</Text>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Error Section */}
                            {detailedPreview && detailedPreview.normalization_errors.length > 0 && (
                                <div className="mt-3">
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        colorScheme="red"
                                        onClick={() => setShowErrors(!showErrors)}
                                    >
                                        {showErrors ? <LuChevronUp /> : <LuChevronDown />}
                                        View {detailedPreview.normalization_errors.length} normalization errors
                                    </Button>
                                    {showErrors && (
                                        <div className="mt-2 bg-red-50 p-3 text-sm">
                                            {detailedPreview.normalization_errors.map((err, idx) => (
                                                <Text key={idx} className="block text-red-700">
                                                    Row {err.row_index}: {err.error}
                                                </Text>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Central Load More Button */}
                        {detailedPreview && !loadAllRaw && !loadAllNormalized && (detailedPreview.sample_rows.length < detailedPreview.row_count) && (
                            <div className="mb-3 mt-4 flex justify-center">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => loadDetailedPreview(true, 'both')}
                                    colorScheme="blue"
                                    loading={loadingDetailed}
                                >
                                    Load All Rows ({detailedPreview.row_count} total)
                                </Button>
                            </div>
                        )}

                        {/* Split View */}
                        <div className="mt-4 flex gap-4">
                            {/* Raw Data Panel */}
                            <div className="min-w-0 flex-1 overflow-hidden border border-blue-200 bg-blue-50 p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <Text className="text-sm font-bold text-blue-700">
                                        Raw Data {loadAllRaw && '(All)'}
                                    </Text>
                                    {!loadAllRaw && detailedPreview && (
                                        <Text className="text-xs text-gray-600">
                                            Showing {detailedPreview.sample_rows.length} of {detailedPreview.row_count}
                                        </Text>
                                    )}
                                </div>
                                {loadingDetailed && (
                                    <div className="py-8 text-center">

                                        <Spinner size="lg" className="mb-2" />
                                        <Text className="text-sm text-gray-600">Loading...</Text>
                                    </div>
                                )}
                                {detailedPreview && !loadingDetailed && (
                                    <div
                                        ref={rawScrollRef}
                                        className="max-h-[500px] max-w-full overflow-y-auto overflow-x-auto"
                                        onScroll={() => handleScroll('raw')}
                                    >
                                        {detailedPreview.sample_rows.length > 0 ? (
                                            <table className="whitespace-nowrap text-xs">
                                                <thead>
                                                    <tr>
                                                        <th className="w-[40px] text-left">#</th>
                                                        {Object.keys(detailedPreview.sample_rows[0])
                                                            .filter((key) => key !== 'group_id' && key !== 'role')
                                                            .map((key) => (
                                                                <th key={key} className="min-w-[80px] max-w-[150px] text-left">{key}</th>
                                                            ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {detailedPreview.sample_rows.map((row, idx) => {
                                                        const gid = row.group_id as string | undefined;
                                                        const role = row.role as string | undefined;
                                                        const colorIdx = gid ? groupColorMap.get(gid) : undefined;
                                                        const isHovered = gid != null && gid === hoveredGroupId;
                                                        const isConsumed = role === 'consumed';
                                                        const isSkipped = role === 'skipped';
                                                        const bgColor = isSkipped
                                                            ? 'bg-gray-50'
                                                            : isHovered && colorIdx != null
                                                                ? GROUP_COLORS[colorIdx].hover
                                                                : colorIdx != null
                                                                    ? GROUP_COLORS[colorIdx].bg
                                                                    : '';

                                                        // Hide group_id and role columns from display
                                                        const displayEntries = Object.entries(row).filter(
                                                            ([key]) => key !== 'group_id' && key !== 'role'
                                                        );

                                                        return (
                                                            <tr
                                                                key={idx}
                                                                className={`cursor-pointer ${bgColor} ${isConsumed || isSkipped ? 'opacity-55' : 'opacity-100'}`}
                                                                onMouseEnter={() => gid && setHoveredGroupId(gid)}
                                                                onMouseLeave={() => setHoveredGroupId(null)}
                                                            >
                                                                <td>
                                                                    <div className="flex items-center gap-1">
                                                                        <Badge colorScheme="gray" className="text-[10px]">{idx + 1}</Badge>
                                                                        {isConsumed && (
                                                                            <Badge colorScheme="orange" className="text-[10px]">sub</Badge>
                                                                        )}
                                                                        {isSkipped && (
                                                                            <Badge colorScheme="red" className="text-[10px]">skip</Badge>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                                {displayEntries.map(([key, value], colIdx) => {
                                                                    const strValue = String(value);
                                                                    const shouldTruncate = strValue.length > 20 &&
                                                                        (key.toLowerCase().includes('id') ||
                                                                            key.toLowerCase().includes('hash') ||
                                                                            key.toLowerCase().includes('address'));

                                                                    return (
                                                                        <td key={colIdx}>
                                                                            {shouldTruncate ? (
                                                                                <Text className="font-mono text-xs" title={strValue}>
                                                                                    {`${strValue.slice(0, 8)}...${strValue.slice(-4)}`}
                                                                                </Text>
                                                                            ) : (
                                                                                strValue
                                                                            )}
                                                                        </td>
                                                                    );
                                                                })}
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        ) : (
                                            <Text className="text-sm text-gray-500">No data</Text>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Normalized Data Panel */}
                            <div className="min-w-0 flex-1 overflow-hidden border border-green-200 bg-green-50 p-3">
                                <div className="mb-2 flex items-center justify-between">
                                    <Text className="text-sm font-bold text-green-700">
                                        Normalized Data {loadAllNormalized && '(All)'}
                                    </Text>
                                    {!loadAllNormalized && detailedPreview && (
                                        <Text className="text-xs text-gray-600">
                                            Showing {detailedPreview.sample_normalized.length} of {detailedPreview.row_count}
                                        </Text>
                                    )}
                                </div>
                                {loadingDetailed && (
                                    <div className="py-8 text-center">
                                        <Spinner size="lg" className="mb-2" />
                                        <Text className="text-sm text-gray-600">Loading...</Text>
                                    </div>
                                )}
                                {detailedPreview && !loadingDetailed && detailedPreview.sample_normalized.length > 0 && (
                                    <div
                                        ref={normalizedScrollRef}
                                        className="max-h-[500px] max-w-full overflow-y-auto overflow-x-auto"
                                        onScroll={() => handleScroll('normalized')}
                                    >
                                        <table className="whitespace-nowrap text-xs">
                                            <thead>
                                                <tr>
                                                    <th className="w-[40px] text-left">#</th>
                                                    <th className="min-w-[80px] max-w-[120px] text-left">Tx ID</th>
                                                    <th className="min-w-[100px] max-w-[130px] text-left">Date/Time</th>
                                                    <th className="min-w-[60px] max-w-[90px] text-left">Type</th>
                                                    <th className="min-w-[70px] max-w-[90px] text-left">Direction</th>
                                                    <th className="min-w-[60px] max-w-[90px] text-left">Asset</th>
                                                    <th className="min-w-[80px] max-w-[110px] text-left">Amount</th>
                                                    <th className="min-w-[70px] max-w-[100px] text-left">Price</th>
                                                    <th className="min-w-[50px] max-w-[70px] text-left">Price Asset</th>
                                                    <th className="min-w-[60px] max-w-[90px] text-left">Fee</th>
                                                    <th className="min-w-[50px] max-w-[70px] text-left">Fee Asset</th>
                                                    <th className="min-w-[100px] max-w-[150px] text-left">From Account</th>
                                                    <th className="min-w-[100px] max-w-[150px] text-left">To Account</th>
                                                    <th className="min-w-[60px] max-w-[90px] text-left">Network</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {detailedPreview.sample_normalized.map((tx, idx) => {
                                                    const gid = tx.group_id;
                                                    const colorIdx = gid ? groupColorMap.get(gid) : undefined;
                                                    const isHovered = gid != null && gid === hoveredGroupId;
                                                    const bgColor = isHovered && colorIdx != null
                                                        ? GROUP_COLORS[colorIdx].hover
                                                        : colorIdx != null
                                                            ? GROUP_COLORS[colorIdx].bg
                                                            : '';

                                                    return (
                                                        <tr
                                                            key={idx}
                                                            className={`cursor-pointer ${bgColor}`}
                                                            onMouseEnter={() => gid && setHoveredGroupId(gid)}

                                                            onMouseLeave={() => setHoveredGroupId(null)}
                                                        >
                                                            <td>
                                                                <Badge colorScheme="gray" className="text-[10px]">{idx + 1}</Badge>
                                                            </td>
                                                            <td>
                                                                <Text className="font-mono text-xs text-gray-600" title={tx.source_transaction_id || ''}>
                                                                    {tx.source_transaction_id
                                                                        ? `${tx.source_transaction_id.slice(0, 6)}...`
                                                                        : '-'
                                                                    }
                                                                </Text>
                                                            </td>
                                                            <td>
                                                                <Text className="text-xs">
                                                                    {new Date(tx.date_time).toLocaleString('en-US', {
                                                                        month: 'short',
                                                                        day: 'numeric',
                                                                        hour: '2-digit',
                                                                        minute: '2-digit',
                                                                    })}
                                                                </Text>
                                                            </td>
                                                            <td>
                                                                <div className="flex items-center gap-1">
                                                                    <Badge colorScheme={getTypeColor(tx.transaction_type)} className="text-[10px]">{tx.transaction_type}</Badge>
                                                                    {tx.source_transaction_type && tx.source_transaction_type !== tx.transaction_type && (
                                                                        <Text className="text-[10px] text-gray-500">{tx.source_transaction_type}</Text>
                                                                    )}
                                                                </div>
                                                            </td>
                                                            <td>
                                                                <Badge
                                                                    colorScheme={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                                                    className="text-[10px]"
                                                                >
                                                                    {tx.direction === 'inflow' ? '↓ In' : tx.direction === 'outflow' ? '↑ Out' : tx.direction}
                                                                </Badge>
                                                            </td>
                                                            <td className="font-bold">
                                                                <Text className="text-xs">{tx.source_asset_symbol}</Text>
                                                            </td>
                                                            <td>
                                                                <Text className="text-xs">{tx.quantity.toFixed(4)}</Text>
                                                            </td>
                                                            <td>
                                                                <Text className="text-xs">
                                                                    {tx.source_price ? `${tx.source_price.toFixed(2)}` : '-'}
                                                                </Text>
                                                            </td>
                                                            <td>
                                                                <Badge colorScheme="blue" className="text-[10px]">
                                                                    {tx.source_price_quote_asset_symbol || '-'}
                                                                </Badge>
                                                            </td>
                                                            <td>
                                                                <Text className="text-xs">{tx.fee > 0 ? tx.fee.toFixed(4) : '-'}</Text>
                                                            </td>
                                                            <td>
                                                                <Badge colorScheme="orange" className="text-[10px]">
                                                                    {tx.source_fee_quote_asset_symbol || '-'}
                                                                </Badge>
                                                            </td>
                                                            <td>
                                                                <Text className="font-mono text-xs text-gray-600" title={tx.source_from_account || ''}>
                                                                    {tx.source_from_account
                                                                        ? `${tx.source_from_account.slice(0, 8)}...`
                                                                        : '-'
                                                                    }
                                                                </Text>
                                                            </td>
                                                            <td>
                                                                <Text className="font-mono text-xs text-gray-600" title={tx.source_to_account || ''}>
                                                                    {tx.source_to_account
                                                                        ? `${tx.source_to_account.slice(0, 8)}...`
                                                                        : '-'
                                                                    }
                                                                </Text>
                                                            </td>
                                                            <td>
                                                                <Badge colorScheme="gray" className="text-[10px]">{tx.network || '-'}</Badge>
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 border-t border-gray-100 px-5 py-4">
                        <div className="flex flex-1 items-center gap-3">
                            <label className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    checked={saveAsDefault}
                                    onChange={(e) => setSaveAsDefault(e.target.checked)}
                                    className="h-4 w-4 border border-gray-300"
                                />
                                <Text className="text-xs text-gray-600">
                                    {hasExistingDefault ? 'Replace default file' : 'Save as default file'}
                                </Text>
                            </label>
                        </div>
                        <div className="flex gap-2">
                            <Button variant="outline" onClick={onClose}>
                                Cancel
                            </Button>
                            <Button colorScheme="blue" onClick={() => onConfirm(saveAsDefault)}>
                                {saveAsDefault ? '📌 Import as Default' : 'Confirm Import'}
                            </Button>
                        </div>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
