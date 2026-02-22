import {
    Box,
    Button,
    Code,
    Flex,
    Heading,
    HStack,
    IconButton,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
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
        <Box
            p={4}
            bg="gray.50"
            _dark={{ bg: 'gray.800' }}
            borderRadius="md"
            borderWidth="1px"
            mb={4}
        >
            <Flex justify="space-between" align="center" mb={3}>
                <VStack align="start" gap={0}>
                    <Heading size="sm">Raw Transaction Data</Heading>
                    {data && (
                        <Text fontSize="xs" color="gray.500">
                            Source: {data.source} | ID: {data.source_transaction_id}
                        </Text>
                    )}
                </VStack>
                <HStack>
                    <IconButton
                        aria-label="Copy JSON"
                        size="xs"
                        variant="ghost"
                        onClick={handleCopy}
                        disabled={!data}
                    >
                        <LuCopy />
                    </IconButton>
                    <IconButton
                        aria-label="Close"
                        size="xs"
                        variant="ghost"
                        onClick={onClose}
                    >
                        <LuX />
                    </IconButton>
                </HStack>
            </Flex>

            {copied && (
                <Text fontSize="xs" color="green.600" mb={2}>
                    Copied to clipboard!
                </Text>
            )}

            {loading && (
                <Flex justify="center" py={4}>
                    <Spinner size="sm" />
                </Flex>
            )}

            {error && (
                <Box p={3} bg="red.50" borderRadius="md" _dark={{ bg: 'red.900' }}>
                    <Text fontSize="sm" color="red.600">
                        {error}
                    </Text>
                    <Button size="xs" mt={2} onClick={() => fetchData(showFull)}>
                        Retry
                    </Button>
                </Box>
            )}

            {!loading && !error && data && (
                <>
                    <Box
                        maxH="300px"
                        overflowY="auto"
                        bg="gray.900"
                        color="gray.100"
                        borderRadius="md"
                        p={3}
                        fontSize="xs"
                        fontFamily="mono"
                    >
                        <Code
                            as="pre"
                            display="block"
                            whiteSpace="pre-wrap"
                            wordBreak="break-all"
                            bg="transparent"
                            color="inherit"
                            fontSize="inherit"
                        >
                            {formatJson(data.raw_data)}
                        </Code>
                    </Box>

                    {data.truncated && !showFull && (
                        <Button
                            size="xs"
                            variant="ghost"
                            mt={2}
                            onClick={handleShowFull}
                        >
                            Show full data <LuChevronDown />
                        </Button>
                    )}

                    {showFull && (
                        <Button
                            size="xs"
                            variant="ghost"
                            mt={2}
                            onClick={() => fetchData(false)}
                        >
                            Show truncated <LuChevronUp />
                        </Button>
                    )}

                    <HStack mt={3} fontSize="xs" color="gray.500">
                        <Text>Ingested: {new Date(data.ingestion_time).toLocaleString()}</Text>
                        {data.truncated && <Text>• Data truncated to 10KB</Text>}
                    </HStack>
                </>
            )}
        </Box>
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
            <Text color="gray.500" py={4}>
                {emptyLabel}
            </Text>
        );
    }

    return (
        <Box>
            {selectedRawId && (
                <RawDataViewer
                    rawId={selectedRawId}
                    onClose={() => setSelectedRawId(null)}
                />
            )}

            {loadingMapping && (
                <HStack fontSize="xs" color="gray.500" mb={2}>
                    <Spinner size="xs" />
                    <Text>Loading raw data links...</Text>
                </HStack>
            )}

            <Box maxH="300px" overflowY="auto">
                <VStack align="stretch" gap={1}>
                    {visibleIds.map((id, idx) => {
                        const rawId = rawIdMapping[id];
                        const isSelected = rawId === selectedRawId;

                        return (
                            <Flex
                                key={idx}
                                align="center"
                                gap={2}
                                py={1}
                                px={2}
                                borderRadius="sm"
                                cursor={rawId ? 'pointer' : 'default'}
                                _hover={
                                    rawId
                                        ? { bg: 'gray.100', _dark: { bg: 'gray.700' } }
                                        : undefined
                                }
                                bg={isSelected ? 'blue.50' : undefined}
                                _dark={{
                                    bg: isSelected ? 'blue.900' : undefined,
                                }}
                                onClick={() => handleIdClick(id)}
                            >
                                <Text fontSize="xs" fontFamily="mono" flex={1}>
                                    {id}
                                </Text>
                                {rawId && (
                                    <LuExternalLink size={12} color="gray" />
                                )}
                            </Flex>
                        );
                    })}
                </VStack>

                {hasMore && !showAll && (
                    <Button
                        size="xs"
                        variant="ghost"
                        mt={2}
                        onClick={() => setShowAll(true)}
                    >
                        Show {ids.length - maxVisible} more...
                    </Button>
                )}

                {showAll && hasMore && (
                    <Button
                        size="xs"
                        variant="ghost"
                        mt={2}
                        onClick={() => setShowAll(false)}
                    >
                        Show less
                    </Button>
                )}
            </Box>
        </Box>
    );
};
