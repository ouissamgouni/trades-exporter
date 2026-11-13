import { Badge, Button, Input, Spinner, Tabs, TabsList, TabsTrigger, TabsContent, Textarea, type BadgeColorScheme } from './ui/primitives';
import { cn } from '../lib/cn';
import { createPortal } from 'react-dom';
import * as RadixDialog from '@radix-ui/react-dialog';
import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { LuChevronDown, LuChevronLeft, LuChevronRight, LuChevronsLeft, LuChevronsRight, LuFilter, LuPlay, LuSearch, LuCheck, LuTags, LuSettings, LuTrash2, LuX } from 'react-icons/lu';
import { API_URL, Asset, AssetPriceGetter, Category, DimensionCategories } from '../types';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { ASSET_TYPE_OPTIONS, ComboSelect } from './ComboSelect';
import { ConfirmDialog, useConfirmDialog } from './ui/ConfirmDialog';
import { DeleteAssetDialog } from './DeleteAssetDialog';
import { Tooltip } from './ui/tooltip';
import { toaster } from './ui/toaster';
import AssetFormDialog from './AssetFormDialog';

// Use ASSET_TYPE_OPTIONS but it now only has 3 values: crypto, stock, fiat
const PRICE_TYPE_OPTIONS = ASSET_TYPE_OPTIONS;

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

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
    const [categoriesDialogTab, setCategoriesDialogTab] = useState('');
    const [bulkCategoriesDialogTab, setBulkCategoriesDialogTab] = useState('');

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

    // Pagination
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

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

    // Pagination computation
    const totalRows = assets.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const paginatedAssets = useMemo(() => {
        const start = safePage * pageSize;
        return assets.slice(start, start + pageSize);
    }, [assets, safePage, pageSize]);

    // Reset page when filters change
    useEffect(() => { setPage(0); }, [searchFilter, statusFilter, typeFilter, categoryFilter, priceGetterFilter]);

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

    const saveCellEdit = useCallback(async (override?: unknown) => {
        if (!editingCell) return;
        const { assetId, field } = editingCell;
        // Selects save on change with the picked value; blur/Enter pass an event or nothing.
        const value = typeof override === 'string' ? override : cellValue;
        try {
            const res = await fetch(`${API_URL}/assets/${assetId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: field === 'status' ? parseInt(value) : field === 'denomination_currency_id' ? (value ? parseInt(value) : null) : field === 'isin' ? (value || null) : value }),
            });
            if (!res.ok) throw new Error('Failed to save');
            // Optimistic update
            setAllAssets(prev => prev.map(a => {
                if (a.asset_id !== assetId) return a;
                if (field === 'denomination_currency_id') {
                    const denomId = value ? parseInt(value) : null;
                    const denomAsset = denomId ? prev.find(x => x.asset_id === denomId) : null;
                    return {
                        ...a,
                        denomination_currency_id: denomId,
                        denomination_currency: denomAsset ? { asset_id: denomAsset.asset_id!, symbol: denomAsset.symbol, label: denomAsset.label } : null,
                    };
                }
                return { ...a, [field]: field === 'status' ? parseInt(value) : value };
            }));
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

    const handleCreateFormClose = (createdAssetId?: number) => {
        setShowCreateDialog(false);
        if (createdAssetId) refreshAssets();
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
            return <span className="text-[10px] text-slate-400">—</span>;
        }
        const MAX_VISIBLE = 2;
        const visible = asset.categories.slice(0, MAX_VISIBLE);
        const remaining = asset.categories.length - MAX_VISIBLE;
        return (
            <div className="flex flex-col gap-0">
                {visible.map(cat => (
                    <span
                        key={cat.id}
                        className="truncate whitespace-nowrap text-[10px] leading-[1.5]"
                        style={{ maxWidth: '260px' }}
                        title={`${cat.dimension_label}: ${cat.label}`}
                    >
                        <span className="font-semibold text-slate-500">{cat.dimension_label}:</span>{' '}
                        <Badge
                            colorScheme={!cat.color ? 'gray' : undefined}
                            className="px-1 py-0 text-[10px] leading-[1.3]"
                            style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                        >
                            {cat.label}
                        </Badge>
                    </span>
                ))}
                {remaining > 0 && (
                    <Tooltip content={asset.categories.slice(MAX_VISIBLE).map(c => `${c.dimension_label}: ${c.label}`).join('\n')}>
                        <span className="cursor-pointer text-[10px] text-blue-500 hover:underline">
                            +{remaining} more
                        </span>
                    </Tooltip>
                )}
            </div>
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
            return <span className="text-[10px] text-slate-400">—</span>;
        }

        const formatParams = (params: Record<string, any>) => {
            if (!params || Object.keys(params).length === 0) return '';
            return Object.entries(params)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
        };

        const MAX_VISIBLE = 2;
        const visible = asset.price_getters.slice(0, MAX_VISIBLE);
        const remaining = asset.price_getters.length - MAX_VISIBLE;

        return (
            <div className="flex flex-col gap-0">
                {visible.map(pg => {
                    const paramsStr = formatParams(pg.params);
                    const tooltip = [
                        pg.price_getter,
                        pg.external_id ? `ID: ${pg.external_id}` : 'ID: auto',
                        `priority: ${pg.priority}`,
                        paramsStr ? `params: {${paramsStr}}` : ''
                    ].filter(Boolean).join(' | ');

                    return (
                        <span key={pg.id} className="truncate whitespace-nowrap text-[10px] leading-[1.5]" style={{ maxWidth: '180px' }} title={tooltip}>
                            <Badge
                                colorScheme={pg.enabled ? 'blue' : 'gray'}
                                className="px-1 py-0 text-[10px] leading-[1.3]"
                            >
                                {pg.price_getter}{pg.external_id ? `: ${pg.external_id}` : ''}
                            </Badge>
                        </span>
                    );
                })}
                {remaining > 0 && (
                    <Tooltip content={asset.price_getters.slice(MAX_VISIBLE).map(pg => `${pg.price_getter}${pg.external_id ? `: ${pg.external_id}` : ''}`).join('\n')}>
                        <span className="cursor-pointer text-[10px] text-blue-500 hover:underline">
                            +{remaining} more
                        </span>
                    </Tooltip>
                )}
            </div>
        );
    };

    if (loading) return (
        <div className="rounded-md bg-slate-50 py-10 text-center">
            <Spinner size="lg" className="text-blue-500" />
            <span className="mt-4 block">Loading assets...</span>
        </div>
    );

    if (error) return (
        <div className="rounded-md border border-red-200 bg-red-50 py-10 text-center">
            <span className="text-red-600">Error: {error}</span>
        </div>
    );

    return (
        <div>
            <div className="mb-3 flex items-center justify-between border-b border-slate-200 pb-2">
                <div>
                    <h2 className="mb-0.5 text-sm font-semibold">💎 Assets</h2>
                    <span className="block text-xs text-slate-600">
                        Manage assets and their price getter configurations.
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    {/* Global Mock Mode Toggle */}
                    <div className={cn('flex items-center gap-2 rounded-md border px-3 py-1.5', mockModeEnabled ? 'border-orange-200 bg-orange-50' : 'border-slate-200 bg-slate-50')}>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={mockModeEnabled}
                            aria-label="Mock Mode"
                            disabled={mockModeLoading}
                            onClick={() => toggleMockMode()}
                            className={cn('relative inline-flex h-[18px] w-[32px] items-center rounded-full transition-colors disabled:opacity-50', mockModeEnabled ? 'bg-blue-500' : 'bg-slate-300')}
                        >
                            <span className={cn('inline-block h-[14px] w-[14px] transform rounded-full bg-white transition-transform', mockModeEnabled ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
                        </button>
                        <span className="whitespace-nowrap text-xs font-medium">
                            Mock {mockModeEnabled ? '🟢' : '⚪'}
                        </span>
                    </div>
                    <Button size="sm" colorScheme="green" onClick={openImportDialog}>
                        📥 Import CSV
                    </Button>
                    <Button size="sm" colorScheme="blue" onClick={() => setShowCreateDialog(true)}>
                        ➕ Add Asset
                    </Button>
                    <Button size="sm" onClick={refreshAssets} variant="outline">
                        🔄 Refresh
                    </Button>
                </div>
            </div>

            {/* ============ Collapsible Filter Section ============ */}
            <div className={cn('mb-4 overflow-visible rounded-md border bg-slate-50', hasActiveFilters ? 'border-blue-300' : 'border-slate-200')}>
                {/* Clickable header */}
                <div
                    className="flex cursor-pointer items-center justify-between rounded-md p-3 hover:bg-slate-100"
                    onClick={() => setFiltersExpanded(!filtersExpanded)}
                >
                    <div className="flex items-center gap-1.5">
                        <div className="transition-transform duration-200" style={{ transform: filtersExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                            <LuChevronDown size={14} />
                        </div>
                        <LuFilter size={12} />
                        <span className="text-xs font-semibold">Filters</span>
                        {activeFilterCount > 0 && (
                            <Badge colorScheme="blue" className="text-[10px]">{activeFilterCount} active</Badge>
                        )}
                    </div>
                    <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                        {hasActiveFilters && (
                            <Button size="sm" variant="ghost" onClick={clearFilters} className="text-slate-500 hover:text-slate-700">
                                ✕ Clear All
                            </Button>
                        )}
                    </div>
                </div>

                {/* Chip summary when collapsed but filters active */}
                {hasActiveFilters && !filtersExpanded && (
                    <div className="px-3 pb-3">
                        <div className="flex flex-wrap gap-1">
                            {searchFilter && <Badge colorScheme="blue" className="border border-blue-300 bg-white text-xs">Search: {searchFilter}</Badge>}
                            {statusFilter !== '' && <Badge colorScheme="green" className="border border-green-300 bg-white text-xs">Status: {statusFilter === '0' ? 'Active' : 'Inactive'}</Badge>}
                            {typeFilter && <Badge colorScheme="purple" className="border border-purple-300 bg-white text-xs">Type: {typeFilter}</Badge>}
                            {priceGetterFilter && <Badge colorScheme="orange" className="border border-orange-300 bg-white text-xs">Getter: {priceGetterFilter}</Badge>}
                            {categoryFilter.size > 0 && <Badge colorScheme="green" className="border border-green-300 bg-white text-xs">{categoryFilter.size} categories</Badge>}
                        </div>
                    </div>
                )}

                {!hasActiveFilters && !filtersExpanded && (
                    <div className="px-3 pb-3">
                        <span className="text-xs italic text-slate-500">No filters applied</span>
                    </div>
                )}

                {/* Filter Cards Grid */}
                {filtersExpanded && (
                    <div className="p-3 pt-1">
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                            {/* Search Card */}
                            <div className={cn('min-h-[70px] rounded-md border bg-white p-2', searchFilter ? 'border-blue-200' : 'border-slate-200')}>
                                <div className="mb-1.5 flex items-center gap-1">
                                    <span className="text-xs">🔍</span>
                                    <span className="text-[10px] font-semibold uppercase text-slate-600">Search</span>
                                </div>
                                <div className="flex items-center gap-1 rounded-sm bg-slate-50 px-1 py-1">
                                    <LuSearch size={10} color="#A0AEC0" />
                                    <input
                                        type="text"
                                        placeholder="Symbol or label..."
                                        value={searchFilter}
                                        onChange={e => setSearchFilter(e.target.value)}
                                        style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: '11px', width: '100%', color: '#4A5568' }}
                                    />
                                </div>
                            </div>

                            {/* Status Card */}
                            <div className={cn('min-h-[70px] rounded-md border bg-white p-2', statusFilter !== '' ? 'border-green-200' : 'border-slate-200')}>
                                <div className="mb-1.5 flex items-center gap-1">
                                    <span className="text-xs">📋</span>
                                    <span className="text-[10px] font-semibold uppercase text-slate-600">Status</span>
                                    {statusFilter !== '' && <Badge colorScheme="green" className="rounded-full text-[10px]">1</Badge>}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {[{ v: '', l: 'All' }, { v: '0', l: 'Active' }, { v: '1', l: 'Inactive' }].map(opt => (
                                        <button
                                            key={opt.v}
                                            type="button"
                                            className={cn(
                                                'cursor-pointer rounded-sm border px-1.5 py-0.5 text-[10px] font-medium',
                                                statusFilter === opt.v
                                                    ? 'border-green-300 bg-green-100 text-green-700 hover:bg-green-200'
                                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                                            )}
                                            onClick={() => setStatusFilter(opt.v)}
                                        >
                                            {statusFilter === opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Type Card */}
                            <div className={cn('min-h-[70px] rounded-md border bg-white p-2', typeFilter ? 'border-purple-200' : 'border-slate-200')}>
                                <div className="mb-1.5 flex items-center gap-1">
                                    <span className="text-xs">🏷️</span>
                                    <span className="text-[10px] font-semibold uppercase text-slate-600">Type</span>
                                    {typeFilter && <Badge colorScheme="purple" className="rounded-full text-[10px]">1</Badge>}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {[{ v: '', l: 'All' }, { v: 'crypto', l: 'Crypto' }, { v: 'stock', l: 'Stock' }, { v: 'fiat', l: 'Fiat' }].map(opt => (
                                        <button
                                            key={opt.v}
                                            type="button"
                                            className={cn(
                                                'cursor-pointer rounded-sm border px-1.5 py-0.5 text-[10px] font-medium',
                                                typeFilter === opt.v
                                                    ? 'border-purple-300 bg-purple-100 text-purple-700 hover:bg-purple-200'
                                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                                            )}
                                            onClick={() => setTypeFilter(opt.v)}
                                        >
                                            {typeFilter === opt.v && opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Price Getter Card */}
                            <div className={cn('min-h-[70px] rounded-md border bg-white p-2', priceGetterFilter ? 'border-orange-200' : 'border-slate-200')}>
                                <div className="mb-1.5 flex items-center gap-1">
                                    <span className="text-xs">💰</span>
                                    <span className="text-[10px] font-semibold uppercase text-slate-600">Price Getters</span>
                                    {priceGetterFilter && <Badge colorScheme="orange" className="rounded-full text-[10px]">1</Badge>}
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {[{ v: '', l: 'All' }, { v: 'has', l: 'Has any' }, { v: 'none', l: 'None' }, ...availableGetters.map(g => ({ v: g, l: g }))].map(opt => (
                                        <button
                                            key={opt.v}
                                            type="button"
                                            className={cn(
                                                'cursor-pointer rounded-sm border px-1.5 py-0.5 text-[10px] font-medium',
                                                priceGetterFilter === opt.v
                                                    ? 'border-orange-300 bg-orange-100 text-orange-700 hover:bg-orange-200'
                                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                                            )}
                                            onClick={() => setPriceGetterFilter(opt.v)}
                                        >
                                            {priceGetterFilter === opt.v && opt.v && <LuCheck size={8} style={{ display: 'inline', marginRight: 2 }} />}
                                            {opt.l}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Categories Card (spans 2 cols) */}
                            <div
                                className={cn(
                                    'col-span-1 min-h-[70px] rounded-md border bg-white p-2 md:col-span-2',
                                    categoryFilter.size > 0 ? 'border-green-200' : 'border-slate-200'
                                )}
                            >
                                <div className="mb-1.5 flex items-center justify-between">
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs">📁</span>
                                        <span className="text-[10px] font-semibold uppercase text-slate-600">Categories</span>
                                        {categoryFilter.size > 0 && <Badge colorScheme="green" className="text-[10px]">{categoryFilter.size}</Badge>}
                                    </div>
                                    {categoryFilter.size > 0 && (
                                        <Button size="sm" variant="ghost" onClick={() => setCategoryFilter(new Set())} className="text-[10px]">Clear</Button>
                                    )}
                                </div>
                                {dimensionData.length === 0 ? (
                                    <span className="text-xs text-slate-400">No categories available</span>
                                ) : (
                                    <div className="flex flex-col gap-1.5">
                                        {dimensionData.map(dim => (
                                            <div key={dim.id}>
                                                <div className="flex cursor-pointer items-center gap-1 rounded-sm p-0.5 hover:bg-slate-50" onClick={() => toggleFilterDimension(String(dim.id))}>
                                                    <span className="text-[10px]">{expandedDimensions.has(String(dim.id)) ? '▼' : '▶'}</span>
                                                    <span className="text-[10px] font-medium">{dim.label}</span>
                                                    {dim.categories.some(c => categoryFilter.has(c.id)) && (
                                                        <Badge colorScheme="green" className="text-[10px]">{dim.categories.filter(c => categoryFilter.has(c.id)).length}</Badge>
                                                    )}
                                                </div>
                                                {expandedDimensions.has(String(dim.id)) && (
                                                    <div className="ml-4 mt-0.5 flex flex-wrap gap-1">
                                                        {dim.categories.map(cat => (
                                                            <button
                                                                key={cat.id}
                                                                type="button"
                                                                className="cursor-pointer rounded-sm px-1.5 py-0.5 text-[10px] font-medium"
                                                                style={categoryFilter.has(cat.id) ? { backgroundColor: cat.color || '#319795', color: '#fff' } : { backgroundColor: '#EDF2F7', color: '#4A5568' }}
                                                                onClick={() => toggleFilterCategory(cat.id)}
                                                            >
                                                                {categoryFilter.has(cat.id) && '✓ '}{cat.label}
                                                            </button>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>


            {/* ============ Floating Bulk Actions Bar ============ */}
            {selectedIds.size > 0 && createPortal(
                <div className="animate-slide-up fixed inset-x-0 bottom-0 z-[1000] border-t border-slate-200 backdrop-blur-sm" style={{ backgroundColor: 'rgba(255, 255, 255, 0.85)', boxShadow: '0 -2px 8px rgba(0,0,0,0.08)' }}>
                    <div className="mx-auto max-w-[1400px] px-4 py-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="text-xs font-semibold text-blue-700">
                                {selectedIds.size} asset{selectedIds.size > 1 ? 's' : ''} selected
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm border border-blue-300 px-1.5 py-0.5 text-xs text-blue-700 hover:bg-blue-50" onClick={() => { setBulkStatus(0); setShowBulkStatusDialog(true); }}>
                                    ✓ Status
                                </button>
                                <div className="mx-0.5 h-4 border-l border-slate-300" />
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm border border-purple-300 px-1.5 py-0.5 text-xs text-purple-700 hover:bg-purple-50" onClick={() => { setBulkType(''); setShowBulkTypeDialog(true); }}>
                                    🏷️ Type
                                </button>
                                <div className="mx-0.5 h-4 border-l border-slate-300" />
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm border border-green-300 px-1.5 py-0.5 text-xs text-green-700 hover:bg-green-50" onClick={() => { setBulkCategoryIds(new Set()); setBulkCategoryMode('add'); setShowBulkCategoriesDialog(true); }}>
                                    📁 Categories
                                </button>
                                <div className="mx-0.5 h-4 border-l border-slate-300" />
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm border border-orange-300 px-1.5 py-0.5 text-xs text-orange-700 hover:bg-orange-50" onClick={() => { setBulkPriceGetter({ price_getter: availableGetters[0] || '', external_id: '', priority: 100 }); setShowBulkPriceGettersDialog(true); }}>
                                    💰 Getters
                                </button>
                                <div className="mx-0.5 h-4 border-l border-slate-300" />
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm border border-red-300 px-1.5 py-0.5 text-xs text-red-700 hover:bg-red-50" onClick={() => { fetchDeletionImpact(Array.from(selectedIds)); setShowBulkDeleteDialog(true); }}>
                                    🗑️ Delete
                                </button>
                                <div className="mx-0.5 h-4 border-l border-slate-300" />
                                <button type="button" className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-slate-500 hover:text-slate-700" onClick={() => setSelectedIds(new Set())}>
                                    ✕
                                </button>
                            </div>
                        </div>
                    </div>
                </div>,
                document.body
            )}

            <div className="relative overflow-x-auto rounded-md bg-white text-xs shadow-sm" style={{ paddingBottom: selectedIds.size > 0 ? '48px' : '0' }}>
                {/* Pagination bar (top) */}
                {totalRows > PAGE_SIZE_OPTIONS[0] && (
                    <div className="border-b border-slate-100">
                        <div className="flex w-full items-center justify-between px-3 py-1.5">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-500">Rows:</span>
                                <div className="inline-flex overflow-hidden rounded-md border border-slate-200">
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <Button
                                            key={size}
                                            size="sm"
                                            variant={pageSize === size ? 'subtle' : 'ghost'}
                                            colorScheme={pageSize === size ? 'blue' : 'gray'}
                                            className="rounded-none px-2 text-xs"
                                            onClick={() => { setPageSize(size); setPage(0); }}
                                        >
                                            {size}
                                        </Button>
                                    ))}
                                </div>
                            </div>

                            <span className="text-[10px] text-slate-500">
                                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                            </span>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} className="px-1">
                                    <LuChevronsLeft size={12} />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="px-1">
                                    <LuChevronLeft size={14} />
                                </Button>
                                <span className="mx-1 text-xs text-slate-600">
                                    {safePage + 1} / {pageCount}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="px-1">
                                    <LuChevronRight size={14} />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} className="px-1">
                                    <LuChevronsRight size={12} />
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
                <table className="w-full">
                    <thead>
                        <tr>
                            <th className="w-[30px]">
                                <input
                                    type="checkbox"
                                    title="Select all assets"
                                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                    checked={assets.length > 0 && selectedIds.size === assets.length}
                                    onChange={toggleSelectAll}
                                />
                            </th>
                            <th className="w-[50px]">ID</th>
                            <th className="w-[80px]">Symbol</th>
                            <th className="w-[180px]">Label</th>
                            <th className="w-[100px]">ISIN</th>
                            <th className="w-[60px]">Type</th>
                            <th className="w-[80px]">Currency</th>
                            <th className="w-[280px]">Categories</th>
                            <th className="w-[100px]">Getters</th>
                            <th className="w-[70px]">Txns</th>
                            <th className="w-[60px]">Status</th>
                            <th className="w-[40px]"></th>
                        </tr>
                    </thead>
                    <tbody>
                        {assets.length === 0 ? (
                            <tr>
                                <td colSpan={12}>
                                    <span className="block py-8 text-center text-slate-500">
                                        {allAssets.length === 0 ? 'No assets found' : 'No assets match filters'}
                                    </span>
                                </td>
                            </tr>
                        ) : (
                            paginatedAssets.map(asset => (
                                <tr key={asset.asset_id} className={selectedIds.has(asset.asset_id!) ? 'bg-blue-50' : undefined}>
                                    <td>
                                        <input
                                            type="checkbox"
                                            title={`Select ${asset.symbol}`}
                                            className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                            checked={selectedIds.has(asset.asset_id!)}
                                            onChange={() => toggleSelectAsset(asset.asset_id!)}
                                        />
                                    </td>
                                    <td>{asset.asset_id}</td>
                                    {/* Click-to-edit: Symbol */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'symbol', asset.symbol)}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'symbol' ? (
                                            <Input autoFocus value={cellValue} onChange={e => setCellValue(e.target.value)}
                                                onBlur={saveCellEdit} onKeyDown={handleCellKeyDown} />
                                        ) : (
                                            <Badge colorScheme="blue">{asset.symbol}</Badge>
                                        )}
                                    </td>
                                    {/* Click-to-edit: Label */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'label', asset.label || '')}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'label' ? (
                                            <Input autoFocus value={cellValue} onChange={e => setCellValue(e.target.value)}
                                                onBlur={saveCellEdit} onKeyDown={handleCellKeyDown} />
                                        ) : (
                                            <span className="hover:text-blue-600">{asset.label || '-'}</span>
                                        )}
                                    </td>
                                    {/* Click-to-edit: ISIN */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'isin', asset.isin || '')}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'isin' ? (
                                            <Input autoFocus value={cellValue} onChange={e => setCellValue(e.target.value)}
                                                onBlur={saveCellEdit} onKeyDown={handleCellKeyDown} />
                                        ) : (
                                            <span className={cn('text-xs hover:text-blue-600', !asset.isin && 'text-slate-400')}>{asset.isin || '-'}</span>
                                        )}
                                    </td>
                                    {/* Click-to-edit: Type */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'price_type', asset.price_type || '')}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'price_type' ? (
                                            <select
                                                autoFocus
                                                className="h-8 border border-slate-300 px-2 text-sm"
                                                value={cellValue}
                                                onClick={e => e.stopPropagation()}
                                                onChange={e => saveCellEdit(e.target.value)}
                                                onBlur={cancelCellEdit}
                                            >
                                                <option value="" disabled>—</option>
                                                <option value="crypto">Crypto</option>
                                                <option value="stock">Stock</option>
                                                <option value="fiat">Fiat</option>
                                            </select>
                                        ) : (
                                            <Badge colorScheme={
                                                asset.price_type === 'crypto' ? 'orange' :
                                                    asset.price_type === 'stock' ? 'blue' :
                                                        asset.price_type === 'fiat' ? 'green' : 'gray'
                                            }>
                                                {asset.price_type || '-'}
                                            </Badge>
                                        )}
                                    </td>
                                    {/* Click-to-edit: Denomination Currency */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'denomination_currency_id', String(asset.denomination_currency_id ?? ''))}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'denomination_currency_id' ? (
                                            <select
                                                autoFocus
                                                className="h-8 border border-slate-300 px-2 text-sm"
                                                value={cellValue}
                                                onClick={e => e.stopPropagation()}
                                                onChange={e => saveCellEdit(e.target.value)}
                                                onBlur={cancelCellEdit}
                                            >
                                                <option value="">—</option>
                                                {allAssets.filter(a => a.price_type === 'fiat' && a.asset_id).map(a => (
                                                    <option key={a.asset_id} value={String(a.asset_id)}>
                                                        {a.symbol}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <Badge colorScheme={asset.denomination_currency ? 'green' : 'gray'}>
                                                {asset.denomination_currency?.symbol || '-'}
                                            </Badge>
                                        )}
                                    </td>
                                    <td>
                                        <div className="flex items-center gap-2">
                                            {renderAssetCategories(asset)}
                                            <button
                                                type="button"
                                                className="flex h-4 min-w-[16px] items-center justify-center p-0 text-slate-500 hover:text-slate-700"
                                                onClick={() => openCategoriesDialog(asset)}
                                                title="Manage categories"
                                            >
                                                <LuTags className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                    <td>
                                        <div className="flex items-center gap-2">
                                            {renderPriceGetters(asset)}
                                            <button
                                                type="button"
                                                className="flex h-4 min-w-[16px] items-center justify-center p-0 text-slate-500 hover:text-slate-700"
                                                onClick={() => openGettersDialog(asset)}
                                                title="Configure price getters"
                                            >
                                                <LuSettings className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    </td>
                                    {/* Transaction count */}
                                    <td>
                                        {(() => {
                                            const count = txCountsByAssetId[asset.asset_id!] ?? 0;
                                            return count > 0 ? (
                                                <Badge
                                                    colorScheme="purple"
                                                    className="cursor-pointer hover:opacity-80"
                                                    onClick={() => setDrawerAsset({ id: asset.asset_id!, symbol: asset.symbol })}
                                                    title={`View ${count} transactions for ${asset.symbol}`}
                                                >
                                                    {count}
                                                </Badge>
                                            ) : (
                                                <span className="text-xs text-slate-400">0</span>
                                            );
                                        })()}
                                    </td>
                                    {/* Click-to-edit: Status */}
                                    <td className="cursor-pointer" onClick={() => startCellEdit(asset.asset_id!, 'status', String(asset.status ?? 0))}>
                                        {editingCell && editingCell.assetId === asset.asset_id && editingCell.field === 'status' ? (
                                            <select
                                                autoFocus
                                                className="h-8 border border-slate-300 px-2 text-sm"
                                                value={cellValue}
                                                onClick={e => e.stopPropagation()}
                                                onChange={e => saveCellEdit(e.target.value)}
                                                onBlur={cancelCellEdit}
                                            >
                                                <option value="0">Active</option>
                                                <option value="1">Inactive</option>
                                            </select>
                                        ) : (
                                            <Badge colorScheme={asset.status === 0 ? 'green' : 'gray'}>
                                                {asset.status === 0 ? 'Active' : 'Inactive'}
                                            </Badge>
                                        )}
                                    </td>
                                    <td>
                                        <button
                                            type="button"
                                            className="flex h-4 min-w-[16px] items-center justify-center p-0 text-red-500 hover:text-red-700"
                                            onClick={() => deleteAsset(asset.asset_id!, asset.symbol)}
                                            title="Delete asset"
                                        >
                                            <LuTrash2 className="h-3.5 w-3.5" />
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
                {/* Pagination bar (bottom) */}
                {totalRows > PAGE_SIZE_OPTIONS[0] && (
                    <div className="border-t border-slate-100">
                        <div className="flex w-full items-center justify-between px-3 py-1.5">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-500">Rows:</span>
                                <div className="inline-flex overflow-hidden rounded-md border border-slate-200">
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <Button
                                            key={size}
                                            size="sm"
                                            variant={pageSize === size ? 'subtle' : 'ghost'}
                                            colorScheme={pageSize === size ? 'blue' : 'gray'}
                                            className="rounded-none px-2 text-xs"
                                            onClick={() => { setPageSize(size); setPage(0); }}
                                        >
                                            {size}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            <span className="text-[10px] text-slate-500">
                                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
                            </span>
                            <div className="flex items-center gap-1">
                                <Button size="sm" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} className="px-1">
                                    <LuChevronsLeft size={12} />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="px-1">
                                    <LuChevronLeft size={14} />
                                </Button>
                                <span className="mx-1 text-xs text-slate-600">
                                    {safePage + 1} / {pageCount}
                                </span>
                                <Button size="sm" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} className="px-1">
                                    <LuChevronRight size={14} />
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} className="px-1">
                                    <LuChevronsRight size={12} />
                                </Button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="mt-2 rounded-md bg-white p-2 shadow-sm">
                <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">
                        <strong>Showing:</strong> {assets.length} of {allAssets.length} assets
                        {hasActiveFilters && ' (filtered)'}
                    </span>
                    {selectedIds.size > 0 && (
                        <span className="text-sm text-blue-600">
                            <strong>{selectedIds.size}</strong> selected
                        </span>
                    )}
                </div>
            </div>

            {/* Create Asset Dialog — delegated to canonical AssetFormDialog */}
            <AssetFormDialog
                isOpen={showCreateDialog}
                onClose={handleCreateFormClose}
            />

            {/* Price Getters Dialog */}
            <RadixDialog.Root open={showGettersDialog} onOpenChange={(open) => setShowGettersDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[750px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">
                                Price Getters for {selectedAsset?.symbol}
                            </RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Configure price sources for this asset. Lower priority numbers are tried first.
                                If no getters are configured, the default (Yahoo) will be used.
                            </span>

                            {/* Current getters */}
                            {selectedAsset?.price_getters && selectedAsset.price_getters.length > 0 && (
                                <div className="mb-6">
                                    <span className="mb-2 block font-medium">Current Price Getters:</span>
                                    <div className="overflow-x-auto">
                                        <table className="w-full">
                                            <thead>
                                                <tr>
                                                    <th>Source</th>
                                                    <th>External ID</th>
                                                    <th>Parameters</th>
                                                    <th>Priority</th>
                                                    <th>Enabled</th>
                                                    <th>Test</th>
                                                    <th>Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {selectedAsset.price_getters.map(pg => {
                                                    const isEditing = editingGetterId === pg.id;
                                                    const isMock = pg.price_getter === 'mock';
                                                    const autoResult = autoTestResults[pg.id];

                                                    // For mock getters, show min/max params specially
                                                    const mockMin = pg.params?.min_price;
                                                    const mockMax = pg.params?.max_price;
                                                    const mockPrices = pg.params?.prices as Record<string, number> | undefined;
                                                    const hasConfiguredPrices = isMock && mockPrices && typeof mockPrices === 'object' && Object.keys(mockPrices).length > 0;
                                                    const mockQuoteCurrency = pg.params?.quote_currency as string | undefined;

                                                    // Non-mock params display
                                                    const paramsEntries = Object.entries(pg.params || {}).filter(
                                                        ([k]) => !isMock || (k !== 'min_price' && k !== 'max_price')
                                                    );
                                                    const hasParams = isMock ? (mockMin != null || mockMax != null || hasConfiguredPrices) : paramsEntries.length > 0;

                                                    return (
                                                        <tr key={pg.id}>
                                                            <td>
                                                                <Badge colorScheme={isMock ? 'orange' : 'purple'}>{pg.price_getter}</Badge>
                                                            </td>
                                                            <td>
                                                                {isEditing ? (
                                                                    <Input
                                                                        className="w-[120px] font-mono"
                                                                        value={editingValues.external_id}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, external_id: e.target.value }))}
                                                                        placeholder="e.g. BTC-USD"
                                                                    />
                                                                ) : (
                                                                    <span className="font-mono text-sm">
                                                                        {pg.external_id || <span className="text-slate-400">(auto)</span>}
                                                                    </span>
                                                                )}
                                                            </td>
                                                            <td>
                                                                {isEditing && isMock && !hasConfiguredPrices ? (
                                                                    /* Mock getter: min/max text boxes */
                                                                    (() => {
                                                                        let minVal: number | string = '', maxVal: number | string = '';
                                                                        try { const p = JSON.parse(editingValues.params); minVal = p.min_price ?? ''; maxVal = p.max_price ?? ''; } catch { /* ignore */ }
                                                                        return (
                                                                            <div className="flex items-center gap-1">
                                                                                <Input
                                                                                    type="number"
                                                                                    placeholder="Min"
                                                                                    className="w-[80px] text-xs"
                                                                                    value={minVal}
                                                                                    onChange={(e) => {
                                                                                        try {
                                                                                            const p = JSON.parse(editingValues.params || '{}');
                                                                                            p.min_price = e.target.value ? parseFloat(e.target.value) : 0;
                                                                                            setEditingValues(v => ({ ...v, params: JSON.stringify(p) }));
                                                                                        } catch { /* ignore */ }
                                                                                    }}
                                                                                />
                                                                                <span className="text-xs text-slate-400">–</span>
                                                                                <Input
                                                                                    type="number"
                                                                                    placeholder="Max"
                                                                                    className="w-[80px] text-xs"
                                                                                    value={maxVal}
                                                                                    onChange={(e) => {
                                                                                        try {
                                                                                            const p = JSON.parse(editingValues.params || '{}');
                                                                                            p.max_price = e.target.value ? parseFloat(e.target.value) : 0;
                                                                                            setEditingValues(v => ({ ...v, params: JSON.stringify(p) }));
                                                                                        } catch { /* ignore */ }
                                                                                    }}
                                                                                />
                                                                            </div>
                                                                        );
                                                                    })()
                                                                ) : isEditing ? (
                                                                    <Textarea
                                                                        className="w-[150px] font-mono text-xs"
                                                                        value={editingValues.params}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, params: e.target.value }))}
                                                                        placeholder='{"key": "value"}'
                                                                        rows={2}
                                                                    />
                                                                ) : isMock && hasConfiguredPrices ? (
                                                                    /* Mock getter: deterministic prices summary */
                                                                    <Tooltip content={
                                                                        <div className="whitespace-pre font-mono text-xs">
                                                                            {Object.entries(mockPrices!).map(([k, v]) => (
                                                                                <div key={k}>{k} → {v}</div>
                                                                            ))}
                                                                        </div>
                                                                    } showArrow>
                                                                        <span className="cursor-default font-mono text-xs text-orange-600">
                                                                            {Object.keys(mockPrices!).length} price{Object.keys(mockPrices!).length !== 1 ? 's' : ''}{mockQuoteCurrency ? ` (${mockQuoteCurrency})` : ''}
                                                                        </span>
                                                                    </Tooltip>
                                                                ) : isMock ? (
                                                                    /* Mock getter: display range */
                                                                    <span className="font-mono text-xs text-orange-600">
                                                                        {mockMin != null && mockMax != null
                                                                            ? `${mockMin} – ${mockMax}`
                                                                            : <span className="text-slate-400">no range</span>}
                                                                    </span>
                                                                ) : hasParams ? (
                                                                    <div className="flex flex-wrap gap-1">
                                                                        {paramsEntries.map(([k, v]) => (
                                                                            <Badge key={k} colorScheme="gray">
                                                                                {k}: {String(v)}
                                                                            </Badge>
                                                                        ))}
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-xs text-slate-400">—</span>
                                                                )}
                                                            </td>
                                                            <td>
                                                                {isEditing ? (
                                                                    <Input
                                                                        type="number"
                                                                        className="w-[60px]"
                                                                        value={editingValues.priority}
                                                                        onChange={(e) => setEditingValues(v => ({ ...v, priority: parseInt(e.target.value) || 100 }))}
                                                                    />
                                                                ) : (
                                                                    pg.priority
                                                                )}
                                                            </td>
                                                            <td>
                                                                <Badge
                                                                    colorScheme={pg.enabled ? 'green' : 'gray'}
                                                                    className="cursor-pointer"
                                                                    onClick={() => togglePriceGetter(pg)}
                                                                >
                                                                    {pg.enabled ? 'Yes' : 'No'}
                                                                </Badge>
                                                            </td>
                                                            <td>
                                                                <div className="flex items-center gap-1">
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
                                                                            <div className="cursor-default">
                                                                                {autoResult.loading ? (
                                                                                    <Spinner size="xs" />
                                                                                ) : autoResult.success ? (
                                                                                    <span className="text-sm text-green-500">✅</span>
                                                                                ) : (
                                                                                    <span className="text-sm text-red-500">❌</span>
                                                                                )}
                                                                            </div>
                                                                        </Tooltip>
                                                                    )}
                                                                    <button
                                                                        type="button"
                                                                        className="flex h-4 min-w-[16px] items-center justify-center p-0 text-blue-500 hover:text-blue-700"
                                                                        onClick={() => openTestModal(pg)}
                                                                        title="Test getter"
                                                                    >
                                                                        <LuPlay size={12} />
                                                                    </button>
                                                                </div>
                                                            </td>
                                                            <td>
                                                                {isEditing ? (
                                                                    <div className="flex gap-1">
                                                                        <button type="button" className="text-green-600 hover:text-green-800" onClick={saveEditingGetter}>✓</button>
                                                                        <button type="button" className="text-slate-500 hover:text-slate-700" onClick={cancelEditingGetter}>✕</button>
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex gap-1">
                                                                        <button type="button" className="text-blue-500 hover:text-blue-700" onClick={() => startEditingGetter(pg)}>✏️</button>
                                                                        {!isMock && (
                                                                            <button type="button" className="text-red-500 hover:text-red-700" onClick={() => deletePriceGetter(pg.id)}>🗑️</button>
                                                                        )}
                                                                    </div>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}

                            {/* Add new getter */}
                            <div className="border-t border-slate-200 pt-4">
                                <span className="mb-3 block font-medium">Add Price Getter:</span>
                                <div className="flex flex-col gap-3">
                                    <div className="flex gap-3">
                                        <div className="flex-1">
                                            <span className="mb-1 block text-sm">Source</span>
                                            <select
                                                className="h-8 w-full border border-slate-300 px-2 text-sm"
                                                value={newGetter.price_getter}
                                                onChange={e => setNewGetter({ ...newGetter, price_getter: e.target.value })}
                                            >
                                                {availableGetters.filter(g => g !== 'mock').map(g => (
                                                    <option key={g} value={g}>{g}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="flex-1">
                                            <span className="mb-1 block text-sm">Priority</span>
                                            <Input
                                                type="number"
                                                value={newGetter.priority}
                                                onChange={e => setNewGetter({ ...newGetter, priority: parseInt(e.target.value) || 100 })}
                                            />
                                        </div>
                                    </div>
                                    <div>
                                        <span className="mb-1 block text-sm">
                                            External ID
                                            <span className="ml-1 text-xs text-slate-500">
                                                (e.g., "BTC-USD" for Yahoo, "bitcoin" for CoinGecko, "AAPL" for DataReader)
                                            </span>
                                        </span>
                                        <Input
                                            placeholder={selectedAsset?.symbol || 'Leave empty to use asset symbol'}
                                            value={newGetter.external_id || ''}
                                            onChange={e => setNewGetter({
                                                ...newGetter,
                                                external_id: e.target.value || ''
                                            })}
                                        />
                                        {!newGetter.external_id && selectedAsset?.symbol && (
                                            <span className="mt-0.5 block text-xs text-slate-400">
                                                Will use "{selectedAsset.symbol}" by default
                                            </span>
                                        )}
                                    </div>
                                    <div>
                                        <span className="mb-1 block text-sm">
                                            Extra Parameters
                                            <span className="ml-1 text-xs text-slate-500">
                                                (JSON, e.g., {`{"native_quote_currency": "EUR"}`})
                                            </span>
                                        </span>
                                        <Input
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
                                    </div>
                                    <div className="flex gap-2">
                                        <Button colorScheme="blue" size="sm" onClick={addPriceGetter} className="flex-1">
                                            ➕ Add Price Getter
                                        </Button>
                                        <Button
                                            colorScheme="green"
                                            variant="outline"
                                            size="sm"
                                            onClick={testNewGetter}
                                            disabled={!newGetter.price_getter || newGetterTestLoading}
                                        >
                                            {newGetterTestLoading ? <Spinner size="xs" /> : '🧪 Test'}
                                        </Button>
                                    </div>
                                    {newGetterTestResult && (
                                        <div className={cn('p-2 text-xs', newGetterTestResult.success ? 'bg-green-50' : 'bg-red-50')}>
                                            {newGetterTestResult.success ? (
                                                <span className="text-green-700">
                                                    ✅ Price: <strong>{newGetterTestResult.price?.toFixed(6)}</strong>
                                                </span>
                                            ) : (
                                                <span className="text-red-700">❌ {newGetterTestResult.error}</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowGettersDialog(false)}>
                                Close
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Test Price Getter Modal */}
            <RadixDialog.Root open={showTestModal} onOpenChange={(open) => { setShowTestModal(open); if (!open) { setTestResult(null); setTestModalGetter(null); } }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">
                                🧪 Test: {testModalGetter?.price_getter}
                                {testModalGetter?.external_id && (
                                    <span className="text-sm font-normal text-slate-500"> ({testModalGetter.external_id})</span>
                                )}
                            </RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <div className="flex flex-col gap-3">
                                <div>
                                    <span className="mb-1 block text-sm font-medium">Test Date</span>
                                    <Input
                                        type="date"
                                        value={testDate}
                                        onChange={e => setTestDate(e.target.value)}
                                    />
                                </div>
                                <Button
                                    colorScheme="blue"
                                    size="sm"
                                    onClick={runTestFromModal}
                                    disabled={testLoading}
                                >
                                    {testLoading ? <Spinner size="xs" className="mr-2" /> : null}
                                    Run Test
                                </Button>
                                {testResult && (
                                    <div className={cn('border p-3', testResult.success ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50')}>
                                        {testResult.success ? (
                                            <div className="flex flex-col gap-1">
                                                <span className="font-medium text-green-700">
                                                    ✅ Price: {testResult.price?.toFixed(6)}
                                                </span>
                                                {testResult.source && (
                                                    <span className="text-xs text-slate-600">Source: {testResult.source}</span>
                                                )}
                                                {testResult.quote_currency && (
                                                    <span className="text-xs text-slate-600">Quote: {testResult.quote_currency}</span>
                                                )}
                                                {testResult.ticker_used && (
                                                    <span className="text-xs text-slate-600">Ticker: {testResult.ticker_used}</span>
                                                )}
                                            </div>
                                        ) : (
                                            <span className="text-sm text-red-700">❌ {testResult.error}</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" size="sm" onClick={() => setShowTestModal(false)}>
                                Close
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Categories Assignment Dialog */}
            <RadixDialog.Root open={showCategoriesDialog} onOpenChange={(open) => {
                setShowCategoriesDialog(open);
                if (open) setCategoriesDialogTab(String(dimensionData[0]?.id ?? ''));
            }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[650px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">
                                🏷️ Categories for {selectedAsset?.symbol}
                            </RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Assign categories to classify this asset for reporting and filtering.
                                Select categories from each dimension as needed.
                            </span>

                            {dimensionData.length === 0 ? (
                                <div className="py-6 text-center">
                                    <span className="text-slate-500">No categories available. Create some in the Categories editor first.</span>
                                </div>
                            ) : (
                                <Tabs value={categoriesDialogTab || String(dimensionData[0]?.id)} onValueChange={setCategoriesDialogTab}>
                                    <TabsList className="mb-4">
                                        {dimensionData.map(dim => (
                                            <TabsTrigger key={dim.id} value={String(dim.id)}>
                                                {dim.label}
                                                {dim.categories.some(c => selectedCategoryIds.has(c.id)) && (
                                                    <Badge colorScheme="blue" className="ml-1">
                                                        {dim.categories.filter(c => selectedCategoryIds.has(c.id)).length}
                                                    </Badge>
                                                )}
                                            </TabsTrigger>
                                        ))}
                                    </TabsList>

                                    {dimensionData.map(dim => (
                                        <TabsContent key={dim.id} value={String(dim.id)}>
                                            <div className="max-h-[300px] overflow-y-auto border border-slate-200 p-3">
                                                {dim.categories.length === 0 ? (
                                                    <span className="text-sm text-slate-500">No categories in this dimension.</span>
                                                ) : (
                                                    <div className="flex flex-col gap-2">
                                                        {dim.categories.map(cat => (
                                                            <div
                                                                key={cat.id}
                                                                className={cn(
                                                                    'flex cursor-pointer items-center gap-3 p-2',
                                                                    selectedCategoryIds.has(cat.id) ? 'bg-blue-50 hover:bg-blue-100' : 'hover:bg-slate-50',
                                                                )}
                                                                onClick={() => toggleCategory(cat.id)}
                                                            >
                                                                <input
                                                                    type="checkbox"
                                                                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                                                    checked={selectedCategoryIds.has(cat.id)}
                                                                    onChange={() => toggleCategory(cat.id)}
                                                                />
                                                                {cat.color && (
                                                                    <div
                                                                        className="h-3 w-3 rounded-full"
                                                                        style={{ backgroundColor: cat.color }}
                                                                    />
                                                                )}
                                                                <div className="flex-1">
                                                                    <span className="text-sm font-medium">{cat.label}</span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </TabsContent>
                                    ))}
                                </Tabs>
                            )}

                            {/* Selected summary */}
                            {selectedCategoryIds.size > 0 && (
                                <div className="mt-4 bg-slate-50 p-3">
                                    <span className="mb-2 block text-sm font-medium">
                                        Selected ({selectedCategoryIds.size}):
                                    </span>
                                    <div className="flex flex-wrap gap-1">
                                        {dimensionData.flatMap(dim =>
                                            dim.categories
                                                .filter(c => selectedCategoryIds.has(c.id))
                                                .map(cat => (
                                                    <Badge
                                                        key={cat.id}
                                                        style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                                                        colorScheme={!cat.color ? 'purple' : undefined}
                                                    >
                                                        {cat.label}
                                                        <span
                                                            className="ml-1 cursor-pointer"
                                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); toggleCategory(cat.id); }}
                                                        >
                                                            ✕
                                                        </span>
                                                    </Badge>
                                                ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowCategoriesDialog(false)}>
                                Cancel
                            </Button>
                            <Button
                                colorScheme="blue"
                                onClick={saveCategories}
                                loading={savingCategories}
                            >
                                💾 Save Categories
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* CSV Import Dialog */}
            <RadixDialog.Root open={showImportDialog} onOpenChange={(open) => { setShowImportDialog(open); if (!open) resetImportDialog(); }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[800px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">
                                📥 Import Assets from CSV
                            </RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            {importStep === 'select' && (
                                <div>
                                    <span className="mb-4 block text-sm text-slate-600">
                                        Upload a CSV file to bulk import assets with price getters and categories.
                                    </span>

                                    {/* File drop zone */}
                                    <div
                                        className={cn(
                                            'cursor-pointer border-2 border-dashed p-8 text-center transition-all hover:border-blue-400 hover:bg-blue-50',
                                            importFile ? 'border-green-400 bg-green-50' : 'border-slate-300 bg-slate-50',
                                        )}
                                        onClick={() => fileInputRef.current?.click()}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={handleFileDrop}
                                    >
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".csv"
                                            onChange={handleFileSelect}
                                            style={{ display: 'none' }}
                                        />
                                        {importFile ? (
                                            <div>
                                                <span className="block text-lg font-medium text-green-600">
                                                    ✅ {importFile.name}
                                                </span>
                                                <span className="mt-1 block text-sm text-slate-500">
                                                    {(importFile.size / 1024).toFixed(1)} KB
                                                </span>
                                                <Button size="sm" className="mt-3" variant="outline" onClick={(e) => { e.stopPropagation(); setImportFile(null); }}>
                                                    Choose Different File
                                                </Button>
                                            </div>
                                        ) : (
                                            <div>
                                                <span className="mb-2 block text-lg">📂</span>
                                                <span className="block font-medium">Drop CSV file here or click to browse</span>
                                                <span className="mt-1 block text-sm text-slate-500">
                                                    Supports: .csv files
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Expected format info */}
                                    <div className="mt-4 bg-blue-50 p-3">
                                        <span className="mb-2 block text-sm font-medium text-blue-700">
                                            Expected CSV Format:
                                        </span>
                                        <span className="block font-mono text-xs text-blue-600">
                                            Ticker / Symbol, Label, Source 1, Symbol 1, Source 2, Symbol 2,
                                            Source 3, Symbol 3, Currency, Investment Category 1, Investment Category 2
                                        </span>
                                    </div>
                                </div>
                            )}

                            {importStep === 'preview' && importPreview && (
                                <div>
                                    <div className="mb-4 flex gap-4">
                                        <div className="flex-1 bg-blue-50 p-3">
                                            <span className="block text-2xl font-bold text-blue-600">
                                                {importPreview.assets_count}
                                            </span>
                                            <span className="block text-sm text-blue-600">Assets</span>
                                        </div>
                                        <div className="flex-1 bg-purple-50 p-3">
                                            <span className="block text-2xl font-bold text-purple-600">
                                                {importPreview.categories_count}
                                            </span>
                                            <span className="block text-sm text-purple-600">Categories</span>
                                        </div>
                                        {importPreview.errors.length > 0 && (
                                            <div className="flex-1 bg-red-50 p-3">
                                                <span className="block text-2xl font-bold text-red-600">
                                                    {importPreview.errors.length}
                                                </span>
                                                <span className="block text-sm text-red-600">Parse Errors</span>
                                            </div>
                                        )}
                                    </div>

                                    {/* Preview table */}
                                    <span className="mb-2 block font-medium">Assets to Import:</span>
                                    <div className="max-h-[300px] overflow-y-auto border border-slate-200">
                                        <table className="w-full">
                                            <thead>
                                                <tr>
                                                    <th>Symbol</th>
                                                    <th>Label</th>
                                                    <th>Type</th>
                                                    <th>Price Getters</th>
                                                    <th>Categories</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {importPreview.assets.slice(0, 20).map((asset, idx) => (
                                                    <tr key={idx}>
                                                        <td>
                                                            <Badge colorScheme="blue">{asset.symbol}</Badge>
                                                        </td>
                                                        <td>
                                                            <span className="block max-w-[150px] truncate text-sm">{asset.label}</span>
                                                        </td>
                                                        <td>
                                                            <Badge colorScheme={
                                                                asset.price_type === 'crypto' ? 'orange' :
                                                                    asset.price_type === 'stock' ? 'blue' : 'green'
                                                            }>
                                                                {asset.price_type}
                                                            </Badge>
                                                        </td>
                                                        <td>
                                                            <div className="flex flex-wrap gap-1">
                                                                {asset.price_getters.map((pg, i) => (
                                                                    <Badge key={i} colorScheme="purple">
                                                                        {pg.getter}
                                                                    </Badge>
                                                                ))}
                                                            </div>
                                                        </td>
                                                        <td>
                                                            <div className="flex flex-wrap gap-1">
                                                                {asset.categories.slice(0, 2).map((cat, i) => (
                                                                    <Badge key={i} colorScheme="gray">
                                                                        {cat}
                                                                    </Badge>
                                                                ))}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {importPreview.assets.length > 20 && (
                                            <span className="block p-2 text-center text-sm text-slate-500">
                                                ... and {importPreview.assets.length - 20} more assets
                                            </span>
                                        )}
                                    </div>

                                    {/* Import options */}
                                    <div className="mt-4 bg-slate-50 p-3">
                                        <span className="mb-3 block font-medium">Import Options:</span>
                                        <div className="flex flex-col gap-3">
                                            <div className="flex items-center gap-3">
                                                <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                                    checked={dryRunMode}
                                                    onChange={(e) => setDryRunMode(e.target.checked)}
                                                />
                                                <div>
                                                    <span className="block text-sm font-medium">Dry Run (Preview Only)</span>
                                                    <span className="block text-xs text-slate-500">
                                                        See what would be imported without making changes
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                                    checked={replacePriceGetters}
                                                    onChange={(e) => setReplacePriceGetters(e.target.checked)}
                                                />
                                                <div>
                                                    <span className="block text-sm font-medium">Replace Existing Price Getters</span>
                                                    <span className="block text-xs text-slate-500">
                                                        Uncheck to merge with existing price getters
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Errors/warnings */}
                                    {importPreview.errors.length > 0 && (
                                        <div className="mt-4 bg-red-50 p-3">
                                            <span className="mb-2 block font-medium text-red-600">⚠️ Parse Errors:</span>
                                            {importPreview.errors.slice(0, 5).map((err, i) => (
                                                <span key={i} className="block text-sm text-red-600">
                                                    Row {err.row}: {err.error}
                                                </span>
                                            ))}
                                            {importPreview.errors.length > 5 && (
                                                <span className="block text-sm text-red-500">
                                                    ... and {importPreview.errors.length - 5} more errors
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {importStep === 'result' && importResult && (
                                <div>
                                    <div
                                        className={cn(
                                            'mb-4 p-4 text-center',
                                            importResult.dry_run ? 'bg-blue-50' : 'bg-green-50',
                                        )}
                                    >
                                        <span className={cn('block text-xl font-bold', importResult.dry_run ? 'text-blue-600' : 'text-green-600')}>
                                            {importResult.dry_run ? '🔍 Dry Run Complete' : '✅ Import Successful!'}
                                        </span>
                                        {importResult.dry_run && (
                                            <span className="mt-1 block text-sm text-blue-600">
                                                No changes were made. Uncheck "Dry Run" and import again to apply changes.
                                            </span>
                                        )}
                                    </div>

                                    <div className="mb-4 flex flex-wrap gap-4">
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="mb-2 block font-medium">Assets</span>
                                            <div className="flex gap-2">
                                                <Badge colorScheme="green">{importResult.assets.created} created</Badge>
                                                <Badge colorScheme="blue">{importResult.assets.updated} updated</Badge>
                                            </div>
                                        </div>
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="mb-2 block font-medium">Categories</span>
                                            <div className="flex gap-2">
                                                <Badge colorScheme="green">{importResult.categories.created} created</Badge>
                                                <Badge colorScheme="blue">{importResult.categories.updated} updated</Badge>
                                            </div>
                                        </div>
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="mb-2 block font-medium">Price Getters</span>
                                            <div className="flex gap-2">
                                                <Badge colorScheme="green">{importResult.price_getters.created} created</Badge>
                                            </div>
                                        </div>
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="mb-2 block font-medium">Category Links</span>
                                            <div className="flex gap-2">
                                                <Badge colorScheme="green">{importResult.asset_categories.created} created</Badge>
                                            </div>
                                        </div>
                                    </div>

                                    {importResult.summary.total_errors > 0 && (
                                        <div className="bg-red-50 p-3">
                                            <span className="mb-2 block font-medium text-red-600">
                                                ⚠️ {importResult.summary.total_errors} Errors:
                                            </span>
                                            {importResult.parse_errors.slice(0, 3).map((err, i) => (
                                                <span key={i} className="block text-sm text-red-600">
                                                    {JSON.stringify(err)}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {importResult.warnings.length > 0 && (
                                        <div className="mt-3 bg-yellow-50 p-3">
                                            <span className="mb-2 block font-medium text-yellow-700">
                                                ⚠️ Warnings:
                                            </span>
                                            {importResult.warnings.slice(0, 5).map((warn, i) => (
                                                <span key={i} className="block text-sm text-yellow-700">{warn}</span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {importLoading && (
                                <div className="flex items-center justify-center py-8">
                                    <Spinner size="lg" className="text-blue-500" />
                                    <span className="ml-3">Processing...</span>
                                </div>
                            )}
                        </div>
                        <div className="flex w-full items-center justify-between gap-2 border-t border-slate-200 p-4">
                            <div>
                                {importStep !== 'select' && (
                                    <Button variant="outline" onClick={resetImportDialog}>
                                        ← Start Over
                                    </Button>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                                    {importStep === 'result' ? 'Close' : 'Cancel'}
                                </Button>
                                {importStep === 'select' && (
                                    <Button
                                        colorScheme="blue"
                                        onClick={previewImport}
                                        disabled={!importFile || importLoading}
                                    >
                                        Preview Import →
                                    </Button>
                                )}
                                {importStep === 'preview' && (
                                    <Button
                                        colorScheme={dryRunMode ? 'blue' : 'green'}
                                        onClick={executeImport}
                                        disabled={importLoading}
                                    >
                                        {dryRunMode ? '🔍 Run Dry Import' : '📥 Import Assets'}
                                    </Button>
                                )}
                                {importStep === 'result' && importResult?.dry_run && (
                                    <Button
                                        colorScheme="green"
                                        onClick={() => { setDryRunMode(false); setImportStep('preview'); }}
                                    >
                                        📥 Import for Real
                                    </Button>
                                )}
                            </div>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Bulk Status Dialog */}
            <RadixDialog.Root open={showBulkStatusDialog} onOpenChange={(open) => setShowBulkStatusDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">Set Status for {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Change the status of all selected assets.
                            </span>
                            <div>
                                <span className="mb-2 block font-medium">New Status</span>
                                <select
                                    className="h-8 w-full border border-slate-300 px-2 text-sm"
                                    value={String(bulkStatus)}
                                    onChange={e => setBulkStatus(parseInt(e.target.value))}
                                >
                                    <option value="0">Active</option>
                                    <option value="1">Inactive</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkStatusDialog(false)}>Cancel</Button>
                            <Button colorScheme="blue" onClick={executeBulkStatusUpdate} loading={bulkOperationLoading}>
                                Apply to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Bulk Type Dialog */}
            <RadixDialog.Root open={showBulkTypeDialog} onOpenChange={(open) => setShowBulkTypeDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">Set Type for {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Change the price type of all selected assets.
                            </span>
                            <div>
                                <span className="mb-2 block font-medium">New Type</span>
                                <select
                                    className="h-8 w-full border border-slate-300 px-2 text-sm"
                                    value={bulkType}
                                    onChange={e => setBulkType(e.target.value)}
                                >
                                    <option value="">-- Select Type --</option>
                                    <option value="crypto">Crypto</option>
                                    <option value="stock">Stock</option>
                                    <option value="fiat">Fiat</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkTypeDialog(false)}>Cancel</Button>
                            <Button colorScheme="blue" onClick={executeBulkTypeUpdate} loading={bulkOperationLoading} disabled={!bulkType}>
                                Apply to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Bulk Categories Dialog */}
            <RadixDialog.Root open={showBulkCategoriesDialog} onOpenChange={(open) => {
                setShowBulkCategoriesDialog(open);
                if (open) setBulkCategoriesDialogTab(String(dimensionData[0]?.id ?? ''));
            }}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[650px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">Assign Categories to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Select how to apply categories to the selected assets.
                            </span>

                            {/* Mode Selection */}
                            <div className="mb-4 bg-slate-50 p-3">
                                <span className="mb-2 block font-medium">Operation Mode</span>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        colorScheme={bulkCategoryMode === 'add' ? 'green' : 'gray'}
                                        variant={bulkCategoryMode === 'add' ? 'solid' : 'outline'}
                                        onClick={() => setBulkCategoryMode('add')}
                                    >
                                        ➕ Add to existing
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorScheme={bulkCategoryMode === 'replace' ? 'green' : 'gray'}
                                        variant={bulkCategoryMode === 'replace' ? 'solid' : 'outline'}
                                        onClick={() => setBulkCategoryMode('replace')}
                                    >
                                        🔄 Replace all
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorScheme={bulkCategoryMode === 'remove' ? 'red' : 'gray'}
                                        variant={bulkCategoryMode === 'remove' ? 'solid' : 'outline'}
                                        onClick={() => setBulkCategoryMode('remove')}
                                    >
                                        ➖ Remove
                                    </Button>
                                </div>
                                <span className="mt-2 block text-xs text-slate-500">
                                    {bulkCategoryMode === 'add' && 'Selected categories will be added to assets (keeping existing).'}
                                    {bulkCategoryMode === 'replace' && 'All existing categories will be replaced with selected ones.'}
                                    {bulkCategoryMode === 'remove' && 'Selected categories will be removed from assets.'}
                                </span>
                            </div>

                            {/* Category Selection */}
                            {dimensionData.length === 0 ? (
                                <div className="py-6 text-center">
                                    <span className="text-slate-500">No categories available.</span>
                                </div>
                            ) : (
                                <Tabs value={bulkCategoriesDialogTab || String(dimensionData[0]?.id)} onValueChange={setBulkCategoriesDialogTab}>
                                    <TabsList className="mb-4">
                                        {dimensionData.map(dim => (
                                            <TabsTrigger key={dim.id} value={String(dim.id)}>
                                                {dim.label}
                                                {dim.categories.some(c => bulkCategoryIds.has(c.id)) && (
                                                    <Badge colorScheme="green" className="ml-1">
                                                        {dim.categories.filter(c => bulkCategoryIds.has(c.id)).length}
                                                    </Badge>
                                                )}
                                            </TabsTrigger>
                                        ))}
                                    </TabsList>

                                    {dimensionData.map(dim => (
                                        <TabsContent key={dim.id} value={String(dim.id)}>
                                            <div className="max-h-[250px] overflow-y-auto border border-slate-200 p-3">
                                                {dim.categories.length === 0 ? (
                                                    <span className="text-sm text-slate-500">No categories in this dimension.</span>
                                                ) : (
                                                    <div className="flex flex-col gap-2">
                                                        {dim.categories.map(cat => (
                                                            <div
                                                                key={cat.id}
                                                                className={cn(
                                                                    'flex cursor-pointer items-center gap-3 p-2',
                                                                    bulkCategoryIds.has(cat.id) ? 'bg-green-50 hover:bg-green-100' : 'hover:bg-slate-50',
                                                                )}
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
                                                                <input
                                                                    type="checkbox"
                                                                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                                                    checked={bulkCategoryIds.has(cat.id)}
                                                                    onChange={() => { /* toggled via parent onClick */ }}
                                                                />
                                                                {cat.color && (
                                                                    <div className="h-3 w-3 rounded-full" style={{ backgroundColor: cat.color }} />
                                                                )}
                                                                <div className="flex-1">
                                                                    <span className="text-sm font-medium">{cat.label}</span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </TabsContent>
                                    ))}
                                </Tabs>
                            )}

                            {/* Selected Summary */}
                            {bulkCategoryIds.size > 0 && (
                                <div className="mt-4 bg-slate-50 p-3">
                                    <span className="mb-2 block text-sm font-medium">
                                        Selected ({bulkCategoryIds.size}):
                                    </span>
                                    <div className="flex flex-wrap gap-1">
                                        {dimensionData.flatMap(dim =>
                                            dim.categories
                                                .filter(c => bulkCategoryIds.has(c.id))
                                                .map(cat => (
                                                    <Badge
                                                        key={cat.id}
                                                        style={cat.color ? { backgroundColor: cat.color, color: '#fff' } : undefined}
                                                        colorScheme={!cat.color ? 'green' : undefined}
                                                    >
                                                        {cat.label}
                                                    </Badge>
                                                ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkCategoriesDialog(false)}>Cancel</Button>
                            <Button
                                colorScheme="green"
                                onClick={executeBulkCategoriesUpdate}
                                loading={bulkOperationLoading}
                                disabled={bulkCategoryIds.size === 0}
                            >
                                {bulkCategoryMode === 'add' && '➕ Add'}
                                {bulkCategoryMode === 'replace' && '🔄 Replace'}
                                {bulkCategoryMode === 'remove' && '➖ Remove'}
                                {' '}Categories
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Bulk Price Getters Dialog */}
            <RadixDialog.Root open={showBulkPriceGettersDialog} onOpenChange={(open) => setShowBulkPriceGettersDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[500px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">Assign Price Getter to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-4 block text-sm text-slate-600">
                                Add a price getter to all selected assets. This will add to existing getters.
                            </span>

                            <div className="flex flex-col gap-4">
                                <div>
                                    <span className="mb-2 block font-medium">Price Getter Source</span>
                                    <select
                                        className="h-8 w-full border border-slate-300 px-2 text-sm"
                                        value={bulkPriceGetter.price_getter}
                                        onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, price_getter: e.target.value })}
                                    >
                                        <option value="">-- Select Source --</option>
                                        {availableGetters.map(g => (
                                            <option key={g} value={g}>{g}</option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <span className="mb-1 block font-medium">External ID (optional)</span>
                                    <Input
                                        placeholder="Leave empty to use asset symbol"
                                        value={bulkPriceGetter.external_id}
                                        onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, external_id: e.target.value })}
                                    />
                                    <span className="mt-1 block text-xs text-slate-500">
                                        If empty, each asset's symbol will be used as the external ID.
                                    </span>
                                </div>

                                <div>
                                    <span className="mb-2 block font-medium">Priority</span>
                                    <Input
                                        type="number"
                                        value={bulkPriceGetter.priority}
                                        onChange={e => setBulkPriceGetter({ ...bulkPriceGetter, priority: parseInt(e.target.value) || 100 })}
                                    />
                                    <span className="mt-1 block text-xs text-slate-500">
                                        Lower values = higher priority (tried first)
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkPriceGettersDialog(false)}>Cancel</Button>
                            <Button
                                colorScheme="blue"
                                onClick={executeBulkPriceGettersUpdate}
                                loading={bulkOperationLoading}
                                disabled={!bulkPriceGetter.price_getter}
                            >
                                Assign to {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Bulk Delete Dialog */}
            <RadixDialog.Root
                open={showBulkDeleteDialog}
                onOpenChange={(open) => {
                    setShowBulkDeleteDialog(open);
                    if (!open) {
                        setDeletionImpact({});
                    }
                }}
            >
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 px-5 py-4">
                            <RadixDialog.Title className="text-base font-semibold">Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}?</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            <span className="mb-2 block font-bold text-red-600">
                                ⚠️ Warning: This action cannot be undone!
                            </span>
                            <span className="mb-4 block">
                                You are about to delete <strong>{selectedIds.size}</strong> asset{selectedIds.size > 1 ? 's' : ''}.
                            </span>

                            {isImpactLoading ? (
                                <div className="mt-4 flex items-center gap-2">
                                    <Spinner size="xs" />
                                    <span className="text-xs text-slate-500">Checking for linked data...</span>
                                </div>
                            ) : (
                                <>
                                    {/* Blockers (prevent deletion) */}
                                    {(deletionImpact.transactions || deletionImpact.cost_lots || deletionImpact.realized_pnl) ? (
                                        <div className="mt-4 border border-red-300 bg-red-50 p-3">
                                            <span className="mb-1 block text-xs font-bold text-red-800">
                                                🚫 Cannot delete - Linked data exists:
                                            </span>
                                            <div className="flex flex-col gap-0.5">
                                                {deletionImpact.transactions && (
                                                    <span className="text-[10px] text-red-700">
                                                        • {deletionImpact.transactions} transaction(s) - delete transactions first
                                                    </span>
                                                )}
                                                {deletionImpact.cost_lots && (
                                                    <span className="text-[10px] text-red-700">
                                                        • {deletionImpact.cost_lots} cost lot(s) - delete transactions first
                                                    </span>
                                                )}
                                                {deletionImpact.realized_pnl && (
                                                    <span className="text-[10px] text-red-700">
                                                        • {deletionImpact.realized_pnl} P&L record(s) - delete transactions first
                                                    </span>
                                                )}
                                            </div>
                                            <span className="mt-2 block text-[10px] italic text-red-800">
                                                Assets with transaction history cannot be deleted. Delete all related transactions first.
                                            </span>
                                        </div>
                                    ) : Object.keys(deletionImpact).length > 0 ? (
                                        /* Cascade deletions (informational) */
                                        <div className="mt-4 border border-orange-200 bg-orange-50 p-3">
                                            <span className="mb-1 block text-xs font-bold text-orange-800">
                                                ⚠️ Linked objects that will also be deleted:
                                            </span>
                                            <div className="flex flex-col gap-0.5">
                                                {Object.entries(deletionImpact).map(([key, count]) => (
                                                    <span key={key} className="text-[10px] text-orange-700">
                                                        • {count} {key.replace(/_/g, ' ')}
                                                    </span>
                                                ))}
                                            </div>
                                            <span className="mt-2 block text-[10px] italic text-orange-800">
                                                This data is linked to these asset(s) and will be removed due to cascade deletion.
                                            </span>
                                        </div>
                                    ) : null}
                                </>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>Cancel</Button>
                            <Button
                                colorScheme="red"
                                onClick={executeBulkDelete}
                                loading={bulkOperationLoading}
                                disabled={bulkOperationLoading || deletionImpact.transactions > 0 || deletionImpact.cost_lots > 0 || deletionImpact.realized_pnl > 0}
                            >
                                🗑️ Delete {selectedIds.size} Asset{selectedIds.size > 1 ? 's' : ''}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

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
                    <div
                        className="fixed inset-0 z-[2000] cursor-pointer bg-black/40"
                        onClick={() => setDrawerAsset(null)}
                    />

                    {/* Panel: bottom sheet on mobile, right-side panel on sm+ */}
                    <div
                        className="fixed inset-x-0 bottom-0 top-auto z-[2001] max-h-[90vh] w-full max-w-full overflow-y-auto border-t border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[75vw] sm:max-w-[1400px] sm:border-l sm:border-t-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Sticky header */}
                        <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
                            <div className="flex items-center gap-2">
                                <Badge colorScheme="purple" className="text-sm">
                                    {drawerAsset.symbol}
                                </Badge>
                                <h3 className="text-sm font-semibold">
                                    Transactions ({txCountsByAssetId[drawerAsset.id] ?? 0})
                                </h3>
                            </div>
                            <button
                                type="button"
                                className="flex h-6 min-w-[24px] items-center justify-center p-0 text-slate-500 hover:text-slate-700"
                                onClick={() => setDrawerAsset(null)}
                                title="Close drawer"
                            >
                                <LuX />
                            </button>
                        </div>

                        {/* Transactions Table */}
                        <div className="p-4">
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
                        </div>
                    </div>
                </>
            )}
        </div>
    );
};
