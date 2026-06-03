import React, { useState, useEffect, useMemo } from 'react';
import {
    Box,
    Button,
    Checkbox,
    Dialog,
    Flex,
    Text,
    Badge,
    Spinner,
    Stack,
    Table,
    Tabs,
    Portal,
} from '@chakra-ui/react';
import { LuCheck, LuTriangleAlert, LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { FileUploadDetailedPreview, API_URL } from '../types';

// Color palette for group_id linking between raw and normalized panels
const GROUP_COLORS = [
    { bg: 'blue.50', hover: 'blue.100' },
    { bg: 'green.50', hover: 'green.100' },
    { bg: 'purple.50', hover: 'purple.100' },
    { bg: 'orange.50', hover: 'orange.100' },
    { bg: 'pink.50', hover: 'pink.100' },
    { bg: 'teal.50', hover: 'teal.100' },
    { bg: 'yellow.50', hover: 'yellow.100' },
    { bg: 'cyan.50', hover: 'cyan.100' },
];

// Transaction type → badge color palette (matches TransactionRow.tsx)
const getTypeColor = (type: string): string => {
    const t = type.toLowerCase();
    if (t === 'trade') return 'blue';
    if (t === 'transfer' || t === 'deposit') return 'purple';
    if (t === 'dividend') return 'teal';
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
        <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onClose(); }} size="full">
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content maxW="95vw">
                        <Dialog.Header>
                            <Dialog.Title>File Upload Preview</Dialog.Title>
                        </Dialog.Header>

                        <Dialog.Body>
                            {/* Summary Header */}
                            <Box mb={4} p={4} bg="gray.50" borderRadius="md">
                                <Flex justify="space-between" align="center" mb={2}>
                                    <Text fontSize="lg" fontWeight="bold">{fileName}</Text>
                                    <Text fontSize="sm" color="gray.600">{formatFileSize(fileSize)}</Text>
                                </Flex>

                                <Stack gap={2}>
                                    <Flex align="center" gap={2}>
                                        <Badge colorPalette="green" size="sm">
                                            <LuCheck /> {quickPreview.row_count} rows
                                        </Badge>
                                        {detailedPreview && (
                                            <>
                                                <Badge colorPalette="blue" size="sm">
                                                    {detailedPreview.normalized_count} normalized
                                                </Badge>
                                                {detailedPreview.normalization_errors.length > 0 && (
                                                    <Badge colorPalette="red" size="sm">
                                                        <LuTriangleAlert /> {detailedPreview.normalization_errors.length} errors
                                                    </Badge>
                                                )}
                                            </>
                                        )}
                                    </Flex>

                                    {quickPreview.date_range && (
                                        <Text fontSize="sm" color="gray.600">
                                            📅 {formatDate(quickPreview.date_range.min_date)} → {formatDate(quickPreview.date_range.max_date)}
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
                                {detailedPreview && detailedPreview.normalization_errors.length > 0 && (
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
                            {detailedPreview && !loadAllRaw && !loadAllNormalized && (detailedPreview.sample_rows.length < detailedPreview.row_count) && (
                                <Flex justify="center" mb={3} mt={4}>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => loadDetailedPreview(true, 'both')}
                                        colorPalette="blue"
                                        loading={loadingDetailed}
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
                                            Raw Data {loadAllRaw && '(All)'}
                                        </Text>
                                        {!loadAllRaw && detailedPreview && (
                                            <Text fontSize="xs" color="gray.600">
                                                Showing {detailedPreview.sample_rows.length} of {detailedPreview.row_count}
                                            </Text>
                                        )}
                                    </Flex>
                                    {loadingDetailed && (
                                        <Box textAlign="center" py={8}>
                                            <Spinner size="lg" mb={2} />
                                            <Text color="gray.600" fontSize="sm">Loading...</Text>
                                        </Box>
                                    )}
                                    {detailedPreview && !loadingDetailed && (
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
                                                            {Object.keys(detailedPreview.sample_rows[0])
                                                                .filter((key) => key !== 'group_id' && key !== 'role')
                                                                .map((key) => (
                                                                <Table.ColumnHeader key={key} minW="80px" maxW="150px">{key}</Table.ColumnHeader>
                                                            ))}
                                                        </Table.Row>
                                                    </Table.Header>
                                                    <Table.Body>
                                                        {detailedPreview.sample_rows.map((row, idx) => {
                                                            const gid = row.group_id as string | undefined;
                                                            const role = row.role as string | undefined;
                                                            const colorIdx = gid ? groupColorMap.get(gid) : undefined;
                                                            const isHovered = gid != null && gid === hoveredGroupId;
                                                            const isConsumed = role === 'consumed';
                                                            const isSkipped = role === 'skipped';
                                                            const bgColor = isSkipped
                                                                ? 'gray.50'
                                                                : isHovered && colorIdx != null
                                                                    ? GROUP_COLORS[colorIdx].hover
                                                                    : colorIdx != null
                                                                        ? GROUP_COLORS[colorIdx].bg
                                                                        : undefined;

                                                            // Hide group_id and role columns from display
                                                            const displayEntries = Object.entries(row).filter(
                                                                ([key]) => key !== 'group_id' && key !== 'role'
                                                            );

                                                            return (
                                                            <Table.Row
                                                                key={idx}
                                                                bg={bgColor}
                                                                opacity={isConsumed || isSkipped ? 0.55 : 1}
                                                                cursor="pointer"
                                                                onMouseEnter={() => gid && setHoveredGroupId(gid)}
                                                                onMouseLeave={() => setHoveredGroupId(null)}
                                                            >
                                                                <Table.Cell>
                                                                    <Flex align="center" gap={1}>
                                                                        <Badge size="xs" colorPalette="gray">{idx + 1}</Badge>
                                                                        {isConsumed && (
                                                                            <Badge size="xs" colorPalette="orange" variant="subtle">sub</Badge>
                                                                        )}
                                                                        {isSkipped && (
                                                                            <Badge size="xs" colorPalette="red" variant="subtle">skip</Badge>
                                                                        )}
                                                                    </Flex>
                                                                </Table.Cell>
                                                                {displayEntries.map(([key, value], colIdx) => {
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
                                                            );
                                                        })}
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
                                            Normalized Data {loadAllNormalized && '(All)'}
                                        </Text>
                                        {!loadAllNormalized && detailedPreview && (
                                            <Text fontSize="xs" color="gray.600">
                                                Showing {detailedPreview.sample_normalized.length} of {detailedPreview.row_count}
                                            </Text>
                                        )}
                                    </Flex>
                                    {loadingDetailed && (
                                        <Box textAlign="center" py={8}>
                                            <Spinner size="lg" mb={2} />
                                            <Text color="gray.600" fontSize="sm">Loading...</Text>
                                        </Box>
                                    )}
                                    {detailedPreview && !loadingDetailed && detailedPreview.sample_normalized.length > 0 && (
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
                                                    {detailedPreview.sample_normalized.map((tx, idx) => {
                                                        const gid = tx.group_id;
                                                        const colorIdx = gid ? groupColorMap.get(gid) : undefined;
                                                        const isHovered = gid != null && gid === hoveredGroupId;
                                                        const bgColor = isHovered && colorIdx != null
                                                            ? GROUP_COLORS[colorIdx].hover
                                                            : colorIdx != null
                                                                ? GROUP_COLORS[colorIdx].bg
                                                                : undefined;

                                                        return (
                                                        <Table.Row
                                                            key={idx}
                                                            bg={bgColor}
                                                            cursor="pointer"
                                                            onMouseEnter={() => gid && setHoveredGroupId(gid)}
                                                            onMouseLeave={() => setHoveredGroupId(null)}
                                                        >
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
                                                                <Flex align="center" gap={1}>
                                                                    <Badge size="xs" colorPalette={getTypeColor(tx.transaction_type)} variant="subtle">{tx.transaction_type}</Badge>
                                                                    {tx.source_transaction_type && tx.source_transaction_type !== tx.transaction_type && (
                                                                        <Text fontSize="2xs" color="gray.500">{tx.source_transaction_type}</Text>
                                                                    )}
                                                                </Flex>
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
                                                        );
                                                    })}
                                                </Table.Body>
                                            </Table.Root>
                                        </Box>
                                    )}
                                </Box>
                            </Flex>
                        </Dialog.Body>

                        <Dialog.Footer>
                            <Flex align="center" gap={3} flex={1}>
                                <Checkbox.Root
                                    checked={saveAsDefault}
                                    onCheckedChange={(e) => setSaveAsDefault(!!e.checked)}
                                    size="sm"
                                >
                                    <Checkbox.HiddenInput />
                                    <Checkbox.Control>
                                        <Checkbox.Indicator />
                                    </Checkbox.Control>
                                    <Checkbox.Label>
                                        <Text fontSize="xs" color="gray.600">
                                            {hasExistingDefault ? 'Replace default file' : 'Save as default file'}
                                        </Text>
                                    </Checkbox.Label>
                                </Checkbox.Root>
                            </Flex>
                            <Flex gap={2}>
                                <Button variant="outline" onClick={onClose}>
                                    Cancel
                                </Button>
                                <Button colorPalette="blue" onClick={() => onConfirm(saveAsDefault)}>
                                    {saveAsDefault ? '📌 Import as Default' : 'Confirm Import'}
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};
