import {
    Badge, Box,
    Button, Checkbox, Dialog, Flex,
    Heading, Icon, IconButton, Input, NativeSelect, Portal, SimpleGrid, Slider, Spinner, Switch,
    Table, Tabs, Tag, Text, Textarea, Progress
} from '@chakra-ui/react';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { LuChevronDown, LuFilter, LuPlay, LuSearch, LuCheck, LuTags, LuSettings, LuTrash2, LuX } from 'react-icons/lu';
import { API_URL, Asset, AssetPriceGetter, Category, DimensionCategories } from '../types';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { DeleteAssetDialog } from './DeleteAssetDialog';
import { Tooltip } from './ui/tooltip';
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

    // Deletion impact check
    const [deletionImpact, setDeletionImpact] = useState<Record<string, number>>({});
    const [isImpactLoading, setIsImpactLoading] = useState(false);

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

    // Filter section
    const [filtersExpanded, setFiltersExpanded] = useState(false);

    // Mock mode
    const [mockModeEnabled, setMockModeEnabled] = useState(false);
    const [mockModeLoading, setMockModeLoading] = useState(false);

    // Price getter test modal
    const [showTestModal, setShowTestModal] = useState(false);
    const [testModalGetter, setTestModalGetter] = useState<AssetPriceGetter | null>(null);
    const [testDate, setTestDate] = useState<string>(() => {
        const d = new Date(); d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
    });
    const [testResult, setTestResult] = useState<{ success: boolean; price?: number; error?: string; quote_currency?: string; source?: string; ticker_used?: string } | null>(null);
    const [testLoading, setTestLoading] = useState(false);

    // Auto-test results: map from getter id -> test result
    const [autoTestResults, setAutoTestResults] = useState<Record<number, { success: boolean; price?: number; error?: string; loading?: boolean }>>({});

    // Test for unsaved getter (add form)
    const [newGetterTestResult, setNewGetterTestResult] = useState<{ success: boolean; price?: number; error?: string } | null>(null);
    const [newGetterTestLoading, setNewGetterTestLoading] = useState(false);

    // Click-to-edit: which cell is being edited { assetId, field }
    const [editingCell, setEditingCell] = useState<{ assetId: number; field: string } | null>(null);
    const [cellValue, setCellValue] = useState<string>('');

    // Confirmation dialogs
    const [deleteTarget, setDeleteTarget] = useState<{ id: number; symbol: string } | null>(null);
    const deletePriceGetterConfirm = useConfirmDialog<number>();

    // Transaction counts per asset_id
    const [txCountsByAssetId, setTxCountsByAssetId] = useState<Record<number, number>>({});

    // Asset transactions drawer state
    const [drawerAsset, setDrawerAsset] = useState<{ id: number; symbol: string } | null>(null);
    const drawerFilters = useMemo<TransactionFilterState | undefined>(() => {
        if (!drawerAsset) return undefined;
        return { ...defaultFilterState, relatedAssetIds: [String(drawerAsset.id)] };
    }, [drawerAsset]);

    const fetchTransactionCounts = async () => {
        try {
            const response = await fetch(`${API_URL}/assets/transaction-counts-by-id`);
            if (response.ok) {
                const data: Record<number, number> = await response.json();
                setTxCountsByAssetId(data);
            }
        } catch (err) {
            console.error('Failed to fetch transaction counts:', err);
        }
    };

    useEffect(() => {
        fetchAllAssets();
        fetchAvailableGetters();
        fetchCategories();
        fetchMockMode();
        fetchTransactionCounts();
    }, []);

    // Client-side filtering derived from allAssets (no separate state copy)
    const assets = useMemo(() => {
        return allAssets.filter(asset => {
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
    }, [allAssets, searchFilter, statusFilter, typeFilter, categoryFilter, priceGetterFilter]);

    // Clear selection when filters change
    useEffect(() => {
        setSelectedIds(new Set());
    }, [searchFilter, statusFilter, typeFilter, categoryFilter, priceGetterFilter]);

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

    // ------------------------------------------------------------------
    // Mock mode
    // ------------------------------------------------------------------
    const fetchMockMode = async () => {
        try {
            const res = await fetch(`${API_URL}/config/settings`);
            if (res.ok) {
                const data = await res.json();
                setMockModeEnabled(!!data.mock_mode_enabled);
            }
        } catch { /* ignore */ }
    };

    const toggleMockMode = async () => {
        setMockModeLoading(true);
        try {
            const res = await fetch(`${API_URL}/config/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mock_mode_enabled: !mockModeEnabled }),
            });
            if (!res.ok) throw new Error('Failed to toggle mock mode');
            setMockModeEnabled(!mockModeEnabled);
            await refreshAssets(); // refresh to get updated getter enabled states
            toaster.success({ title: `Mock mode ${!mockModeEnabled ? 'enabled' : 'disabled'}` });
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed' });
        } finally {
            setMockModeLoading(false);
        }
    };

    // ------------------------------------------------------------------
    // Test price getter (modal-based)
    // ------------------------------------------------------------------
    const openTestModal = (pg: AssetPriceGetter) => {
        setTestModalGetter(pg);
        setTestResult(null);
        setShowTestModal(true);
    };

    const runTestFromModal = async () => {
        if (!selectedAsset || !testModalGetter) return;
        setTestResult(null);
        setTestLoading(true);
        try {
            const res = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_getter: testModalGetter.price_getter,
                    external_id: testModalGetter.external_id || undefined,
                    params: testModalGetter.params || {},
                    date: testDate || undefined,
                }),
            });
            const data = await res.json();
            setTestResult(data);
        } catch (err) {
            setTestResult({ success: false, error: err instanceof Error ? err.message : 'Network error' });
        } finally {
            setTestLoading(false);
        }
    };

    // Auto-test all getters when dialog opens
    const runAutoTests = useCallback(async (asset: Asset) => {
        if (!asset.price_getters || asset.price_getters.length === 0) return;
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().slice(0, 10);

        // Initialize loading states
        const initialResults: Record<number, { success: boolean; price?: number; error?: string; loading?: boolean }> = {};
        for (const pg of asset.price_getters) {
            initialResults[pg.id] = { success: false, loading: true };
        }
        setAutoTestResults(initialResults);

        // Run tests in parallel
        const promises = asset.price_getters.map(async (pg) => {
            try {
                const res = await fetch(`${API_URL}/assets/${asset.asset_id}/price-getters/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        price_getter: pg.price_getter,
                        external_id: pg.external_id || undefined,
                        params: pg.params || {},
                        date: dateStr,
                    }),
                });
                const data = await res.json();
                setAutoTestResults(prev => ({ ...prev, [pg.id]: { success: data.success, price: data.price, error: data.error } }));
            } catch (err) {
                setAutoTestResults(prev => ({ ...prev, [pg.id]: { success: false, error: 'Network error' } }));
            }
        });
        await Promise.all(promises);
    }, []);

    // Test unsaved getter (from the Add form)
    const testNewGetter = async () => {
        if (!selectedAsset || !newGetter.price_getter) return;
        setNewGetterTestResult(null);
        setNewGetterTestLoading(true);
        try {
            const res = await fetch(`${API_URL}/assets/${selectedAsset.asset_id}/price-getters/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    price_getter: newGetter.price_getter,
                    external_id: newGetter.external_id || undefined,
                    params: newGetter.params || {},
                    date: testDate || undefined,
                }),
            });
            const data = await res.json();
            setNewGetterTestResult(data);
        } catch (err) {
            setNewGetterTestResult({ success: false, error: err instanceof Error ? err.message : 'Network error' });
        } finally {
            setNewGetterTestLoading(false);
        }
    };

    // ------------------------------------------------------------------
    // Click-to-edit cell helpers
    // ------------------------------------------------------------------
    const startCellEdit = useCallback((assetId: number, field: string, currentValue: string) => {
        setEditingCell({ assetId, field });
        setCellValue(currentValue);
    }, []);

    const cancelCellEdit = useCallback(() => {
        setEditingCell(null);
        setCellValue('');
    }, []);

    const saveCellEdit = useCallback(async () => {
        if (!editingCell) return;
        const { assetId, field } = editingCell;
        try {
            const res = await fetch(`${API_URL}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: field === 'status' ? parseInt(cellValue) : cellValue }),
            });
            if (!res.ok) throw new Error('Failed to save');
            // Optimistic update
            setAllAssets(prev => prev.map(a => a.asset_id === assetId ? { ...a, [field]: field === 'status' ? parseInt(cellValue) : cellValue } : a));
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
        setEditingCell(null);
        setCellValue('');
    }, [editingCell, cellValue]);

    const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); saveCellEdit(); }
        if (e.key === 'Escape') cancelCellEdit();
    }, [saveCellEdit, cancelCellEdit]);

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

    const deleteAsset = (id: number, symbol: string) => {
        setDeleteTarget({ id, symbol });
    };

    const handleAssetDeleted = async () => {
        setDeleteTarget(null);
        await refreshAssets();
        toaster.success({ title: 'Asset deleted' });
    };

    // Price getter CRUD
    const openGettersDialog = (asset: Asset) => {
        setSelectedAsset(asset);
        setShowGettersDialog(true);
        setAutoTestResults({});
        setNewGetterTestResult(null);
        const firstNonMock = availableGetters.find(g => g !== 'mock') || '';
        setNewGetter({ price_getter: firstNonMock, external_id: '', priority: 100, enabled: true, params: {} });
        // Auto-test all getters
        runAutoTests(asset);
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
    const MOCK_DEFAULTS: Record<string, { min_price: number; max_price: number }> = {
        crypto: { min_price: 100, max_price: 50000 },
        stock: { min_price: 10, max_price: 500 },
        fiat: { min_price: 0.5, max_price: 2 },
    };

    const startEditingGetter = (pg: AssetPriceGetter) => {
        setEditingGetterId(pg.id);
        let params = pg.params || {};
        // For mock getters with empty range, populate asset-type defaults
        if (pg.price_getter === 'mock' && params.min_price == null && params.max_price == null && selectedAsset) {
            const defaults = MOCK_DEFAULTS[selectedAsset.price_type || 'crypto'] || MOCK_DEFAULTS.crypto;
            params = { ...params, ...defaults };
        }
        setEditingValues({
            external_id: pg.external_id || '',
            priority: pg.priority,
            params: JSON.stringify(params, null, 2)
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
    const activeFilterCount = (searchFilter ? 1 : 0) + (statusFilter !== '' ? 1 : 0) + (typeFilter ? 1 : 0) + categoryFilter.size + (priceGetterFilter ? 1 : 0);

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

    // Fetch deletion impact
    const fetchDeletionImpact = async (ids: number[]) => {
        setIsImpactLoading(true);
        setDeletionImpact({});
        try {
            const response = await fetch(`${API_URL}/assets/bulk/check-linked`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_ids: ids })
            });
            if (response.ok) {
                const data = await response.json();
                setDeletionImpact(data);
            }
        } catch (err) {
            console.error('Failed to fetch deletion impact:', err);
        } finally {
            setIsImpactLoading(false);
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
                // Check if it's a blocker error with details
                if (errData.detail?.blockers) {
                    const affectedCount = errData.detail.affected_assets?.length || 0;
                    throw new Error(`Cannot delete ${affectedCount} asset(s) with existing transactions or P&L data. Delete transactions first.`);
                }
                throw new Error(errData.detail?.message || errData.detail || 'Failed to delete assets');
            }
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message || `Deleted ${result.deleted_count} assets` });
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
                <Flex gap={2} align="center">
                    {/* Global Mock Mode Toggle */}
                    <Flex align="center" gap={2} px={3} py={1.5} bg={mockModeEnabled ? 'orange.50' : 'gray.50'} borderRadius="md" border="1px solid" borderColor={mockModeEnabled ? 'orange.200' : 'gray.200'}>
                        <Switch.Root
                            checked={mockModeEnabled}
                            onCheckedChange={() => toggleMockMode()}
                            disabled={mockModeLoading}
                            size="sm"
                        >
                            <Switch.HiddenInput />
                            <Switch.Control />
                        </Switch.Root>
                        <Text fontSize="xs" fontWeight="medium" whiteSpace="nowrap">
                            Mock {mockModeEnabled ? '🟢' : '⚪'}
                        </Text>
                    </Flex>
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

            {/* ============ Collapsible Filter Section ============ */}
            <Box
                mb={4}
                bg="gray.50"
                borderRadius="md"
                border="1px solid"
                borderColor={hasActiveFilters ? 'blue.300' : 'gray.200'}
                overflow="visible"
            >
                {/* Clickable header */}
                <Flex
                    align="center"
                    justify="space-between"
                    p={3}
                    cursor="pointer"
                    _hover={{ bg: 'gray.100' }}
                    onClick={() => setFiltersExpanded(!filtersExpanded)}
                    borderRadius="md"
                >
                    <Flex align="center" gap={1.5}>
                        <Box transition="transform 0.2s" transform={filtersExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'}>
                            <LuChevronDown size={14} />
                        </Box>
                        <LuFilter size={12} />
                        <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                        {activeFilterCount > 0 && (
                            <Badge size="xs" colorPalette="blue">{activeFilterCount} active</Badge>
                        )}
                    </Flex>
                    <Flex gap={1.5} onClick={e => e.stopPropagation()}>
                        {hasActiveFilters && (
                            <Button size="xs" variant="ghost" onClick={clearFilters} color="gray.500" _hover={{ color: 'gray.700' }}>
                                ✕ Clear All
                            </Button>
                        )}
                    </Flex>
                </Flex>

                {/* Chip summary when collapsed but filters active */}
                {hasActiveFilters && !filtersExpanded && (
                    <Box px={3} pb={3}>
                        <Flex flexWrap="wrap" gap={1}>
                            {searchFilter && <Badge size="sm" colorPalette="blue" variant="outline">Search: {searchFilter}</Badge>}
                            {statusFilter !== '' && <Badge size="sm" colorPalette="green" variant="outline">Status: {statusFilter === '0' ? 'Active' : 'Inactive'}</Badge>}
                            {typeFilter && <Badge size="sm" colorPalette="purple" variant="outline">Type: {typeFilter}</Badge>}
                            {priceGetterFilter && <Badge size="sm" colorPalette="orange" variant="outline">Getter: {priceGetterFilter}</Badge>}
                            {categoryFilter.size > 0 && <Badge size="sm" colorPalette="teal" variant="outline">{categoryFilter.size} categories</Badge>}
                        </Flex>
                    </Box>
                )}

                {!hasActiveFilters && !filtersExpanded && (
                    <Box px={3} pb={3}>
                        <Text fontSize="xs" color="gray.500" fontStyle="italic">No filters applied</Text>
                    </Box>
                )}

                {/* Filter Cards Grid */}
                {filtersExpanded && (
                    <Box p={3} pt={1}>
                        <SimpleGrid columns={{ base: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap={2}>
                            {/* Search Card */}
                            <Box bg="white" border="1px solid" borderColor={searchFilter ? 'blue.200' : 'gray.200'} borderRadius="md" p={2} minH="70px">
                                <Flex align="center" gap={1} mb={1.5}>
                                    <Text fontSize="xs">🔍</Text>
                                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Search</Text>
                                </Flex>
                                <Flex align="center" gap={1} px={1} py={1} bg="gray.50" borderRadius="sm">
                                    <LuSearch size={10} color="#A0AEC0" />
                                    <input
                                        type="text"
                                        placeholder="Symbol or label..."
                                        value={searchFilter}
                                        onChange={e => setSearchFilter(e.target.value)}
                                        style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: '11px', width: '100%', color: '#4A5568' }}
                                    />
                                </Flex>
                            </Box>

                            {/* Status Card */}
                            <Box bg="white" border="1px solid" borderColor={statusFilter !== '' ? 'green.200' : 'gray.200'} borderRadius="md" p={2} minH="70px">
                                <Flex align="center" gap={1} mb={1.5}>
                                    <Text fontSize="xs">📋</Text>
                                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Status</Text>
                                    {statusFilter !== '' && <Badge size="xs" colorPalette="green" borderRadius="full">1</Badge>}
                                </Flex>
                                <Flex flexWrap="wrap" gap={1}>
                                    {[{ v: '', l: 'All' }, { v: '0', l: 'Active' }, { v: '1', l: 'Inactive' }].map(opt => (
                                        <Box key={opt.v} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs" fontWeight="medium" cursor="pointer"
                                            bg={statusFilter === opt.v ? 'green.100' : 'gray.50'}
                                            color={statusFilter === opt.v ? 'green.700' : 'gray.600'}
                                            border="1px solid" borderColor={statusFilter === opt.v ? 'green.300' : 'gray.200'}
                                            _hover={{ bg: statusFilter === opt.v ? 'green.200' : 'gray.100' }}
                                            onClick={() => setStatusFilter(opt.v)}
                                        >
                                            {statusFilter === opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </Box>
                                    ))}
                                </Flex>
                            </Box>

                            {/* Type Card */}
                            <Box bg="white" border="1px solid" borderColor={typeFilter ? 'purple.200' : 'gray.200'} borderRadius="md" p={2} minH="70px">
                                <Flex align="center" gap={1} mb={1.5}>
                                    <Text fontSize="xs">🏷️</Text>
                                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Type</Text>
                                    {typeFilter && <Badge size="xs" colorPalette="purple" borderRadius="full">1</Badge>}
                                </Flex>
                                <Flex flexWrap="wrap" gap={1}>
                                    {[{ v: '', l: 'All' }, { v: 'crypto', l: 'Crypto' }, { v: 'stock', l: 'Stock' }, { v: 'fiat', l: 'Fiat' }].map(opt => (
                                        <Box key={opt.v} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs" fontWeight="medium" cursor="pointer"
                                            bg={typeFilter === opt.v ? 'purple.100' : 'gray.50'}
                                            color={typeFilter === opt.v ? 'purple.700' : 'gray.600'}
                                            border="1px solid" borderColor={typeFilter === opt.v ? 'purple.300' : 'gray.200'}
                                            _hover={{ bg: typeFilter === opt.v ? 'purple.200' : 'gray.100' }}
                                            onClick={() => setTypeFilter(opt.v)}
                                        >
                                            {typeFilter === opt.v && opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </Box>
                                    ))}
                                </Flex>
                            </Box>

                            {/* Price Getter Card */}
                            <Box bg="white" border="1px solid" borderColor={priceGetterFilter ? 'orange.200' : 'gray.200'} borderRadius="md" p={2} minH="70px">
                                <Flex align="center" gap={1} mb={1.5}>
                                    <Text fontSize="xs">💰</Text>
                                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Price Getters</Text>
                                    {priceGetterFilter && <Badge size="xs" colorPalette="orange" borderRadius="full">1</Badge>}
                                </Flex>
                                <Flex flexWrap="wrap" gap={1}>
                                    {[{ v: '', l: 'All' }, { v: 'has', l: 'Has any' }, { v: 'none', l: 'None' }, ...availableGetters.map(g => ({ v: g, l: g }))].map(opt => (
                                        <Box key={opt.v} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs" fontWeight="medium" cursor="pointer"
                                            bg={priceGetterFilter === opt.v ? 'orange.100' : 'gray.50'}
                                            color={priceGetterFilter === opt.v ? 'orange.700' : 'gray.600'}
                                            border="1px solid" borderColor={priceGetterFilter === opt.v ? 'orange.300' : 'gray.200'}
                                            _hover={{ bg: priceGetterFilter === opt.v ? 'orange.200' : 'gray.100' }}
                                            onClick={() => setPriceGetterFilter(opt.v)}
                                        >
                                            {priceGetterFilter === opt.v && opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </Box>
                                    ))}
                                </Flex>
                            </Box>

                            {/* Categories Card (spans 2 cols) */}
                            <Box
                                bg="white" border="1px solid" borderColor={categoryFilter.size > 0 ? 'teal.200' : 'gray.200'}
                                borderRadius="md" p={2} minH="70px"
                                gridColumn={{ base: 'span 1', md: 'span 2' }}
                            >
                                <Flex align="center" justify="space-between" mb={1.5}>
                                    <Flex align="center" gap={1}>
                                        <Text fontSize="xs">📁</Text>
                                        <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Categories</Text>
                                        {categoryFilter.size > 0 && <Badge size="xs" colorPalette="teal" borderRadius="full">{categoryFilter.size}</Badge>}
                                    </Flex>
                                    {categoryFilter.size > 0 && (
                                        <Button size="xs" variant="ghost" onClick={() => setCategoryFilter(new Set())} fontSize="2xs">Clear</Button>
                                    )}
                                </Flex>
                                {dimensionData.length === 0 ? (
                                    <Text fontSize="xs" color="gray.400">No categories available</Text>
                                ) : (
                                    <Flex direction="column" gap={1.5}>
                                        {dimensionData.map(dim => (
                                            <Box key={dim.id}>
                                                <Flex align="center" gap={1} cursor="pointer" onClick={() => toggleFilterDimension(String(dim.id))} _hover={{ bg: 'gray.50' }} p={0.5} borderRadius="sm">
                                                    <Text fontSize="2xs">{expandedDimensions.has(String(dim.id)) ? '▼' : '▶'}</Text>
                                                    <Text fontSize="2xs" fontWeight="medium">{dim.label}</Text>
                                                    {dim.categories.some(c => categoryFilter.has(c.id)) && (
                                                        <Badge size="xs" colorPalette="teal">{dim.categories.filter(c => categoryFilter.has(c.id)).length}</Badge>
                                                    )}
                                                </Flex>
                                                {expandedDimensions.has(String(dim.id)) && (
                                                    <Flex gap={1} flexWrap="wrap" ml={4} mt={0.5}>
                                                        {dim.categories.map(cat => (
                                                            <Box key={cat.id} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs" fontWeight="medium" cursor="pointer"
                                                                style={categoryFilter.has(cat.id) ? { backgroundColor: cat.color || '#319795', color: '#fff' } : { backgroundColor: '#EDF2F7', color: '#4A5568' }}
                                                                onClick={() => toggleFilterCategory(cat.id)}
                                                            >
                                                                {categoryFilter.has(cat.id) && '✓ '}{cat.label}
                                                            </Box>
                                                        ))}
                                                    </Flex>
                                                )}
                                            </Box>
                                        ))}
                                    </Flex>
                                )}
                            </Box>
                        </SimpleGrid>
                    </Box>
                )}
            </Box>

            {/* ============ Floating Bulk Actions Bar ============ */}
            {selectedIds.size > 0 && (
                <Portal>
                    <Box
                        position="fixed"
                        bottom={0}
                        left={0}
                        right={0}
                        zIndex={1000}
                        bg="rgba(255, 255, 255, 0.85)"
                        backdropFilter="blur(8px)"
                        borderTop="1px solid"
                        borderColor="gray.200"
                        boxShadow="0 -2px 8px rgba(0,0,0,0.08)"
                        animation="slideUp 150ms ease-out"
                        css={{
                            '@keyframes slideUp': {
                                from: { transform: 'translateY(100%)' },
                                to: { transform: 'translateY(0)' },
                            },
                        }}
                    >
                        <Box maxW="1400px" mx="auto" px={4} py={1.5}>
                            <Flex justify="space-between" align="center" flexWrap="wrap" gap={1.5}>
                                <Text fontWeight="semibold" color="blue.700" fontSize="xs">
                                    {selectedIds.size} asset{selectedIds.size > 1 ? 's' : ''} selected
                                </Text>
                                <Flex gap={1} flexWrap="wrap" align="center">
                                    <Button size="2xs" fontSize="xs" colorPalette="blue" variant="outline" onClick={() => { setBulkStatus(0); setShowBulkStatusDialog(true); }}>
                                        ✓ Status
                                    </Button>
                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" />
                                    <Button size="2xs" fontSize="xs" colorPalette="purple" variant="outline" onClick={() => { setBulkType(''); setShowBulkTypeDialog(true); }}>
                                        🏷️ Type
                                    </Button>
                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" />
                                    <Button size="2xs" fontSize="xs" colorPalette="teal" variant="outline" onClick={() => { setBulkCategoryIds(new Set()); setBulkCategoryMode('add'); setShowBulkCategoriesDialog(true); }}>
                                        📁 Categories
                                    </Button>
                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" />
                                    <Button size="2xs" fontSize="xs" colorPalette="orange" variant="outline" onClick={() => { setBulkPriceGetter({ price_getter: availableGetters[0] || '', external_id: '', priority: 100 }); setShowBulkPriceGettersDialog(true); }}>
                                        💰 Getters
                                    </Button>
                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" />
                                    <Button size="2xs" fontSize="xs" colorPalette="red" variant="outline" onClick={() => { fetchDeletionImpact(Array.from(selectedIds)); setShowBulkDeleteDialog(true); }}>
                                        🗑️ Delete
                                    </Button>
                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" />
                                    <Button size="2xs" fontSize="xs" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                                        ✕
                                    </Button>
                                </Flex>
                            </Flex>
                        </Box>
                    </Box>
                </Portal>
            )}

            <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" fontSize="xs" pb={selectedIds.size > 0 ? '48px' : '0'}>
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
                            <Table.ColumnHeader width="70px">Txns</Table.ColumnHeader>
                            <Table.ColumnHeader width="60px">Status</Table.ColumnHeader>
                            <Table.ColumnHeader width="40px"></Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {assets.length === 0 ? (
                            <Table.Row>
                                <Table.Cell colSpan={10}>
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
                                    {/* Click-to-edit: Symbol */}
                                    <Table.Cell cursor="pointer" onClick={() => startCellEdit(asset.asset_id!, 'symbol', asset.symbol)}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'symbol' ? (
                                            <Input size="sm" autoFocus value={cellValue} onChange={e => setCellValue(e.target.value)}
                                                onBlur={saveCellEdit} onKeyDown={handleCellKeyDown} />
                                        ) : (
                                            <Badge colorPalette="blue">{asset.symbol}</Badge>
                                        )}
                                    </Table.Cell>
                                    {/* Click-to-edit: Label */}
                                    <Table.Cell cursor="pointer" onClick={() => startCellEdit(asset.asset_id!, 'label', asset.label || '')}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'label' ? (
                                            <Input size="sm" autoFocus value={cellValue} onChange={e => setCellValue(e.target.value)}
                                                onBlur={saveCellEdit} onKeyDown={handleCellKeyDown} />
                                        ) : (
                                            <Text _hover={{ color: 'blue.600' }}>{asset.label || '-'}</Text>
                                        )}
                                    </Table.Cell>
                                    {/* Click-to-edit: Type */}
                                    <Table.Cell cursor="pointer" onClick={() => startCellEdit(asset.asset_id!, 'price_type', asset.price_type || '')}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'price_type' ? (
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field autoFocus value={cellValue}
                                                    onChange={e => { setCellValue(e.target.value); }}
                                                    onBlur={saveCellEdit}
                                                >
                                                    <option value="crypto">Crypto</option>
                                                    <option value="stock">Stock</option>
                                                    <option value="fiat">Fiat</option>
                                                </NativeSelect.Field>
                                            </NativeSelect.Root>
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
                                    {/* Transaction count */}
                                    <Table.Cell>
                                        {(() => {
                                            const count = txCountsByAssetId[asset.asset_id!] ?? 0;
                                            return count > 0 ? (
                                                <Badge
                                                    colorPalette="purple"
                                                    cursor="pointer"
                                                    _hover={{ opacity: 0.8 }}
                                                    onClick={() => setDrawerAsset({ id: asset.asset_id!, symbol: asset.symbol })}
                                                    title={`View ${count} transactions for ${asset.symbol}`}
                                                >
                                                    {count}
                                                </Badge>
                                            ) : (
                                                <Text color="gray.400" fontSize="xs">0</Text>
                                            );
                                        })()}
                                    </Table.Cell>
                                    {/* Click-to-edit: Status */}
                                    <Table.Cell cursor="pointer" onClick={() => startCellEdit(asset.asset_id!, 'status', String(asset.status ?? 0))}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'status' ? (
                                            <NativeSelect.Root size="sm">
                                                <NativeSelect.Field autoFocus value={cellValue}
                                                    onChange={e => setCellValue(e.target.value)}
                                                    onBlur={saveCellEdit}
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
                                        <IconButton
                                            size="xs"
                                            variant="ghost"
                                            colorPalette="red"
                                            aria-label="Delete asset"
                                            onClick={() => deleteAsset(asset.asset_id!, asset.symbol)}
                                        >
                                            <Icon as={LuTrash2} boxSize={3.5} />
                                        </IconButton>
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
                        <Dialog.Content maxWidth="750px">
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
                                        <Box overflowX="auto">
                                            <Table.Root size="sm">
                                                <Table.Header>
                                                    <Table.Row>
                                                        <Table.ColumnHeader>Source</Table.ColumnHeader>
                                                        <Table.ColumnHeader>External ID</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Parameters</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Priority</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Enabled</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Test</Table.ColumnHeader>
                                                        <Table.ColumnHeader>Actions</Table.ColumnHeader>
                                                    </Table.Row>
                                                </Table.Header>
                                                <Table.Body>
                                                    {selectedAsset.price_getters.map(pg => {
                                                        const isEditing = editingGetterId === pg.id;
                                                        const isMock = pg.price_getter === 'mock';
                                                        const autoResult = autoTestResults[pg.id];

                                                        // For mock getters, show min/max params specially
                                                        const mockMin = pg.params?.min_price;
                                                        const mockMax = pg.params?.max_price;

                                                        // Non-mock params display
                                                        const paramsEntries = Object.entries(pg.params || {}).filter(
                                                            ([k]) => !isMock || (k !== 'min_price' && k !== 'max_price')
                                                        );
                                                        const hasParams = isMock ? (mockMin != null || mockMax != null) : paramsEntries.length > 0;

                                                        return (
                                                            <Table.Row key={pg.id}>
                                                                <Table.Cell>
                                                                    <Badge colorPalette={isMock ? 'orange' : 'purple'}>{pg.price_getter}</Badge>
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
                                                                    {isEditing && isMock ? (
                                                                        /* Mock getter: min/max text boxes */
                                                                        (() => {
                                                                            let minVal: number | string = '', maxVal: number | string = '';
                                                                            try { const p = JSON.parse(editingValues.params); minVal = p.min_price ?? ''; maxVal = p.max_price ?? ''; } catch { /* ignore */ }
                                                                            return (
                                                                                <Flex gap={1} align="center">
                                                                                    <Input
                                                                                        size="sm"
                                                                                        type="number"
                                                                                        placeholder="Min"
                                                                                        width="80px"
                                                                                        fontSize="xs"
                                                                                        value={minVal}
                                                                                        onChange={(e) => {
                                                                                            try {
                                                                                                const p = JSON.parse(editingValues.params || '{}');
                                                                                                p.min_price = e.target.value ? parseFloat(e.target.value) : 0;
                                                                                                setEditingValues(v => ({ ...v, params: JSON.stringify(p) }));
                                                                                            } catch { /* ignore */ }
                                                                                        }}
                                                                                    />
                                                                                    <Text fontSize="xs" color="gray.400">–</Text>
                                                                                    <Input
                                                                                        size="sm"
                                                                                        type="number"
                                                                                        placeholder="Max"
                                                                                        width="80px"
                                                                                        fontSize="xs"
                                                                                        value={maxVal}
                                                                                        onChange={(e) => {
                                                                                            try {
                                                                                                const p = JSON.parse(editingValues.params || '{}');
                                                                                                p.max_price = e.target.value ? parseFloat(e.target.value) : 0;
                                                                                                setEditingValues(v => ({ ...v, params: JSON.stringify(p) }));
                                                                                            } catch { /* ignore */ }
                                                                                        }}
                                                                                    />
                                                                                </Flex>
                                                                            );
                                                                        })()
                                                                    ) : isEditing ? (
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
                                                                    ) : isMock ? (
                                                                        /* Mock getter: display range */
                                                                        <Text fontSize="xs" fontFamily="mono" color="orange.600">
                                                                            {mockMin != null && mockMax != null
                                                                                ? `${mockMin} – ${mockMax}`
                                                                                : <Text as="span" color="gray.400">no range</Text>}
                                                                        </Text>
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
                                                                    <Flex align="center" gap={1}>
                                                                        {/* Auto-test status icon */}
                                                                        {autoResult && (
                                                                            <Tooltip
                                                                                content={
                                                                                    autoResult.loading
                                                                                        ? 'Testing...'
                                                                                        : autoResult.success
                                                                                            ? `✅ ${autoResult.price?.toFixed(6) ?? 'OK'}`
                                                                                            : `❌ ${autoResult.error || 'Failed'}`
                                                                                }
                                                                                showArrow
                                                                            >
                                                                                <Box cursor="default">
                                                                                    {autoResult.loading ? (
                                                                                        <Spinner size="xs" />
                                                                                    ) : autoResult.success ? (
                                                                                        <Text color="green.500" fontSize="sm">✅</Text>
                                                                                    ) : (
                                                                                        <Text color="red.500" fontSize="sm">❌</Text>
                                                                                    )}
                                                                                </Box>
                                                                            </Tooltip>
                                                                        )}
                                                                        <IconButton
                                                                            size="xs"
                                                                            variant="ghost"
                                                                            colorPalette="blue"
                                                                            aria-label="Test getter"
                                                                            onClick={() => openTestModal(pg)}
                                                                        >
                                                                            <LuPlay size={12} />
                                                                        </IconButton>
                                                                    </Flex>
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
                                                                            {!isMock && (
                                                                                <Button size="xs" colorPalette="red" variant="ghost" onClick={() => deletePriceGetter(pg.id)}>🗑️</Button>
                                                                            )}
                                                                        </Flex>
                                                                    )}
                                                                </Table.Cell>
                                                            </Table.Row>
                                                        );
                                                    })}
                                                </Table.Body>
                                            </Table.Root>
                                        </Box>
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
                                                        {availableGetters.filter(g => g !== 'mock').map(g => (
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
                                                placeholder={selectedAsset?.symbol || 'Leave empty to use asset symbol'}
                                                value={newGetter.external_id || ''}
                                                onChange={e => setNewGetter({
                                                    ...newGetter,
                                                    external_id: e.target.value || ''
                                                })}
                                            />
                                            {!newGetter.external_id && selectedAsset?.symbol && (
                                                <Text fontSize="xs" color="gray.400" mt={0.5}>
                                                    Will use "{selectedAsset.symbol}" by default
                                                </Text>
                                            )}
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
                                        <Flex gap={2}>
                                            <Button colorPalette="blue" size="sm" onClick={addPriceGetter} flex={1}>
                                                ➕ Add Price Getter
                                            </Button>
                                            <Button
                                                colorPalette="teal"
                                                variant="outline"
                                                size="sm"
                                                onClick={testNewGetter}
                                                disabled={!newGetter.price_getter || newGetterTestLoading}
                                            >
                                                {newGetterTestLoading ? <Spinner size="xs" /> : '🧪 Test'}
                                            </Button>
                                        </Flex>
                                        {newGetterTestResult && (
                                            <Box p={2} bg={newGetterTestResult.success ? 'green.50' : 'red.50'} borderRadius="sm" fontSize="xs">
                                                {newGetterTestResult.success ? (
                                                    <Text color="green.700">
                                                        ✅ Price: <strong>{newGetterTestResult.price?.toFixed(6)}</strong>
                                                    </Text>
                                                ) : (
                                                    <Text color="red.700">❌ {newGetterTestResult.error}</Text>
                                                )}
                                            </Box>
                                        )}
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

            {/* Test Price Getter Modal */}
            <Dialog.Root open={showTestModal} onOpenChange={(e) => { setShowTestModal(e.open); if (!e.open) { setTestResult(null); setTestModalGetter(null); } }}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxWidth="420px">
                            <Dialog.Header>
                                <Dialog.Title fontSize="md">
                                    🧪 Test: {testModalGetter?.price_getter}
                                    {testModalGetter?.external_id && (
                                        <Text as="span" fontWeight="normal" fontSize="sm" color="gray.500"> ({testModalGetter.external_id})</Text>
                                    )}
                                </Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Flex direction="column" gap={3}>
                                    <Box>
                                        <Text fontSize="sm" fontWeight="medium" mb={1}>Test Date</Text>
                                        <Input
                                            size="sm"
                                            type="date"
                                            value={testDate}
                                            onChange={e => setTestDate(e.target.value)}
                                        />
                                    </Box>
                                    <Button
                                        colorPalette="blue"
                                        size="sm"
                                        onClick={runTestFromModal}
                                        disabled={testLoading}
                                    >
                                        {testLoading ? <Spinner size="xs" mr={2} /> : null}
                                        Run Test
                                    </Button>
                                    {testResult && (
                                        <Box p={3} bg={testResult.success ? 'green.50' : 'red.50'} borderRadius="md" border="1px solid" borderColor={testResult.success ? 'green.200' : 'red.200'}>
                                            {testResult.success ? (
                                                <Flex direction="column" gap={1}>
                                                    <Text color="green.700" fontWeight="medium">
                                                        ✅ Price: {testResult.price?.toFixed(6)}
                                                    </Text>
                                                    {testResult.source && (
                                                        <Text fontSize="xs" color="gray.600">Source: {testResult.source}</Text>
                                                    )}
                                                    {testResult.quote_currency && (
                                                        <Text fontSize="xs" color="gray.600">Quote: {testResult.quote_currency}</Text>
                                                    )}
                                                    {testResult.ticker_used && (
                                                        <Text fontSize="xs" color="gray.600">Ticker: {testResult.ticker_used}</Text>
                                                    )}
                                                </Flex>
                                            ) : (
                                                <Text color="red.700" fontSize="sm">❌ {testResult.error}</Text>
                                            )}
                                        </Box>
                                    )}
                                </Flex>
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Button variant="outline" size="sm" onClick={() => setShowTestModal(false)}>
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
            <Dialog.Root
                open={showBulkDeleteDialog}
                onOpenChange={(e) => {
                    setShowBulkDeleteDialog(e.open);
                    if (!e.open) {
                        setDeletionImpact({});
                    }
                }}
            >
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}?</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text color="red.600" fontWeight="bold" mb={2}>
                                    ⚠️ Warning: This action cannot be undone!
                                </Text>
                                <Text mb={4}>
                                    You are about to delete <strong>{selectedIds.size}</strong> asset{selectedIds.size > 1 ? 's' : ''}.
                                </Text>

                                {isImpactLoading ? (
                                    <Flex align="center" gap={2} mt={4}>
                                        <Spinner size="xs" />
                                        <Text fontSize="xs" color="gray.500">Checking for linked data...</Text>
                                    </Flex>
                                ) : (
                                    <>
                                        {/* Blockers (prevent deletion) */}
                                        {(deletionImpact.transactions || deletionImpact.cost_lots || deletionImpact.realized_pnl) ? (
                                            <Box mt={4} p={3} bg="red.50" border="1px solid" borderColor="red.300" borderRadius="md">
                                                <Text fontSize="xs" fontWeight="bold" color="red.800" mb={1}>
                                                    🚫 Cannot delete - Linked data exists:
                                                </Text>
                                                <Flex direction="column" gap={0.5}>
                                                    {deletionImpact.transactions && (
                                                        <Text fontSize="10px" color="red.700">
                                                            • {deletionImpact.transactions} transaction(s) - delete transactions first
                                                        </Text>
                                                    )}
                                                    {deletionImpact.cost_lots && (
                                                        <Text fontSize="10px" color="red.700">
                                                            • {deletionImpact.cost_lots} cost lot(s) - delete transactions first
                                                        </Text>
                                                    )}
                                                    {deletionImpact.realized_pnl && (
                                                        <Text fontSize="10px" color="red.700">
                                                            • {deletionImpact.realized_pnl} P&L record(s) - delete transactions first
                                                        </Text>
                                                    )}
                                                </Flex>
                                                <Text fontSize="10px" color="red.800" mt={2} fontStyle="italic">
                                                    Assets with transaction history cannot be deleted. Delete all related transactions first.
                                                </Text>
                                            </Box>
                                        ) : Object.keys(deletionImpact).length > 0 ? (
                                            /* Cascade deletions (informational) */
                                            <Box mt={4} p={3} bg="orange.50" border="1px solid" borderColor="orange.200" borderRadius="md">
                                                <Text fontSize="xs" fontWeight="bold" color="orange.800" mb={1}>
                                                    ⚠️ Linked objects that will also be deleted:
                                                </Text>
                                                <Flex direction="column" gap={0.5}>
                                                    {Object.entries(deletionImpact).map(([key, count]) => (
                                                        <Text key={key} fontSize="10px" color="orange.700">
                                                            • {count} {key.replace(/_/g, ' ')}
                                                        </Text>
                                                    ))}
                                                </Flex>
                                                <Text fontSize="10px" color="orange.800" mt={2} fontStyle="italic">
                                                    This data is linked to these asset(s) and will be removed due to cascade deletion.
                                                </Text>
                                            </Box>
                                        ) : null}
                                    </>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>Cancel</Button>
                                    <Button
                                        colorPalette="red"
                                        onClick={executeBulkDelete}
                                        loading={bulkOperationLoading}
                                        disabled={bulkOperationLoading || deletionImpact.transactions > 0 || deletionImpact.cost_lots > 0 || deletionImpact.realized_pnl > 0}
                                    >
                                        🗑️ Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Asset Dialog with cascade preview */}
            <DeleteAssetDialog
                isOpen={deleteTarget !== null}
                onClose={() => setDeleteTarget(null)}
                assetId={deleteTarget?.id ?? null}
                assetSymbol={deleteTarget?.symbol ?? ''}
                onDeleted={handleAssetDeleted}
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

            {/* Asset Transactions Drawer */}
            {drawerAsset && drawerFilters && (
                <>
                    {/* Backdrop */}
                    <Box
                        position="fixed"
                        inset={0}
                        bg="blackAlpha.400"
                        zIndex={2000}
                        onClick={() => setDrawerAsset(null)}
                        cursor="pointer"
                    />

                    {/* Panel */}
                    <Box
                        position="fixed"
                        right={0}
                        top={0}
                        bottom={0}
                        width="75vw"
                        maxW="1400px"
                        bg="white"
                        boxShadow="xl"
                        zIndex={2001}
                        overflowY="auto"
                        borderLeft="1px solid"
                        borderColor="gray.200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Sticky header */}
                        <Flex
                            justify="space-between"
                            align="center"
                            px={4}
                            py={3}
                            borderBottom="1px solid"
                            borderColor="gray.200"
                            bg="white"
                            position="sticky"
                            top={0}
                            zIndex={1}
                        >
                            <Flex align="center" gap={2}>
                                <Badge colorPalette="purple" fontSize="sm">
                                    {drawerAsset.symbol}
                                </Badge>
                                <Heading size="sm">
                                    Transactions ({txCountsByAssetId[drawerAsset.id] ?? 0})
                                </Heading>
                            </Flex>
                            <IconButton
                                size="sm"
                                variant="ghost"
                                aria-label="Close drawer"
                                onClick={() => setDrawerAsset(null)}
                            >
                                <LuX />
                            </IconButton>
                        </Flex>

                        {/* Transactions Table */}
                        <Box p={4}>
                            <TransactionsTable
                                key={`asset-txns-${drawerAsset.id}`}
                                tableId={`assetTxns-${drawerAsset.id}`}
                                title=""
                                subtitle=""
                                filters={drawerFilters}
                                showFilters={true}
                                defaultFiltersCollapsed={true}
                                showBundles={false}
                                compact={true}
                            />
                        </Box>
                    </Box>
                </>
            )}
        </Box>
    );
};
