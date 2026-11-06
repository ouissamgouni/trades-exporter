import * as RadixDialog from '@radix-ui/react-dialog';
import { Badge, Button, Input, Spinner } from './ui/primitives';
import React, { useEffect, useState } from 'react';
import { LuTriangleAlert, LuCheck, LuPencil, LuPlus, LuTrash2, LuX, LuChevronDown, LuChevronRight, LuGripVertical, LuShuffle } from 'react-icons/lu';
import { API_URL, Category, CategoryAssetsResponse, Dimension, DimensionWithCategories, LinkedAsset, UnclassifiedAssetsResponse } from '../types';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';
import { ColorSelector } from './ColorSelector';
import { getNextAvailableColor, getContrastTextColor, DEFAULT_CATEGORY_COLOR, CATEGORY_COLOR_PALETTE } from '../constants/colors';

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

    // Randomizing state
    const [randomizingDimensionId, setRandomizingDimensionId] = useState<number | null>(null);

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

    const handleRandomizeColors = async (dimension: DimensionWithCategories) => {
        setRandomizingDimensionId(dimension.id);
        try {
            // Shuffle the palette
            const shuffled = [...CATEGORY_COLOR_PALETTE].sort(() => Math.random() - 0.5);
            // Assign to categories
            const updates = dimension.categories.map((category, index) => {
                const newColor = shuffled[index % shuffled.length];
                return fetch(`${API_BASE}/categories/${category.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        label: category.label,
                        color: newColor,
                        ordinal: category.ordinal,
                    }),
                });
            });
            // Wait for all updates
            await Promise.all(updates);
            toaster.success({ title: 'Success', description: `Randomized colors for ${dimension.label}` });
            fetchCategories();
        } catch (error: any) {
            toaster.error({ title: 'Error', description: 'Failed to randomize colors' });
        } finally {
            setRandomizingDimensionId(null);
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
            <div className="flex h-[200px] items-center justify-center">
                <Spinner size="lg" />
            </div>
        );
    }

    return (
        <div>
            <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">Asset Categories</h2>
                <span className="text-sm text-slate-500">
                    Classify assets by dimensions (e.g., Asset Class: Crypto, Sector: DeFi)
                </span>
            </div>

            {/* Add Dimension Button */}
            <div className="mb-4">
                {isCreatingDimension ? (
                    <div className="flex items-center gap-2">
                        <Input
                            placeholder="Dimension name (e.g., Asset Class)"
                            value={newDimensionLabel}
                            onChange={e => setNewDimensionLabel(e.target.value)}
                            className="w-[300px]"
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleCreateDimension();
                                if (e.key === 'Escape') {
                                    setIsCreatingDimension(false);
                                    setNewDimensionLabel('');
                                }
                            }}
                            autoFocus
                        />
                        <Button
                            aria-label="Confirm"
                            size="sm"
                            colorScheme="green"
                            onClick={handleCreateDimension}
                        >
                            <LuCheck />
                        </Button>
                        <Button
                            aria-label="Cancel"
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                setIsCreatingDimension(false);
                                setNewDimensionLabel('');
                            }}
                        >
                            <LuX />
                        </Button>
                    </div>
                ) : (
                    <Button size="sm" variant="outline" onClick={() => setIsCreatingDimension(true)}>
                        <LuPlus className="mr-1" /> Add Dimension
                    </Button>
                )}
            </div>

            {/* Dimensions as Collapsible Cards */}
            <div className="flex flex-col gap-3">
                {dimensionData.map(dim => {
                    const isCollapsed = collapsedDimensions.has(dim.id);
                    const categoryCount = dim.categories.length;
                    const totalAssets = dim.categories.reduce((sum, c) => sum + (c.asset_count || 0), 0);
                    const unclassifiedCount = unclassifiedCounts[dim.id] || 0;

                    return (
                        <div
                            key={dim.id}
                            className="overflow-hidden border border-slate-200 bg-white transition-colors hover:border-slate-400"
                        >
                            {/* Dimension Header - Always Visible */}
                            <div
                                className="flex cursor-pointer items-center justify-between bg-slate-50 p-3 hover:bg-slate-100"
                                onClick={() => toggleDimensionCollapse(dim.id)}
                            >
                                <div className="flex items-center gap-3">
                                    {/* Collapse Toggle */}
                                    {isCollapsed ? (
                                        <LuChevronRight className="h-5 w-5 text-slate-500" />
                                    ) : (
                                        <LuChevronDown className="h-5 w-5 text-slate-500" />
                                    )}

                                    {/* Dimension Title */}
                                    {editingDimension?.id === dim.id ? (
                                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                            <Input
                                                value={editingDimensionLabel}
                                                onChange={e => setEditingDimensionLabel(e.target.value)}
                                                className="w-[200px]"
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') handleUpdateDimension();
                                                    if (e.key === 'Escape') cancelEdit();
                                                }}
                                                autoFocus
                                            />
                                            <Button
                                                aria-label="Save"
                                                size="sm"
                                                colorScheme="green"
                                                onClick={handleUpdateDimension}
                                            >
                                                <LuCheck />
                                            </Button>
                                            <Button
                                                aria-label="Cancel"
                                                size="sm"
                                                variant="ghost"
                                                onClick={cancelEdit}
                                            >
                                                <LuX />
                                            </Button>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-semibold">{dim.label}</h3>
                                            <Button
                                                aria-label="Edit dimension"
                                                size="sm"
                                                variant="ghost"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    startEditDimension(dim);
                                                }}
                                            >
                                                <LuPencil className="h-3 w-3" />
                                            </Button>
                                        </div>
                                    )}
                                </div>

                                {/* Stats & Actions */}
                                <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
                                    {/* Summary badges */}
                                    <div className="flex items-center gap-2">
                                        <Badge colorScheme="gray">
                                            {categoryCount} {categoryCount === 1 ? 'category' : 'categories'}
                                        </Badge>
                                        <Badge colorScheme="blue">
                                            {totalAssets} assets
                                        </Badge>
                                        {unclassifiedCount > 0 && (
                                            <Badge
                                                colorScheme="orange"
                                                className="cursor-pointer"
                                                onClick={() => openUnclassifiedDrawer(dim)}
                                            >
                                                {unclassifiedCount} unclassified
                                            </Badge>
                                        )}
                                    </div>

                                    {/* Action buttons */}
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => startCreateCategory(dim.id)}
                                    >
                                        <LuPlus className="mr-1" /> Add
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => handleRandomizeColors(dim)}
                                        loading={randomizingDimensionId === dim.id}
                                    >
                                        <LuShuffle className="mr-1" /> Shuffle colors
                                    </Button>
                                    <Button
                                        aria-label="Delete dimension"
                                        size="sm"
                                        variant="ghost"
                                        colorScheme="red"
                                        onClick={() => handleDeleteDimension(dim)}
                                    >
                                        <LuTrash2 className="h-3 w-3" />
                                    </Button>
                                </div>
                            </div>

                            {/* Collapsible Content */}
                            {!isCollapsed && (
                                <div className="p-4">
                                    {/* Unclassified Warning */}
                                    {unclassifiedCount > 0 && (
                                        <div
                                            className="mb-4 cursor-pointer border-l-4 border-orange-400 bg-orange-50 p-3 hover:bg-orange-100"
                                            onClick={() => openUnclassifiedDrawer(dim)}
                                        >
                                            <div className="flex items-center gap-2">
                                                <LuTriangleAlert className="text-orange-500" />
                                                <span className="text-sm font-medium">
                                                    {unclassifiedCount} assets need classification in this dimension
                                                </span>
                                                <span className="text-sm text-slate-500">
                                                    Click to view
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    {/* Category Grid */}
                                    <div className="flex flex-wrap gap-2">
                                        {/* Add category inline form */}
                                        {isCreating && newCategoryDimensionId === dim.id && (
                                            <div className="flex items-center gap-2 border border-dashed border-green-400 bg-slate-50 p-2">
                                                <Input
                                                    placeholder="Category name"
                                                    value={formData.label}
                                                    onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                    className="w-[150px]"
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
                                                    colorScheme="green"
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
                                            </div>
                                        )}

                                        {/* Category pills */}
                                        {dim.categories.map(cat => (
                                            <div key={cat.id}>
                                                {editingCategory?.id === cat.id ? (
                                                    <div className="flex items-center gap-2 border border-blue-400 bg-slate-50 p-2">
                                                        <Input
                                                            value={formData.label}
                                                            onChange={e => setFormData({ ...formData, label: e.target.value })}
                                                            className="w-[150px]"
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
                                                            colorScheme="green"
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
                                                    </div>
                                                ) : (
                                                    <div
                                                        className="flex cursor-pointer items-center gap-2 px-3 py-2 shadow-sm transition-all hover:-translate-y-px hover:opacity-85"
                                                        style={{ backgroundColor: cat.color || DEFAULT_CATEGORY_COLOR }}
                                                        onClick={() => openCategoryDrawer(cat)}
                                                    >
                                                        <span
                                                            className="text-sm font-medium"
                                                            style={{ color: getContrastTextColor(cat.color || DEFAULT_CATEGORY_COLOR) }}
                                                        >
                                                            {cat.label}
                                                        </span>
                                                        {(cat.asset_count || 0) > 0 && (
                                                            <span
                                                                className="text-xs opacity-70"
                                                                style={{ color: getContrastTextColor(cat.color || DEFAULT_CATEGORY_COLOR) }}
                                                            >
                                                                ({cat.asset_count})
                                                            </span>
                                                        )}
                                                        <div className="flex items-center gap-0">
                                                            <Button
                                                                aria-label="Edit"
                                                                size="sm"
                                                                variant="ghost"
                                                                onClick={e => {
                                                                    e.stopPropagation();
                                                                    startEditCategory(cat);
                                                                }}
                                                            >
                                                                <LuPencil className="h-3 w-3" />
                                                            </Button>
                                                            <Button
                                                                aria-label="Delete"
                                                                size="sm"
                                                                variant="ghost"
                                                                colorScheme="red"
                                                                onClick={e => {
                                                                    e.stopPropagation();
                                                                    handleDeleteCategory(cat);
                                                                }}
                                                            >
                                                                <LuTrash2 className="h-3 w-3" />
                                                            </Button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ))}

                                        {dim.categories.length === 0 && !isCreating && (
                                            <div className="w-full border border-dashed border-slate-300 p-4 text-center">
                                                <span className="text-sm text-slate-500">
                                                    No categories yet. Click "Add" to create one.
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}

                {dimensionData.length === 0 && (
                    <div className="border border-dashed border-slate-200 p-8 text-center">
                        <p className="mb-2 text-slate-500">No dimensions defined yet</p>
                        <p className="text-sm text-slate-400">
                            Create dimensions like "Asset Class", "Sector", or "Region" to categorize your assets.
                        </p>
                    </div>
                )}
            </div>

            {/* Assets Drawer (Dialog as drawer) */}
            <RadixDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white p-4 shadow-lg">
                        <div className="mb-3 flex items-center justify-between">
                            <RadixDialog.Title className="text-base font-semibold">
                                {drawerIsUnclassified
                                    ? `Unclassified Assets (${drawerDimensionLabel})`
                                    : `Assets: ${drawerCategory?.label}`}
                            </RadixDialog.Title>
                            <RadixDialog.Close asChild>
                                <Button aria-label="Close" size="sm" variant="ghost">
                                    <LuX />
                                </Button>
                            </RadixDialog.Close>
                        </div>
                        {drawerLoading ? (
                            <div className="flex justify-center py-4">
                                <Spinner />
                            </div>
                        ) : drawerAssets.length === 0 ? (
                            <p className="py-4 text-center text-slate-500">
                                No assets found
                            </p>
                        ) : (
                            <div className="flex max-h-[400px] flex-col items-stretch gap-2 overflow-y-auto">
                                {drawerAssets.map(asset => (
                                    <div
                                        key={asset.asset_id}
                                        className="flex items-center justify-between border border-slate-200 p-2"
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium">{asset.symbol}</span>
                                            {asset.label && (
                                                <span className="text-sm text-slate-500">
                                                    {asset.label}
                                                </span>
                                            )}
                                        </div>
                                        {!drawerIsUnclassified && (
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                colorScheme="red"
                                                onClick={() => handleUnlinkAsset(asset.asset_id)}
                                            >
                                                Unlink
                                            </Button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

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
        </div>
    );
};
