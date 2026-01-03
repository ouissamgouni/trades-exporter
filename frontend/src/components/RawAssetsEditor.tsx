import {
    Badge, Box,
    Button, Dialog, Flex,
    Heading, Input, NativeSelect, Portal, Spinner,
    Table, Text
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { API_URL, Asset, RawAsset } from '../types';
import { AssetSelector } from './AssetSelector';

export const RawAssetsEditor: React.FC = () => {
    const [rawAssets, setRawAssets] = useState<RawAsset[]>([]);
    const [assets, setAssets] = useState<Asset[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingKey, setEditingKey] = useState<string | null>(null);
    const [editAssetId, setEditAssetId] = useState<number | null>(null);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newRawAsset, setNewRawAsset] = useState<Partial<RawAsset>>({});
    const [sourceFilter, setSourceFilter] = useState('');
    const [linkedFilter, setLinkedFilter] = useState<string>('');

    useEffect(() => {
        fetchRawAssets();
        fetchAssets();
    }, [sourceFilter, linkedFilter]);

    const fetchRawAssets = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (sourceFilter) params.append('source', sourceFilter);
            if (linkedFilter === 'linked') params.append('has_asset_id', 'true');
            if (linkedFilter === 'unlinked') params.append('has_asset_id', 'false');
            const response = await fetch(`${API_URL}/raw-assets?${params}`);
            if (!response.ok) throw new Error('Failed to fetch raw assets');
            const data = await response.json();
            setRawAssets(data);
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
        if (assetId === null || assetId === undefined) return null;
        const asset = assets.find(a => a.asset_id === assetId);
        return asset?.symbol || `ID:${assetId}`;
    };

    const getEditKey = (rawAsset: RawAsset) => `${rawAsset.source}:${rawAsset.symbol}`;

    const startEditing = (rawAsset: RawAsset) => {
        setEditingKey(getEditKey(rawAsset));
        setEditAssetId(rawAsset.asset_id ?? null);
    };

    const saveRawAsset = async (rawAsset: RawAsset) => {
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: editAssetId })
            });
            if (!response.ok) throw new Error('Failed to update raw asset');
            await fetchRawAssets();
            setEditingKey(null);
            setEditAssetId(null);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to save');
        }
    };

    const createRawAsset = async () => {
        if (!newRawAsset.symbol || !newRawAsset.source) {
            alert('Symbol and Source are required');
            return;
        }
        try {
            const response = await fetch(`${API_URL}/raw-assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newRawAsset)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create raw asset');
            }
            await fetchRawAssets();
            setNewRawAsset({});
            setShowCreateDialog(false);
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to create');
        }
    };

    const deleteRawAsset = async (rawAsset: RawAsset) => {
        if (!window.confirm(`Delete raw asset ${rawAsset.symbol} from ${rawAsset.source}?`)) return;
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete raw asset');
            await fetchRawAssets();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to delete');
        }
    };

    const unlinkRawAsset = async (rawAsset: RawAsset) => {
        try {
            const response = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAsset.source)}/${encodeURIComponent(rawAsset.symbol)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: null })
            });
            if (!response.ok) throw new Error('Failed to unlink raw asset');
            await fetchRawAssets();
        } catch (err) {
            alert(err instanceof Error ? err.message : 'Failed to unlink');
        }
    };

    // Get unique sources for filter
    const uniqueSources = [...new Set(rawAssets.map(ra => ra.source))];

    if (loading) return (
        <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
            <Spinner size="xl" color="blue.500" />
            <Text mt={4}>Loading raw assets...</Text>
        </Box>
    );

    if (error) return (
        <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
            <Text color="red.600">Error: {error}</Text>
        </Box>
    );

    const linkedCount = rawAssets.filter(ra => ra.asset_id !== null).length;
    const unlinkedCount = rawAssets.filter(ra => ra.asset_id === null).length;

    return (
        <Box>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>🔗 Raw Assets Mapping</Heading>
                    <Text color="gray.600" fontSize="sm">
                        Link source-specific asset symbols to normalized assets.
                    </Text>
                </Box>
                <Flex gap={2}>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Mapping
                    </Button>
                    <Button onClick={fetchRawAssets} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            <Flex gap={4} mb={6} align="center" flexWrap="wrap">
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Source:</Text>
                    <NativeSelect.Root size="sm" width="150px">
                        <NativeSelect.Field
                            value={sourceFilter}
                            onChange={e => setSourceFilter(e.target.value)}
                        >
                            <option value="">All Sources</option>
                            {uniqueSources.map(source => (
                                <option key={source} value={source}>{source}</option>
                            ))}
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                <Flex align="center" gap={2}>
                    <Text fontWeight="medium" fontSize="sm">Status:</Text>
                    <NativeSelect.Root size="sm" width="120px">
                        <NativeSelect.Field
                            value={linkedFilter}
                            onChange={e => setLinkedFilter(e.target.value)}
                        >
                            <option value="">All</option>
                            <option value="linked">Linked</option>
                            <option value="unlinked">Unlinked</option>
                        </NativeSelect.Field>
                    </NativeSelect.Root>
                </Flex>
                {(sourceFilter || linkedFilter) && (
                    <Button size="sm" variant="outline" onClick={() => { setSourceFilter(''); setLinkedFilter(''); }}>
                        Clear Filters
                    </Button>
                )}
            </Flex>

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader>Source Symbol</Table.ColumnHeader>
                            <Table.ColumnHeader>Source</Table.ColumnHeader>
                            <Table.ColumnHeader>Linked Asset</Table.ColumnHeader>
                            <Table.ColumnHeader>Status</Table.ColumnHeader>
                            <Table.ColumnHeader>Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {rawAssets.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={5}>
                                    <Text textAlign="center" py={8} color="gray.500">
                                        No raw assets found
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            rawAssets.map(rawAsset => {
                                const key = getEditKey(rawAsset);
                                const isEditing = editingKey === key;
                                return (
                                    <Table.Row key={key} bg={rawAsset.asset_id === null ? 'orange.50' : undefined}>
                                        <Table.Cell maxW="200px">
                                            <Text fontWeight="medium" fontSize="sm" truncate title={rawAsset.symbol}>{rawAsset.symbol}</Text>
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Badge colorPalette="purple">{rawAsset.source}</Badge>
                                        </Table.Cell>
                                        <Table.Cell>
                                            {isEditing ? (
                                                <Box width="180px">
                                                    <AssetSelector
                                                        value={editAssetId}
                                                        onChange={setEditAssetId}
                                                        assets={assets}
                                                        onAssetCreated={fetchAssets}
                                                        defaultSymbol={rawAsset.symbol}
                                                        placeholder="Search assets..."
                                                    />
                                                </Box>
                                            ) : (
                                                rawAsset.asset_id ? (
                                                    <Badge colorPalette="blue">{getAssetSymbol(rawAsset.asset_id)}</Badge>
                                                ) : (
                                                    <Text fontSize="sm" color="gray.400">Not linked</Text>
                                                )
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            {rawAsset.asset_id !== null ? (
                                                <Badge colorPalette="green">Linked</Badge>
                                            ) : (
                                                <Badge colorPalette="orange">Unlinked</Badge>
                                            )}
                                        </Table.Cell>
                                        <Table.Cell>
                                            <Flex gap={1}>
                                                {isEditing ? (
                                                    <>
                                                        <Button size="xs" colorPalette="blue" onClick={() => saveRawAsset(rawAsset)}>
                                                            💾
                                                        </Button>
                                                        <Button size="xs" variant="outline" onClick={() => { setEditingKey(null); setEditAssetId(null); }}>
                                                            ✗
                                                        </Button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Button size="xs" variant="outline" onClick={() => startEditing(rawAsset)}>
                                                            🔗
                                                        </Button>
                                                        {rawAsset.asset_id !== null && (
                                                            <Button size="xs" colorPalette="orange" variant="outline" onClick={() => unlinkRawAsset(rawAsset)}>
                                                                ⛓️‍💥
                                                            </Button>
                                                        )}
                                                        <Button size="xs" colorPalette="red" variant="outline" onClick={() => deleteRawAsset(rawAsset)}>
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
                    <strong>Total:</strong> {rawAssets.length} raw assets
                    {' • '}<Badge colorPalette="green" size="sm">{linkedCount} linked</Badge>
                    {' • '}<Badge colorPalette="orange" size="sm">{unlinkedCount} unlinked</Badge>
                </Text>
            </Box>

            {/* Create Raw Asset Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Add Raw Asset Mapping</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source Symbol *</Text>
                                        <Input
                                            placeholder="e.g., BTCUSDT"
                                            value={newRawAsset.symbol || ''}
                                            onChange={e => setNewRawAsset({ ...newRawAsset, symbol: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Source *</Text>
                                        <Input
                                            placeholder="e.g., binance, coinbase"
                                            value={newRawAsset.source || ''}
                                            onChange={e => setNewRawAsset({ ...newRawAsset, source: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Link to Asset (optional)</Text>
                                        <AssetSelector
                                            value={newRawAsset.asset_id ?? null}
                                            onChange={(assetId) => setNewRawAsset({ ...newRawAsset, asset_id: assetId ?? undefined })}
                                            assets={assets}
                                            onAssetCreated={fetchAssets}
                                            defaultSymbol={newRawAsset.symbol || ''}
                                            placeholder="Search or create asset..."
                                        />
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); setNewRawAsset({}); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="blue" onClick={createRawAsset}>
                                        Create Mapping
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
