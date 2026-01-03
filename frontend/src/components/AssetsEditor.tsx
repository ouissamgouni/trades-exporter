import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, IconButton, Input, NativeSelect, Portal, Spinner,
    Table, Tag, Text
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, Asset, AssetPriceGetter, Category, DimensionCategories } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';

// Use ASSET_TYPE_OPTIONS but it now only has 3 values: crypto, stock, fiat
const PRICE_TYPE_OPTIONS = ASSET_TYPE_OPTIONS;

interface PriceGetterFormData {
    price_getter: string;
    priority: number;
    enabled: boolean;
    params: { asset_id?: string };
}

export const AssetsEditor: React.FC = () => {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Partial<Asset>>({});
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newAsset, setNewAsset] = useState<Partial<Asset>>({ status: 0 });
    const [symbolFilter, setSymbolFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState<string>('');

    // Price getter management
    const [availableGetters, setAvailableGetters] = useState<string[]>([]);
    const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
    const [showGettersDialog, setShowGettersDialog] = useState(false);
    const [newGetter, setNewGetter] = useState<PriceGetterFormData>({
        price_getter: '',
        priority: 100,
        enabled: true,
        params: {}
    });

    useEffect(() => {
        fetchAssets();
        fetchAvailableGetters();
    }, [symbolFilter, statusFilter]);

    const fetchAvailableGetters = async () => {
        try {
            const response = await fetch(`${API_URL}/assets/price-getters/available`);
            if (response.ok) {
                const data = await response.json();
                setAvailableGetters(data);
            }
        } catch (err) {
            console.error('Failed to fetch available getters:', err);
        }
    };

    const fetchAssets = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.append('include_getters', 'true');
            if (symbolFilter) params.append('symbol', symbolFilter);
            if (statusFilter !== '') params.append('status', statusFilter);
            const response = await fetch(`${API_URL}/assets?${params}`);
            if (!response.ok) throw new Error('Failed to fetch assets');
            const data = await response.json();
            setAssets(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const startEditing = (asset: Asset) => {
        setEditingId(asset.asset_id!);
        setEditValues({
            symbol: asset.symbol,
            label: asset.label || '',
            price_type: asset.price_type || '',
            tags: asset.tags || [],
            status: asset.status ?? 0,
        });
    };

    const saveAsset = async (id: number) => {
        try {
            const response = await fetch(`${API_URL}/assets/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(editValues)
            });
            if (!response.ok) throw new Error('Failed to update asset');
            await fetchAssets();
            setEditingId(null);
            setEditValues({});
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to save');
        }
    };

    const createAsset = async () => {
        if (!newAsset.symbol?.trim()) {
            alert('Symbol is required');
            return;
        }
        try {
            const response = await fetch(`${API_URL}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newAsset)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create asset');
            }
            await fetchAssets();
            setNewAsset({ status: 0 });
            setShowCreateDialog(false);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to create asset');
        }
    };

    const deleteAsset = async (id: number) => {
        if (!window.confirm('Are you sure you want to delete this asset?')) return;
        try {
            const response = await fetch(`${API_URL}/assets/${id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete asset');
            await fetchAssets();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete asset');
        }
    };

    // Price getter CRUD
    const openGettersDialog = (asset: Asset) => {
        setSelectedAsset(asset);
        setShowGettersDialog(true);
        setNewGetter({ price_getter: availableGetters[0] || '', priority: 100, enabled: true, params: {} });
    };

    const addPriceGetter = async () => {
        if (!selectedAsset || !newGetter.price_getter) return;
        try {
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newGetter)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to add price getter');
            }
            await fetchAssets();
            // Refresh selected asset
            const updatedAsset = assets.find(a => a.asset_id === selectedAsset.asset_id);
            if (updatedAsset) setSelectedAsset(updatedAsset);
            setNewGetter({ price_getter: availableGetters[0] || '', priority: 100, enabled: true, params: {} });
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to add price getter');
        }
    };

    const deletePriceGetter = async (getterId: number) => {
        if (!selectedAsset) return;
        if (!window.confirm('Delete this price getter?')) return;
        try {
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/${getterId}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete price getter');
            await fetchAssets();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete');
        }
    };

    const togglePriceGetter = async (getter: AssetPriceGetter) => {
        if (!selectedAsset) return;
        try {
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/${getter.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !getter.enabled })
            });
            if (!response.ok) throw new Error('Failed to update price getter');
            await fetchAssets();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to update');
        }
    };

    // Refresh selected asset when assets change
    useEffect(() => {
        if (selectedAsset) {
            const updated = assets.find(a => a.asset_id === selectedAsset.asset_id);
            if (updated) setSelectedAsset(updated);
        }
    }, [assets]);

    const renderPriceGetters = (asset: Asset) => {
        if (!asset.price_getters || asset.price_getters.length === 0) {
            return <Text color="gray.400" fontSize="xs">None (uses default)</Text>;
        }
        return (
            <Flex gap={1} flexWrap="wrap">
                {asset.price_getters.map(pg => (
                    <Badge
                        key={pg.id}
                        colorPalette={pg.enabled ? 'blue' : 'gray'}
                        fontSize="xs"
                        title={`${pg.price_getter}: ${pg.params?.asset_id || 'auto'} (priority: ${pg.priority})`}
                    >
                        {pg.price_getter}
                        {pg.params?.asset_id && `: ${pg.params.asset_id}`}
                    </Badge>
                ))}
            </Flex>
        );
    };

    if (loading) return (
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading assets...</Text>
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
                    <Heading as="h2" size="md" mb={1}>💎 Assets</Heading>
                    <Text color="gray.600" fontSize="sm">
                        Manage assets and their price getter configurations.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Asset
                    </Button>
                    <Button onClick={fetchAssets} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Symbol:</Text>
                    <Input
                        size="sm"
                        width="150px"
                        placeholder="Search..."
                        value={symbolFilter}
                        onChange={e => setSymbolFilter(e.target.value)}
                    />
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Status:</Text>
                    <NativeSelect.Root size="sm" width="auto">
                        <NativeSelect.Field
                            value={statusFilter}
                            onChange={e => setStatusFilter(e.target.value)}
                        >
                            <option value="">All</option>
                            <option value="0">Active</option>
                            <option value="1">Inactive</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(symbolFilter || statusFilter !== '') && (
                    <Button size="sm" variant="outline" onClick={() => { setSymbolFilter(''); setStatusFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </Flex>

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>ID</Table.ColumnHeader>
                            <Table.ColumnHeader>Symbol</Table.ColumnHeader>
                            <Table.ColumnHeader>Label</Table.ColumnHeader>
                            <Table.ColumnHeader>Type</Table.ColumnHeader>
                            <Table.ColumnHeader>Price Getters</Table.ColumnHeader>
                            <Table.ColumnHeader>Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {assets.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={7}>
                                    <Text textAlign="center" py={8} color="gray.500">
                                        No assets found
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            assets.map(asset => (
                                <Table.Row key={asset.asset_id}>
                                    <Table.Cell>{asset.asset_id}</Table.Cell>
                                    <Table.Cell>
                                        {editingId === asset.asset_id ? (
                                            <Input
                                                size="sm"
                                                value={editValues.symbol || ''}
                                                onChange={e => setEditValues({ ...editValues, symbol: e.target.value })}
                                            />
                                        ) : (
                                            <Badge colorPalette="blue">{asset.symbol}</Badge>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {editingId === asset.asset_id ? (
                                            <Input
                                                size="sm"
                                                value={editValues.label || ''}
                                                onChange={e => setEditValues({ ...editValues, label: e.target.value })}
                                            />
                                        ) : (
                                            <Text>{asset.label || '-'}</Text>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        {editingId === asset.asset_id ? (
                                            <ComboSelect
                                                value={editValues.price_type || ''}
                                                onChange={val => setEditValues({ ...editValues, price_type: val })}
                                                options={PRICE_TYPE_OPTIONS}
                                                placeholder="Type..."
                                                width="100px"
                                            />
                                        ) : (
                                            <Tag.Root size="sm" colorPalette={
                                                asset.price_type === 'crypto' ? 'orange' :
                                                    asset.price_type === 'stock' ? 'blue' :
                                                        asset.price_type === 'fiat' ? 'green' : 'gray'
                                            }>
                                                <Tag.Label>{asset.price_type || '-'}</Tag.Label>
                                            </Tag.Root>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex align="center" gap={2}>
                                            {renderPriceGetters(asset)}
                                            <Button size="xs" variant="ghost" onClick={() => openGettersDialog(asset)}>
                                                ⚙️
                                            </Button>
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        {editingId === asset.asset_id ? (
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field
                                                    value={String(editValues.status ?? 0)}
                                                    onChange={e => setEditValues({ ...editValues, status: parseInt(e.target.value) })}
                                                >
                                                    <option value="0">Active</option>
                                                    <option value="1">Inactive</option>
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
                                        ) : (
                                            <Badge colorPalette={asset.status === 0 ? 'green' : 'gray'}>
                                                {asset.status === 0 ? 'Active' : 'Inactive'}
                                            </Badge>
                                        )}
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex gap={1}>
                                            {editingId === asset.asset_id ? (
                                                <>
                                                    <Button size="xs" colorPalette="blue" onClick={() => saveAsset(asset.asset_id!)}>
                                                        💾
                                                    </Button>
                                                    <Button size="xs" variant="outline" onClick={() => { setEditingId(null); setEditValues({}); }}>
                                                        ✗
                                                    </Button>
                                                </>
                                            ) : (
                                                <>
                                                    <Button size="xs" variant="outline" onClick={() => startEditing(asset)}>
                                                        ✏️
                                                    </Button>
                                                    <Button size="xs" colorPalette="red" variant="outline" onClick={() => deleteAsset(asset.asset_id!)}>
                                                        🗑️
                                                    </Button>
                                                </>
                                            )}
                                        </Flex>
                                    </Table.Cell>
                                </Table.Row>
                            ))
                        )}
                    </Table.Body>
                </Table.Root>
            </Box>

            <Box mt={4} p={4} bg="white" borderRadius="md" boxShadow="sm">
                <Text fontSize="sm" color="gray.600">
                    <strong>Total:</strong> {assets.length} assets
                </Text>
            </Box>

            {/* Create Asset Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Add New Asset</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Symbol *</Text>
                                        <Input
                                            placeholder="e.g., BTC, ETH"
                                            value={newAsset.symbol || ''}
                                            onChange={e => setNewAsset({ ...newAsset, symbol: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Label</Text>
                                        <Input
                                            placeholder="e.g., Bitcoin"
                                            value={newAsset.label || ''}
                                            onChange={e => setNewAsset({ ...newAsset, label: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Price Type</Text>
                                        <ComboSelect
                                            value={newAsset.price_type || ''}
                                            onChange={val => setNewAsset({ ...newAsset, price_type: val })}
                                            options={PRICE_TYPE_OPTIONS}
                                            placeholder="Select type..."
                                            width="100%"
                                            size="md"
                                        />
                                        <Text fontSize="xs" color="gray.500" mt={1}>
                                            Determines which price getter to use (crypto=CoinGecko, stock=DataReader, fiat=Forex)
                                        </Text>
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Status</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={String(newAsset.status ?? 0)}
                                                onChange={e => setNewAsset({ ...newAsset, status: parseInt(e.target.value) })}
                                            >
                                                <option value="0">Active</option>
                                                <option value="1">Inactive</option>
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewAsset({ status: 0 }); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="blue" onClick={createAsset}>
                                        Create Asset
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Price Getters Dialog */}
            <Dialog.Root open={showGettersDialog} onOpenChange={(e) => setShowGettersDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="600px">
                            <Dialog.Header>
                                <Dialog.Title>
                                    Price Getters for {selectedAsset?.symbol}
                                </Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Configure price sources for this asset. Lower priority numbers are tried first.
                                    If no getters are configured, the default (Yahoo) will be used.
                                </Text>

                                {/* Current getters */}
                                {selectedAsset?.price_getters && selectedAsset.price_getters.length > 0 && (
                                    <Box mb={6}>
                                        <Text fontWeight="medium" mb={2}>Current Price Getters:</Text>
                                        <Table.Root size="sm">
                                            <Table.Header>
                                                <Table.Row>
                                                    <Table.ColumnHeader>Source</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Asset ID</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Priority</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Actions</Table.ColumnHeader>
                                                </Table.Row>
                                            </Table.Header>
                                            <Table.Body>
                                                {selectedAsset.price_getters.map(pg => (
                                                    <Table.Row key={pg.id}>
                                                        <Table.Cell>
                                                            <Badge colorPalette="purple">{pg.price_getter}</Badge>
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            <Text fontSize="sm">{pg.params?.asset_id || '(auto)'}</Text>
                                                        </Table.Cell>
                                                        <Table.Cell>{pg.priority}</Table.Cell>
                                                        <Table.Cell>
                                                            <Badge
                                                                colorPalette={pg.enabled ? 'green' : 'gray'}
                                                                cursor="pointer"
                                                                onClick={() => togglePriceGetter(pg)}
                                                            >
                                                                {pg.enabled ? 'Yes' : 'No'}
                                                            </Badge>
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            <Button
                                                                size="xs"
                                                                colorPalette="red"
                                                                variant="ghost"
                                                                onClick={() => deletePriceGetter(pg.id)}
                                                            >
                                                                🗑️
                                                            </Button>
                                                        </Table.Cell>
                                                    </Table.Row>
                                                ))}
                                            </Table.Body>
                                        </Table.Root>
                                    </Box>
                                )}

                                {/* Add new getter */}
                                <Box borderTop="1px" borderColor="gray.200" pt={4}>
                                    <Text fontWeight="medium" mb={3}>Add Price Getter:</Text>
                                    <Flex direction="column" gap={3}>
                                        <Flex gap={3}>
                                            <Box flex={1}>
                                                <Text fontSize="sm" mb={1}>Source</Text>
                                                <NativeSelect.Root size="sm">
                                                    <NativeSelect.Field
                                                        value={newGetter.price_getter}
                                                        onChange={e => setNewGetter({ ...newGetter, price_getter: e.target.value })}
                                                    >
                                                        {availableGetters.map(g => (
                                                            <option key={g} value={g}>{g}</option>
                                                        ))}
                                                    </NativeSelect.Field>
                                                </NativeSelect.Root>
                                            </Box>
                                            <Box flex={1}>
                                                <Text fontSize="sm" mb={1}>Priority</Text>
                                                <Input
                                                    size="sm"
                                                    type="number"
                                                    value={newGetter.priority}
                                                    onChange={e => setNewGetter({ ...newGetter, priority: parseInt(e.target.value) || 100 })}
                                                />
                                            </Box>
                                        </Flex>
                                        <Box>
                                            <Text fontSize="sm" mb={1}>
                                                Asset ID
                                                <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                                                    (e.g., "BTC-USD" for Yahoo, "bitcoin" for CoinGecko)
                                                </Text>
                                            </Text>
                                            <Input
                                                size="sm"
                                                placeholder="Leave empty to use symbol"
                                                value={newGetter.params.asset_id || ''}
                                                onChange={e => setNewGetter({
                                                    ...newGetter,
                                                    params: { ...newGetter.params, asset_id: e.target.value || undefined }
                                                })}
                                            />
                                        </Box>
                                        <Button colorPalette="blue" size="sm" onClick={addPriceGetter}>
                                            ➕ Add Price Getter
                                        </Button>
                                    </Flex>
                                </Box>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Button variant="outline" onClick={() => setShowGettersDialog(false)}>
                                    Close
                                </Button>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>
        </Box>
    );
};
