import {
    Badge,
    Box,
    Button, Dialog, Flex, Input, NativeSelect, Portal, Tabs, Text, VStack
} from '@chakra-ui/react';
import React, { useEffect, useRef, useState } from 'react';
import { API_URL, Asset, DimensionWithCategories } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { toaster } from './ui/toaster';

interface AssetSelectorProps {
    value: number | null;
    onChange: (assetId: number | null) => void;
    assets: Asset[];
    onAssetCreated?: () => void;
    placeholder?: string;
    defaultSymbol?: string; // Pre-fill new asset symbol
    size?: 'sm' | 'md';
    // For linking raw_asset when creating new asset from transaction context
    rawAssetSource?: string;
    rawAssetSymbol?: string;
    // Optional: pass pre-fetched dimension data to avoid refetching
    dimensionData?: DimensionWithCategories[];
}

export const AssetSelector: React.FC<AssetSelectorProps> = ({
    value,
    onChange,
    assets,
    onAssetCreated,
    placeholder = 'Search or select asset...',
    defaultSymbol = '',
    size = 'sm',
    rawAssetSource,
    rawAssetSymbol,
    dimensionData: propsDimensionData,
}) => {
    const [search, setSearch] = useState('');
    const [isOpen, setIsOpen] = useState(false);
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newAsset, setNewAsset] = useState<Partial<Asset>>({
        symbol: defaultSymbol,
        label: '',
        price_type: '',
        tags: [],
        status: 0,
    });
    const [creating, setCreating] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Category management - fetch lazily when create dialog opens
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>(propsDimensionData || []);
    const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number>>(new Set());
    const [isFetchingCategories, setIsFetchingCategories] = useState(false);

    // Get current asset symbol
    const selectedAsset = assets.find(a => a.asset_id === value);

    // Filter assets by search
    const filteredAssets = assets.filter(a =>
        a.symbol.toLowerCase().includes(search.toLowerCase()) ||
        (a.label && a.label.toLowerCase().includes(search.toLowerCase()))
    );

    // Update dimension data when props change
    useEffect(() => {
        if (propsDimensionData && propsDimensionData.length > 0) {
            setDimensionData(propsDimensionData);
        }
    }, [propsDimensionData]);

    // Fetch categories only when create dialog opens (lazy loading)
    const fetchCategoriesIfNeeded = async () => {
        // Skip if already have data (from props or previous fetch)
        if (dimensionData.length > 0 || isFetchingCategories) return;

        setIsFetchingCategories(true);
        try {
            const response = await fetch(`${API_URL}/categories/by-dimension`);
            if (response.ok) {
                const data: DimensionWithCategories[] = await response.json();
                setDimensionData(data);
            }
        } catch (err) {
            console.warn('Failed to fetch categories:', err);
        } finally {
            setIsFetchingCategories(false);
        }
    };

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const linkRawAsset = async (assetId: number) => {
        // If raw asset context is provided, link the raw_asset to the asset
        if (rawAssetSource && rawAssetSymbol && assetId) {
            try {
                // First try to PATCH (update existing raw asset)
                const patchResponse = await fetch(`${API_URL}/raw-assets/${encodeURIComponent(rawAssetSource)}/${encodeURIComponent(rawAssetSymbol)}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId })
                });

                // If raw asset doesn't exist (404), create it
                if (patchResponse.status === 404) {
                    await fetch(`${API_URL}/raw-assets`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            symbol: rawAssetSymbol,
                            source: rawAssetSource,
                            asset_id: assetId
                        })
                    });
                }
            } catch (linkErr) {
                console.warn('Failed to link raw asset:', linkErr);
                // Don't fail the whole operation if linking fails
            }
        }
    };

    const handleSelect = async (assetId: number | null) => {
        onChange(assetId);
        setIsOpen(false);
        setSearch('');

        // Link raw_asset when selecting an existing asset
        if (assetId) {
            await linkRawAsset(assetId);
        }
    };

    const createAsset = async () => {
        if (!newAsset.symbol?.trim()) {
            toaster.error({ title: 'Symbol is required' });
            return;
        }
        setCreating(true);
        try {
            const response = await fetch(`${API_URL}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: newAsset.symbol.toUpperCase(),
                    label: newAsset.label || null,
                    price_type: newAsset.price_type || null,
                    tags: newAsset.tags || null,
                    status: newAsset.status ?? 0,
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create asset');
            }
            const created = await response.json();

            // Link the raw_asset to the new asset
            if (created.asset_id) {
                await linkRawAsset(created.asset_id);

                // Assign categories if any selected
                if (selectedCategoryIds.size > 0) {
                    try {
                        await fetch(`${API_URL}/categories/asset/${created.asset_id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ category_ids: Array.from(selectedCategoryIds) })
                        });
                    } catch (catErr) {
                        console.warn('Failed to assign categories:', catErr);
                        // Don't fail the whole operation
                    }
                }
            }

            setShowCreateDialog(false);
            resetNewAsset();
            // Select the newly created asset first
            onChange(created.asset_id);
            // Then refresh the assets list
            if (onAssetCreated) onAssetCreated();
        } catch (err) {
            toaster.error({ title: err instanceof Error ? err.message : 'Failed to create asset' });
        } finally {
            setCreating(false);
        }
    };

    const resetNewAsset = () => {
        setNewAsset({
            symbol: '',
            label: '',
            price_type: '',
            tags: [],
            status: 0,
        });
        setSelectedCategoryIds(new Set());
    };

    const openCreateDialog = () => {
        const symbolValue = search || rawAssetSymbol || defaultSymbol;
        setNewAsset(prev => ({
            ...prev,
            symbol: symbolValue,
            label: symbolValue, // Pre-fill label with the same value
        }));
        // Fetch categories lazily when dialog opens
        fetchCategoriesIfNeeded();
        setShowCreateDialog(true);
        setIsOpen(false);
    };

    return (
        <Box position="relative" ref={containerRef}>
            <Input
                size={size}
                value={isOpen ? search : (selectedAsset ? selectedAsset.symbol : '')}
                onChange={e => {
                    setSearch(e.target.value);
                    if (!isOpen) setIsOpen(true);
                }}
                onFocus={() => setIsOpen(true)}
                placeholder={placeholder}
                bg="white"
            />

            {isOpen && (
                <Box
                    position="absolute"
                    top="100%"
                    left={0}
                    right={0}
                    zIndex={1000}
                    bg="white"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="md"
                    boxShadow="lg"
                    maxH="250px"
                    overflowY="auto"
                    mt={1}
                >
                    {/* Clear selection option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'gray.100' }}
                        onClick={() => handleSelect(null)}
                        color="gray.500"
                        fontSize="sm"
                    >
                        -- Not linked --
                    </Box>

                    {/* Filtered assets */}
                    {filteredAssets.map(asset => (
                        <Box
                            key={asset.asset_id}
                            p={2}
                            cursor="pointer"
                            bg={value === asset.asset_id ? 'blue.50' : undefined}
                            _hover={{ bg: 'blue.100' }}
                            onClick={() => handleSelect(asset.asset_id!)}
                            fontSize="sm"
                        >
                            <Text fontWeight="medium">{asset.symbol}</Text>
                            {asset.label && <Text fontSize="xs" color="gray.500">{asset.label}</Text>}
                        </Box>
                    ))}

                    {/* No results / Create new */}
                    {filteredAssets.length === 0 && (
                        <Box p={2} color="gray.500" fontSize="sm">
                            No assets found
                        </Box>
                    )}

                    {/* Create new asset option */}
                    <Box
                        p={2}
                        cursor="pointer"
                        _hover={{ bg: 'green.50' }}
                        onClick={openCreateDialog}
                        color="green.600"
                        fontSize="sm"
                        borderTop="1px solid"
                        borderColor="gray.100"
                    >
                        ➕ Create new asset {search && `"${search.toUpperCase()}"`}
                    </Box>
                </Box>
            )}

            {/* Create Asset Dialog */}
            <Dialog.Root open={showCreateDialog} onOpenChange={(e) => setShowCreateDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Create New Asset</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Symbol *</Text>
                                        <Input
                                            placeholder="e.g., BTC, ETH, USDT"
                                            value={newAsset.symbol || ''}
                                            onChange={e => setNewAsset({ ...newAsset, symbol: e.target.value.toUpperCase() })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Label</Text>
                                        <Input
                                            placeholder="e.g., Bitcoin, Ethereum"
                                            value={newAsset.label || ''}
                                            onChange={e => setNewAsset({ ...newAsset, label: e.target.value })}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Type</Text>
                                        <ComboSelect
                                            value={newAsset.price_type || ''}
                                            onChange={val => setNewAsset({ ...newAsset, price_type: val })}
                                            options={ASSET_TYPE_OPTIONS}
                                            placeholder="Select or type..."
                                            width="100%"
                                            size="md"
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>Tags</Text>
                                        <Input
                                            placeholder="e.g., defi, layer1, stablecoin (comma-separated)"
                                            value={(newAsset.tags || []).map(t => Object.keys(t)[0]).filter(Boolean).join(', ')}
                                            onChange={e => {
                                                const tagStrings = e.target.value.split(',').map(t => t.trim()).filter(t => t);
                                                const tags = tagStrings.map(tag => ({ [tag]: true }));
                                                setNewAsset({ ...newAsset, tags });
                                            }}
                                        />
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

                                    {/* Category Selection */}
                                    {dimensionData.length > 0 && (
                                        <Box>
                                            <Text fontWeight="medium" mb={1}>Categories</Text>
                                            <Box borderWidth={1} borderColor="gray.200" borderRadius="md" p={2} maxH="300px" overflowY="auto">
                                                <Tabs.Root defaultValue={dimensionData[0]?.label} size="sm">
                                                    <Tabs.List>
                                                        {dimensionData.map(dim => (
                                                            <Tabs.Trigger key={dim.id} value={dim.label}>
                                                                {dim.label}
                                                            </Tabs.Trigger>
                                                        ))}
                                                    </Tabs.List>
                                                    {dimensionData.map(dim => (
                                                        <Tabs.Content key={dim.id} value={dim.label}>
                                                            <VStack align="stretch" gap={1} mt={2}>
                                                                {dim.categories.map(cat => (
                                                                    <Flex
                                                                        key={cat.id}
                                                                        align="center"
                                                                        gap={2}
                                                                        p={1}
                                                                        borderRadius="sm"
                                                                        cursor="pointer"
                                                                        _hover={{ bg: 'gray.50' }}
                                                                        onClick={() => {
                                                                            setSelectedCategoryIds(prev => {
                                                                                const next = new Set(prev);
                                                                                if (next.has(cat.id)) {
                                                                                    next.delete(cat.id);
                                                                                } else {
                                                                                    next.add(cat.id);
                                                                                }
                                                                                return next;
                                                                            });
                                                                        }}
                                                                    >
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={selectedCategoryIds.has(cat.id)}
                                                                            onChange={() => { }}
                                                                            style={{ cursor: 'pointer' }}
                                                                        />
                                                                        <Badge
                                                                            colorPalette={cat.color || 'gray'}
                                                                            size="sm"
                                                                            variant="subtle"
                                                                        >
                                                                            {cat.label}
                                                                        </Badge>
                                                                    </Flex>
                                                                ))}
                                                            </VStack>
                                                        </Tabs.Content>
                                                    ))}
                                                </Tabs.Root>
                                                {selectedCategoryIds.size > 0 && (
                                                    <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                        <Text fontSize="xs" color="gray.500" mb={1}>
                                                            Selected ({selectedCategoryIds.size}):
                                                        </Text>
                                                        <Flex gap={1} flexWrap="wrap">
                                                            {Array.from(selectedCategoryIds).map(catId => {
                                                                const cat = dimensionData
                                                                    .flatMap(d => d.categories)
                                                                    .find(c => c.id === catId);
                                                                if (!cat) return null;
                                                                return (
                                                                    <Badge
                                                                        key={catId}
                                                                        colorPalette={cat.color || 'gray'}
                                                                        size="xs"
                                                                        variant="solid"
                                                                    >
                                                                        {cat.label}
                                                                    </Badge>
                                                                );
                                                            })}
                                                        </Flex>
                                                    </Box>
                                                )}
                                            </Box>
                                        </Box>
                                    )}
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowCreateDialog(false); resetNewAsset(); }}>
                                        Cancel
                                    </Button>
                                    <Button
                                        colorPalette="green"
                                        onClick={createAsset}
                                        loading={creating}
                                        disabled={!newAsset.symbol?.trim()}
                                    >
                                        Create & Select
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
