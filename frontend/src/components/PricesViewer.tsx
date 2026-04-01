
import {
    Badge, Box,
    Button, Checkbox, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text
} from '@chakra-ui/react';
import React, { useEffect, useMemo, useState } from 'react';
import { API_URL, Asset, PaginatedPriceSnapshotsResponse, PriceSnapshot } from '../types';
import { useAssets } from '../hooks/useAssets';
import { AssetBadge } from './AssetBadge';
import { AssetSelector } from './AssetSelector';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { usePagination, DEFAULT_PAGE_SIZE } from '../hooks/usePagination';
import { TablePagination } from './TablePagination';
import { PriceHealthCards } from './PriceHealthCards';

type PriceViewMode = 'health' | 'table';

export const PricesViewer: React.FC = () => {
    const [viewMode, setViewMode] = useState<PriceViewMode>('health');
    const [prices, setPrices] = useState<PriceSnapshot[]>([]);
    const [totalItems, setTotalItems] = useState(0);
    const { assets } = useAssets();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<PriceSnapshot>>({});
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newPrice, setNewPrice] = useState<Partial<PriceSnapshot>>({});
    const [assetIdFilter, setAssetIdFilter] = useState<number | null>(null);
    const [quoteAssetIdFilter, setQuoteAssetIdFilter] = useState<number | null>(null);
    const [sourceFilter, setSourceFilter] = useState<string>('');
    const [snapshotTimeFrom, setSnapshotTimeFrom] = useState<string>('');
    const [snapshotTimeTo, setSnapshotTimeTo] = useState<string>('');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

    // Pagination
    const pagination = usePagination({ storageKey: 'prices', initialPageSize: DEFAULT_PAGE_SIZE });

    const deleteConfirm = useConfirmDialog<PriceSnapshot>();

    // Calculate pagination offset for server-side pagination
    const offset = (pagination.page - 1) * pagination.pageSize;

    useEffect(() => {
        fetchPrices();
    }, [assetIdFilter, quoteAssetIdFilter, sourceFilter, snapshotTimeFrom, snapshotTimeTo, pagination.page, pagination.pageSize]);

    // Extract unique sources from fetched prices for filter dropdown
    const availableSources = useMemo(() => {
        const sources = new Set<string>();
        prices.forEach(p => {
            if (p.source) sources.add(p.source);
        });
        return Array.from(sources).sort();
    }, [prices]);

    const fetchPrices = async () => {
        setLoading(true);
        setError(null);
        setSelectedIds(new Set()); // Clear selection on refresh
        try {
            const params = new URLSearchParams();
            if (assetIdFilter) params.append('asset_id', String(assetIdFilter));
            if (quoteAssetIdFilter) params.append('quote_asset_id', String(quoteAssetIdFilter));
            if (sourceFilter) params.append('source', sourceFilter);
            if (snapshotTimeFrom) params.append('snapshot_time_from', snapshotTimeFrom);
            if (snapshotTimeTo) params.append('snapshot_time_to', snapshotTimeTo);
            params.append('limit', String(pagination.pageSize));
            params.append('offset', String(offset));
            const response = await fetch(`${API_URL}/price-snapshots?${params}`);
            if (!response.ok) throw new Error('Failed to fetch prices');
            const data: PaginatedPriceSnapshotsResponse = await response.json();
            setPrices(data.items);
            setTotalItems(data.total);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const getAssetSymbol = (assetId: number | null | undefined) => {
        if (assetId === null || assetId === undefined) return 'Unknown';
        const asset = assets.find(a => a.asset_id === assetId);
        return asset?.symbol || `ID:${assetId}`;
    };

    const formatSnapshotTime = (isoString: string): string => {
        try {
            const date = new Date(isoString);
            return date.toLocaleString(undefined, {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            });
        } catch {
            return isoString;
        }
    };

    const clearFilters = () => {
        setAssetIdFilter(null);
        setQuoteAssetIdFilter(null);
        setSourceFilter('');
        setSnapshotTimeFrom('');
        setSnapshotTimeTo('');
        pagination.firstPage();
    };

    const hasActiveFilters = assetIdFilter !== null || quoteAssetIdFilter !== null || sourceFilter || snapshotTimeFrom || snapshotTimeTo;

    const getEditKey = (price: PriceSnapshot) => `${price.snapshot_id}`;

    const startEditing = (price: PriceSnapshot) => {
        setEditingKey(getEditKey(price));
        setEditValues({
            price: price.price,
            source: price.source || '',
        });
    };

    const savePrice = async (price: PriceSnapshot) => {
        try {
            const response = await fetch(`${API_URL}/price-snapshots/${price.snapshot_id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editValues)
            });
            if (!response.ok) throw new Error('Failed to update price');
            await fetchPrices();
            setEditingKey(null);
            setEditValues({});
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const createPrice = async () => {
        if (!newPrice.asset_id || !newPrice.snapshot_time || newPrice.price === undefined) {
            toaster.error({ title: 'Validation error', description: 'Asset ID, Snapshot Time, and Price are required' });
            return;
        }
        try {
            const response = await fetch(`${API_URL}/price-snapshots`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newPrice)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create price');
            }
            await fetchPrices();
            setNewPrice({});
            setShowCreateDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create price' });
        }
    };

    const deletePrice = (price: PriceSnapshot) => {
        deleteConfirm.open(price);
    };

    const executeDelete = async () => {
        if (!deleteConfirm.data) return;
        const price = deleteConfirm.data;
        try {
            const response = await fetch(`${API_URL}/price-snapshots/${price.snapshot_id}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete price');
            await fetchPrices();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete price' });
        }
    };

    const toggleSelection = (snapshotId: number) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(snapshotId)) {
                newSet.delete(snapshotId);
            } else {
                newSet.add(snapshotId);
            }
            return newSet;
        });
    };

    const toggleSelectAll = () => {
        if (selectedIds.size === prices.length) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(prices.map(p => p.snapshot_id)));
        }
    };

    const clearSelection = () => {
        setSelectedIds(new Set());
    };

    const bulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setBulkDeleteLoading(true);
        try {
            const response = await fetch(`${API_URL}/price-snapshots/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snapshot_ids: Array.from(selectedIds) })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to delete prices');
            }
            const result = await response.json();
            toaster.success({ title: 'Success', description: `Successfully deleted ${result.affected_count} price record(s)` });
            setShowBulkDeleteDialog(false);
            setSelectedIds(new Set());
            await fetchPrices();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete prices' });
        } finally {
            setBulkDeleteLoading(false);
        }
    };

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>💰 Price Snapshots</Heading>
                    <Text color="gray.600" fontSize="sm">
                        {viewMode === 'health'
                            ? 'Monitor price data freshness and detect anomalies across all assets.'
                            : 'View and manage historical cryptocurrency price snapshots.'}
                    </Text>
                </Box>
                <Flex gap={2} align="center">
                    {/* View mode toggle */}
                    <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                        {([{ value: 'health' as const, label: '🩺 Health' }, { value: 'table' as const, label: '📋 Table' }]).map(opt => (
                            <Button
                                key={opt.value}
                                size="sm"
                                variant={viewMode === opt.value ? 'solid' : 'ghost'}
                                colorPalette={viewMode === opt.value ? 'blue' : 'gray'}
                                borderRadius="0"
                                onClick={() => setViewMode(opt.value)}
                                px={3}
                                fontSize="sm"
                            >
                                {opt.label}
                            </Button>
                        ))}
                    </Flex>
                    {viewMode === 'table' && (
                        <>
                            <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                                ➕ Add Price
                            </Button>
                            <Button onClick={fetchPrices} variant="outline">
                                🔄 Refresh
                            </Button>
                        </>
                    )}
                </Flex>
            </Flex>

            {/* === HEALTH VIEW === */}
            {viewMode === 'health' && (
                <PriceHealthCards />
            )}

            {/* === TABLE VIEW === */}
            {viewMode === 'table' && loading && (
                <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                    <Spinner size="xl" color="blue.500" />
                    <Text mt={4}>Loading prices...</Text>
                </Box>
            )}

            {viewMode === 'table' && error && (
                <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                    <Text color="red.600">Error: {error}</Text>
                </Box>
            )}

            {viewMode === 'table' && !loading && !error && <>
                <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" fontSize="sm">Asset:</Text>
                        <Box width="180px">
                            <AssetSelector
                                value={assetIdFilter}
                                onChange={(id) => { setAssetIdFilter(id); pagination.firstPage(); }}
                                assets={assets}
                                placeholder="All Assets"
                                size="sm"
                            />
                        </Box>
                    </Flex>
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" fontSize="sm">Quote Asset:</Text>
                        <Box width="180px">
                            <AssetSelector
                                value={quoteAssetIdFilter}
                                onChange={(id) => { setQuoteAssetIdFilter(id); pagination.firstPage(); }}
                                assets={assets}
                                placeholder="All Quote Assets"
                                size="sm"
                            />
                        </Box>
                    </Flex>
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" fontSize="sm">Source:</Text>
                        <NativeSelect.Root size="sm" width="150px">
                            <NativeSelect.Field
                                value={sourceFilter}
                                onChange={e => { setSourceFilter(e.target.value); pagination.firstPage(); }}
                            >
                                <option value="">All Sources</option>
                                {availableSources.map(source => (
                                    <option key={source} value={source}>
                                        {source}
                                    </option>
                                ))}
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>
                    <Flex align="center" gap={2}>
                        <Text fontWeight="medium" fontSize="sm">Snapshot Time:</Text>
                        <Input
                            type="datetime-local"
                            size="sm"
                            width="180px"
                            placeholder="From"
                            value={snapshotTimeFrom}
                            onChange={e => { setSnapshotTimeFrom(e.target.value); pagination.firstPage(); }}
                        />
                        <Text fontSize="sm">to</Text>
                        <Input
                            type="datetime-local"
                            size="sm"
                            width="180px"
                            placeholder="To"
                            value={snapshotTimeTo}
                            onChange={e => { setSnapshotTimeTo(e.target.value); pagination.firstPage(); }}
                        />
                    </Flex>
                    {hasActiveFilters && (
                        <Button size="sm" variant="outline" onClick={clearFilters}>
                            Clear Filters
                        </Button>
                    )}
                </Flex>

                <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                    <Table.Root size="sm">
                        <Table.Header>
                            <Table.Row>
                                <Table.ColumnHeader width="40px">
                                    <Checkbox.Root
                                        checked={prices.length > 0 && selectedIds.size === prices.length}
                                        onCheckedChange={toggleSelectAll}
                                    >
                                        <Checkbox.HiddenInput />
                                        <Checkbox.Control />
                                    </Checkbox.Root>
                                </Table.ColumnHeader>
                                <Table.ColumnHeader>Asset</Table.ColumnHeader>
                                <Table.ColumnHeader>Quote Asset</Table.ColumnHeader>
                                <Table.ColumnHeader>Snapshot Time</Table.ColumnHeader>
                                <Table.ColumnHeader>Price</Table.ColumnHeader>
                                <Table.ColumnHeader>Source</Table.ColumnHeader>
                                <Table.ColumnHeader>Actions</Table.ColumnHeader>
                            </Table.Row>
                        </Table.Header>
                        <Table.Body>
                            {prices.length === 0 ? (
                                <Table.Row>
                                    <Table.Cell colSpan={7}>
                                        <Text textAlign="center" py={8} color="gray.500">
                                            No price snapshots found
                                        </Text>
                                    </Table.Cell>
                                </Table.Row>
                            ) : (
                                prices.map((price, index) => {
                                    const key = price.snapshot_id ? getEditKey(price) : `price-${index}`;
                                    return (
                                        <Table.Row key={key} bg={selectedIds.has(price.snapshot_id) ? 'blue.50' : undefined}>
                                            <Table.Cell>
                                                <Checkbox.Root
                                                    checked={selectedIds.has(price.snapshot_id)}
                                                    onCheckedChange={() => toggleSelection(price.snapshot_id)}
                                                >
                                                    <Checkbox.HiddenInput />
                                                    <Checkbox.Control />
                                                </Checkbox.Root>
                                            </Table.Cell>
                                            <Table.Cell>
                                                <AssetBadge
                                                    asset={{
                                                        id: price.asset_id,
                                                        symbol: price.asset_symbol || getAssetSymbol(price.asset_id),
                                                        label: price.asset_label,
                                                    }}
                                                    colorPalette="blue"
                                                    size="xs"
                                                />
                                            </Table.Cell>
                                            <Table.Cell>
                                                <AssetBadge
                                                    asset={price.quote_asset_id ? {
                                                        id: price.quote_asset_id,
                                                        symbol: price.quote_asset_symbol || getAssetSymbol(price.quote_asset_id),
                                                        label: price.quote_asset_label,
                                                    } : null}
                                                    colorPalette="green"
                                                    size="xs"
                                                    fallback="-"
                                                />
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Text fontSize="xs">{formatSnapshotTime(price.snapshot_time)}</Text>
                                            </Table.Cell>
                                            <Table.Cell>
                                                {editingKey === key ? (
                                                    <Input
                                                        size="sm"
                                                        type="number"
                                                        step="any"
                                                        value={editValues.price ?? ''}
                                                        onChange={e => setEditValues({ ...editValues, price: parseFloat(e.target.value) })}
                                                    />
                                                ) : (
                                                    <Text fontWeight="medium" fontSize="xs">{price.price != null ? price.price.toFixed(8) : '-'}</Text>
                                                )}
                                            </Table.Cell>
                                            <Table.Cell>
                                                {editingKey === key ? (
                                                    <Input
                                                        size="sm"
                                                        value={editValues.source || ''}
                                                        onChange={e => setEditValues({ ...editValues, source: e.target.value })}
                                                    />
                                                ) : (
                                                    <Text fontSize="xs">{price.source || '-'}</Text>
                                                )}
                                            </Table.Cell>
                                            <Table.Cell>
                                                <Flex gap={1}>
                                                    {editingKey === key ? (
                                                        <>
                                                            <Button size="xs" colorPalette="blue" onClick={() => savePrice(price)}>
                                                                💾
                                                            </Button>
                                                            <Button size="xs" variant="outline" onClick={() => { setEditingKey(null); setEditValues({}); }}>
                                                                ✗
                                                            </Button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Button size="xs" variant="outline" onClick={() => startEditing(price)}>
                                                                ✏️
                                                            </Button>
                                                            <Button size="xs" colorPalette="red" variant="outline" onClick={() => deletePrice(price)}>
                                                                🗑️
                                                            </Button>
                                                        </>
                                                    )}
                                                </Flex>
                                            </Table.Cell>
                                        </Table.Row>
                                    );
                                })
                            )}
                        </Table.Body>
                    </Table.Root>
                </Box>

                <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                    <Flex justify="space-between" align="center" flexWrap="wrap" gap={4}>
                        {/* Left side: Info */}
                        <Text fontSize="sm" color="gray.600">
                            Showing {totalItems === 0 ? 0 : offset + 1}-{Math.min(offset + pagination.pageSize, totalItems)} of <strong>{totalItems}</strong> records
                            {selectedIds.size > 0 && (
                                <> | <strong>Selected:</strong> {selectedIds.size}</>
                            )}
                        </Text>
                    </Flex>

                    {/* Pagination controls */}
                    <TablePagination
                        pagination={pagination}
                        total={totalItems}
                    />
                </Box>

                {/* Bulk Action Bar */}
                {selectedIds.size > 0 && (
                    <Box
                        position="fixed"
                        bottom={4}
                        left="50%"
                        transform="translateX(-50%)"
                        bg="gray.800"
                        color="white"
                        px={6}
                        py={3}
                        borderRadius="lg"
                        boxShadow="lg"
                        zIndex={10}
                    >
                        <Flex align="center" gap={4}>
                            <Text fontWeight="medium">
                                {selectedIds.size} selected
                            </Text>
                            <Button
                                size="sm"
                                variant="outline"
                                colorPalette="whiteAlpha"
                                onClick={clearSelection}
                            >
                                Clear Selection
                            </Button>
                            <Button
                                size="sm"
                                colorPalette="red"
                                onClick={() => setShowBulkDeleteDialog(true)}
                            >
                                🗑️ Delete Selected
                            </Button>
                        </Flex>
                    </Box>
                )}

                {/* Bulk Delete Confirmation Dialog */}
                <Dialog.Root open={showBulkDeleteDialog} onOpenChange={(e) => setShowBulkDeleteDialog(e.open)}>
                    <Portal>
                        <Dialog.Backdrop />
                        <Dialog.Positioner>
                            <Dialog.Content>
                                <Dialog.Header>
                                    <Dialog.Title>Confirm Bulk Delete</Dialog.Title>
                                </Dialog.Header>
                                <Dialog.Body>
                                    <Text>
                                        Are you sure you want to delete <strong>{selectedIds.size}</strong> price record(s)?
                                        This action cannot be undone.
                                    </Text>
                                </Dialog.Body>
                                <Dialog.Footer>
                                    <Flex gap={2}>
                                        <Button
                                            variant="outline"
                                            onClick={() => setShowBulkDeleteDialog(false)}
                                            disabled={bulkDeleteLoading}
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            colorPalette="red"
                                            onClick={bulkDelete}
                                            disabled={bulkDeleteLoading}
                                        >
                                            {bulkDeleteLoading ? <Spinner size="sm" /> : 'Delete'}
                                        </Button>
                                    </Flex>
                                </Dialog.Footer>
                            </Dialog.Content>
                        </Dialog.Positioner>
                    </Portal>
                </Dialog.Root>

                {/* Create Price Dialog */}
                <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                    <Portal>
                        <Dialog.Backdrop />
                        <Dialog.Positioner>
                            <Dialog.Content>
                                <Dialog.Header>
                                    <Dialog.Title>Add New Price Snapshot</Dialog.Title>
                                </Dialog.Header>
                                <Dialog.Body>
                                    <Flex direction="column" gap={4}>
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Asset *</Text>
                                            <NativeSelect.Root>
                                                <NativeSelect.Field
                                                    value={newPrice.asset_id ?? ''}
                                                    onChange={e => setNewPrice({ ...newPrice, asset_id: parseInt(e.target.value) })}
                                                >
                                                    <option value="">Select asset...</option>
                                                    {assets.map(asset => (
                                                        <option key={asset.asset_id} value={asset.asset_id}>
                                                            {asset.symbol} (ID: {asset.asset_id})
                                                        </option>
                                                    ))}
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                        </Box>
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Quote Asset</Text>
                                            <NativeSelect.Root>
                                                <NativeSelect.Field
                                                    value={newPrice.quote_asset_id ?? ''}
                                                    onChange={e => setNewPrice({ ...newPrice, quote_asset_id: e.target.value ? parseInt(e.target.value) : undefined })}
                                                >
                                                    <option value="">Select quote asset...</option>
                                                    {assets.map(asset => (
                                                        <option key={asset.asset_id} value={asset.asset_id}>
                                                            {asset.symbol} (ID: {asset.asset_id})
                                                        </option>
                                                    ))}
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                        </Box>
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Snapshot Time (ISO format) *</Text>
                                            <Input
                                                placeholder="e.g., 2025-01-15T10:30:00"
                                                value={newPrice.snapshot_time || ''}
                                                onChange={e => setNewPrice({ ...newPrice, snapshot_time: e.target.value })}
                                            />
                                        </Box>
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Price *</Text>
                                            <Input
                                                type="number"
                                                step="any"
                                                placeholder="e.g., 42000.50"
                                                value={newPrice.price ?? ''}
                                                onChange={e => setNewPrice({ ...newPrice, price: parseFloat(e.target.value) })}
                                            />
                                        </Box>
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Source</Text>
                                            <Input
                                                placeholder="e.g., coingecko, manual"
                                                value={newPrice.source || ''}
                                                onChange={e => setNewPrice({ ...newPrice, source: e.target.value })}
                                            />
                                        </Box>
                                    </Flex>
                                </Dialog.Body>
                                <Dialog.Footer>
                                    <Flex gap={2}>
                                        <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewPrice({}); }}>
                                            Cancel
                                        </Button>
                                        <Button colorPalette="blue" onClick={createPrice}>
                                            Create Price Snapshot
                                        </Button>
                                    </Flex>
                                </Dialog.Footer>
                            </Dialog.Content>
                        </Dialog.Positioner>
                    </Portal>
                </Dialog.Root>

            </>}

            {/* Delete Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={deleteConfirm.close}
                onConfirm={executeDelete}
                title="Delete Price Record"
                message="Are you sure you want to delete this price record?"
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};
