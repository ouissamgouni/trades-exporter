
import React, { useState } from 'react';
import {
    Box,
    Badge,
    Button,
    Flex,
    Input,
    Table,
    Text,
    Icon,
} from '@chakra-ui/react';
import { FiCheckCircle, FiAlertCircle, FiAlertTriangle, FiSearch, FiClock, FiDatabase, FiPlus } from 'react-icons/fi';
import { AssetRef, PriceResponse } from '../../types';
import { formatTimeLocale } from '../../utils/dateUtils';
import { AddManualPriceDialog } from './AddManualPriceDialog';

interface PriceStatusListProps {
    prices: PriceResponse[];
    baseCurrency: string;
    quoteAssetId?: number;  // Base currency asset ID for manual price entry
    onPriceAdded?: (assetId: number) => void;  // Callback after manual price is saved
}

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
}) => {
    const [search, setSearch] = useState('');

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

    const filtered = prices.filter(p =>
        (p.asset.symbol && p.asset.symbol.toLowerCase().includes(search.toLowerCase())) ||
        (p.source && p.source.toLowerCase().includes(search.toLowerCase()))
    );

    // Sort: Errors first, then stale, then by name
    const sorted = [...filtered].sort((a, b) => {
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

    // Count stats
    const okCount = prices.filter(p => !p.error && p.price != null && !p.is_stale).length;
    const staleCount = prices.filter(p => p.is_stale && p.price != null).length;
    const failedCount = prices.filter(p => !!p.error || p.price == null).length;

    return (
        <Box height="100%" display="flex" flexDirection="column">
            {/* Header / Stats */}
            <Box p={4} borderBottom="1px solid" borderColor="gray.100" bg="gray.50">
                <Flex justify="space-between" align="center" mb={4}>
                    <Box>
                        <Text fontSize="lg" fontWeight="bold">Price Status</Text>
                        <Flex gap={2} mt={1}>
                            <Badge colorPalette="green" variant="solid">
                                {okCount} OK
                            </Badge>
                            {staleCount > 0 && (
                                <Badge colorPalette="orange" variant="solid">
                                    {staleCount} Stale
                                </Badge>
                            )}
                            <Badge colorPalette="red" variant="solid">
                                {failedCount} Failed
                            </Badge>
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
                {sorted.length === 0 ? (
                    <Flex justify="center" align="center" h="200px" color="gray.400" direction="column">
                        <FiDatabase size={32} />
                        <Text mt={2}>No price data available</Text>
                    </Flex>
                ) : (
                    <Table.Root size="sm" stickyHeader>
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
                            {sorted.map((item) => {
                                const isError = !!item.error;
                                const isStale = !!item.is_stale;
                                const rowBg = isError ? 'red.50' : isStale ? 'orange.50' : undefined;
                                const iconColor = isError ? 'red.500' : isStale ? 'orange.500' : 'green.500';
                                const StatusIcon = isError ? FiAlertCircle : isStale ? FiAlertTriangle : FiCheckCircle;

                                return (
                                    <Table.Row key={item.asset.id} bg={rowBg}>
                                        <Table.Cell>
                                            <Icon color={iconColor}>
                                                <StatusIcon />
                                            </Icon>
                                        </Table.Cell>
                                        <Table.Cell fontWeight="medium">
                                            {item.asset.symbol}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontWeight={isError ? 'normal' : 'bold'}>
                                                {formatCurrency(item.price, baseCurrency)}
                                            </Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex direction="column" gap={1}>
                                                {isError ? (
                                                    <Text color="red.600" fontSize="xs" fontWeight="medium">
                                                        {item.error}
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
