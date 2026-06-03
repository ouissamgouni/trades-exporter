/**
 * AssetFormDialog — Canonical dialog for creating a new asset.
 *
 * Used everywhere in the app: AssetSelector dropdowns, AssetsEditor settings
 * page, TransactionSidePanel quick-create, etc.
 *
 * On successful creation the dialog calls `onClose(createdAssetId)`.
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Dialog,
    Flex,
    Input,
    NativeSelect,
    Portal,
    Tabs,
    Text,
    VStack,
} from '@chakra-ui/react';
import { API_URL, DimensionWithCategories } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { toaster } from './ui/toaster';
import { useAssets } from '../hooks/useAssets';

export interface AssetPrefill {
    symbol?: string;
    label?: string;
    price_type?: string;
}

interface AssetFormDialogProps {
    isOpen: boolean;
    onClose: (createdAssetId?: number) => void;
    prefill?: AssetPrefill;
    /** If provided, link the raw_asset to the newly created asset. */
    rawAssetSource?: string;
    rawAssetSymbol?: string;
}

const AssetFormDialog: React.FC<AssetFormDialogProps> = ({
    isOpen,
    onClose,
    prefill,
    rawAssetSource,
    rawAssetSymbol,
}) => {
    const { assets: allAssets, refetchAssets } = useAssets();
    const [formData, setFormData] = useState({
        symbol: prefill?.symbol || '',
        label: prefill?.label || '',
        isin: '',
        price_type: prefill?.price_type || '',
        tags: [] as Record<string, any>[],
        status: 0,
        denomination_currency_id: null as number | null,
    });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Category selection
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>([]);
    const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number>>(new Set());
    const [isFetchingCategories, setIsFetchingCategories] = useState(false);

    const fiatAssets = React.useMemo(
        () => allAssets.filter(a => a.price_type === 'fiat' && a.asset_id),
        [allAssets]
    );

    // Fetch categories lazily when dialog opens
    const fetchCategoriesIfNeeded = async () => {
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

    // Reset form when dialog opens with new prefill
    React.useEffect(() => {
        if (isOpen) {
            setFormData({
                symbol: prefill?.symbol?.toUpperCase() || '',
                label: prefill?.label || prefill?.symbol || '',
                isin: '',
                price_type: prefill?.price_type || '',
                tags: [],
                status: 0,
                denomination_currency_id: null,
            });
            setSelectedCategoryIds(new Set());
            setError('');
            fetchCategoriesIfNeeded();
        }
    }, [isOpen, prefill?.symbol, prefill?.label, prefill?.price_type]);

    const linkRawAsset = async (assetId: number) => {
        if (!rawAssetSource || !rawAssetSymbol || !assetId) return;
        try {
            const patchResponse = await fetch(
                `${API_URL}/raw-assets/${encodeURIComponent(rawAssetSource)}/${encodeURIComponent(rawAssetSymbol)}`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ asset_id: assetId }),
                }
            );
            if (patchResponse.status === 404) {
                await fetch(`${API_URL}/raw-assets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        symbol: rawAssetSymbol,
                        source: rawAssetSource,
                        asset_id: assetId,
                    }),
                });
            }
        } catch (err) {
            console.warn('Failed to link raw asset:', err);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formData.symbol.trim()) {
            setError('Symbol is required');
            return;
        }

        setLoading(true);
        setError('');
        try {
            const response = await fetch(`${API_URL}/assets`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: formData.symbol.toUpperCase(),
                    label: formData.label || null,
                    isin: formData.isin || null,
                    price_type: formData.price_type || null,
                    tags: formData.tags.length > 0 ? formData.tags : null,
                    status: formData.status,
                    denomination_currency_id: formData.denomination_currency_id,
                }),
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to create asset');
            }

            const created = await response.json();

            // Link raw_asset if context provided
            if (created.asset_id) {
                await linkRawAsset(created.asset_id);

                // Assign categories if any selected
                if (selectedCategoryIds.size > 0) {
                    try {
                        await fetch(`${API_URL}/categories/asset/${created.asset_id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ category_ids: Array.from(selectedCategoryIds) }),
                        });
                    } catch (catErr) {
                        console.warn('Failed to assign categories:', catErr);
                    }
                }
            }

            refetchAssets();
            toaster.success({ title: `Asset "${formData.symbol}" created` });
            onClose(created.asset_id);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create asset');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog.Root
            open={isOpen}
            onOpenChange={(e) => {
                if (!e.open) onClose();
            }}
        >
            <Portal>
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <form onSubmit={handleSubmit}>
                            <Dialog.Header>
                                <Dialog.Title>Create New Asset</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={4}>
                                    {error && (
                                        <Text color="red.500" fontSize="sm">
                                            {error}
                                        </Text>
                                    )}
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Symbol *
                                        </Text>
                                        <Input
                                            placeholder="e.g., BTC, ETH, USDT"
                                            value={formData.symbol}
                                            onChange={(e) =>
                                                setFormData({ ...formData, symbol: e.target.value.toUpperCase() })
                                            }
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Label
                                        </Text>
                                        <Input
                                            placeholder="e.g., Bitcoin, Ethereum"
                                            value={formData.label}
                                            onChange={(e) =>
                                                setFormData({ ...formData, label: e.target.value })
                                            }
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            ISIN
                                        </Text>
                                        <Input
                                            placeholder="e.g., US0378331005"
                                            value={formData.isin}
                                            onChange={(e) =>
                                                setFormData({ ...formData, isin: e.target.value.toUpperCase() })
                                            }
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Type
                                        </Text>
                                        <ComboSelect
                                            value={formData.price_type}
                                            onChange={(val) =>
                                                setFormData({ ...formData, price_type: val })
                                            }
                                            options={ASSET_TYPE_OPTIONS}
                                            placeholder="Select or type..."
                                            width="100%"
                                            size="md"
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Tags
                                        </Text>
                                        <Input
                                            placeholder="e.g., defi, layer1, stablecoin (comma-separated)"
                                            value={formData.tags
                                                .map((t) => Object.keys(t)[0])
                                                .filter(Boolean)
                                                .join(', ')}
                                            onChange={(e) => {
                                                const tagStrings = e.target.value
                                                    .split(',')
                                                    .map((t) => t.trim())
                                                    .filter((t) => t);
                                                const tags = tagStrings.map((tag) => ({ [tag]: true }));
                                                setFormData({ ...formData, tags });
                                            }}
                                        />
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Denomination Currency
                                        </Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={String(formData.denomination_currency_id ?? '')}
                                                onChange={(e) =>
                                                    setFormData({
                                                        ...formData,
                                                        denomination_currency_id: e.target.value ? parseInt(e.target.value) : null,
                                                    })
                                                }
                                            >
                                                <option value="">— Not set —</option>
                                                {fiatAssets.map(a => (
                                                    <option key={a.asset_id} value={String(a.asset_id)}>
                                                        {a.symbol}{a.label ? ` (${a.label})` : ''}
                                                    </option>
                                                ))}
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>
                                    <Box>
                                        <Text fontWeight="medium" mb={1}>
                                            Status
                                        </Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={String(formData.status)}
                                                onChange={(e) =>
                                                    setFormData({
                                                        ...formData,
                                                        status: parseInt(e.target.value),
                                                    })
                                                }
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
                                                                                if (next.has(cat.id)) next.delete(cat.id);
                                                                                else next.add(cat.id);
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
                                    <Button variant="outline" onClick={() => onClose()}>
                                        Cancel
                                    </Button>
                                    <Button
                                        type="submit"
                                        colorPalette="green"
                                        loading={loading}
                                        disabled={!formData.symbol.trim()}
                                    >
                                        Create
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </form>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Portal>
        </Dialog.Root>
    );
};

export default AssetFormDialog;
