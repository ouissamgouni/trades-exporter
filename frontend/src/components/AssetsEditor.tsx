import {
    Badge, Box,
    Button, Checkbox, Dialog, Flex,
    Heading, Icon, IconButton, Input, NativeSelect, Portal, Spinner,
    Table, Tabs, Tag, Text, Textarea, Progress
} from '@chakra-ui/react';
import React, { useEffect, useState, useRef } from 'react';
import { LuTags, LuSettings } from 'react-icons/lu';
import { API_URL, Asset, AssetPriceGetter, Category, DimensionCategories } from '../types';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { toaster } from './ui/toaster';

// Use ASSET_TYPE_OPTIONS but it now only has 3 values: crypto, stock, fiat
const PRICE_TYPE_OPTIONS = ASSET_TYPE_OPTIONS;

interface PriceGetterFormData {
    price_getter: string;
    external_id: string;  // API identifier: "BTC-USD", "bitcoin", "AAPL"
    priority: number;
    enabled: boolean;
    params: Record<string, any>;  // Extra params: native_quote_currency, source, etc.
}

// Types for CSV import
interface ImportPreviewAsset {
    symbol: string;
    label: string;
    price_type: string;
    currency: string;
    price_getters: { getter: string; priority: number; params: Record<string, any> }[];
    categories: string[];
}

interface ImportPreviewCategory {
    dimension: string;
    dimension_label: string;
    key: string;
    label: string;
}

interface ImportPreviewResult {
    filename: string;
    assets_count: number;
    categories_count: number;
    errors: { row: number; error: string }[];
    warnings: string[];
    assets: ImportPreviewAsset[];
    categories: ImportPreviewCategory[];
}

interface ImportResult {
    assets: { created: number; updated: number; skipped: number; errors: any[] };
    categories: { created: number; updated: number; skipped: number; errors: any[] };
    price_getters: { created: number; updated: number; skipped: number; errors: any[] };
    asset_categories: { created: number; updated: number; skipped: number; errors: any[] };
    parse_errors: any[];
    warnings: string[];
    dry_run: boolean;
    summary: { total_assets: number; total_categories: number; total_price_getters: number; total_errors: number };
}

// Bulk action mode for categories
type BulkCategoryMode = 'add' | 'replace' | 'remove';

export const AssetsEditor: React.FC = () => {
    const [assets, setAssets] = useState<Asset[]>([]);
    const [allAssets, setAllAssets] = useState<Asset[]>([]); // Full dataset for client-side filtering
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [editValues, setEditValues] = useState<Partial<Asset>>({});
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [newAsset, setNewAsset] = useState<Partial<Asset>>({ status: 0 });

    // Extended filters (client-side)
    const [searchFilter, setSearchFilter] = useState(''); // Searches symbol + label
    const [statusFilter, setStatusFilter] = useState<string>('');
    const [typeFilter, setTypeFilter] = useState<string>('');
    const [categoryFilter, setCategoryFilter] = useState<Set<number>>(new Set()); // Category IDs
    const [priceGetterFilter, setPriceGetterFilter] = useState<string>(''); // 'has', 'none', or specific getter
    const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set());

    // Selection state for bulk operations
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

    // Bulk operation dialogs
    const [showBulkStatusDialog, setShowBulkStatusDialog] = useState(false);
    const [showBulkTypeDialog, setShowBulkTypeDialog] = useState(false);
    const [showBulkCategoriesDialog, setShowBulkCategoriesDialog] = useState(false);
    const [showBulkPriceGettersDialog, setShowBulkPriceGettersDialog] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
    const [bulkStatus, setBulkStatus] = useState<number>(0);
    const [bulkType, setBulkType] = useState<string>('');
    const [bulkCategoryMode, setBulkCategoryMode] = useState<BulkCategoryMode>('add');
    const [bulkCategoryIds, setBulkCategoryIds] = useState<Set<number>>(new Set());
    const [bulkPriceGetter, setBulkPriceGetter] = useState<{ price_getter: string; external_id: string; priority: number }>({ price_getter: '', external_id: '', priority: 100 });
    const [bulkOperationLoading, setBulkOperationLoading] = useState(false);

    // Price getter management
    const [availableGetters, setAvailableGetters] = useState<string[]>([]);
    const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
    const [showGettersDialog, setShowGettersDialog] = useState(false);
    const [newGetter, setNewGetter] = useState<PriceGetterFormData>({
        price_getter: '',
        external_id: '',
        priority: 100,
        enabled: true,
        params: {}
    });
    // Inline editing state for price getters
    const [editingGetterId, setEditingGetterId] = useState<number | null>(null);
    const [editingValues, setEditingValues] = useState<{
        external_id: string;
        priority: number;
        params: string;
    }>({ external_id: '', priority: 100, params: '{}' });

    // Category management
    const [dimensionData, setDimensionData] = useState<DimensionCategories[]>([]);
    const [showCategoriesDialog, setShowCategoriesDialog] = useState(false);
    const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<number>>(new Set());
    const [savingCategories, setSavingCategories] = useState(false);

    // CSV Import
    const [showImportDialog, setShowImportDialog] = useState(false);
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
    const [importResult, setImportResult] = useState<ImportResult | null>(null);
    const [importLoading, setImportLoading] = useState(false);
    const [importStep, setImportStep] = useState<'select' | 'preview' | 'result'>('select');
    const [dryRunMode, setDryRunMode] = useState(true);
    const [replacePriceGetters, setReplacePriceGetters] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Confirmation dialogs
    const deleteAssetConfirm = useConfirmDialog<number>();
    const deletePriceGetterConfirm = useConfirmDialog<number>();

    useEffect(() => {
        fetchAllAssets();
        fetchAvailableGetters();
        fetchCategories();
    }, []);

    // Client-side filtering effect
    useEffect(() => {
        const filtered = allAssets.filter(asset => {
            // Search filter (symbol + label)
            if (searchFilter) {
                const search = searchFilter.toLowerCase();
                const matchesSymbol = asset.symbol.toLowerCase().includes(search);
                const matchesLabel = (asset.label || '').toLowerCase().includes(search);
                if (!matchesSymbol && !matchesLabel) return false;
            }

            // Status filter
            if (statusFilter !== '') {
                if (asset.status !== parseInt(statusFilter)) return false;
            }

            // Type filter
            if (typeFilter) {
                if (asset.price_type !== typeFilter) return false;
            }

            // Category filter (asset must have ALL selected categories)
            if (categoryFilter.size > 0) {
                const assetCategoryIds = new Set((asset.categories || []).map(c => c.id));
                for (const catId of categoryFilter) {
                    if (!assetCategoryIds.has(catId)) return false;
                }
            }

            // Price getter filter
            if (priceGetterFilter) {
                const hasGetters = (asset.price_getters || []).length > 0;
                if (priceGetterFilter === 'has' && !hasGetters) return false;
                if (priceGetterFilter === 'none' && hasGetters) return false;
                if (priceGetterFilter !== 'has' && priceGetterFilter !== 'none') {
                    // Specific getter type
                    const hasSpecificGetter = (asset.price_getters || []).some(pg => pg.price_getter === priceGetterFilter);
                    if (!hasSpecificGetter) return false;
                }
            }

            return true;
        });
        setAssets(filtered);
        // Clear selection when filters change
        setSelectedIds(new Set());
    }, [allAssets, searchFilter, statusFilter, typeFilter, categoryFilter, priceGetterFilter]);

    const fetchCategories = async () => {
        try {
            const response = await fetch(`${API_URL}/categories/by-dimension`);
            if (response.ok) {
                const data: DimensionCategories[] = await response.json();
                setDimensionData(data);
            }
        } catch (err) {
            console.error('Failed to fetch categories:', err);
        }
    };

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

    const fetchAllAssets = async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.append('include_getters', 'true');
            params.append('include_categories', 'true');
            params.append('limit', '10000'); // Fetch all for client-side filtering
            const response = await fetch(`${API_URL}/assets?${params}`);
            if (!response.ok) throw new Error('Failed to fetch assets');
            const data = await response.json();
            setAllAssets(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    };

    const refreshAssets = async () => {
        await fetchAllAssets();
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
            await refreshAssets();
            setEditingId(null);
            setEditValues({});
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const createAsset = async () => {
        if (!newAsset.symbol?.trim()) {
            toaster.error({ title: 'Validation error', description: 'Symbol is required' });
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
            await refreshAssets();
            setNewAsset({ status: 0 });
            setShowCreateDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create asset' });
        }
    };

    const deleteAsset = (id: number) => {
        deleteAssetConfirm.open(id);
    };

    const executeDeleteAsset = async () => {
        if (!deleteAssetConfirm.data) return;
        const id = deleteAssetConfirm.data;
        try {
            const response = await fetch(`${API_URL}/assets/${id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete asset');
            await refreshAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete asset' });
        }
    };

    // Price getter CRUD
    const openGettersDialog = (asset: Asset) => {
        setSelectedAsset(asset);
        setShowGettersDialog(true);
        setNewGetter({ price_getter: availableGetters[0] || '', external_id: '', priority: 100, enabled: true, params: {} });
    };

    const addPriceGetter = async () => {
        if (!selectedAsset || !newGetter.price_getter) return;
        try {
            // Build payload with external_id as separate field
            const payload = {
                price_getter: newGetter.price_getter,
                external_id: newGetter.external_id || null,
                priority: newGetter.priority,
                enabled: newGetter.enabled,
                params: newGetter.params || {}
            };
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to add price getter');
            }
            await refreshAssets();
            // Refresh selected asset
            const updatedAsset = assets.find(a => a.asset_id === selectedAsset.asset_id);
            if (updatedAsset) setSelectedAsset(updatedAsset);
            setNewGetter({ price_getter: availableGetters[0] || '', external_id: '', priority: 100, enabled: true, params: {} });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to add price getter' });
        }
    };

    const deletePriceGetter = (getterId: number) => {
        if (!selectedAsset) return;
        deletePriceGetterConfirm.open(getterId);
    };

    const executeDeletePriceGetter = async () => {
        if (!selectedAsset || !deletePriceGetterConfirm.data) return;
        const getterId = deletePriceGetterConfirm.data;
        try {
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/${getterId}`, {
                method: 'DELETE'
            });
            if (!response.ok) throw new Error('Failed to delete price getter');
            await refreshAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete' });
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
            await refreshAssets();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        }
    };

    // Inline editing functions for price getters
    const startEditingGetter = (pg: AssetPriceGetter) => {
        setEditingGetterId(pg.id);
        setEditingValues({
            external_id: pg.external_id || '',
            priority: pg.priority,
            params: JSON.stringify(pg.params || {}, null, 2)
        });
    };

    const cancelEditingGetter = () => {
        setEditingGetterId(null);
        setEditingValues({ external_id: '', priority: 100, params: '{}' });
    };

    const saveEditingGetter = async () => {
        if (!selectedAsset || editingGetterId === null) return;
        try {
            let parsedParams = {};
            try {
                parsedParams = JSON.parse(editingValues.params || '{}');
            } catch {
                toaster.error({ title: 'Validation error', description: 'Invalid JSON in parameters' });
                return;
            }
            const response = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/${editingGetterId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    external_id: editingValues.external_id || null,
                    priority: editingValues.priority,
                    params: parsedParams
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to update');
            }
            await refreshAssets();
            cancelEditingGetter();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        }
    };

    // Category management functions
    const openCategoriesDialog = (asset: Asset) => {
        setSelectedAsset(asset);
        // Initialize selected categories from asset
        const existingIds = new Set((asset.categories || []).map(c => c.id));
        setSelectedCategoryIds(existingIds);
        setShowCategoriesDialog(true);
    };

    const toggleCategory = (categoryId: number) => {
        setSelectedCategoryIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(categoryId)) {
                newSet.delete(categoryId);
            } else {
                newSet.add(categoryId);
            }
            return newSet;
        });
    };

    const saveCategories = async () => {
        if (!selectedAsset) return;
        setSavingCategories(true);
        try {
            const response = await fetch(`${API_URL}/categories/asset/${selectedAsset.asset_id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category_ids: Array.from(selectedCategoryIds) })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to save categories');
            }
            await refreshAssets();
            setShowCategoriesDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save categories' });
        } finally {
            setSavingCategories(false);
        }
    };

    // ============================================================================
    // Bulk Operations
    // ============================================================================

    const toggleSelectAll = () => {
        if (selectedIds.size === assets.length && assets.length > 0) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(assets.map(a => a.asset_id!)));
        }
    };

    const toggleSelectAsset = (assetId: number) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(assetId)) {
                newSet.delete(assetId);
            } else {
                newSet.add(assetId);
            }
            return newSet;
        });
    };

    const clearFilters = () => {
        setSearchFilter('');
        setStatusFilter('');
        setTypeFilter('');
        setCategoryFilter(new Set());
        setPriceGetterFilter('');
        setExpandedDimensions(new Set());
    };

    const hasActiveFilters = searchFilter || statusFilter !== '' || typeFilter || categoryFilter.size > 0 || priceGetterFilter;

    const toggleFilterDimension = (dimension: string) => {
        setExpandedDimensions(prev => {
            const newSet = new Set(prev);
            if (newSet.has(dimension)) {
                newSet.delete(dimension);
            } else {
                newSet.add(dimension);
            }
            return newSet;
        });
    };

    const toggleFilterCategory = (categoryId: number) => {
        setCategoryFilter(prev => {
            const newSet = new Set(prev);
            if (newSet.has(categoryId)) {
                newSet.delete(categoryId);
            } else {
                newSet.add(categoryId);
            }
            return newSet;
        });
    };

    // Bulk Status Update
    const executeBulkStatusUpdate = async () => {
        if (selectedIds.size === 0) return;
        setBulkOperationLoading(true);
        try {
            const response = await fetch(`${API_URL}/assets/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedIds),
                    updates: { status: bulkStatus }
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to update assets');
            }
            await refreshAssets();
            setShowBulkStatusDialog(false);
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update assets' });
        } finally {
            setBulkOperationLoading(false);
        }
    };

    // Bulk Type Update
    const executeBulkTypeUpdate = async () => {
        if (selectedIds.size === 0) return;
        setBulkOperationLoading(true);
        try {
            const response = await fetch(`${API_URL}/assets/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedIds),
                    updates: { price_type: bulkType }
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to update assets');
            }
            await refreshAssets();
            setShowBulkTypeDialog(false);
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update assets' });
        } finally {
            setBulkOperationLoading(false);
        }
    };

    // Bulk Categories Update
    const executeBulkCategoriesUpdate = async () => {
        if (selectedIds.size === 0) return;
        setBulkOperationLoading(true);
        try {
            const response = await fetch(`${API_URL}/assets/bulk/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedIds),
                    category_ids: Array.from(bulkCategoryIds),
                    mode: bulkCategoryMode
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to update categories');
            }
            await refreshAssets();
            setShowBulkCategoriesDialog(false);
            setSelectedIds(new Set());
            setBulkCategoryIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update categories' });
        } finally {
            setBulkOperationLoading(false);
        }
    };

    // Bulk Price Getters Update
    const executeBulkPriceGettersUpdate = async () => {
        if (selectedIds.size === 0 || !bulkPriceGetter.price_getter) return;
        setBulkOperationLoading(true);
        try {
            const response = await fetch(`${API_URL}/assets/bulk/price-getters`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedIds),
                    price_getter: bulkPriceGetter.price_getter,
                    external_id: bulkPriceGetter.external_id || null,
                    priority: bulkPriceGetter.priority
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to assign price getters');
            }
            await refreshAssets();
            setShowBulkPriceGettersDialog(false);
            setSelectedIds(new Set());
            setBulkPriceGetter({ price_getter: '', external_id: '', priority: 100 });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to assign price getters' });
        } finally {
            setBulkOperationLoading(false);
        }
    };

    // Bulk Delete
    const executeBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setBulkOperationLoading(true);
        try {
            const response = await fetch(`${API_URL}/assets/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    asset_ids: Array.from(selectedIds)
                })
            });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Failed to delete assets');
            }
            await refreshAssets();
            setShowBulkDeleteDialog(false);
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete assets' });
        } finally {
            setBulkOperationLoading(false);
        }
    };

    // CSV Import functions
    const openImportDialog = () => {
        setShowImportDialog(true);
        setImportStep('select');
        setImportFile(null);
        setImportPreview(null);
        setImportResult(null);
        setDryRunMode(true);
    };

    const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            setImportFile(file);
        }
    };

    const handleFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file && file.name.endsWith('.csv')) {
            setImportFile(file);
        } else {
            toaster.error({ title: 'Invalid file', description: 'Please drop a CSV file' });
        }
    };

    const previewImport = async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const response = await fetch(`${API_URL}/assets/import-csv/preview`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Preview failed');
            }

            const data: ImportPreviewResult = await response.json();
            setImportPreview(data);
            setImportStep('preview');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to preview CSV' });
        } finally {
            setImportLoading(false);
        }
    };

    const executeImport = async () => {
        if (!importFile) return;
        setImportLoading(true);
        try {
            const formData = new FormData();
            formData.append('file', importFile);

            const params = new URLSearchParams();
            params.append('dry_run', String(dryRunMode));
            params.append('replace_price_getters', String(replacePriceGetters));

            const response = await fetch(`${API_URL}/assets/import-csv?${params}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Import failed');
            }

            const data: ImportResult = await response.json();
            setImportResult(data);
            setImportStep('result');

            // Refresh assets list if not a dry run
            if (!dryRunMode) {
                await refreshAssets();
            }
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to import CSV' });
        } finally {
            setImportLoading(false);
        }
    };

    const resetImportDialog = () => {
        setImportStep('select');
        setImportFile(null);
        setImportPreview(null);
        setImportResult(null);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    };

    const renderAssetCategories = (asset: Asset) => {
        if (!asset.categories || asset.categories.length === 0) {
            return <Text color="gray.400" fontSize="2xs">—</Text>;
        }
        return (
            <Flex gap={0.5} flexWrap="wrap">
                {asset.categories.slice(0, 4).map(cat => (
                    <Badge
                        key={cat.id}
                        fontSize="2xs"
                        px={1}
                        py={0}
                        lineHeight="1.4"
                        style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                        colorPalette={!cat.color ? 'gray' : undefined}
                        variant="subtle"
                        title={`${cat.dimension_label}: ${cat.label}`}
                    >
                        {cat.dimension_label?.charAt(0)}: {cat.label}
                    </Badge>
                ))}
                {asset.categories.length > 4 && (
                    <Badge fontSize="2xs" px={1} py={0} colorPalette="gray" variant="outline">
                        +{asset.categories.length - 4}
                    </Badge>
                )}
            </Flex>
        );
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

        // Helper to format params for tooltip
        const formatParams = (params: Record<string, any>) => {
            if (!params || Object.keys(params).length === 0) return '';
            return Object.entries(params)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
        };

        return (
            <Flex gap={1} flexWrap="wrap">
                {asset.price_getters.map(pg => {
                    const paramsStr = formatParams(pg.params);
                    const tooltip = [
                        pg.price_getter,
                        pg.external_id ? `ID: ${pg.external_id}` : 'ID: auto',
                        `priority: ${pg.priority}`,
                        paramsStr ? `params: {${paramsStr}}` : ''
                    ].filter(Boolean).join(' | ');

                    return (
                        <Badge
                            key={pg.id}
                            colorPalette={pg.enabled ? 'blue' : 'gray'}
                            fontSize="xs"
                            title={tooltip}
                        >
                            {pg.price_getter}
                            {pg.external_id && `: ${pg.external_id}`}
                        </Badge>
                    );
                })}
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
                    <Button colorPalette="green" onClick={openImportDialog}>
                        📥 Import CSV
                    </Button>
                    <Button colorPalette="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Asset
                    </Button>
                    <Button onClick={refreshAssets} variant="outline">
                        🔄 Refresh
                    </Button>
                </Flex>
            </Flex>

            {/* Enhanced Filter Bar */}
            <Box mb={6} p={4} bg="gray.50" borderRadius="md">
                <Flex gap={4} align="flex-start" flexWrap="wrap">
                    {/* Search (Symbol + Label) */}
                    <Flex direction="column" gap={1}>
                        <Text fontWeight="medium" fontSize="xs" color="gray.600">Search</Text>
                        <Input
                            size="sm"
                            width="180px"
                            placeholder="Symbol or label..."
                            value={searchFilter}
                            onChange={e => setSearchFilter(e.target.value)}
                        />
                    </Flex>

                    {/* Status Filter */}
                    <Flex direction="column" gap={1}>
                        <Text fontWeight="medium" fontSize="xs" color="gray.600">Status</Text>
                        <NativeSelect.Root size="sm" width="120px">
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

                    {/* Type Filter */}
                    <Flex direction="column" gap={1}>
                        <Text fontWeight="medium" fontSize="xs" color="gray.600">Type</Text>
                        <NativeSelect.Root size="sm" width="120px">
                            <NativeSelect.Field
                                value={typeFilter}
                                onChange={e => setTypeFilter(e.target.value)}
                            >
                                <option value="">All</option>
                                <option value="crypto">Crypto</option>
                                <option value="stock">Stock</option>
                                <option value="fiat">Fiat</option>
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>

                    {/* Price Getter Filter */}
                    <Flex direction="column" gap={1}>
                        <Text fontWeight="medium" fontSize="xs" color="gray.600">Price Getters</Text>
                        <NativeSelect.Root size="sm" width="140px">
                            <NativeSelect.Field
                                value={priceGetterFilter}
                                onChange={e => setPriceGetterFilter(e.target.value)}
                            >
                                <option value="">All</option>
                                <option value="has">Has any</option>
                                <option value="none">None configured</option>
                                {availableGetters.map(g => (
                                    <option key={g} value={g}>Has: {g}</option>
                                ))}
                            </NativeSelect.Field>
                        </NativeSelect.Root>
                    </Flex>

                    {/* Clear Filters */}
                    {hasActiveFilters && (
                        <Flex direction="column" gap={1} justifyContent="flex-end">
                            <Text fontWeight="medium" fontSize="xs" color="transparent">.</Text>
                            <Button size="sm" variant="outline" onClick={clearFilters}>
                                ✕ Clear Filters
                            </Button>
                        </Flex>
                    )}
                </Flex>

                {/* Hierarchical Category Filter */}
                <Box mt={4} pt={4} borderTop="1px" borderColor="gray.200">
                    <Flex justify="space-between" align="center" mb={2}>
                        <Text fontWeight="medium" fontSize="xs" color="gray.600">Categories Filter</Text>
                        {categoryFilter.size > 0 && (
                            <Button size="xs" variant="ghost" onClick={() => setCategoryFilter(new Set())}>
                                Clear ({categoryFilter.size})
                            </Button>
                        )}
                    </Flex>
                    {dimensionData.length === 0 ? (
                        <Text fontSize="sm" color="gray.400">No categories available</Text>
                    ) : (
                        <Flex direction="column" gap={2}>
                            {dimensionData.map(dim => (
                                <Box key={dim.id}>
                                    <Flex
                                        align="center"
                                        gap={2}
                                        cursor="pointer"
                                        onClick={() => toggleFilterDimension(String(dim.id))}
                                        _hover={{ bg: 'gray.100' }}
                                        p={1}
                                        borderRadius="sm"
                                    >
                                        <Text fontSize="sm">{expandedDimensions.has(String(dim.id)) ? '▼' : '▶'}</Text>
                                        <Text fontSize="sm" fontWeight="medium">{dim.label}</Text>
                                        {dim.categories.some(c => categoryFilter.has(c.id)) && (
                                            <Badge size="sm" colorPalette="blue">
                                                {dim.categories.filter(c => categoryFilter.has(c.id)).length}
                                            </Badge>
                                        )}
                                    </Flex>
                                    {expandedDimensions.has(String(dim.id)) && (
                                        <Flex gap={1} flexWrap="wrap" ml={6} mt={1}>
                                            {dim.categories.map(cat => (
                                                <Badge
                                                    key={cat.id}
                                                    fontSize="xs"
                                                    cursor="pointer"
                                                    onClick={() => toggleFilterCategory(cat.id)}
                                                    style={categoryFilter.has(cat.id)
                                                        ? { backgroundColor: cat.color || '#3182ce', color: '#fff' }
                                                        : { backgroundColor: '#E2E8F0', color: '#4A5568' }
                                                    }
                                                    _hover={{ opacity: 0.8 }}
                                                >
                                                    {categoryFilter.has(cat.id) && '✓ '}
                                                    {cat.label}
                                                </Badge>
                                            ))}
                                        </Flex>
                                    )}
                                </Box>
                            ))}
                        </Flex>
                    )}
                </Box>
            </Box>

            {/* Bulk Actions Bar */}
            {selectedIds.size > 0 && (
                <Box mb={4} p={4} bg="blue.50" borderRadius="md" borderWidth={1} borderColor="blue.200">
                    <Flex justify="space-between" align="center" flexWrap="wrap" gap={2}>
                        <Text fontWeight="medium" color="blue.700">
                            {selectedIds.size} asset{selectedIds.size > 1 ? 's' : ''} selected
                        </Text>
                        <Flex gap={2} flexWrap="wrap">
                            <Button size="sm" colorPalette="blue" variant="outline" onClick={() => { setBulkStatus(0); setShowBulkStatusDialog(true); }}>
                                ✓ Set Status
                            </Button>
                            <Button size="sm" colorPalette="purple" variant="outline" onClick={() => { setBulkType(''); setShowBulkTypeDialog(true); }}>
                                🏷️ Set Type
                            </Button>
                            <Button size="sm" colorPalette="teal" variant="outline" onClick={() => { setBulkCategoryIds(new Set()); setBulkCategoryMode('add'); setShowBulkCategoriesDialog(true); }}>
                                📁 Assign Categories
                            </Button>
                            <Button size="sm" colorPalette="orange" variant="outline" onClick={() => { setBulkPriceGetter({ price_getter: availableGetters[0] || '', external_id: '', priority: 100 }); setShowBulkPriceGettersDialog(true); }}>
                                💰 Assign Price Getters
                            </Button>
                            <Button size="sm" colorPalette="red" variant="outline" onClick={() => setShowBulkDeleteDialog(true)}>
                                🗑️ Delete
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                                ✕ Clear Selection
                            </Button>
                        </Flex>
                    </Flex>
                </Box>
            )}

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" fontSize="xs">
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="30px">
                                <Checkbox.Root
                                    checked={assets.length > 0 && selectedIds.size === assets.length}
                                    onCheckedChange={toggleSelectAll}
                                >
                                    <Checkbox.HiddenInput />
                                    <Checkbox.Control />
                                </Checkbox.Root>
                            </Table.ColumnHeader>
                            <Table.ColumnHeader width="50px">ID</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Symbol</Table.ColumnHeader>
                            <Table.ColumnHeader width="180px">Label</Table.ColumnHeader>
                            <Table.ColumnHeader width="60px">Type</Table.ColumnHeader>
                            <Table.ColumnHeader width="280px">Categories</Table.ColumnHeader>
                            <Table.ColumnHeader width="100px">Getters</Table.ColumnHeader>
                            <Table.ColumnHeader width="60px">Status</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Actions</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {assets.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={9}>
                                    <Text textAlign="center" py={8} color="gray.500">
                                        {allAssets.length === 0 ? 'No assets found' : 'No assets match filters'}
                                    </Text>
                                </Table.Cell>
                            </Table.Row>
                        ) : (
                            assets.map(asset => (
                                <Table.Row key={asset.asset_id} bg={selectedIds.has(asset.asset_id!) ? 'blue.50' : undefined}>
                                    <Table.Cell>
                                        <Checkbox.Root
                                            checked={selectedIds.has(asset.asset_id!)}
                                            onCheckedChange={() => toggleSelectAsset(asset.asset_id!)}
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control />
                                        </Checkbox.Root>
                                    </Table.Cell>
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
                                            {renderAssetCategories(asset)}
                                            <IconButton
                                                size="xs"
                                                variant="ghost"
                                                aria-label="Manage categories"
                                                onClick={() => openCategoriesDialog(asset)}
                                                title="Manage categories"
                                            >
                                                <Icon as={LuTags} boxSize={3.5} />
                                            </IconButton>
                                        </Flex>
                                    </Table.Cell>
                                    <Table.Cell>
                                        <Flex align="center" gap={2}>
                                            {renderPriceGetters(asset)}
                                            <IconButton
                                                size="xs"
                                                variant="ghost"
                                                aria-label="Configure price getters"
                                                onClick={() => openGettersDialog(asset)}
                                            >
                                                <Icon as={LuSettings} boxSize={3.5} />
                                            </IconButton>
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
                <Flex justify="space-between" align="center">
                    <Text fontSize="sm" color="gray.600">
                        <strong>Showing:</strong> {assets.length} of {allAssets.length} assets
                        {hasActiveFilters && ' (filtered)'}
                    </Text>
                    {selectedIds.size > 0 && (
                        <Text fontSize="sm" color="blue.600">
                            <strong>{selectedIds.size}</strong> selected
                        </Text>
                    )}
                </Flex>
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
                        <Dialog.Content maxWidth="700px">
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
                                                    <Table.ColumnHeader>External ID</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Parameters</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Priority</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                                                    <Table.ColumnHeader>Actions</Table.ColumnHeader>
                                                </Table.Row>
                                            </Table.Header>
                                            <Table.Body>
                                                {selectedAsset.price_getters.map(pg => {
                                                    const isEditing = editingGetterId === pg.id;
                                                    const paramsEntries = Object.entries(pg.params || {});
                                                    const hasParams = paramsEntries.length > 0;

                                                    return (
                                                        <Table.Row key={pg.id}>
                                                            <Table.Cell>
                                                                <Badge colorPalette="purple">{pg.price_getter}</Badge>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                {isEditing ? (
                                                                    <Input
                                                                        size="sm"
                                                                        value={editingValues.external_id}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, external_id: e.target.value }))}
                                                                        placeholder="e.g. BTC-USD"
                                                                        fontFamily="mono"
                                                                        width="120px"
                                                                    />
                                                                ) : (
                                                                    <Text fontSize="sm" fontFamily="mono">
                                                                        {pg.external_id || <Text as="span" color="gray.400">(auto)</Text>}
                                                                    </Text>
                                                                )}
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                {isEditing ? (
                                                                    <Textarea
                                                                        size="sm"
                                                                        value={editingValues.params}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, params: e.target.value }))}
                                                                        placeholder='{"key": "value"}'
                                                                        fontFamily="mono"
                                                                        fontSize="xs"
                                                                        rows={2}
                                                                        width="150px"
                                                                    />
                                                                ) : hasParams ? (
                                                                    <Flex gap={1} flexWrap="wrap">
                                                                        {paramsEntries.map(([k, v]) => (
                                                                            <Badge key={k} colorPalette="gray" fontSize="xs">
                                                                                {k}: {String(v)}
                                                                            </Badge>
                                                                        ))}
                                                                    </Flex>
                                                                ) : (
                                                                    <Text fontSize="xs" color="gray.400">—</Text>
                                                                )}
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                {isEditing ? (
                                                                    <Input
                                                                        size="sm"
                                                                        type="number"
                                                                        value={editingValues.priority}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, priority: parseInt(e.target.value) || 100 }))}
                                                                        width="60px"
                                                                    />
                                                                ) : (
                                                                    pg.priority
                                                                )}
                                                            </Table.Cell>
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
                                                                {isEditing ? (
                                                                    <Flex gap={1}>
                                                                        <Button size="xs" colorPalette="green" variant="ghost" onClick={saveEditingGetter}>✓</Button>
                                                                        <Button size="xs" colorPalette="gray" variant="ghost" onClick={cancelEditingGetter}>✕</Button>
                                                                    </Flex>
                                                                ) : (
                                                                    <Flex gap={1}>
                                                                        <Button size="xs" colorPalette="blue" variant="ghost" onClick={() => startEditingGetter(pg)}>✏️</Button>
                                                                        <Button size="xs" colorPalette="red" variant="ghost" onClick={() => deletePriceGetter(pg.id)}>🗑️</Button>
                                                                    </Flex>
                                                                )}
                                                            </Table.Cell>
                                                        </Table.Row>
                                                    );
                                                })}
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
                                                External ID
                                                <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                                                    (e.g., "BTC-USD" for Yahoo, "bitcoin" for CoinGecko, "AAPL" for DataReader)
                                                </Text>
                                            </Text>
                                            <Input
                                                size="sm"
                                                placeholder="Leave empty to use asset symbol"
                                                value={newGetter.external_id || ''}
                                                onChange={e => setNewGetter({
                                                    ...newGetter,
                                                    external_id: e.target.value || ''
                                                })}
                                            />
                                        </Box>
                                        <Box>
                                            <Text fontSize="sm" mb={1}>
                                                Extra Parameters
                                                <Text as="span" color="gray.500" fontSize="xs" ml={1}>
                                                    (JSON, e.g., {`{"native_quote_currency": "EUR"}`})
                                                </Text>
                                            </Text>
                                            <Input
                                                size="sm"
                                                placeholder='{"native_quote_currency": "USD"}'
                                                value={Object.keys(newGetter.params).length > 0 ? JSON.stringify(newGetter.params) : ''}
                                                onChange={e => {
                                                    try {
                                                        const parsed = e.target.value ? JSON.parse(e.target.value) : {};
                                                        setNewGetter({ ...newGetter, params: parsed });
                                                    } catch {
                                                        // Invalid JSON, keep current value
                                                    }
                                                }}
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

            {/* Categories Assignment Dialog */}
            <Dialog.Root open={showCategoriesDialog} onOpenChange={(e) => setShowCategoriesDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="650px">
                            <Dialog.Header>
                                <Dialog.Title>
                                    🏷️ Categories for {selectedAsset?.symbol}
                                </Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Assign categories to classify this asset for reporting and filtering.
                                    Select categories from each dimension as needed.
                                </Text>

                                {dimensionData.length === 0 ? (
                                    <Box textAlign="center" py={6}>
                                        <Text color="gray.500">No categories available. Create some in the Categories editor first.</Text>
                                    </Box>
                                ) : (
                                    <Tabs.Root defaultValue={String(dimensionData[0]?.id)}>
                                        <Tabs.List mb={4}>
                                            {dimensionData.map(dim => (
                                                <Tabs.Trigger key={dim.id} value={String(dim.id)}>
                                                    {dim.label}
                                                    {dim.categories.some(c => selectedCategoryIds.has(c.id)) && (
                                                        <Badge ml={1} colorPalette="blue" size="sm">
                                                            {dim.categories.filter(c => selectedCategoryIds.has(c.id)).length}
                                                        </Badge>
                                                    )}
                                                </Tabs.Trigger>
                                            ))}
                                        </Tabs.List>

                                        {dimensionData.map(dim => (
                                            <Tabs.Content key={dim.id} value={String(dim.id)}>
                                                <Box
                                                    maxHeight="300px"
                                                    overflowY="auto"
                                                    border="1px"
                                                    borderColor="gray.200"
                                                    borderRadius="md"
                                                    p={3}
                                                >
                                                    {dim.categories.length === 0 ? (
                                                        <Text color="gray.500" fontSize="sm">No categories in this dimension.</Text>
                                                    ) : (
                                                        <Flex direction="column" gap={2}>
                                                            {dim.categories.map(cat => (
                                                                <Flex
                                                                    key={cat.id}
                                                                    align="center"
                                                                    gap={3}
                                                                    p={2}
                                                                    borderRadius="md"
                                                                    bg={selectedCategoryIds.has(cat.id) ? 'blue.50' : 'transparent'}
                                                                    _hover={{ bg: selectedCategoryIds.has(cat.id) ? 'blue.100' : 'gray.50' }}
                                                                    cursor="pointer"
                                                                    onClick={() => toggleCategory(cat.id)}
                                                                >
                                                                    <Checkbox.Root
                                                                        checked={selectedCategoryIds.has(cat.id)}
                                                                        onCheckedChange={() => toggleCategory(cat.id)}
                                                                    >
                                                                        <Checkbox.HiddenInput />
                                                                        <Checkbox.Control />
                                                                    </Checkbox.Root>
                                                                    {cat.color && (
                                                                        <Box
                                                                            w={3}
                                                                            h={3}
                                                                            borderRadius="full"
                                                                            bg={cat.color}
                                                                        />
                                                                    )}
                                                                    <Box flex={1}>
                                                                        <Text fontWeight="medium" fontSize="sm">{cat.label}</Text>
                                                                    </Box>
                                                                </Flex>
                                                            ))}
                                                        </Flex>
                                                    )}
                                                </Box>
                                            </Tabs.Content>
                                        ))}
                                    </Tabs.Root>
                                )}

                                {/* Selected summary */}
                                {selectedCategoryIds.size > 0 && (
                                    <Box mt={4} p={3} bg="gray.50" borderRadius="md">
                                        <Text fontSize="sm" fontWeight="medium" mb={2}>
                                            Selected ({selectedCategoryIds.size}):
                                        </Text>
                                        <Flex gap={1} flexWrap="wrap">
                                            {dimensionData.flatMap(dim =>
                                                dim.categories
                                                    .filter(c => selectedCategoryIds.has(c.id))
                                                    .map(cat => (
                                                        <Badge
                                                            key={cat.id}
                                                            fontSize="xs"
                                                            style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                                                            colorPalette={!cat.color ? 'purple' : undefined}
                                                        >
                                                            {cat.label}
                                                            <Box
                                                                as="span"
                                                                ml={1}
                                                                cursor="pointer"
                                                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); toggleCategory(cat.id); }}
                                                            >
                                                                ✕
                                                            </Box>
                                                        </Badge>
                                                    ))
                                            )}
                                        </Flex>
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowCategoriesDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button
                                        colorPalette="blue"
                                        onClick={saveCategories}
                                        loading={savingCategories}
                                    >
                                        💾 Save Categories
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* CSV Import Dialog */}
            <Dialog.Root open={showImportDialog} onOpenChange={(e) => { setShowImportDialog(e.open); if (!e.open) resetImportDialog(); }}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="800px">
                            <Dialog.Header>
                                <Dialog.Title>
                                    📥 Import Assets from CSV
                                </Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                {importStep === 'select' && (
                                    <Box>
                                        <Text fontSize="sm" color="gray.600" mb={4}>
                                            Upload a CSV file to bulk import assets with price getters and categories.
                                        </Text>

                                        {/* File drop zone */}
                                        <Box
                                            border="2px dashed"
                                            borderColor={importFile ? 'green.400' : 'gray.300'}
                                            borderRadius="md"
                                            p={8}
                                            textAlign="center"
                                            bg={importFile ? 'green.50' : 'gray.50'}
                                            cursor="pointer"
                                            onClick={() => fileInputRef.current?.click()}
                                            onDragOver={(e) => e.preventDefault()}
                                            onDrop={handleFileDrop}
                                            _hover={{ borderColor: 'blue.400', bg: 'blue.50' }}
                                            transition="all 0.2s"
                                        >
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                accept=".csv"
                                                onChange={handleFileSelect}
                                                style={{ display: 'none' }}
                                            />
                                            {importFile ? (
                                                <Box>
                                                    <Text fontSize="lg" fontWeight="medium" color="green.600">
                                                        ✅ {importFile.name}
                                                    </Text>
                                                    <Text fontSize="sm" color="gray.500" mt={1}>
                                                        {(importFile.size / 1024).toFixed(1)} KB
                                                    </Text>
                                                    <Button size="sm" mt={3} variant="outline" onClick={(e) => { e.stopPropagation(); setImportFile(null); }}>
                                                        Choose Different File
                                                    </Button>
                                                </Box>
                                            ) : (
                                                <Box>
                                                    <Text fontSize="lg" mb={2}>📂</Text>
                                                    <Text fontWeight="medium">Drop CSV file here or click to browse</Text>
                                                    <Text fontSize="sm" color="gray.500" mt={1}>
                                                        Supports: .csv files
                                                    </Text>
                                                </Box>
                                            )}
                                        </Box>

                                        {/* Expected format info */}
                                        <Box mt={4} p={3} bg="blue.50" borderRadius="md">
                                            <Text fontSize="sm" fontWeight="medium" color="blue.700" mb={2}>
                                                Expected CSV Format:
                                            </Text>
                                            <Text fontSize="xs" color="blue.600" fontFamily="mono">
                                                Ticker / Symbol, Label, Source 1, Symbol 1, Source 2, Symbol 2,
                                                Source 3, Symbol 3, Currency, Investment Category 1, Investment Category 2
                                            </Text>
                                        </Box>
                                    </Box>
                                )}

                                {importStep === 'preview' && importPreview && (
                                    <Box>
                                        <Flex gap={4} mb={4}>
                                            <Box flex={1} p={3} bg="blue.50" borderRadius="md">
                                                <Text fontSize="2xl" fontWeight="bold" color="blue.600">
                                                    {importPreview.assets_count}
                                                </Text>
                                                <Text fontSize="sm" color="blue.600">Assets</Text>
                                            </Box>
                                            <Box flex={1} p={3} bg="purple.50" borderRadius="md">
                                                <Text fontSize="2xl" fontWeight="bold" color="purple.600">
                                                    {importPreview.categories_count}
                                                </Text>
                                                <Text fontSize="sm" color="purple.600">Categories</Text>
                                            </Box>
                                            {importPreview.errors.length > 0 && (
                                                <Box flex={1} p={3} bg="red.50" borderRadius="md">
                                                    <Text fontSize="2xl" fontWeight="bold" color="red.600">
                                                        {importPreview.errors.length}
                                                    </Text>
                                                    <Text fontSize="sm" color="red.600">Parse Errors</Text>
                                                </Box>
                                            )}
                                        </Flex>

                                        {/* Preview table */}
                                        <Text fontWeight="medium" mb={2}>Assets to Import:</Text>
                                        <Box maxHeight="300px" overflowY="auto" border="1px" borderColor="gray.200" borderRadius="md">
                                            <Table.Root size="sm">
                                                <Table.Header>
                                                    <Table.Row>
                                                        <Table.ColumnHeader>Symbol</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Label</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Type</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Price Getters</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Categories</Table.ColumnHeader>
                                                    </Table.Row>
                                                </Table.Header>
                                                <Table.Body>
                                                    {importPreview.assets.slice(0, 20).map((asset, idx) => (
                                                        <Table.Row key={idx}>
                                                            <Table.Cell>
                                                                <Badge colorPalette="blue">{asset.symbol}</Badge>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Text fontSize="sm" truncate maxW="150px">{asset.label}</Text>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Tag.Root size="sm" colorPalette={
                                                                    asset.price_type === 'crypto' ? 'orange' :
                                                                        asset.price_type === 'stock' ? 'blue' : 'green'
                                                                }>
                                                                    <Tag.Label>{asset.price_type}</Tag.Label>
                                                                </Tag.Root>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Flex gap={1} flexWrap="wrap">
                                                                    {asset.price_getters.map((pg, i) => (
                                                                        <Badge key={i} fontSize="xs" colorPalette="purple">
                                                                            {pg.getter}
                                                                        </Badge>
                                                                    ))}
                                                                </Flex>
                                                            </Table.Cell>
                                                            <Table.Cell>
                                                                <Flex gap={1} flexWrap="wrap">
                                                                    {asset.categories.slice(0, 2).map((cat, i) => (
                                                                        <Badge key={i} fontSize="xs" colorPalette="gray">
                                                                            {cat}
                                                                        </Badge>
                                                                    ))}
                                                                </Flex>
                                                            </Table.Cell>
                                                        </Table.Row>
                                                    ))}
                                                </Table.Body>
                                            </Table.Root>
                                            {importPreview.assets.length > 20 && (
                                                <Text fontSize="sm" color="gray.500" p={2} textAlign="center">
                                                    ... and {importPreview.assets.length - 20} more assets
                                                </Text>
                                            )}
                                        </Box>

                                        {/* Import options */}
                                        <Box mt={4} p={3} bg="gray.50" borderRadius="md">
                                            <Text fontWeight="medium" mb={3}>Import Options:</Text>
                                            <Flex direction="column" gap={3}>
                                                <Flex align="center" gap={3}>
                                                    <Checkbox.Root
                                                        checked={dryRunMode}
                                                        onCheckedChange={(e) => setDryRunMode(!!e.checked)}
                                                    >
                                                        <Checkbox.HiddenInput />
                                                        <Checkbox.Control />
                                                    </Checkbox.Root>
                                                    <Box>
                                                        <Text fontWeight="medium" fontSize="sm">Dry Run (Preview Only)</Text>
                                                        <Text fontSize="xs" color="gray.500">
                                                            See what would be imported without making changes
                                                        </Text>
                                                    </Box>
                                                </Flex>
                                                <Flex align="center" gap={3}>
                                                    <Checkbox.Root
                                                        checked={replacePriceGetters}
                                                        onCheckedChange={(e) => setReplacePriceGetters(!!e.checked)}
                                                    >
                                                        <Checkbox.HiddenInput />
                                                        <Checkbox.Control />
                                                    </Checkbox.Root>
                                                    <Box>
                                                        <Text fontWeight="medium" fontSize="sm">Replace Existing Price Getters</Text>
                                                        <Text fontSize="xs" color="gray.500">
                                                            Uncheck to merge with existing price getters
                                                        </Text>
                                                    </Box>
                                                </Flex>
                                            </Flex>
                                        </Box>

                                        {/* Errors/warnings */}
                                        {importPreview.errors.length > 0 && (
                                            <Box mt={4} p={3} bg="red.50" borderRadius="md">
                                                <Text fontWeight="medium" color="red.600" mb={2}>⚠️ Parse Errors:</Text>
                                                {importPreview.errors.slice(0, 5).map((err, i) => (
                                                    <Text key={i} fontSize="sm" color="red.600">
                                                        Row {err.row}: {err.error}
                                                    </Text>
                                                ))}
                                                {importPreview.errors.length > 5 && (
                                                    <Text fontSize="sm" color="red.500">
                                                        ... and {importPreview.errors.length - 5} more errors
                                                    </Text>
                                                )}
                                            </Box>
                                        )}
                                    </Box>
                                )}

                                {importStep === 'result' && importResult && (
                                    <Box>
                                        <Box
                                            p={4}
                                            bg={importResult.dry_run ? 'blue.50' : 'green.50'}
                                            borderRadius="md"
                                            mb={4}
                                            textAlign="center"
                                        >
                                            <Text fontSize="xl" fontWeight="bold" color={importResult.dry_run ? 'blue.600' : 'green.600'}>
                                                {importResult.dry_run ? '🔍 Dry Run Complete' : '✅ Import Successful!'}
                                            </Text>
                                            {importResult.dry_run && (
                                                <Text fontSize="sm" color="blue.600" mt={1}>
                                                    No changes were made. Uncheck "Dry Run" and import again to apply changes.
                                                </Text>
                                            )}
                                        </Box>

                                        <Flex gap={4} mb={4} flexWrap="wrap">
                                            <Box flex={1} p={3} bg="gray.50" borderRadius="md" minW="150px">
                                                <Text fontWeight="medium" mb={2}>Assets</Text>
                                                <Flex gap={2}>
                                                    <Badge colorPalette="green">{importResult.assets.created} created</Badge>
                                                    <Badge colorPalette="blue">{importResult.assets.updated} updated</Badge>
                                                </Flex>
                                            </Box>
                                            <Box flex={1} p={3} bg="gray.50" borderRadius="md" minW="150px">
                                                <Text fontWeight="medium" mb={2}>Categories</Text>
                                                <Flex gap={2}>
                                                    <Badge colorPalette="green">{importResult.categories.created} created</Badge>
                                                    <Badge colorPalette="blue">{importResult.categories.updated} updated</Badge>
                                                </Flex>
                                            </Box>
                                            <Box flex={1} p={3} bg="gray.50" borderRadius="md" minW="150px">
                                                <Text fontWeight="medium" mb={2}>Price Getters</Text>
                                                <Flex gap={2}>
                                                    <Badge colorPalette="green">{importResult.price_getters.created} created</Badge>
                                                </Flex>
                                            </Box>
                                            <Box flex={1} p={3} bg="gray.50" borderRadius="md" minW="150px">
                                                <Text fontWeight="medium" mb={2}>Category Links</Text>
                                                <Flex gap={2}>
                                                    <Badge colorPalette="green">{importResult.asset_categories.created} created</Badge>
                                                </Flex>
                                            </Box>
                                        </Flex>

                                        {importResult.summary.total_errors > 0 && (
                                            <Box p={3} bg="red.50" borderRadius="md">
                                                <Text fontWeight="medium" color="red.600" mb={2}>
                                                    ⚠️ {importResult.summary.total_errors} Errors:
                                                </Text>
                                                {importResult.parse_errors.slice(0, 3).map((err, i) => (
                                                    <Text key={i} fontSize="sm" color="red.600">
                                                        {JSON.stringify(err)}
                                                    </Text>
                                                ))}
                                            </Box>
                                        )}

                                        {importResult.warnings.length > 0 && (
                                            <Box mt={3} p={3} bg="yellow.50" borderRadius="md">
                                                <Text fontWeight="medium" color="yellow.700" mb={2}>
                                                    ⚠️ Warnings:
                                                </Text>
                                                {importResult.warnings.slice(0, 5).map((warn, i) => (
                                                    <Text key={i} fontSize="sm" color="yellow.700">{warn}</Text>
                                                ))}
                                            </Box>
                                        )}
                                    </Box>
                                )}

                                {importLoading && (
                                    <Flex justify="center" align="center" py={8}>
                                        <Spinner size="lg" color="blue.500" />
                                        <Text ml={3}>Processing...</Text>
                                    </Flex>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2} justify="space-between" width="100%">
                                    <Box>
                                        {importStep !== 'select' && (
                                            <Button variant="outline" onClick={resetImportDialog}>
                                                ← Start Over
                                            </Button>
                                        )}
                                    </Box>
                                    <Flex gap={2}>
                                        <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                                            {importStep === 'result' ? 'Close' : 'Cancel'}
                                        </Button>
                                        {importStep === 'select' && (
                                            <Button
                                                colorPalette="blue"
                                                onClick={previewImport}
                                                disabled={!importFile || importLoading}
                                            >
                                                Preview Import →
                                            </Button>
                                        )}
                                        {importStep === 'preview' && (
                                            <Button
                                                colorPalette={dryRunMode ? 'blue' : 'green'}
                                                onClick={executeImport}
                                                disabled={importLoading}
                                            >
                                                {dryRunMode ? '🔍 Run Dry Import' : '📥 Import Assets'}
                                            </Button>
                                        )}
                                        {importStep === 'result' && importResult?.dry_run && (
                                            <Button
                                                colorPalette="green"
                                                onClick={() => { setDryRunMode(false); setImportStep('preview'); }}
                                            >
                                                📥 Import for Real
                                            </Button>
                                        )}
                                    </Flex>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Status Dialog */}
            <Dialog.Root open={showBulkStatusDialog} onOpenChange={(e) => setShowBulkStatusDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Set Status for {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Change the status of all selected assets.
                                </Text>
                                <Box>
                                    <Text fontWeight="medium" mb={2}>New Status</Text>
                                    <NativeSelect.Root>
                                        <NativeSelect.Field
                                            value={String(bulkStatus)}
                                            onChange={e => setBulkStatus(parseInt(e.target.value))}
                                        >
                                            <option value="0">Active</option>
                                            <option value="1">Inactive</option>
                                        </NativeSelect.Field>
                                    </NativeSelect.Root>
                                </Box>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkStatusDialog(false)}>Cancel</Button>
                                    <Button colorPalette="blue" onClick={executeBulkStatusUpdate} loading={bulkOperationLoading}>
                                        Apply to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Type Dialog */}
            <Dialog.Root open={showBulkTypeDialog} onOpenChange={(e) => setShowBulkTypeDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Set Type for {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Change the price type of all selected assets.
                                </Text>
                                <Box>
                                    <Text fontWeight="medium" mb={2}>New Type</Text>
                                    <NativeSelect.Root>
                                        <NativeSelect.Field
                                            value={bulkType}
                                            onChange={e => setBulkType(e.target.value)}
                                        >
                                            <option value="">-- Select Type --</option>
                                            <option value="crypto">Crypto</option>
                                            <option value="stock">Stock</option>
                                            <option value="fiat">Fiat</option>
                                        </NativeSelect.Field>
                                    </NativeSelect.Root>
                                </Box>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkTypeDialog(false)}>Cancel</Button>
                                    <Button colorPalette="purple" onClick={executeBulkTypeUpdate} loading={bulkOperationLoading} disabled={!bulkType}>
                                        Apply to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Categories Dialog */}
            <Dialog.Root open={showBulkCategoriesDialog} onOpenChange={(e) => setShowBulkCategoriesDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="650px">
                            <Dialog.Header>
                                <Dialog.Title>Assign Categories to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Select how to apply categories to the selected assets.
                                </Text>

                                {/* Mode Selection */}
                                <Box mb={4} p={3} bg="gray.50" borderRadius="md">
                                    <Text fontWeight="medium" mb={2}>Operation Mode</Text>
                                    <Flex gap={2}>
                                        <Button
                                            size="sm"
                                            colorPalette={bulkCategoryMode === 'add' ? 'teal' : 'gray'}
                                            variant={bulkCategoryMode === 'add' ? 'solid' : 'outline'}
                                            onClick={() => setBulkCategoryMode('add')}
                                        >
                                            ➕ Add to existing
                                        </Button>
                                        <Button
                                            size="sm"
                                            colorPalette={bulkCategoryMode === 'replace' ? 'teal' : 'gray'}
                                            variant={bulkCategoryMode === 'replace' ? 'solid' : 'outline'}
                                            onClick={() => setBulkCategoryMode('replace')}
                                        >
                                            🔄 Replace all
                                        </Button>
                                        <Button
                                            size="sm"
                                            colorPalette={bulkCategoryMode === 'remove' ? 'red' : 'gray'}
                                            variant={bulkCategoryMode === 'remove' ? 'solid' : 'outline'}
                                            onClick={() => setBulkCategoryMode('remove')}
                                        >
                                            ➖ Remove
                                        </Button>
                                    </Flex>
                                    <Text fontSize="xs" color="gray.500" mt={2}>
                                        {bulkCategoryMode === 'add' && 'Selected categories will be added to assets (keeping existing).'}
                                        {bulkCategoryMode === 'replace' && 'All existing categories will be replaced with selected ones.'}
                                        {bulkCategoryMode === 'remove' && 'Selected categories will be removed from assets.'}
                                    </Text>
                                </Box>

                                {/* Category Selection */}
                                {dimensionData.length === 0 ? (
                                    <Box textAlign="center" py={6}>
                                        <Text color="gray.500">No categories available.</Text>
                                    </Box>
                                ) : (
                                    <Tabs.Root defaultValue={String(dimensionData[0]?.id)}>
                                        <Tabs.List mb={4}>
                                            {dimensionData.map(dim => (
                                                <Tabs.Trigger key={dim.id} value={String(dim.id)}>
                                                    {dim.label}
                                                    {dim.categories.some(c => bulkCategoryIds.has(c.id)) && (
                                                        <Badge ml={1} colorPalette="teal" size="sm">
                                                            {dim.categories.filter(c => bulkCategoryIds.has(c.id)).length}
                                                        </Badge>
                                                    )}
                                                </Tabs.Trigger>
                                            ))}
                                        </Tabs.List>

                                        {dimensionData.map(dim => (
                                            <Tabs.Content key={dim.id} value={String(dim.id)}>
                                                <Box maxHeight="250px" overflowY="auto" border="1px" borderColor="gray.200" borderRadius="md" p={3}>
                                                    {dim.categories.length === 0 ? (
                                                        <Text color="gray.500" fontSize="sm">No categories in this dimension.</Text>
                                                    ) : (
                                                        <Flex direction="column" gap={2}>
                                                            {dim.categories.map(cat => (
                                                                <Flex
                                                                    key={cat.id}
                                                                    align="center"
                                                                    gap={3}
                                                                    p={2}
                                                                    borderRadius="md"
                                                                    bg={bulkCategoryIds.has(cat.id) ? 'teal.50' : 'transparent'}
                                                                    _hover={{ bg: bulkCategoryIds.has(cat.id) ? 'teal.100' : 'gray.50' }}
                                                                    cursor="pointer"
                                                                    onClick={() => {
                                                                        setBulkCategoryIds(prev => {
                                                                            const newSet = new Set(prev);
                                                                            if (newSet.has(cat.id)) {
                                                                                newSet.delete(cat.id);
                                                                            } else {
                                                                                newSet.add(cat.id);
                                                                            }
                                                                            return newSet;
                                                                        });
                                                                    }}
                                                                >
                                                                    <Checkbox.Root checked={bulkCategoryIds.has(cat.id)}>
                                                                        <Checkbox.HiddenInput />
                                                                        <Checkbox.Control />
                                                                    </Checkbox.Root>
                                                                    {cat.color && (
                                                                        <Box w={3} h={3} borderRadius="full" bg={cat.color} />
                                                                    )}
                                                                    <Box flex={1}>
                                                                        <Text fontWeight="medium" fontSize="sm">{cat.label}</Text>
                                                                    </Box>
                                                                </Flex>
                                                            ))}
                                                        </Flex>
                                                    )}
                                                </Box>
                                            </Tabs.Content>
                                        ))}
                                    </Tabs.Root>
                                )}

                                {/* Selected Summary */}
                                {bulkCategoryIds.size > 0 && (
                                    <Box mt={4} p={3} bg="gray.50" borderRadius="md">
                                        <Text fontSize="sm" fontWeight="medium" mb={2}>
                                            Selected ({bulkCategoryIds.size}):
                                        </Text>
                                        <Flex gap={1} flexWrap="wrap">
                                            {dimensionData.flatMap(dim =>
                                                dim.categories
                                                    .filter(c => bulkCategoryIds.has(c.id))
                                                    .map(cat => (
                                                        <Badge
                                                            key={cat.id}
                                                            fontSize="xs"
                                                            style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                                                            colorPalette={!cat.color ? 'teal' : undefined}
                                                        >
                                                            {cat.label}
                                                        </Badge>
                                                    ))
                                            )}
                                        </Flex>
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkCategoriesDialog(false)}>Cancel</Button>
                                    <Button
                                        colorPalette="teal"
                                        onClick={executeBulkCategoriesUpdate}
                                        loading={bulkOperationLoading}
                                        disabled={bulkCategoryIds.size === 0}
                                    >
                                        {bulkCategoryMode === 'add' && '➕ Add'}
                                        {bulkCategoryMode === 'replace' && '🔄 Replace'}
                                        {bulkCategoryMode === 'remove' && '➖ Remove'}
                                        {' '}Categories
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Price Getters Dialog */}
            <Dialog.Root open={showBulkPriceGettersDialog} onOpenChange={(e) => setShowBulkPriceGettersDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="500px">
                            <Dialog.Header>
                                <Dialog.Title>Assign Price Getter to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text fontSize="sm" color="gray.600" mb={4}>
                                    Add a price getter to all selected assets. This will add to existing getters.
                                </Text>

                                <Flex direction="column" gap={4}>
                                    <Box>
                                        <Text fontWeight="medium" mb={2}>Price Getter Source</Text>
                                        <NativeSelect.Root>
                                            <NativeSelect.Field
                                                value={bulkPriceGetter.price_getter}
                                                onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, price_getter: e.target.value })}
                                            >
                                                <option value="">-- Select Source --</option>
                                                {availableGetters.map(g => (
                                                    <option key={g} value={g}>{g}</option>
                                                ))}
                                            </NativeSelect.Field>
                                        </NativeSelect.Root>
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={1}>External ID (optional)</Text>
                                        <Input
                                            placeholder="Leave empty to use asset symbol"
                                            value={bulkPriceGetter.external_id}
                                            onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, external_id: e.target.value })}
                                        />
                                        <Text fontSize="xs" color="gray.500" mt={1}>
                                            If empty, each asset's symbol will be used as the external ID.
                                        </Text>
                                    </Box>

                                    <Box>
                                        <Text fontWeight="medium" mb={2}>Priority</Text>
                                        <Input
                                            type="number"
                                            value={bulkPriceGetter.priority}
                                            onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, priority: parseInt(e.target.value) || 100 })}
                                        />
                                        <Text fontSize="xs" color="gray.500" mt={1}>
                                            Lower values = higher priority (tried first)
                                        </Text>
                                    </Box>
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkPriceGettersDialog(false)}>Cancel</Button>
                                    <Button
                                        colorPalette="orange"
                                        onClick={executeBulkPriceGettersUpdate}
                                        loading={bulkOperationLoading}
                                        disabled={!bulkPriceGetter.price_getter}
                                    >
                                        Assign to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Bulk Delete Dialog */}
            <Dialog.Root open={showBulkDeleteDialog} onOpenChange={(e) => setShowBulkDeleteDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}?</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Box p={4} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                                    <Text color="red.700" fontWeight="medium" mb={2}>⚠️ Warning</Text>
                                    <Text color="red.600" fontSize="sm">
                                        This action cannot be undone. All selected assets and their associated
                                        price getters and category assignments will be permanently deleted.
                                    </Text>
                                </Box>
                                <Box mt={4}>
                                    <Text fontSize="sm" color="gray.600">
                                        You are about to delete <strong>{selectedIds.size}</strong> asset{selectedIds.size > 1 ? 's' : ''}.
                                    </Text>
                                </Box>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>Cancel</Button>
                                    <Button colorPalette="red" onClick={executeBulkDelete} loading={bulkOperationLoading}>
                                        🗑️ Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Asset Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deleteAssetConfirm.isOpen}
                onClose={deleteAssetConfirm.close}
                onConfirm={executeDeleteAsset}
                title="Delete Asset"
                message="Are you sure you want to delete this asset?"
                confirmLabel="Delete"
                isDestructive
            />

            {/* Delete Price Getter Confirmation Dialog */}
            <ConfirmDialog
                isOpen={deletePriceGetterConfirm.isOpen}
                onClose={deletePriceGetterConfirm.close}
                onConfirm={executeDeletePriceGetter}
                title="Delete Price Getter"
                message="Delete this price getter?"
                confirmLabel="Delete"
                isDestructive
            />
        </Box>
    );
};
