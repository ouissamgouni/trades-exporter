import {
    Badge,
    Box,
    Button,
    Collapsible,
    Dialog,
    Flex,
    Heading,
    HStack,
    Icon,
    IconButton,
    Input,
    Portal,
    Spinner,
    Stack,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { LuTriangleAlert, LuCheck, LuPencil, LuPlus, LuTrash2, LuX, LuChevronDown, LuChevronRight, LuGripVertical } from 'react-icons/lu';
import { API_URL, Category, CategoryAssetsResponse, Dimension, DimensionWithCategories, LinkedAsset, UnclassifiedAssetsResponse } from '../types';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { Toaster, toaster } from './ui/toaster';
import { ColorSelector } from './ColorSelector';
import { getNextAvailableColor, getContrastTextColor, DEFAULT_CATEGORY_COLOR } from '../constants/colors';

const API_BASE = API_URL;

interface CategoryFormData {
    dimension_id: number;
    label: string;
    color: string;
    ordinal: number;
}

export const CategoriesEditor: React.FC = () => {
    const [dimensionData, setDimensionData] = useState<DimensionWithCategories[]>([]);
    const [loading, setLoading] = useState(true);
    const [editingCategory, setEditingCategory] = useState<Category | null>(null);
    const [editingDimension, setEditingDimension] = useState<Dimension | null>(null);
    const [editingDimensionLabel, setEditingDimensionLabel] = useState<string>('');
    const [isCreating, setIsCreating] = useState(false);
    const [newCategoryDimensionId, setNewCategoryDimensionId] = useState<number | null>(null);
    const [isCreatingDimension, setIsCreatingDimension] = useState(false);
    const [newDimensionLabel, setNewDimensionLabel] = useState('');
    const [formData, setFormData] = useState<CategoryFormData>({
        dimension_id: 0,
        label: '',
        color: '',
        ordinal: 0,
    });

    // Drawer state for linked assets
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [drawerCategory, setDrawerCategory] = useState<Category | null>(null);
    const [drawerAssets, setDrawerAssets] = useState<LinkedAsset[]>([]);
    const [drawerLoading, setDrawerLoading] = useState(false);
    const [drawerIsUnclassified, setDrawerIsUnclassified] = useState(false);
    const [drawerDimensionId, setDrawerDimensionId] = useState<number>(0);
    const [drawerDimensionLabel, setDrawerDimensionLabel] = useState<string>('');

    // Unclassified counts per dimension
    const [unclassifiedCounts, setUnclassifiedCounts] = useState<Record<number, number>>({});

    // Collapsible state per dimension (default expanded)
    const [collapsedDimensions, setCollapsedDimensions] = useState<Set<number>>(new Set());

    // Confirmation dialogs
    const deleteCategoryConfirm = useConfirmDialog<Category>();
    const deleteDimensionConfirm = useConfirmDialog<DimensionWithCategories>();

    const toggleDimensionCollapse = (dimensionId: number) => {
        setCollapsedDimensions(prev => {
            const next = new Set(prev);
            if (next.has(dimensionId)) {
                next.delete(dimensionId);
            } else {
                next.add(dimensionId);
            }
            return next;
        });
    };

    const fetchCategories = async () => {
        try {
            const response = await fetch(`${API_BASE}/categories/by-dimension`);
            if (!response.ok) throw new Error('Failed to fetch categories');
            const data: DimensionWithCategories[] = await response.json();
            setDimensionData(data);

            // Fetch unclassified counts for each dimension
            const counts: Record<number, number> = {};
            for (const dim of data) {
                try {
                    const ucResponse = await fetch(`${API_BASE}/categories/dimensions/${dim.id}/unclassified`);
                    if (ucResponse.ok) {
                        const ucData: UnclassifiedAssetsResponse = await ucResponse.json();
                        counts[dim.id] = ucData.count;
                    }
                } catch {
                    // Ignore errors for individual dimensions
                }
            }
            setUnclassifiedCounts(counts);
        } catch (error) {
            toaster.error({ title: 'Error', description: 'Failed to load categories' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCategories();
    }, []);

    const startCreateCategory = (dimensionId: number) => {
        // Get used colors in this dimension to suggest an unused one
        const dimension = dimensionData.find(d => d.id === dimensionId);
        const usedColors = dimension?.categories.map(c => c.color).filter(Boolean) as string[] || [];
        const suggestedColor = getNextAvailableColor(usedColors);

        setNewCategoryDimensionId(dimensionId);
        setIsCreating(true);
        setFormData({
            dimension_id: dimensionId,
            label: '',
            color: suggestedColor,
            ordinal: 0,
        });
    };

    const startEditCategory = (category: Category) => {
        // If category has no color, suggest next available
        let colorToUse = category.color || '';
        if (!colorToUse) {
            const dimension = dimensionData.find(d => d.id === category.dimension_id);
            const usedColors = dimension?.categories
                .filter(c => c.id !== category.id)
                .map(c => c.color)
                .filter(Boolean) as string[] || [];
            colorToUse = getNextAvailableColor(usedColors);
        }

        setEditingCategory(category);
        setFormData({
            dimension_id: category.dimension_id,
            label: category.label,
            color: colorToUse,
            ordinal: category.ordinal,
        });
    };

    const startEditDimension = (dimension: DimensionWithCategories) => {
        setEditingDimension({ id: dimension.id, label: dimension.label, ordinal: dimension.ordinal });
        setEditingDimensionLabel(dimension.label);
    };

    const cancelEdit = () => {
        setEditingCategory(null);
        setIsCreating(false);
        setNewCategoryDimensionId(null);
        setEditingDimension(null);
        setEditingDimensionLabel('');
        setFormData({
            dimension_id: 0,
            label: '',
            color: '',
            ordinal: 0,
        });
    };

    const handleCreateCategory = async () => {
        if (!formData.label) {
            toaster.error({ title: 'Validation Error', description: 'Label is required' });
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dimension_id: formData.dimension_id,
                    label: formData.label,
                    color: formData.color || null,
                    ordinal: formData.ordinal,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to create category');
            }

            toaster.success({ title: 'Success', description: 'Category created' });
            cancelEdit();
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleUpdateCategory = async () => {
        if (!editingCategory) return;

        try {
            const response = await fetch(`${API_BASE}/categories/${editingCategory.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: formData.label,
                    color: formData.color || null,
                    ordinal: formData.ordinal,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to update category');
            }

            toaster.success({ title: 'Success', description: 'Category updated' });
            cancelEdit();
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleDeleteCategory = (category: Category) => {
        deleteCategoryConfirm.open(category);
    };

    const executeDeleteCategory = async () => {
        if (!deleteCategoryConfirm.data) return;
        const category = deleteCategoryConfirm.data;

        try {
            const response = await fetch(`${API_BASE}/categories/${category.id}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to delete category');
            }

            toaster.success({ title: 'Success', description: 'Category deleted' });
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleCreateDimension = async () => {
        if (!newDimensionLabel) {
            toaster.error({ title: 'Validation Error', description: 'Dimension label is required' });
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: newDimensionLabel,
                    ordinal: dimensionData.length,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to create dimension');
            }

            toaster.success({ title: 'Success', description: `Dimension "${newDimensionLabel}" created` });
            setIsCreatingDimension(false);
            setNewDimensionLabel('');
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleUpdateDimension = async () => {
        if (!editingDimension || !editingDimensionLabel) return;

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions/${editingDimension.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: editingDimensionLabel,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to update dimension');
            }

            toaster.success({ title: 'Success', description: 'Dimension updated' });
            cancelEdit();
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleDeleteDimension = (dimension: DimensionWithCategories) => {
        deleteDimensionConfirm.open(dimension);
    };

    const executeDeleteDimension = async () => {
        if (!deleteDimensionConfirm.data) return;
        const dimension = deleteDimensionConfirm.data;

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions/${dimension.id}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to delete dimension');
            }

            toaster.success({ title: 'Success', description: `Dimension "${dimension.label}" deleted` });
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    // Open drawer to show linked assets for a category
    const openCategoryDrawer = async (category: Category) => {
        setDrawerCategory(category);
        setDrawerIsUnclassified(false);
        setDrawerDimensionId(category.dimension_id);
        setDrawerDimensionLabel(category.dimension_label);
        setDrawerOpen(true);
        setDrawerLoading(true);

        try {
            const response = await fetch(`${API_BASE}/categories/${category.id}/assets`);
            if (!response.ok) throw new Error('Failed to fetch assets');
            const data: CategoryAssetsResponse = await response.json();
            setDrawerAssets(data.assets);
        } catch (error) {
            toaster.error({ title: 'Error', description: 'Failed to load linked assets' });
            setDrawerAssets([]);
        } finally {
            setDrawerLoading(false);
        }
    };

    // Open drawer for unclassified assets
    const openUnclassifiedDrawer = async (dimension: DimensionWithCategories) => {
        setDrawerCategory(null);
        setDrawerIsUnclassified(true);
        setDrawerDimensionId(dimension.id);
        setDrawerDimensionLabel(dimension.label);
        setDrawerOpen(true);
        setDrawerLoading(true);

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions/${dimension.id}/unclassified`);
            if (!response.ok) throw new Error('Failed to fetch unclassified assets');
            const data: UnclassifiedAssetsResponse = await response.json();
            setDrawerAssets(data.assets);
        } catch (error) {
            toaster.error({ title: 'Error', description: 'Failed to load unclassified assets' });
            setDrawerAssets([]);
        } finally {
            setDrawerLoading(false);
        }
    };

    // Unlink an asset from a category
    const handleUnlinkAsset = async (assetId: number) => {
        if (!drawerCategory) return;

        try {
            const response = await fetch(`${API_BASE}/categories/${drawerCategory.id}/assets/${assetId}`, {
                method: 'DELETE',
            });

            if (!response.ok) throw new Error('Failed to unlink asset');

            // Remove from local state
            setDrawerAssets(prev => prev.filter(a => a.asset_id !== assetId));
            toaster.success({ title: 'Success', description: 'Asset unlinked' });

            // Refresh categories to update counts
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    if (loading) {
        return (
            <Flex justify="center" align="center" h="200px">
                <Spinner size="lg" />
            </Flex>
        );
    }

    return (
        <Box>
            <Toaster />
            <Flex justify="space-between" align="center" mb={4}>
                <Heading size="md">Asset Categories</Heading>
                <Text fontSize="sm" color="gray.500">
                    Classify assets by dimensions (e.g., Asset Class: Crypto, Sector: DeFi)
                </Text>
            </Flex>

            {/* Add Dimension Button */}
            <Box mb={4}>
                {isCreatingDimension ? (
                    <HStack gap={2}>
                        <Input
                            placeholder="Dimension name (e.g., Asset Class)"
                            value={newDimensionLabel}
                            onChange={e => setNewDimensionLabel(e.target.value)}
                            size="sm"
                            width="300px"
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleCreateDimension();
                                if (e.key === 'Escape') {
                                    setIsCreatingDimension(false);
                                    setNewDimensionLabel('');
                                }
                            }}
                            autoFocus
                        />
                        <IconButton
                            aria-label="Confirm"
                            size="sm"
                            colorPalette="green"
                            onClick={handleCreateDimension}
                        >
                            <Icon as={LuCheck} />
                        </IconButton>
                        <IconButton
                            aria-label="Cancel"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setIsCreatingDimension(false);
                                setNewDimensionLabel('');
                            }}
                        >
                            <Icon as={LuX} />
                        </IconButton>
                    </HStack>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => setIsCreatingDimension(true)}>
                        <Icon as={LuPlus} mr={1} /> Add Dimension
                    </Button>
                )}
            </Box>

            {/* Dimensions as Collapsible Cards */}
            <Stack gap={3}>
                {dimensionData.map(dim => {
                    const isCollapsed = collapsedDimensions.has(dim.id);
                    const categoryCount = dim.categories.length;
                    const totalAssets = dim.categories.reduce((sum, c) => sum + (c.asset_count || 0), 0);
                    const unclassifiedCount = unclassifiedCounts[dim.id] || 0;

                    return (
                        <Box
                            key={dim.id}
                            borderWidth="1px"
                            borderRadius="lg"
                            bg="bg.subtle"
                            overflow="hidden"
                            _hover={{ borderColor: 'gray.400' }}
                            transition="border-color 0.2s"
                        >
                            {/* Dimension Header - Always Visible */}
                            <Flex
                                justify="space-between"
                                align="center"
                                p={3}
                                bg="bg.muted"
                                cursor="pointer"
                                onClick={() => toggleDimensionCollapse(dim.id)}
                                _hover={{ bg: 'bg.emphasized' }}
                            >
                                <HStack gap={3}>
                                    {/* Collapse Toggle */}
                                    <Icon
                                        as={isCollapsed ? LuChevronRight : LuChevronDown}
                                        boxSize={5}
                                        color="gray.500"
                                    />

                                    {/* Dimension Title */}
                                    {editingDimension?.id === dim.id ? (
                                        <HStack gap={2} onClick={e => e.stopPropagation()}>
                                            <Input
                                                value={editingDimensionLabel}
                                                onChange={e => setEditingDimensionLabel(e.target.value)}
                                                size="sm"
                                                width="200px"
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') handleUpdateDimension();
                                                    if (e.key === 'Escape') cancelEdit();
                                                }}
                                                autoFocus
                                            />
                                            <IconButton
                                                aria-label="Save"
                                                size="xs"
                                                colorPalette="green"
                                                onClick={handleUpdateDimension}
                                            >
                                                <Icon as={LuCheck} />
                                            </IconButton>
                                            <IconButton
                                                aria-label="Cancel"
                                                size="xs"
                                                variant="ghost"
                                                onClick={cancelEdit}
                                            >
                                                <Icon as={LuX} />
                                            </IconButton>
                                        </HStack>
                                    ) : (
                                        <HStack gap={2}>
                                            <Heading size="sm">{dim.label}</Heading>
                                            <IconButton
                                                aria-label="Edit dimension"
                                                size="xs"
                                                variant="ghost"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    startEditDimension(dim);
                                                }}
                                            >
                                                <Icon as={LuPencil} boxSize={3} />
                                            </IconButton>
                                        </HStack>
                                    )}
                                </HStack>

                                {/* Stats & Actions */}
                                <HStack gap={3} onClick={e => e.stopPropagation()}>
                                    {/* Summary badges */}
                                    <HStack gap={2}>
                                        <Badge variant="subtle" colorPalette="gray" size="sm">
                                            {categoryCount} {categoryCount === 1 ? 'category' : 'categories'}
                                        </Badge>
                                        <Badge variant="subtle" colorPalette="blue" size="sm">
                                            {totalAssets} assets
                                        </Badge>
                                        {unclassifiedCount > 0 && (
                                            <Badge
                                                variant="solid"
                                                colorPalette="orange"
                                                size="sm"
                                                cursor="pointer"
                                                onClick={() => openUnclassifiedDrawer(dim)}
                                            >
                                                {unclassifiedCount} unclassified
                                            </Badge>
                                        )}
                                    </HStack>

                                    {/* Action buttons */}
                                    <Button
                                        size="xs"
                                        variant="ghost"
                                        onClick={() => startCreateCategory(dim.id)}
                                    >
                                        <Icon as={LuPlus} mr={1} /> Add
                                    </Button>
                                    <IconButton
                                        aria-label="Delete dimension"
                                        size="xs"
                                        variant="ghost"
                                        colorPalette="red"
                                        onClick={() => handleDeleteDimension(dim)}
                                    >
                                        <Icon as={LuTrash2} boxSize={3} />
                                    </IconButton>
                                </HStack>
                            </Flex>

                            {/* Collapsible Content */}
                            <Collapsible.Root open={!isCollapsed}>
                                <Collapsible.Content>
                                    <Box p={4}>
                                        {/* Unclassified Warning */}
                                        {unclassifiedCount > 0 && (
                                            <Box
                                                mb={4}
                                                p={3}
                                                bg="orange.50"
                                                _dark={{ bg: 'orange.900/30' }}
                                                borderRadius="md"
                                                borderLeftWidth="4px"
                                                borderLeftColor="orange.400"
                                                cursor="pointer"
                                                onClick={() => openUnclassifiedDrawer(dim)}
                                                _hover={{ bg: 'orange.100', _dark: { bg: 'orange.900/50' } }}
                                            >
                                                <HStack>
                                                    <Icon as={LuTriangleAlert} color="orange.500" />
                                                    <Text fontSize="sm" fontWeight="medium">
                                                        {unclassifiedCount} assets need classification in this dimension
                                                    </Text>
                                                    <Text fontSize="sm" color="gray.500">
                                                        Click to view
                                                    </Text>
                                                </HStack>
                                            </Box>
                                        )}

                                        {/* Category Grid */}
                                        <Flex flexWrap="wrap" gap={2}>
                                            {/* Add category inline form */}
                                            {isCreating && newCategoryDimensionId === dim.id && (
                                                <HStack
                                                    gap={2}
                                                    p={2}
                                                    bg="bg.muted"
                                                    borderRadius="lg"
                                                    borderWidth="1px"
                                                    borderStyle="dashed"
                                                    borderColor="green.400"
                                                >
                                                    <Input
                                                        placeholder="Category name"
                                                        value={formData.label}
                                                        onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                        size="sm"
                                                        width="150px"
                                                        onKeyDown={e => {
                                                            if (e.key === 'Enter') handleCreateCategory();
                                                            if (e.key === 'Escape') cancelEdit();
                                                        }}
                                                        autoFocus
                                                    />
                                                    <ColorSelector
                                                        value={formData.color}
                                                        onChange={(color) => setFormData({ ...formData, color })}
                                                    />
                                                    <Button
                                                        size="sm"
                                                        colorPalette="green"
                                                        onClick={handleCreateCategory}
                                                    >
                                                        Save
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={cancelEdit}
                                                    >
                                                        Cancel
                                                    </Button>
                                                </HStack>
                                            )}

                                            {/* Category pills */}
                                            {dim.categories.map(cat => (
                                                <Box key={cat.id}>
                                                    {editingCategory?.id === cat.id ? (
                                                        <HStack
                                                            gap={2}
                                                            p={2}
                                                            bg="bg.muted"
                                                            borderRadius="lg"
                                                            borderWidth="1px"
                                                            borderColor="blue.400"
                                                        >
                                                            <Input
                                                                value={formData.label}
                                                                onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                                size="sm"
                                                                width="150px"
                                                                onKeyDown={e => {
                                                                    if (e.key === 'Enter') handleUpdateCategory();
                                                                    if (e.key === 'Escape') cancelEdit();
                                                                }}
                                                                autoFocus
                                                            />
                                                            <ColorSelector
                                                                value={formData.color}
                                                                onChange={(color) => setFormData({ ...formData, color })}
                                                            />
                                                            <Button
                                                                size="sm"
                                                                colorPalette="green"
                                                                onClick={handleUpdateCategory}
                                                            >
                                                                Save
                                                            </Button>
                                                            <Button
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={cancelEdit}
                                                            >
                                                                Cancel
                                                            </Button>
                                                        </HStack>
                                                    ) : (
                                                        <HStack
                                                            gap={2}
                                                            px={3}
                                                            py={2}
                                                            bg={cat.color || DEFAULT_CATEGORY_COLOR}
                                                            borderRadius="lg"
                                                            cursor="pointer"
                                                            onClick={() => openCategoryDrawer(cat)}
                                                            _hover={{ opacity: 0.85, transform: 'translateY(-1px)' }}
                                                            transition="all 0.15s"
                                                            boxShadow="sm"
                                                        >
                                                            <Text
                                                                fontSize="sm"
                                                                fontWeight="medium"
                                                                color={getContrastTextColor(cat.color || DEFAULT_CATEGORY_COLOR)}
                                                            >
                                                                {cat.label}
                                                            </Text>
                                                            {(cat.asset_count || 0) > 0 && (
                                                                <Text
                                                                    fontSize="xs"
                                                                    color={getContrastTextColor(cat.color || DEFAULT_CATEGORY_COLOR)}
                                                                    opacity={0.7}
                                                                >
                                                                    ({cat.asset_count})
                                                                </Text>
                                                            )}
                                                            <HStack gap={0}>
                                                                <IconButton
                                                                    aria-label="Edit"
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    onClick={e => {
                                                                        e.stopPropagation();
                                                                        startEditCategory(cat);
                                                                    }}
                                                                >
                                                                    <Icon as={LuPencil} boxSize={3} />
                                                                </IconButton>
                                                                <IconButton
                                                                    aria-label="Delete"
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    colorPalette="red"
                                                                    onClick={e => {
                                                                        e.stopPropagation();
                                                                        handleDeleteCategory(cat);
                                                                    }}
                                                                >
                                                                    <Icon as={LuTrash2} boxSize={3} />
                                                                </IconButton>
                                                            </HStack>
                                                        </HStack>
                                                    )}
                                                </Box>
                                            ))}

                                            {dim.categories.length === 0 && !isCreating && (
                                                <Box
                                                    p={4}
                                                    w="full"
                                                    textAlign="center"
                                                    borderWidth="1px"
                                                    borderStyle="dashed"
                                                    borderRadius="lg"
                                                    borderColor="gray.300"
                                                >
                                                    <Text fontSize="sm" color="gray.500">
                                                        No categories yet. Click "Add" to create one.
                                                    </Text>
                                                </Box>
                                            )}
                                        </Flex>
                                    </Box>
                                </Collapsible.Content>
                            </Collapsible.Root>
                        </Box>
                    );
                })}

                {dimensionData.length === 0 && (
                    <Box p={8} textAlign="center" borderWidth="1px" borderRadius="md" borderStyle="dashed">
                        <Text color="gray.500" mb={2}>No dimensions defined yet</Text>
                        <Text fontSize="sm" color="gray.400">
                            Create dimensions like "Asset Class", "Sector", or "Region" to categorize your assets.
                        </Text>
                    </Box>
                )}
            </Stack>

            {/* Assets Drawer (Dialog as drawer) */}
            <Dialog.Root
                open={drawerOpen}
                onOpenChange={e => setDrawerOpen(e.open)}
                placement="center"
                size="md"
            >
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>
                                    {drawerIsUnclassified
                                        ? `Unclassified Assets (${drawerDimensionLabel})`
                                        : `Assets: ${drawerCategory?.label}`}
                                </Dialog.Title>
                                <Dialog.CloseTrigger asChild>
                                    <IconButton aria-label="Close" size="sm" variant="ghost">
                                        <Icon as={LuX} />
                                    </IconButton>
                                </Dialog.CloseTrigger>
                            </Dialog.Header>
                            <Dialog.Body>
                                {drawerLoading ? (
                                    <Flex justify="center" py={4}>
                                        <Spinner />
                                    </Flex>
                                ) : drawerAssets.length === 0 ? (
                                    <Text color="gray.500" textAlign="center" py={4}>
                                        No assets found
                                    </Text>
                                ) : (
                                    <VStack align="stretch" gap={2} maxH="400px" overflowY="auto">
                                        {drawerAssets.map(asset => (
                                            <Flex
                                                key={asset.asset_id}
                                                justify="space-between"
                                                align="center"
                                                p={2}
                                                borderWidth="1px"
                                                borderRadius="md"
                                            >
                                                <HStack>
                                                    <Text fontWeight="medium">{asset.symbol}</Text>
                                                    {asset.label && (
                                                        <Text fontSize="sm" color="gray.500">
                                                            {asset.label}
                                                        </Text>
                                                    )}
                                                </HStack>
                                                {!drawerIsUnclassified && (
                                                    <Button
                                                        size="xs"
                                                        variant="ghost"
                                                        colorPalette="red"
                                                        onClick={() => handleUnlinkAsset(asset.asset_id)}
                                                    >
                                                        Unlink
                                                    </Button>
                                                )}
                                            </Flex>
                                        ))}
                                    </VStack>
                                )}
                            </Dialog.Body>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Category Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteCategoryConfirm.isOpen}
                onClose={deleteCategoryConfirm.close}
                onConfirm={executeDeleteCategory}
                title="Delete Category"
                message={deleteCategoryConfirm.data ? `Delete category "${deleteCategoryConfirm.data.label}"? This will remove it from all assets.` : ''}
                confirmLabel="Delete"
                isDestructive
            />

            {/* Delete Dimension Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteDimensionConfirm.isOpen}
                onClose={deleteDimensionConfirm.close}
                onConfirm={executeDeleteDimension}
                title="Delete Dimension"
                message={deleteDimensionConfirm.data ? `Delete dimension "${deleteDimensionConfirm.data.label}" and all its ${deleteDimensionConfirm.data.categories.length} categories? This cannot be undone.` : ''}
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};
