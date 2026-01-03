
import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, Asset, PriceSnapshot } from '../types';

export const PricesViewer: React.FC = () => {
    const [prices, setPrices] = useState<PriceSnapshot[]>([]);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<PriceSnapshot>>({});
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newPrice, setNewPrice] = useState<Partial<PriceSnapshot>>({});
    const [assetIdFilter, setAssetIdFilter] = useState<string>('');
    const [quoteAssetIdFilter, setQuoteAssetIdFilter] = useState<string>('');

    useEffect(() => {
        fetchPrices();
        fetchAssets();
    }, [assetIdFilter, quoteAssetIdFilter]);

    const fetchPrices = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (assetIdFilter) params.append('asset_id', assetIdFilter);
            if (quoteAssetIdFilter) params.append('quote_asset_id', quoteAssetIdFilter);
            const response = await fetch(`${API_URL}/price-snapshots?${params}`);
            if (!response.ok) throw new Error('Failed to fetch prices');
            const data = await response.json();
            setPrices(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const fetchAssets = async () => {
        try {
            const response = await fetch(`${API_URL}/assets`);
            if (response.ok) {
                const data = await response.json();
                setAssets(data);
            }
        } catch (err) {
            console.error('Failed to fetch assets:', err);
        }
    };

    const getAssetSymbol = (assetId: number | null | undefined) => {
        if (assetId === null || assetId === undefined) return 'Unknown';
        const asset = assets.find(a => a.asset_id === assetId);
        return asset?.symbol || `ID:${assetId}`;
    };

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
            alert(err instanceof Error ? err.message : 'Failed to save');
        }
    };

    const createPrice = async () => {
        if (!newPrice.asset_id || !newPrice.snapshot_time || newPrice.price === undefined) {
            alert('Asset ID, Snapshot Time, and Price are required');
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
            alert(err instanceof Error ? err.message : 'Failed to create price');
        }
    };

    const deletePrice = async (price: PriceSnapshot) => {
        if (!window.confirm('Are you sure you want to delete this price record?')) return;
        try {
            const response = await fetch(`${API_URL}/price-snapshots/${price.snapshot_id}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete price');
            await fetchPrices();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete price');
        }
    };

    if (loading) return (
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading prices...</Text>
        </Box>
    );

    if (error) return (
        <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
            <Text color="red.600">Error: {error}</Text>
        </Box>
    );

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>💰 Price Snapshots</Heading>
                    <Text color="gray.600" fontSize="sm">
                        View and manage historical cryptocurrency price snapshots.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Price
                    </Button>
                    <Button onClick={fetchPrices} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Asset:</Text>
                    <NativeSelect.Root size="sm" width="150px">
                        <NativeSelect.Field
                            value={assetIdFilter}
                            onChange={e => setAssetIdFilter(e.target.value)}
                        >
                            <option value="">All Assets</option>
                            {assets.map(asset => (
                                <option key={asset.asset_id} value={asset.asset_id}>
                                    {asset.symbol}
                                </option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Quote Asset:</Text>
                    <NativeSelect.Root size="sm" width="150px">
                        <NativeSelect.Field
                            value={quoteAssetIdFilter}
                            onChange={e => setQuoteAssetIdFilter(e.target.value)}
                        >
                            <option value="">All Quote Assets</option>
                            {assets.map(asset => (
                                <option key={asset.asset_id} value={asset.asset_id}>
                                    {asset.symbol}
                                </option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(assetIdFilter || quoteAssetIdFilter) && (
                    <Button size="sm" variant="outline" onClick={() => { setAssetIdFilter(''); setQuoteAssetIdFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </Flex>

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Asset</Table.ColumnHeader>
                            <Table.ColumnHeader>Quote Asset</Table.ColumnHeader>
                            <Table.ColumnHeader>Snapshot Time</Table.ColumnHeader>
                            <Table.ColumnHeader>Price</Table.ColumnHeader>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                            <Table.ColumnHeader>Created</Table.ColumnHeader>
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
                                    <Table.Row key={key}>
                                        <Table.Cell>
                                            <Badge colorPalette="blue">{price.asset_symbol || getAssetSymbol(price.asset_id)}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge colorPalette="green">{price.quote_asset_symbol || getAssetSymbol(price.quote_asset_id)}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontSize="sm">{price.snapshot_time}</Text>
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
                                                <Text fontWeight="medium">{price.price != null ? price.price.toFixed(8) : '-'}</Text>
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
                                                <Text fontSize="sm">{price.source || '-'}</Text>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Text fontSize="sm">{price.created_at || '-'}</Text>
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
                <Text fontSize="sm" color="gray.600">
                    <strong>Total:</strong> {prices.length} price records
                </Text>
            </Box>

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
        </Box>
    );
};
