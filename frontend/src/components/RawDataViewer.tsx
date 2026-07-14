import { Button, Heading, Spinner } from './ui/primitives';
import React, { useCallback, useEffect, useState } from 'react';
import { LuChevronDown, LuChevronUp, LuCopy, LuExternalLink, LuX } from 'react-icons/lu';
import { API_URL, LookupSourceIdsResponse, RawTransactionResponse } from '../types';

interface RawDataViewerProps {
    /**
     * The raw transaction ID to fetch data for.
     * Can be the internal ID (number) or source_transaction_id (string)
     */
    rawId: number;
    /**
     * Called when the viewer should be closed
     */
    onClose: () => void;
}

/**
 * Component to display raw transaction data from the original API response.
 * Supports truncated data with "Show full" button.
 */
export const RawDataViewer: React.FC<RawDataViewerProps> = ({ rawId, onClose }) => {
    const [data, setData] = useState<RawTransactionResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showFull, setShowFull] = useState(false);
    const [copied, setCopied] = useState(false);

    const fetchData = useCallback(async (full: boolean = false) => {
        setLoading(true);
        setError(null);
        try {
            const url = full
                ? `${API_URL}/raw-transactions/${rawId}/full`
                : `${API_URL}/raw-transactions/${rawId}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to fetch raw data: ${response.status}`);
            }
            const result: RawTransactionResponse = await response.json();
            setData(result);
            setShowFull(full);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }, [rawId]);

    // Fetch on mount
    React.useEffect(() => {
        fetchData(false);
    }, [fetchData]);

    const handleShowFull = () => {
        fetchData(true);
    };

    const handleCopy = async () => {
        if (!data) return;
        try {
            await navigator.clipboard.writeText(JSON.stringify(data.raw_data, null, 2));
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            console.error('Failed to copy to clipboard');
        }
    };

    const formatJson = (obj: Record<string, unknown>): string => {
        return JSON.stringify(obj, null, 2);
    };

    return (
        <div className="mb-4 border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800">
            <div className="mb-3 flex items-center justify-between">
                <div className="flex flex-col items-start gap-0">
                    <Heading className="text-sm">Raw Transaction Data</Heading>
                    {data && (
                        <span className="text-xs text-slate-500">
                            Source: {data.source} | ID: {data.source_transaction_id}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        aria-label="Copy JSON"
                        size="sm"
                        variant="ghost"
                        onClick={handleCopy}
                        disabled={!data}
                    >
                        <LuCopy />
                    </Button>
                    <Button
                        aria-label="Close"
                        size="sm"
                        variant="ghost"
                        onClick={onClose}
                    >
                        <LuX />
                    </Button>
                </div>
            </div>

            {copied && (
                <span className="mb-2 block text-xs text-green-600">
                    Copied to clipboard!
                </span>
            )}

            {loading && (
                <div className="flex justify-center py-4">
                    <Spinner size="sm" />
                </div>
            )}

            {error && (
                <div className="border border-red-200 bg-red-50 p-3 dark:bg-red-900">
                    <span className="block text-sm text-red-600">
                        {error}
                    </span>
                    <Button size="sm" className="mt-2" onClick={() => fetchData(showFull)}>
                        Retry
                    </Button>
                </div>
            )}

            {!loading && !error && data && (
                <>
                    <div className="max-h-[300px] overflow-y-auto bg-slate-900 p-3 font-mono text-xs text-slate-100">
                        <pre className="whitespace-pre-wrap break-all bg-transparent text-inherit">
                            {formatJson(data.raw_data)}
                        </pre>
                    </div>

                    {data.truncated && !showFull && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="mt-2"
                            onClick={handleShowFull}
                        >
                            Show full data <LuChevronDown />
                        </Button>
                    )}

                    {showFull && (
                        <Button
                            size="sm"
                            variant="ghost"
                            className="mt-2"
                            onClick={() => fetchData(false)}
                        >
                            Show truncated <LuChevronUp />
                        </Button>
                    )}

                    <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                        <span>Ingested: {new Date(data.ingestion_time).toLocaleString()}</span>
                        {data.truncated && <span>• Data truncated to 10KB</span>}
                    </div>
                </>
            )}
        </div>
    );
};

interface TransactionIdListProps {
    /**
     * List of source_transaction_ids to display
     */
    ids: string[];
    /**
     * Label for empty state
     */
    emptyLabel?: string;
    /**
     * Maximum items to show before "show more"
     */
    maxVisible?: number;
    /**
     * Whether to enable raw data lookup and viewing
     */
    enableRawDataView?: boolean;
}

/**
 * Component to display a list of transaction IDs with clickable raw data viewer.
 * Automatically fetches raw_transaction_id mappings when enableRawDataView is true.
 */
export const TransactionIdList: React.FC<TransactionIdListProps> = ({
    ids,
    emptyLabel = 'No transactions',
    maxVisible = 100,
    enableRawDataView = true,
}) => {
    const [selectedRawId, setSelectedRawId] = useState<number | null>(null);
    const [showAll, setShowAll] = useState(false);
    const [rawIdMapping, setRawIdMapping] = useState<Record<string, number>>({});
    const [loadingMapping, setLoadingMapping] = useState(false);

    // Fetch raw_transaction_id mapping for visible IDs
    const fetchMapping = useCallback(async (sourceIds: string[]) => {
        if (!enableRawDataView || sourceIds.length === 0) return;

        setLoadingMapping(true);
        try {
            const response = await fetch(`${API_URL}/raw-transactions/lookup-by-source-ids`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_transaction_ids: sourceIds }),
            });

            if (response.ok) {
                const data: LookupSourceIdsResponse = await response.json();
                setRawIdMapping((prev) => ({ ...prev, ...data.mapping }));
            }
        } catch (err) {
            console.error('Failed to fetch raw_transaction_id mapping:', err);
        } finally {
            setLoadingMapping(false);
        }
    }, [enableRawDataView]);

    // Fetch mapping when IDs change or when showing more
    useEffect(() => {
        const visibleIds = showAll ? ids : ids.slice(0, maxVisible);
        const unmappedIds = visibleIds.filter((id) => !(id in rawIdMapping));

        if (unmappedIds.length > 0) {
            fetchMapping(unmappedIds);
        }
    }, [ids, showAll, maxVisible, rawIdMapping, fetchMapping]);

    const visibleIds = showAll ? ids : ids.slice(0, maxVisible);
    const hasMore = ids.length > maxVisible;

    const handleIdClick = (sourceId: string) => {
        const rawId = rawIdMapping[sourceId];
        if (rawId) {
            setSelectedRawId((prev) => (prev === rawId ? null : rawId));
        }
    };

    if (ids.length === 0) {
        return (
            <div className="py-4 text-slate-500">
                {emptyLabel}
            </div>
        );
    }

    return (
        <div>
            {selectedRawId && (
                <RawDataViewer
                    rawId={selectedRawId}
                    onClose={() => setSelectedRawId(null)}
                />
            )}

            {loadingMapping && (
                <div className="mb-2 flex items-center gap-2 text-xs text-slate-500">
                    <Spinner size="xs" />
                    <span>Loading raw data links...</span>
                </div>
            )}

            <div className="max-h-[300px] overflow-y-auto">
                <div className="flex flex-col items-stretch gap-1">
                    {visibleIds.map((id, idx) => {
                        const rawId = rawIdMapping[id];
                        const isSelected = rawId === selectedRawId;

                        return (
                            <div
                                key={idx}
                                className={`flex items-center gap-2 px-2 py-1 ${rawId ? 'cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700' : ''} ${isSelected ? 'bg-blue-50 dark:bg-blue-900' : ''}`}
                                onClick={() => handleIdClick(id)}
                            >
                                <span className="flex-1 font-mono text-xs">
                                    {id}
                                </span>
                                {rawId && (
                                    <LuExternalLink size={12} color="gray" />
                                )}
                            </div>
                        );
                    })}
                </div>

                {hasMore && !showAll && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2"
                        onClick={() => setShowAll(true)}
                    >
                        Show {ids.length - maxVisible} more...
                    </Button>
                )}

                {showAll && hasMore && (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2"
                        onClick={() => setShowAll(false)}
                    >
                        Show less
                    </Button>
                )}
            </div>
        </div>
    );
};
