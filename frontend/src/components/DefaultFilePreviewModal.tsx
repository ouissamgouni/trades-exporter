import React, { useState, useEffect } from 'react';
import {
    Box,
    Button,
    Dialog,
    Flex,
    Text,
    Badge,
    Spinner,
    Stack,
    Table,
    Portal,
} from '@chakra-ui/react';
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
        <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }} size="full">
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="95vw">
                        <Dialog.Header>
                            <Dialog.Title>Default File Preview</Dialog.Title>
                        </Dialog.Header>

                        <Dialog.Body>
                            {/* Loading state */}
                            {loading && !detailedPreview && (
                                <Box textAlign="center" py={12}>
                                    <Spinner size="xl" mb={4} />
                                    <Text color="gray.600">Loading preview...</Text>
                                </Box>
                            )}

                            {/* Error */}
                            {error && !detailedPreview && (
                                <Box p={4} bg="red.50" borderRadius="md">
                                    <Text color="red.700">{error}</Text>
                                </Box>
                            )}

                            {/* Summary Header */}
                            {detailedPreview && (
                                <>
                                    <Box mb={4} p={4} bg="gray.50" borderRadius="md">
                                        <Flex justify="space-between" align="center" mb={2} minW={0}>
                                            <Text fontSize="lg" fontWeight="bold" truncate flex="1" minW={0}>{fileName}</Text>
                                            <Badge colorPalette="teal" size="sm" flexShrink={0} ml={2}>Default File</Badge>
                                        </Flex>

                                        <Stack gap={2}>
                                            <Flex align="center" gap={2}>
                                                <Badge colorPalette="green" size="sm">
                                                    <LuCheck /> {detailedPreview.row_count} rows
                                                </Badge>
                                                <Badge colorPalette="blue" size="sm">
                                                    {detailedPreview.normalized_count} normalized
                                                </Badge>
                                                {detailedPreview.normalization_errors.length > 0 && (
                                                    <Badge colorPalette="red" size="sm">
                                                        <LuTriangleAlert /> {detailedPreview.normalization_errors.length} errors
                                                    </Badge>
                                                )}
                                            </Flex>

                                            {detailedPreview.date_range && (
                                                <Text fontSize="sm" color="gray.600">
                                                    📅 {formatDate(detailedPreview.date_range.min_date)} → {formatDate(detailedPreview.date_range.max_date)}
                                                </Text>
                                            )}

                                            {assets.length > 0 && (
                                                <Flex gap={1} wrap="wrap">
                                                    <Text fontSize="sm" color="gray.600">💰</Text>
                                                    {assets.slice(0, 10).map((asset) => (
                                                        <Badge key={asset} size="xs" colorPalette="gray">
                                                            {asset}
                                                        </Badge>
                                                    ))}
                                                    {assets.length > 10 && (
                                                        <Text fontSize="xs" color="gray.500">+{assets.length - 10} more</Text>
                                                    )}
                                                </Flex>
                                            )}
                                        </Stack>

                                        {/* Error Section */}
                                        {detailedPreview.normalization_errors.length > 0 && (
                                            <Box mt={3}>
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    colorPalette="red"
                                                    onClick={() => setShowErrors(!showErrors)}
                                                >
                                                    {showErrors ? <LuChevronUp /> : <LuChevronDown />}
                                                    View {detailedPreview.normalization_errors.length} normalization errors
                                                </Button>
                                                {showErrors && (
                                                    <Box mt={2} p={3} bg="red.50" borderRadius="md" fontSize="sm">
                                                        {detailedPreview.normalization_errors.map((err, idx) => (
                                                            <Text key={idx} color="red.700">
                                                                Row {err.row_index}: {err.error}
                                                            </Text>
                                                        ))}
                                                    </Box>
                                                )}
                                            </Box>
                                        )}
                                    </Box>

                                    {/* Central Load More Button */}
                                    {!loadAllRows && (detailedPreview.sample_rows.length < detailedPreview.row_count) && (
                                        <Flex justify="center" mb={3} mt={4}>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => loadPreview(true)}
                                                colorPalette="blue"
                                                loading={loading}
                                            >
                                                Load All Rows ({detailedPreview.row_count} total)
                                            </Button>
                                        </Flex>
                                    )}

                                    {/* Split View */}
                                    <Flex gap={4} mt={4}>
                                        {/* Raw Data Panel */}
                                        <Box flex="1" minW="0" borderWidth="1px" borderRadius="md" p={3} bg="blue.50" borderColor="blue.200" overflow="hidden">
                                            <Flex justify="space-between" align="center" mb={2}>
                                                <Text fontSize="sm" fontWeight="bold" color="blue.700">
                                                    Raw Data {loadAllRows && '(All)'}
                                                </Text>
                                                {!loadAllRows && (
                                                    <Text fontSize="xs" color="gray.600">
                                                        Showing {detailedPreview.sample_rows.length} of {detailedPreview.row_count}
                                                    </Text>
                                                )}
                                            </Flex>
                                            {loading && (
                                                <Box textAlign="center" py={8}>
                                                    <Spinner size="lg" mb={2} />
                                                    <Text color="gray.600" fontSize="sm">Loading...</Text>
                                                </Box>
                                            )}
                                            {!loading && (
                                                <Box
                                                    ref={rawScrollRef}
                                                    maxH="500px"
                                                    maxW="100%"
                                                    overflowY="auto"
                                                    overflowX="auto"
                                                    onScroll={() => handleScroll('raw')}
                                                >
                                                    {detailedPreview.sample_rows.length > 0 ? (
                                                        <Table.Root size="sm" fontSize="xs" whiteSpace="nowrap">
                                                            <Table.Header>
                                                                <Table.Row>
                                                                    <Table.ColumnHeader width="40px">#</Table.ColumnHeader>
                                                                    {Object.keys(detailedPreview.sample_rows[0]).map((key) => (
                                                                        <Table.ColumnHeader key={key} minW="80px" maxW="150px">{key}</Table.ColumnHeader>
                                                                    ))}
                                                                </Table.Row>
                                                            </Table.Header>
                                                            <Table.Body>
                                                                {detailedPreview.sample_rows.map((row, idx) => (
                                                                    <Table.Row key={idx}>
                                                                        <Table.Cell>
                                                                            <Badge size="xs" colorPalette="gray">{idx + 1}</Badge>
                                                                        </Table.Cell>
                                                                        {Object.entries(row).map(([key, value], colIdx) => {
                                                                            const strValue = String(value);
                                                                            const shouldTruncate = strValue.length > 20 &&
                                                                                (key.toLowerCase().includes('id') ||
                                                                                    key.toLowerCase().includes('hash') ||
                                                                                    key.toLowerCase().includes('address'));
                                                                            return (
                                                                                <Table.Cell key={colIdx}>
                                                                                    {shouldTruncate ? (
                                                                                        <Text fontSize="xs" fontFamily="mono" title={strValue}>
                                                                                            {`${strValue.slice(0, 8)}...${strValue.slice(-4)}`}
                                                                                        </Text>
                                                                                    ) : (
                                                                                        strValue
                                                                                    )}
                                                                                </Table.Cell>
                                                                            );
                                                                        })}
                                                                    </Table.Row>
                                                                ))}
                                                            </Table.Body>
                                                        </Table.Root>
                                                    ) : (
                                                        <Text color="gray.500" fontSize="sm">No data</Text>
                                                    )}
                                                </Box>
                                            )}
                                        </Box>

                                        {/* Normalized Data Panel */}
                                        <Box flex="1" minW="0" borderWidth="1px" borderRadius="md" p={3} bg="green.50" borderColor="green.200" overflow="hidden">
                                            <Flex justify="space-between" align="center" mb={2}>
                                                <Text fontSize="sm" fontWeight="bold" color="green.700">
                                                    Normalized Data {loadAllRows && '(All)'}
                                                </Text>
                                                {!loadAllRows && (
                                                    <Text fontSize="xs" color="gray.600">
                                                        Showing {detailedPreview.sample_normalized.length} of {detailedPreview.row_count}
                                                    </Text>
                                                )}
                                            </Flex>
                                            {loading && (
                                                <Box textAlign="center" py={8}>
                                                    <Spinner size="lg" mb={2} />
                                                    <Text color="gray.600" fontSize="sm">Loading...</Text>
                                                </Box>
                                            )}
                                            {!loading && detailedPreview.sample_normalized.length > 0 && (
                                                <Box
                                                    ref={normalizedScrollRef}
                                                    maxH="500px"
                                                    maxW="100%"
                                                    overflowY="auto"
                                                    overflowX="auto"
                                                    onScroll={() => handleScroll('normalized')}
                                                >
                                                    <Table.Root size="sm" fontSize="xs" whiteSpace="nowrap">
                                                        <Table.Header>
                                                            <Table.Row>
                                                                <Table.ColumnHeader width="40px">#</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="80px" maxW="120px">Tx ID</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="100px" maxW="130px">Date/Time</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="60px" maxW="90px">Type</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="70px" maxW="90px">Direction</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="60px" maxW="90px">Asset</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="80px" maxW="110px">Amount</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="70px" maxW="100px">Price</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="50px" maxW="70px">Price Asset</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="60px" maxW="90px">Fee</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="50px" maxW="70px">Fee Asset</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="100px" maxW="150px">From Account</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="100px" maxW="150px">To Account</Table.ColumnHeader>
                                                                <Table.ColumnHeader minW="60px" maxW="90px">Network</Table.ColumnHeader>
                                                            </Table.Row>
                                                        </Table.Header>
                                                        <Table.Body>
                                                            {detailedPreview.sample_normalized.map((tx, idx) => (
                                                                <Table.Row key={idx}>
                                                                    <Table.Cell>
                                                                        <Badge size="xs" colorPalette="gray">{idx + 1}</Badge>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs" fontFamily="mono" color="gray.600" title={tx.source_transaction_id || ''}>
                                                                            {tx.source_transaction_id
                                                                                ? `${tx.source_transaction_id.slice(0, 6)}...`
                                                                                : '-'
                                                                            }
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs">
                                                                            {new Date(tx.date_time).toLocaleString('en-US', {
                                                                                month: 'short',
                                                                                day: 'numeric',
                                                                                hour: '2-digit',
                                                                                minute: '2-digit',
                                                                            })}
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Badge size="xs">{tx.transaction_type}</Badge>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Badge
                                                                            size="xs"
                                                                            colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}
                                                                        >
                                                                            {tx.direction === 'inflow' ? '↓ In' : tx.direction === 'outflow' ? '↑ Out' : tx.direction}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    <Table.Cell fontWeight="bold">
                                                                        <Text fontSize="xs">{tx.source_asset_symbol}</Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs">{tx.quantity.toFixed(4)}</Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs">
                                                                            {tx.source_price ? `${tx.source_price.toFixed(2)}` : '-'}
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Badge size="xs" variant="subtle" colorPalette="blue">
                                                                            {tx.source_price_quote_asset_symbol || '-'}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs">{tx.fee > 0 ? tx.fee.toFixed(4) : '-'}</Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Badge size="xs" variant="subtle" colorPalette="orange">
                                                                            {tx.source_fee_quote_asset_symbol || '-'}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs" fontFamily="mono" color="gray.600" title={tx.source_from_account || ''}>
                                                                            {tx.source_from_account
                                                                                ? `${tx.source_from_account.slice(0, 8)}...`
                                                                                : '-'
                                                                            }
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Text fontSize="xs" fontFamily="mono" color="gray.600" title={tx.source_to_account || ''}>
                                                                            {tx.source_to_account
                                                                                ? `${tx.source_to_account.slice(0, 8)}...`
                                                                                : '-'
                                                                            }
                                                                        </Text>
                                                                    </Table.Cell>
                                                                    <Table.Cell>
                                                                        <Badge size="xs" variant="subtle">{tx.network || '-'}</Badge>
                                                                    </Table.Cell>
                                                                </Table.Row>
                                                            ))}
                                                        </Table.Body>
                                                    </Table.Root>
                                                </Box>
                                            )}
                                        </Box>
                                    </Flex>
                                </>
                            )}
                        </Dialog.Body>

                        <Dialog.Footer>
                            <Button variant="outline" onClick={onClose}>
                                Close
                            </Button>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};
