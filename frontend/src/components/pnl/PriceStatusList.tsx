
import React, { useState, useMemo } from 'react';
import {
    Box,
    Badge,
    Button,
    Flex,
    Input,
    Table,
    Text,
    Icon,
    Spinner,
} from '@chakra-ui/react';
import { FiCheckCircle, FiAlertCircle, FiAlertTriangle, FiSearch, FiClock, FiDatabase, FiPlus, FiLoader, FiRefreshCw } from 'react-icons/fi';
import { AssetRef, PriceResponse } from '../../types';
import { formatTimeLocale } from '../../utils/dateUtils';
import { Tooltip } from '../ui/tooltip';
import { AddManualPriceDialog } from './AddManualPriceDialog';
import { usePriceGapsSummary } from '../../hooks/usePriceGaps';
import { PriceGapAlert } from '../PriceGapAlert';

interface PriceStatusListProps {
    prices: PriceResponse[];
    baseCurrency: string;
    quoteAssetId?: number;  // Base currency asset ID for manual price entry
    onPriceAdded?: (assetId: number) => void;  // Callback after manual price is saved
    onRetryFailed?: () => void;  // Callback to retry all failed price fetches
    loadingAssetIds?: Set<number>;  // Asset IDs currently being fetched
    assetNameMap?: Map<number, string>;  // id → display name for loading placeholders
    totalAssetCount?: number;  // Total assets in table (including non-PnL)
    naAssets?: Array<{ id: number; symbol: string }>;  // Assets with no lots / zero qty
}

type StatusFilter = 'all' | 'ok' | 'stale' | 'error' | 'na' | 'loading';

// Using formatTimeLocale from utils/dateUtils for time formatting

const formatCurrency = (value: number | null | undefined, currency: string): string => {
    if (value == null) return '—';
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
    }).format(value);
};

export const PriceStatusList: React.FC<PriceStatusListProps> = ({
    prices,
    baseCurrency,
    quoteAssetId,
    onPriceAdded,
    onRetryFailed,
    loadingAssetIds,
    assetNameMap,
    totalAssetCount,
    naAssets,
}) => {
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

    // Fetch gap summary for all assets in the list
    const assetIds = useMemo(
        () => prices.map(p => p.asset.id).filter((id): id is number => id != null),
        [prices],
    );
    const { data: gapSummary } = usePriceGapsSummary(assetIds);
    const gapMap = useMemo(() => {
        const m = new Map<number, number>();
        if (gapSummary?.items) {
            for (const item of gapSummary.items) {
                if (item.total_missing_days > 0) m.set(item.asset_id, item.total_missing_days);
            }
        }
        return m;
    }, [gapSummary]);

    // State for manual price dialog
    const [dialogOpen, setDialogOpen] = useState(false);
    const [selectedAsset, setSelectedAsset] = useState<{ id: number; symbol: string } | null>(null);

    const handleAddPriceClick = (asset: AssetRef) => {
        if (asset.id == null || asset.symbol == null) {
            return; // Early return if id or symbol is null/undefined
        }
        setSelectedAsset({ id: asset.id, symbol: asset.symbol });
        setDialogOpen(true);
    };

    const handlePriceSaved = () => {
        if (selectedAsset && onPriceAdded) {
            onPriceAdded(selectedAsset.id);
        }
        setDialogOpen(false);
        setSelectedAsset(null);
    };

    // Merge loading-only assets (in loadingAssetIds but not yet in prices) as placeholder rows
    const allItems = useMemo(() => {
        const priceAssetIds = new Set(prices.map(p => p.asset.id).filter(Boolean));
        const placeholders: PriceResponse[] = [];
        if (loadingAssetIds) {
            for (const id of loadingAssetIds) {
                if (!priceAssetIds.has(id)) {
                    placeholders.push({
                        asset: { id, symbol: assetNameMap?.get(id) ?? `#${id}` },
                        price: null,
                        price_quote: baseCurrency,
                        fetched_at: undefined,
                    });
                }
            }
        }
        // Add N/A assets as placeholder rows
        const naPlaceholders: PriceResponse[] = [];
        if (naAssets) {
            for (const na of naAssets) {
                if (!priceAssetIds.has(na.id) && !(loadingAssetIds?.has(na.id))) {
                    naPlaceholders.push({
                        asset: { id: na.id, symbol: na.symbol },
                        price: null,
                        price_quote: baseCurrency,
                        fetched_at: undefined,
                        _isNa: true,
                    } as PriceResponse & { _isNa?: boolean });
                }
            }
        }
        return [...prices, ...placeholders, ...naPlaceholders];
    }, [prices, loadingAssetIds, baseCurrency, naAssets]);

    const filtered = allItems.filter(p =>
        (p.asset.symbol && p.asset.symbol.toLowerCase().includes(search.toLowerCase())) ||
        (p.source && p.source.toLowerCase().includes(search.toLowerCase()))
    );

    // Sort: Loading first (if panel is open during fetch), then errors, stale, then by name
    const sorted = [...filtered].sort((a, b) => {
        const aLoading = loadingAssetIds?.has(a.asset.id!) ?? false;
        const bLoading = loadingAssetIds?.has(b.asset.id!) ?? false;
        if (aLoading && !bLoading) return -1;
        if (!aLoading && bLoading) return 1;
        const aErr = !!a.error;
        const bErr = !!b.error;
        const aStale = !!a.is_stale;
        const bStale = !!b.is_stale;
        if (aErr && !bErr) return -1;
        if (!aErr && bErr) return 1;
        if (aStale && !bStale) return -1;
        if (!aStale && bStale) return 1;
        return (a.asset.symbol || '').localeCompare(b.asset.symbol || '');
    });

    // Apply status filter
    const displayed = statusFilter === 'all' ? sorted : sorted.filter(item => {
        const isLoading = loadingAssetIds?.has(item.asset.id!) ?? false;
        const isNa = (item as any)._isNa === true;
        const isError = !isLoading && !isNa && (!!item.error || item.price == null);
        const isStale = !isLoading && !isNa && !!item.is_stale;
        const isOk = !isLoading && !isNa && !isError && !isStale;
        switch (statusFilter) {
            case 'loading': return isLoading;
            case 'ok': return isOk;
            case 'stale': return isStale;
            case 'error': return isError;
            case 'na': return isNa;
            default: return true;
        }
    });

    // Count stats
    const loadingCount = loadingAssetIds?.size ?? 0;
    const okCount = allItems.filter(p => !p.error && p.price != null && !p.is_stale && !(loadingAssetIds?.has(p.asset.id!)) && !(p as any)._isNa).length;
    const staleCount = allItems.filter(p => p.is_stale && p.price != null).length;
    const failedCount = allItems.filter(p => (!!p.error || p.price == null) && !(loadingAssetIds?.has(p.asset.id!)) && !(p as any)._isNa).length;
    const naCount = naAssets?.length ?? 0;
    const pricedTotal = okCount + staleCount + failedCount + loadingCount;
    const skippedCount = totalAssetCount != null ? Math.max(totalAssetCount - pricedTotal - naCount, 0) : 0;

    const toggleFilter = (f: StatusFilter) => setStatusFilter(prev => prev === f ? 'all' : f);

    return (
        <Box height="100%" display="flex" flexDirection="column">
            {/* Header / Stats */}
            <Box p={4} borderBottom="1px solid" borderColor="gray.100" bg="gray.50">
                <Flex justify="space-between" align="center" mb={4}>
                    <Box>
                        <Text fontSize="lg" fontWeight="bold">Price Status</Text>
                        <Flex gap={2} mt={1}>
                            {loadingCount > 0 && (
                                <Badge colorPalette="blue" variant={statusFilter === 'loading' ? 'solid' : 'outline'} cursor="pointer" onClick={() => toggleFilter('loading')}>
                                    {loadingCount} Loading
                                </Badge>
                            )}
                            <Badge colorPalette="green" variant={statusFilter === 'ok' ? 'solid' : 'outline'} cursor="pointer" onClick={() => toggleFilter('ok')}>
                                {okCount} OK
                            </Badge>
                            {staleCount > 0 && (
                                <Badge colorPalette="orange" variant={statusFilter === 'stale' ? 'solid' : 'outline'} cursor="pointer" onClick={() => toggleFilter('stale')}>
                                    {staleCount} Stale
                                </Badge>
                            )}
                            <Badge colorPalette="red" variant={statusFilter === 'error' ? 'solid' : 'outline'} cursor="pointer" onClick={() => toggleFilter('error')}>
                                {failedCount} Failed
                            </Badge>
                            {failedCount > 0 && onRetryFailed && (
                                <Button
                                    size="2xs"
                                    variant="outline"
                                    colorPalette="red"
                                    onClick={onRetryFailed}
                                    disabled={loadingCount > 0}
                                >
                                    <FiRefreshCw size={12} />
                                    <Text ml={1} fontSize="xs">Retry Failed</Text>
                                </Button>
                            )}
                            {naCount > 0 && (
                                <Badge colorPalette="gray" variant={statusFilter === 'na' ? 'solid' : 'outline'} cursor="pointer" onClick={() => toggleFilter('na')}>
                                    {naCount} N/A
                                </Badge>
                            )}
                        </Flex>
                    </Box>
                </Flex>

                <Box position="relative">
                    <Input
                        placeholder="Search assets..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        pl={8}
                        size="sm"
                        borderRadius="md"
                        bg="white"
                    />
                    <Box position="absolute" left={2.5} top={2.5} color="gray.400">
                        <FiSearch size={14} />
                    </Box>
                </Box>
            </Box>

            {/* List Content */}
            <Box flex="1" overflowY="auto" p={0}>
                {displayed.length === 0 ? (
                    <Flex justify="center" align="center" h="200px" color="gray.400" direction="column">
                        <FiDatabase size={32} />
                        <Text mt={2}>{statusFilter !== 'all' ? `No ${statusFilter} assets` : 'No price data available'}</Text>
                    </Flex>
                ) : (
                    <Table.Root size="sm" stickyHeader fontSize="xs">
                        <Table.Header>
                            <Table.Row>
                                <Table.ColumnHeader width="40px"></Table.ColumnHeader>
                                <Table.ColumnHeader>Asset</Table.ColumnHeader>
                                <Table.ColumnHeader>Price</Table.ColumnHeader>
                                <Table.ColumnHeader>Details</Table.ColumnHeader>
                                <Table.ColumnHeader width="80px"></Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {displayed.map((item) => {
                                const isLoading = loadingAssetIds?.has(item.asset.id!) ?? false;
                                const isNa = (item as any)._isNa === true;
                                const isError = !isLoading && !isNa && !!item.error;
                                const isStale = !isLoading && !isNa && !!item.is_stale;
                                const rowBg = isLoading ? 'blue.50' : isNa ? 'gray.50' : isError ? 'red.50' : isStale ? 'orange.50' : undefined;
                                const iconColor = isLoading ? 'blue.500' : isNa ? 'gray.400' : isError ? 'red.500' : isStale ? 'orange.500' : 'green.500';
                                const StatusIcon = isLoading ? FiLoader : isNa ? FiDatabase : isError ? FiAlertCircle : isStale ? FiAlertTriangle : FiCheckCircle;

                                return (
                                    <Table.Row key={item.asset.id} bg={rowBg}>
                                        <Table.Cell>
                                            {isLoading ? (
                                                <Spinner size="xs" color="blue.500" />
                                            ) : (
                                                <Icon color={iconColor}>
                                                    <StatusIcon />
                                                </Icon>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell fontWeight="medium">
                                            <Flex align="center" gap={1}>
                                                <Tooltip content={item.asset.label || item.asset.symbol || ''} openDelay={300} disabled={!item.asset.label}>
                                                    <Text>{item.asset.symbol}</Text>
                                                </Tooltip>
                                                {gapMap.has(item.asset.id!) && (
                                                    <Badge size="xs" colorPalette="orange" variant="subtle">
                                                        {gapMap.get(item.asset.id!)} gap{gapMap.get(item.asset.id!)! !== 1 ? 's' : ''}
                                                    </Badge>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontWeight={isError ? 'normal' : 'bold'}>
                                                {isError && item.last_known_price != null
                                                    ? formatCurrency(item.last_known_price, baseCurrency)
                                                    : formatCurrency(item.price, baseCurrency)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex direction="column" gap={1}>
                                                {isLoading ? (
                                                    <Text color="blue.600" fontSize="xs" fontWeight="medium">
                                                        Fetching...
                                                    </Text>
                                                ) : isError ? (
                                                    <>
                                                        <Tooltip content={item.error || ''} openDelay={200}>
                                                            <Text color="red.600" fontSize="xs" fontWeight="medium" truncate maxW="200px">
                                                                {item.error}
                                                            </Text>
                                                        </Tooltip>
                                                        {item.last_known_price != null && (
                                                            <Flex align="center" gap={1} color="gray.500" fontSize="xs">
                                                                <FiClock size={10} />
                                                                <Text>
                                                                    Last: {formatTimeLocale(item.last_known_price_date)}
                                                                    {item.last_known_source ? ` (${item.last_known_source})` : ''}
                                                                </Text>
                                                            </Flex>
                                                        )}
                                                    </>
                                                ) : isNa ? (
                                                    <Text color="gray.500" fontSize="xs" fontWeight="medium">
                                                        No active lots
                                                    </Text>
                                                ) : isStale ? (
                                                    <>
                                                        <Text color="orange.600" fontSize="xs" fontWeight="medium">
                                                            {item.warning || `Stale: ${item.staleness_days} days old`}
                                                        </Text>
                                                        <Flex align="center" gap={1} color="gray.500" fontSize="xs">
                                                            <FiDatabase size={10} />
                                                            <Text>{item.source || 'Unknown'}</Text>
                                                        </Flex>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Flex align="center" gap={1} color="gray.500" fontSize="xs">
                                                            <FiDatabase size={10} />
                                                            <Text>{item.source || 'Unknown'}</Text>
                                                        </Flex>
                                                        <Flex align="center" gap={1} color="gray.400" fontSize="xs">
                                                            <FiClock size={10} />
                                                            <Text>{formatTimeLocale(item.fetched_at)}</Text>
                                                        </Flex>
                                                    </>
                                                )}
                                            </Flex>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {(isError || isStale) && quoteAssetId && (
                                                <Button
                                                    size="xs"
                                                    variant="outline"
                                                    colorPalette={isError ? 'red' : 'orange'}
                                                    onClick={() => handleAddPriceClick(item.asset)}
                                                    title="Add manual price"
                                                >
                                                    <FiPlus size={12} />
                                                    <Text ml={1} fontSize="xs">Add</Text>
                                                </Button>
                                            )}
                                        </Table.Cell>
                                    </Table.Row>
                                );
                            })}
                        </Table.Body>
                    </Table.Root>
                )}
            </Box>

            {/* Manual Price Dialog */}
            {selectedAsset && quoteAssetId && (
                <AddManualPriceDialog
                    isOpen={dialogOpen}
                    onClose={() => {
                        setDialogOpen(false);
                        setSelectedAsset(null);
                    }}
                    onSave={handlePriceSaved}
                    assetId={selectedAsset.id}
                    assetName={selectedAsset.symbol}
                    defaultDate={new Date().toISOString()}
                    quoteAssetId={quoteAssetId}
                    quoteAssetName={baseCurrency}
                />
            )}
        </Box>
    );
};
