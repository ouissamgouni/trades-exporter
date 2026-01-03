import {
    Box,
    Button,
    Flex,
    Heading,
    HStack,
    Icon,
    IconButton,
    Input,
    Spinner,
    Stack,
    Table,
    Tag,
    Text,
    VStack,
} from '@chakra-ui/react';
import React, { useEffect, useState } from 'react';
import { LuChevronDown, LuChevronRight, LuPencil, LuPlus, LuTrash2, LuX, LuCheck } from 'react-icons/lu';
import { Category, DimensionCategories } from '../types';
import { Toaster, toaster } from './ui/toaster';

const API_BASE = 'http://localhost:8000';

interface CategoryFormData {
    dimension: string;
    dimension_label: string;
    key: string;
    label: string;
    parent_id: number | null;
    color: string;
    ordinal: number;
}

const DIMENSION_COLORS: Record<string, string> = {
    asset_class: 'blue',
    sector: 'green',
    region: 'purple',
    currency_peg: 'orange',
};

export const CategoriesEditor: React.FC = () => {
    const [dimensionData, setDimensionData] = useState<DimensionCategories[]>([]);
    const [loading, setLoading] = useState(true);
    const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set(['asset_class', 'sector']));
    const [editingCategory, setEditingCategory] = useState<Category | null>(null);
    const [editingDimension, setEditingDimension] = useState<string | null>(null);
    const [editingDimensionLabel, setEditingDimensionLabel] = useState<string>('');
    const [isCreating, setIsCreating] = useState(false);
    const [newCategoryDimension, setNewCategoryDimension] = useState<string | null>(null);
    const [isCreatingDimension, setIsCreatingDimension] = useState(false);
    const [newDimensionKey, setNewDimensionKey] = useState('');
    const [newDimensionLabel, setNewDimensionLabel] = useState('');
    const [formData, setFormData] = useState<CategoryFormData>({
        dimension: '',
        dimension_label: '',
        key: '',
        label: '',
        parent_id: null,
        color: '',
        ordinal: 0,
    });

    const fetchCategories = async () => {
        try {
            const response = await fetch(`${API_BASE}/categories/by-dimension`);
            if (!response.ok) throw new Error('Failed to fetch categories');
            const data: DimensionCategories[] = await response.json();
            setDimensionData(data);
        } catch (error) {
            toaster.error({ title: 'Error', description: 'Failed to load categories' });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchCategories();
    }, []);

    const toggleDimension = (dimension: string) => {
        setExpandedDimensions(prev => {
            const next = new Set(prev);
            if (next.has(dimension)) {
                next.delete(dimension);
            } else {
                next.add(dimension);
            }
            return next;
        });
    };

    const startCreateCategory = (dimension: string, dimensionLabel: string) => {
        setNewCategoryDimension(dimension);
        setIsCreating(true);
        setFormData({
            dimension,
            dimension_label: dimensionLabel,
            key: '',
            label: '',
            parent_id: null,
            color: '',
            ordinal: 0,
        });
    };

    const startEditCategory = (category: Category) => {
        setEditingCategory(category);
        setFormData({
            dimension: category.dimension,
            dimension_label: category.dimension_label || '',
            key: category.key,
            label: category.label,
            parent_id: category.parent_id || null,
            color: category.color || '',
            ordinal: category.ordinal,
        });
    };

    const startEditDimension = (dimension: string, label: string) => {
        setEditingDimension(dimension);
        setEditingDimensionLabel(label);
    };

    const cancelEdit = () => {
        setEditingCategory(null);
        setIsCreating(false);
        setNewCategoryDimension(null);
        setEditingDimension(null);
        setEditingDimensionLabel('');
        setFormData({
            dimension: '',
            dimension_label: '',
            key: '',
            label: '',
            parent_id: null,
            color: '',
            ordinal: 0,
        });
    };

    const handleCreateCategory = async () => {
        if (!formData.key || !formData.label) {
            toaster.error({ title: 'Validation Error', description: 'Key and Label are required' });
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dimension: formData.dimension,
                    dimension_label: formData.dimension_label || null,
                    key: formData.key,
                    label: formData.label,
                    parent_id: formData.parent_id || null,
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
                    parent_id: formData.parent_id || 0,
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

    const handleDeleteCategory = async (category: Category) => {
        if (!confirm(`Delete category "${category.label}"? This will remove it from all assets.`)) {
            return;
        }

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
        if (!newDimensionKey || !newDimensionLabel) {
            toaster.error({ title: 'Validation Error', description: 'Dimension key and label are required' });
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dimension: newDimensionKey.toLowerCase().replace(/\s+/g, '_'),
                    dimension_label: newDimensionLabel,
                }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to create dimension');
            }

            toaster.success({ title: 'Success', description: `Dimension "${newDimensionLabel}" created` });
            setIsCreatingDimension(false);
            setNewDimensionKey('');
            setNewDimensionLabel('');
            fetchCategories();
            // Expand the new dimension
            setExpandedDimensions(prev => new Set([...prev, newDimensionKey.toLowerCase().replace(/\s+/g, '_')]));
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const handleUpdateDimension = async (dimension: string) => {
        if (!editingDimensionLabel) return;

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions/${dimension}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    dimension_label: editingDimensionLabel,
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

    const handleDeleteDimension = async (dimension: string, label: string) => {
        const categoriesCount = getCategoriesForDimension(dimension).filter(c => c.key !== '_placeholder').length;
        if (!confirm(`Delete dimension "${label}" and all its ${categoriesCount} categories? This cannot be undone.`)) {
            return;
        }

        try {
            const response = await fetch(`${API_BASE}/categories/dimensions/${dimension}`, {
                method: 'DELETE',
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to delete dimension');
            }

            toaster.success({ title: 'Success', description: `Dimension "${label}" deleted` });
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: error.message });
        }
    };

    const getCategoriesForDimension = (dimension: string): Category[] => {
        const dim = dimensionData.find(d => d.dimension === dimension);
        // Filter out placeholder categories
        return (dim?.categories || []).filter(c => c.key !== '_placeholder');
    };

    const getParentOptions = (dimension: string, excludeId?: number): Category[] => {
        return getCategoriesForDimension(dimension).filter(c => c.id !== excludeId && !c.parent_id);
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
                    Classify assets by dimensions for reporting (e.g., Asset Class: Crypto, Sector: DeFi)
                </Text>
            </Flex>

            <Stack gap={4}>
                {dimensionData.map(dimInfo => (
                    <Box key={dimInfo.dimension} borderWidth={1} borderRadius="md" overflow="hidden">
                        {/* Dimension Header */}
                        <Flex
                            bg="gray.50"
                            _dark={{ bg: 'gray.800' }}
                            px={4}
                            py={2}
                            align="center"
                        >
                            <Box
                                cursor="pointer"
                                onClick={() => toggleDimension(dimInfo.dimension)}
                                display="flex"
                                alignItems="center"
                                flex={1}
                            >
                                <Icon
                                    as={expandedDimensions.has(dimInfo.dimension) ? LuChevronDown : LuChevronRight}
                                    mr={2}
                                />
                                <Tag.Root
                                    colorPalette={DIMENSION_COLORS[dimInfo.dimension] || 'gray'}
                                    size="sm"
                                    mr={2}
                                >
                                    <Tag.Label>{dimInfo.dimension}</Tag.Label>
                                </Tag.Root>

                                {editingDimension === dimInfo.dimension ? (
                                    <HStack gap={2} onClick={e => e.stopPropagation()}>
                                        <Input
                                            size="xs"
                                            value={editingDimensionLabel}
                                            onChange={e => setEditingDimensionLabel(e.target.value)}
                                            w="150px"
                                            autoFocus
                                        />
                                        <IconButton
                                            aria-label="Save"
                                            size="xs"
                                            colorPalette="green"
                                            onClick={() => handleUpdateDimension(dimInfo.dimension)}
                                        >
                                            <LuCheck />
                                        </IconButton>
                                        <IconButton
                                            aria-label="Cancel"
                                            size="xs"
                                            variant="ghost"
                                            onClick={cancelEdit}
                                        >
                                            <LuX />
                                        </IconButton>
                                    </HStack>
                                ) : (
                                    <Text fontWeight="medium">{dimInfo.dimension_label}</Text>
                                )}
                            </Box>

                            <Text fontSize="sm" color="gray.500" mr={2}>
                                {getCategoriesForDimension(dimInfo.dimension).length} values
                            </Text>

                            <HStack gap={1}>
                                <IconButton
                                    aria-label="Edit dimension"
                                    size="xs"
                                    variant="ghost"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        startEditDimension(dimInfo.dimension, dimInfo.dimension_label);
                                    }}
                                >
                                    <LuPencil />
                                </IconButton>
                                <IconButton
                                    aria-label="Delete dimension"
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="red"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteDimension(dimInfo.dimension, dimInfo.dimension_label);
                                    }}
                                >
                                    <LuTrash2 />
                                </IconButton>
                                <IconButton
                                    aria-label="Add category"
                                    size="xs"
                                    variant="ghost"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        startCreateCategory(dimInfo.dimension, dimInfo.dimension_label);
                                        if (!expandedDimensions.has(dimInfo.dimension)) {
                                            toggleDimension(dimInfo.dimension);
                                        }
                                    }}
                                >
                                    <LuPlus />
                                </IconButton>
                            </HStack>
                        </Flex>

                        {/* Categories List */}
                        {expandedDimensions.has(dimInfo.dimension) && (
                            <Box>
                                {/* New Category Form */}
                                {isCreating && newCategoryDimension === dimInfo.dimension && (
                                    <Box bg="blue.50" _dark={{ bg: 'blue.900' }} p={3} borderBottomWidth={1}>
                                        <HStack gap={2} mb={2}>
                                            <Input
                                                size="sm"
                                                placeholder="key (e.g., defi)"
                                                value={formData.key}
                                                onChange={e => setFormData({ ...formData, key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
                                                w="150px"
                                            />
                                            <Input
                                                size="sm"
                                                placeholder="Display Label (e.g., DeFi)"
                                                value={formData.label}
                                                onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                flex={1}
                                            />
                                            <Input
                                                size="sm"
                                                placeholder="Color (#hex)"
                                                value={formData.color}
                                                onChange={e => setFormData({ ...formData, color: e.target.value })}
                                                w="100px"
                                            />
                                            <select
                                                style={{ padding: '4px 8px', borderRadius: '4px', fontSize: '14px' }}
                                                value={formData.parent_id || ''}
                                                onChange={e => setFormData({ ...formData, parent_id: e.target.value ? Number(e.target.value) : null })}
                                            >
                                                <option value="">No parent</option>
                                                {getParentOptions(dimInfo.dimension).map(cat => (
                                                    <option key={cat.id} value={cat.id}>{cat.label}</option>
                                                ))}
                                            </select>
                                        </HStack>
                                        <HStack>
                                            <Button size="xs" colorPalette="blue" onClick={handleCreateCategory}>
                                                Create
                                            </Button>
                                            <Button size="xs" variant="ghost" onClick={cancelEdit}>
                                                Cancel
                                            </Button>
                                        </HStack>
                                    </Box>
                                )}

                                {/* Categories Table */}
                                <Table.Root size="sm">
                                    <Table.Header>
                                        <Table.Row>
                                            <Table.ColumnHeader w="150px">Key</Table.ColumnHeader>
                                            <Table.ColumnHeader>Display Label</Table.ColumnHeader>
                                            <Table.ColumnHeader w="120px">Parent</Table.ColumnHeader>
                                            <Table.ColumnHeader w="80px">Color</Table.ColumnHeader>
                                            <Table.ColumnHeader w="80px" textAlign="right">Actions</Table.ColumnHeader>
                                        </Table.Row>
                                    </Table.Header>
                                    <Table.Body>
                                        {getCategoriesForDimension(dimInfo.dimension).map(category => (
                                            <Table.Row key={category.id}>
                                                {editingCategory?.id === category.id ? (
                                                    <>
                                                        <Table.Cell>
                                                            <Text fontFamily="mono" fontSize="sm">{category.key}</Text>
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            <Input
                                                                size="xs"
                                                                value={formData.label}
                                                                onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                            />
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            <select
                                                                style={{ padding: '2px 4px', borderRadius: '4px', fontSize: '12px', width: '100%' }}
                                                                value={formData.parent_id || ''}
                                                                onChange={e => setFormData({ ...formData, parent_id: e.target.value ? Number(e.target.value) : null })}
                                                            >
                                                                <option value="">None</option>
                                                                {getParentOptions(dimInfo.dimension, category.id).map(cat => (
                                                                    <option key={cat.id} value={cat.id}>{cat.label}</option>
                                                                ))}
                                                            </select>
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            <Input
                                                                size="xs"
                                                                value={formData.color}
                                                                onChange={e => setFormData({ ...formData, color: e.target.value })}
                                                                w="70px"
                                                            />
                                                        </Table.Cell>
                                                        <Table.Cell textAlign="right">
                                                            <HStack justify="flex-end" gap={1}>
                                                                <IconButton
                                                                    aria-label="Save"
                                                                    size="xs"
                                                                    colorPalette="green"
                                                                    onClick={handleUpdateCategory}
                                                                >
                                                                    <LuCheck />
                                                                </IconButton>
                                                                <IconButton
                                                                    aria-label="Cancel"
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    onClick={cancelEdit}
                                                                >
                                                                    <LuX />
                                                                </IconButton>
                                                            </HStack>
                                                        </Table.Cell>
                                                    </>
                                                ) : (
                                                    <>
                                                        <Table.Cell>
                                                            <Text
                                                                fontFamily="mono"
                                                                fontSize="sm"
                                                                pl={category.parent_id ? 4 : 0}
                                                            >
                                                                {category.parent_id && '└ '}{category.key}
                                                            </Text>
                                                        </Table.Cell>
                                                        <Table.Cell>{category.label}</Table.Cell>
                                                        <Table.Cell>
                                                            {category.parent_id && (
                                                                <Text fontSize="xs" color="gray.500">
                                                                    {getCategoriesForDimension(dimInfo.dimension).find(c => c.id === category.parent_id)?.label || '-'}
                                                                </Text>
                                                            )}
                                                        </Table.Cell>
                                                        <Table.Cell>
                                                            {category.color && (
                                                                <Box
                                                                    w="20px"
                                                                    h="20px"
                                                                    borderRadius="sm"
                                                                    bg={category.color}
                                                                    borderWidth={1}
                                                                />
                                                            )}
                                                        </Table.Cell>
                                                        <Table.Cell textAlign="right">
                                                            <HStack justify="flex-end" gap={1}>
                                                                <IconButton
                                                                    aria-label="Edit"
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    onClick={() => startEditCategory(category)}
                                                                >
                                                                    <LuPencil />
                                                                </IconButton>
                                                                <IconButton
                                                                    aria-label="Delete"
                                                                    size="xs"
                                                                    variant="ghost"
                                                                    colorPalette="red"
                                                                    onClick={() => handleDeleteCategory(category)}
                                                                >
                                                                    <LuTrash2 />
                                                                </IconButton>
                                                            </HStack>
                                                        </Table.Cell>
                                                    </>
                                                )}
                                            </Table.Row>
                                        ))}
                                        {getCategoriesForDimension(dimInfo.dimension).length === 0 && (
                                            <Table.Row>
                                                <Table.Cell colSpan={5}>
                                                    <Text fontSize="sm" color="gray.500" textAlign="center" py={2}>
                                                        No values in this dimension. Click + to add one.
                                                    </Text>
                                                </Table.Cell>
                                            </Table.Row>
                                        )}
                                    </Table.Body>
                                </Table.Root>
                            </Box>
                        )}
                    </Box>
                ))}

                {/* Add New Dimension */}
                <Box borderWidth={1} borderRadius="md" borderStyle="dashed" p={4}>
                    {isCreatingDimension ? (
                        <VStack align="stretch" gap={2}>
                            <Text fontWeight="medium">Create New Dimension</Text>
                            <HStack gap={2}>
                                <Box flex={1}>
                                    <Text fontSize="xs" color="gray.500" mb={1}>Key (internal)</Text>
                                    <Input
                                        size="sm"
                                        placeholder="e.g., risk_level"
                                        value={newDimensionKey}
                                        onChange={e => setNewDimensionKey(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
                                    />
                                </Box>
                                <Box flex={1}>
                                    <Text fontSize="xs" color="gray.500" mb={1}>Display Label</Text>
                                    <Input
                                        size="sm"
                                        placeholder="e.g., Risk Level"
                                        value={newDimensionLabel}
                                        onChange={e => setNewDimensionLabel(e.target.value)}
                                    />
                                </Box>
                            </HStack>
                            <HStack>
                                <Button size="sm" colorPalette="blue" onClick={handleCreateDimension}>
                                    Create Dimension
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => {
                                    setIsCreatingDimension(false);
                                    setNewDimensionKey('');
                                    setNewDimensionLabel('');
                                }}>
                                    Cancel
                                </Button>
                            </HStack>
                        </VStack>
                    ) : (
                        <VStack>
                            <Text fontSize="sm" color="gray.500">
                                Add a new dimension to classify assets (e.g., Risk Level, Liquidity Tier)
                            </Text>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setIsCreatingDimension(true)}
                            >
                                <LuPlus /> Add Dimension
                            </Button>
                        </VStack>
                    )}
                </Box>
            </Stack>
        </Box>
    );
};
