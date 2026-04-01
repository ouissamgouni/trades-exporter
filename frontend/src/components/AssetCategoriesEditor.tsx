/**
 * AssetCategoriesEditor — Per-asset category picker organised by dimension.
 *
 * Compact layout with inline checkboxes, xs fonts. Saves per-dimension on toggle.
 */

import React, { useEffect, useState } from 'react';
import { Badge, Box, Checkbox, Flex, Spinner, Text } from '@chakra-ui/react';
import { API_URL, Asset, DimensionWithCategories } from '../types';
import { toaster } from './ui/toaster';

interface AssetCategoriesEditorProps {
    asset: Asset;
    onSaved?: () => void;
}

export const AssetCategoriesEditor: React.FC<AssetCategoriesEditorProps> = ({ asset, onSaved }) => {
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>([]);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setLoading(true);
        fetch(`${API_URL}/categories/by-dimension`)
            .then(r => r.ok ? r.json() : [])
            .then((data: DimensionWithCategories[]) => { setDimensionData(data); setLoading(false); })
            .catch(() => { setDimensionData([]); setLoading(false); });
    }, []);

    useEffect(() => {
        setSelectedIds(new Set((asset.categories || []).map(c => c.id)));
    }, [asset.asset_id, asset.categories]);

    const toggle = async (catId: number) => {
        const next = new Set(selectedIds);
        if (next.has(catId)) next.delete(catId); else next.add(catId);
        setSelectedIds(next);

        if (!asset.asset_id) return;
        setSaving(true);
        try {
            const response = await fetch(`${API_URL}/categories/asset/${asset.asset_id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_ids: Array.from(next) }),
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to save');
            }
            onSaved?.();
        } catch (err) {
            // revert on error
            setSelectedIds(new Set((asset.categories || []).map(c => c.id)));
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return <Flex justify="center" py={3}><Spinner size="sm" /></Flex>;
    }

    if (dimensionData.length === 0) {
        return <Text fontSize="xs" color="gray.500" py={2}>No categories available.</Text>;
    }

    return (
        <Box>
            {saving && (
                <Flex justify="flex-end" mb={1}>
                    <Spinner size="xs" />
                </Flex>
            )}
            {dimensionData.map(dim => {
                const selected = dim.categories.filter(c => selectedIds.has(c.id));
                return (
                    <Box key={dim.id} mb={2}>
                        <Flex align="center" gap={1} mb={0.5}>
                            <Text fontSize="10px" fontWeight="bold" color="gray.600" textTransform="uppercase">
                                {dim.label}
                            </Text>
                            {selected.length > 0 && (
                                <Badge size="xs" colorPalette="blue">{selected.length}</Badge>
                            )}
                        </Flex>
                        <Flex gap={1} flexWrap="wrap">
                            {dim.categories.map(cat => {
                                const isSelected = selectedIds.has(cat.id);
                                return (
                                    <Flex
                                        key={cat.id}
                                        align="center"
                                        gap={1}
                                        px={1.5}
                                        py={0.5}
                                        borderRadius="sm"
                                        bg={isSelected ? 'blue.50' : 'transparent'}
                                        border="1px solid"
                                        borderColor={isSelected ? 'blue.200' : 'gray.200'}
                                        cursor="pointer"
                                        _hover={{ bg: isSelected ? 'blue.100' : 'gray.50' }}
                                        onClick={() => toggle(cat.id)}
                                    >
                                        <Checkbox.Root size="sm" checked={isSelected} onCheckedChange={() => toggle(cat.id)}>
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control />
                                        </Checkbox.Root>
                                        {cat.color && <Box w={2} h={2} borderRadius="full" bg={cat.color} />}
                                        <Text fontSize="xs">{cat.label}</Text>
                                    </Flex>
                                );
                            })}
                        </Flex>
                    </Box>
                );
            })}
        </Box>
    );
};

export default AssetCategoriesEditor;
