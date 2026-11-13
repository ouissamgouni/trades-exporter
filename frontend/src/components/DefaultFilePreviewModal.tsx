import React, { useState, useEffect } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Badge, Spinner } from './ui/primitives';
import { LuCheck, LuTriangleAlert, LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { FileUploadDetailedPreview, API_URL } from '../types';

interface DefaultFilePreviewModalProps {
    open: boolean;
    onClose: () => void;
    connectorId: number;
    fileName: string;
}

export const DefaultFilePreviewModal: React.FC<DefaultFilePreviewModalProps> = ({
    open,
    onClose,
    connectorId,
    fileName,
}) => {
    const [detailedPreview, setDetailedPreview] = useState<FileUploadDetailedPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showErrors, setShowErrors] = useState(false);
    const [loadAllRows, setLoadAllRows] = useState(false);

    const rawScrollRef = React.useRef<HTMLDivElement>(null);
    const normalizedScrollRef = React.useRef<HTMLDivElement>(null);
    const [isSyncing, setIsSyncing] = useState(false);

    const formatDate = (dateStr: string | null) => {
        if (!dateStr) return 'N/A';
        return new Date(dateStr).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    };

    const loadPreview = async (allRows = false) => {
        setLoading(true);
        setError(null);
        setLoadAllRows(allRows);

        try {
            const maxSamples = allRows ? 0 : 10;
            const response = await fetch(
                `${API_URL}/connectors/${connectorId}/default-file/preview-detailed?max_samples=${maxSamples}`
            );

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to load preview');
            }

            const data: FileUploadDetailedPreview = await response.json();
            setDetailedPreview(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    // Load on open
    useEffect(() => {
        if (open) {
            setDetailedPreview(null);
            setLoadAllRows(false);
            setShowErrors(false);
            setError(null);
            loadPreview(false);
        }
    }, [open, connectorId]);

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

    const assets = detailedPreview
        ? (detailedPreview.pairs || detailedPreview.currencies || [])
        : [];

    return (
        <RadixDialog.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
            <RadixDialog.Portal>
                <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] flex max-h-[92vh] w-full max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col border border-slate-200 bg-white shadow-xl">
                    <div className="border-b border-slate-100 px-5 py-4">
                        <RadixDialog.Title className="text-base font-semibold text-slate-900">Default File Preview</RadixDialog.Title>
                    </div>

                    <div className="flex-1 overflow-y-auto px-5 py-4">
                        {/* Loading state */}
                        {loading && !detailedPreview && (
                            <div className="py-12 text-center">
                                <Spinner size="lg" className="mb-4" />
                                <div className="text-gray-600">Loading preview...</div>
                            </div>
                        )}

                        {/* Error */}
                        {error && !detailedPreview && (
                            <div className="bg-red-50 p-4">
                                <div className="text-red-700">{error}</div>
                            </div>
                        )}

                        {/* Summary Header */}
                        {detailedPreview && (
                            <>
                                <div className="mb-4 bg-gray-50 p-4">
                                    <div className="mb-2 flex min-w-0 items-center justify-between">
                                        <span className="min-w-0 flex-1 truncate text-lg font-bold">{fileName}</span>
                                        <Badge colorScheme="green" className="ml-2 shrink-0">Default File</Badge>
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <div className="flex items-center gap-2">
                                            <Badge colorScheme="green">
                                                <LuCheck /> {detailedPreview.row_count} rows
                                            </Badge>
                                            <Badge colorScheme="blue">
                                                {detailedPreview.normalized_count} normalized
                                            </Badge>
                                            {detailedPreview.normalization_errors.length > 0 && (
                                                <Badge colorScheme="red">
                                                    <LuTriangleAlert /> {detailedPreview.normalization_errors.length} errors
                                                </Badge>
                                            )}
                                        </div>

                                        {detailedPreview.date_range && (
                                            <div className="text-sm text-gray-600">
                                                📅 {formatDate(detailedPreview.date_range.min_date)} → {formatDate(detailedPreview.date_range.max_date)}
                                            </div>
                                        )}

                                        {assets.length > 0 && (
                                            <div className="flex flex-wrap gap-1">
                                                <span className="text-sm text-gray-600">💰</span>
                                                {assets.slice(0, 10).map((asset) => (
                                                    <Badge key={asset} className="text-[10px]">
                                                        {asset}
                                                    </Badge>
                                                ))}
                                                {assets.length > 10 && (
                                                    <span className="text-xs text-gray-500">+{assets.length - 10} more</span>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Error Section */}
                                    {detailedPreview.normalization_errors.length > 0 && (
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
                                                        <div key={idx} className="text-red-700">
                                                            Row {err.row_index}: {err.error}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Central Load More Button */}
                                {!loadAllRows && (detailedPreview.sample_rows.length < detailedPreview.row_count) && (
                                    <div className="mb-3 mt-4 flex justify-center">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => loadPreview(true)}
                                            colorScheme="blue"
                                            loading={loading}
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
                                            <span className="text-sm font-bold text-blue-700">
                                                Raw Data {loadAllRows && '(All)'}
                                            </span>
                                            {!loadAllRows && (
                                                <span className="text-xs text-gray-600">
                                                    Showing {detailedPreview.sample_rows.length} of {detailedPreview.row_count}
                                                </span>
                                            )}
                                        </div>
                                        {loading && (
                                            <div className="py-8 text-center">
                                                <Spinner size="md" className="mb-2" />
                                                <div className="text-sm text-gray-600">Loading...</div>
                                            </div>
                                        )}
                                        {!loading && (
                                            <div
                                                ref={rawScrollRef}
                                                className="max-h-[500px] max-w-full overflow-auto"
                                                onScroll={() => handleScroll('raw')}
                                            >
                                                {detailedPreview.sample_rows.length > 0 ? (
                                                    <table className="w-full whitespace-nowrap text-xs">
                                                        <thead>
                                                            <tr>
                                                                <th className="w-[40px] text-left">#</th>
                                                                {Object.keys(detailedPreview.sample_rows[0]).map((key) => (
                                                                    <th key={key} className="min-w-[80px] max-w-[150px] text-left">{key}</th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {detailedPreview.sample_rows.map((row, idx) => (
                                                                <tr key={idx}>
                                                                    <td>
                                                                        <Badge className="text-[10px]">{idx + 1}</Badge>
                                                                    </td>
                                                                    {Object.entries(row).map(([key, value], colIdx) => {
                                                                        const strValue = String(value);
                                                                        const shouldTruncate = strValue.length > 20 &&
                                                                            (key.toLowerCase().includes('id') ||
                                                                                key.toLowerCase().includes('hash') ||
                                                                                key.toLowerCase().includes('address'));
                                                                        return (
                                                                            <td key={colIdx}>
                                                                                {shouldTruncate ? (
                                                                                    <span className="font-mono text-xs" title={strValue}>
                                                                                        {`${strValue.slice(0, 8)}...${strValue.slice(-4)}`}
                                                                                    </span>
                                                                                ) : (
                                                                                    strValue
                                                                                )}
                                                                            </td>
                                                                        );
                                                                    })}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                ) : (
                                                    <div className="text-sm text-gray-500">No data</div>
                                                )}
                                            </div>
                                        )}
                                    </div>

                                    {/* Normalized Data Panel */}
                                    <div className="min-w-0 flex-1 overflow-hidden border border-green-200 bg-green-50 p-3">
                                        <div className="mb-2 flex items-center justify-between">
                                            <span className="text-sm font-bold text-green-700">
                                                Normalized Data {loadAllRows && '(All)'}
                                            </span>
                                            {!loadAllRows && (
                                                <span className="text-xs text-gray-600">
                                                    Showing {detailedPreview.sample_normalized.length} of {detailedPreview.row_count}
                                                </span>
                                            )}
                                        </div>
                                        {loading && (
                                            <div className="py-8 text-center">
                                                <Spinner size="md" className="mb-2" />
                                                <div className="text-sm text-gray-600">Loading...</div>
                                            </div>
                                        )}
                                        {!loading && detailedPreview.sample_normalized.length > 0 && (
                                            <div
                                                ref={normalizedScrollRef}
                                                className="max-h-[500px] max-w-full overflow-auto"
                                                onScroll={() => handleScroll('normalized')}
                                            >
                                                <table className="w-full whitespace-nowrap text-xs">
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
                                                        {detailedPreview.sample_normalized.map((tx, idx) => (
                                                            <tr key={idx}>
                                                                <td>
                                                                    <Badge className="text-[10px]">{idx + 1}</Badge>
                                                                </td>
                                                                <td>
                                                                    <span className="font-mono text-xs text-gray-600" title={tx.source_transaction_id || ''}>
                                                                        {tx.source_transaction_id
                                                                            ? `${tx.source_transaction_id.slice(0, 6)}...`
                                                                            : '-'
                                                                        }
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <span className="text-xs">
                                                                        {new Date(tx.date_time).toLocaleString('en-US', {
                                                                            month: 'short',
                                                                            day: 'numeric',
                                                                            hour: '2-digit',
                                                                            minute: '2-digit',
                                                                        })}
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <Badge className="text-[10px]">{tx.transaction_type}</Badge>
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
                                                                    <span className="text-xs">{tx.source_asset_symbol}</span>
                                                                </td>
                                                                <td>
                                                                    <span className="text-xs">{tx.quantity.toFixed(4)}</span>
                                                                </td>
                                                                <td>
                                                                    <span className="text-xs">
                                                                        {tx.source_price ? `${tx.source_price.toFixed(2)}` : '-'}
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <Badge colorScheme="blue" className="text-[10px]">
                                                                        {tx.source_price_quote_asset_symbol || '-'}
                                                                    </Badge>
                                                                </td>
                                                                <td>
                                                                    <span className="text-xs">{tx.fee > 0 ? tx.fee.toFixed(4) : '-'}</span>
                                                                </td>
                                                                <td>
                                                                    <Badge colorScheme="orange" className="text-[10px]">
                                                                        {tx.source_fee_quote_asset_symbol || '-'}
                                                                    </Badge>
                                                                </td>
                                                                <td>
                                                                    <span className="font-mono text-xs text-gray-600" title={tx.source_from_account || ''}>
                                                                        {tx.source_from_account
                                                                            ? `${tx.source_from_account.slice(0, 8)}...`
                                                                            : '-'
                                                                        }
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <span className="font-mono text-xs text-gray-600" title={tx.source_to_account || ''}>
                                                                        {tx.source_to_account
                                                                            ? `${tx.source_to_account.slice(0, 8)}...`
                                                                            : '-'
                                                                        }
                                                                    </span>
                                                                </td>
                                                                <td>
                                                                    <Badge className="text-[10px]">{tx.network || '-'}</Badge>
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="flex justify-end border-t border-slate-100 px-5 py-4">
                        <Button variant="outline" onClick={onClose}>
                            Close
                        </Button>
                    </div>
                </RadixDialog.Content>
            </RadixDialog.Portal>
        </RadixDialog.Root>
    );
};
