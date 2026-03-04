import {
    Badge, Box,
    Button, Checkbox, Dialog, Flex,
    Heading, HStack, Portal, Spinner,
    Switch, Table, Text
} from '@chakra-ui/react';
import { LuArrowUp, LuArrowDown, LuArrowUpDown, LuPlus, LuMinus, LuX } from 'react-icons/lu';
import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    useReactTable,
    getCoreRowModel,
    SortingState,
    VisibilityState,
} from '@tanstack/react-table';
import { API_URL, Account, Asset, Transaction, TransactionStatus, TransactionListResponse, FilterMetadata, AppliedFilters } from '../types';
import { Direction, ReviewStatus, UnitPattern } from '../enums';
import { useDataHealth } from '../contexts/DataHealthContext';
import { useAssets } from '../hooks/useAssets';
import { useAccounts } from '../hooks/useAccounts';
import { useAccountSuggestionsBatch, BatchItem } from '../hooks/useAccountSuggestionsBatch';
import { ComboSelect, TRANSACTION_TYPE_OPTIONS } from './ComboSelect';


import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { TransactionFilters, TransactionFilterState, defaultFilterState } from './TransactionFilters';
import { toaster } from './ui/toaster';
import { getAssetSuggestions } from '../utils/similarity';
import { linkRawAccount } from '../utils/rawAccountApi';
import { fetchAccountSuggestionsBatch, AccountSuggestion } from '../hooks/useAccountSuggestions';
import {
    formatDateTimeCompact,
    dateTimeLocalToISO,
} from '../utils/dateUtils';
import { usePagination, DEFAULT_PAGE_SIZE } from '../hooks/usePagination';
import { useBundleSuggestionMap } from '../hooks/useBundleSuggestionMap';
import { useBundleColorMap } from '../hooks/useBundleColorMap';
import { TablePagination } from './TablePagination';
import { TableConfig, ColumnPlugin, RowAction, BulkAction, TransactionColumnKey, resolveTableConfig, presetToVisibility, ColumnVisibilityPopover } from './tables';
import { useDuplicateMap } from '../hooks/useDuplicateMap';
import AccountFormDialog, { AccountPrefill } from './AccountFormDialog';
import AssetFormDialog, { AssetPrefill } from './AssetFormDialog';
import { BundleCreateDialog, BundleCreateDefaults } from './bundles/BundleCreateDialog';
import { TransactionTableRow, TransactionRowCallbacks, EditableField } from './TransactionTableRow';

// Types for CSV import
interface TradesImportPreviewTransaction {
    date_time: string | null;
    transaction_type: string;
    asset_ticker: string;
    asset_label: string;
    quantity: number | null;
    price: number | null;
    fee: number | null;
    account_code: string;
    is_fee_transaction: boolean;
}

interface TradesImportPreview {
    filename: string;
    transactions_count: number;
    accounts_count: number;
    assets_count: number;
    fee_transactions_count: number;
    errors: { row: number; error: string }[];
    warnings: string[];
    transactions: TradesImportPreviewTransaction[];
    accounts: string[];
    assets: string[];
}

interface TradesImportResult {
    transactions: { created: number; skipped: number; errors: any[] };
    raw_accounts: { created: number; skipped: number; errors: any[] };
    raw_assets: { created: number; skipped: number; errors: any[] };
    pending_review_count: number;
    parse_errors: any[];
    warnings: string[];
    dry_run: boolean;
    summary: { total_transactions: number; total_raw_accounts: number; total_raw_assets: number; total_errors: number };
}

// Direction color mapping for row backgrounds
const directionRowColors: Record<string, string> = {
    [Direction.INFLOW]: 'green.50',
    [Direction.OUTFLOW]: 'red.50',
    internal: 'gray.50',
};

// Props interface for configurable behavior
export interface TransactionsTableProps<T extends Transaction = Transaction> {
    /** Title displayed in the header */
    title?: string;
    /** Subtitle/description text */
    subtitle?: string;
    /** Default workflow filter (e.g., 'pending' for inbox) */
    defaultWorkflowFilter?: string;
    /** Current filter state (controlled) */
    filters?: TransactionFilterState;
    /** Callback when filters change */
    onFiltersChange?: (filters: TransactionFilterState) => void;
    /** Base filters to reset to (optional, defaults to defaultFilterState) */
    resetFilters?: TransactionFilterState;
    /** Message to display when no transactions match filters */
    emptyMessage?: string;
    /** Compact mode for embedded views (smaller fonts, tighter spacing) */
    compact?: boolean;
    /** Embedded mode for popovers/cards: hides title, toolbar, pagination, legend, checkbox, status and actions columns (detail icon is kept) */
    embeddedMode?: boolean;
    /** When embeddedMode=true, also show checkboxes and status column (for duplicate resolution UX) */
    showSelectionInEmbedded?: boolean;
    /** Callback fired whenever the internal row selection changes (works both in normal and embedded+selection mode) */
    onSelectionChange?: (ids: Set<number>) => void;
    /** Pre-select these IDs when the table mounts – changing this (via `key`) can reset selection */
    initialSelectedIds?: number[];
    /** Whether to show the filter bar */
    showFilters?: boolean;
    /** Whether to start with filters collapsed */
    defaultFiltersCollapsed?: boolean;
    /** Whether to show the bundles section */
    showBundles?: boolean;
    /** Whether to show bundle suggestions */
    showSuggestions?: boolean;
    /** Callback when data changes (for parent refresh) */
    onDataChange?: () => void;
    /** Custom API URL to fetch transactions from (overrides default /transactions endpoint) */
    customApiUrl?: string;

    // ============== Plugin Architecture Props ==============

    /** 
     * Unique identifier for this table instance.
     * Used for localStorage keys for column visibility/sizing persistence.
     * Example: 'inbox', 'all', 'assetLinkage'
     */
    tableId?: string;

    /**
     * Initial column visibility override.
     * If provided, overrides localStorage-persisted visibility for this session.
     */
    initialColumnVisibility?: VisibilityState;

    /** 
     * Table configuration for endpoint, column preset, and features.
     * Provides a declarative way to configure the table's behavior.
     */
    config?: TableConfig<T>;

    /**
     * Additional columns to render after the standard columns.
     * These are plugin columns that extend the default table layout.
     */
    additionalColumns?: ColumnPlugin<T>[];

    /**
     * Additional row actions to render in the actions column.
     * These are added alongside the default edit/delete actions.
     */
    additionalRowActions?: RowAction<T>[];

    /**
     * Additional bulk actions to render in the bulk action toolbar.
     * These are added alongside the default status/type/delete actions.
     */
    additionalBulkActions?: BulkAction<T>[];
}

// EditableField type is imported from './TransactionTableRow'

export const TransactionsTable = <T extends Transaction = Transaction>({
    title = 'Transactions',
    subtitle = 'View, filter, and edit transaction details. Select transactions to create a bundle.',
    defaultWorkflowFilter = '',
    filters: controlledFilters,
    onFiltersChange,
    resetFilters,
    emptyMessage,
    compact = false,
    embeddedMode = false,
    showSelectionInEmbedded = false,
    onSelectionChange,
    initialSelectedIds,
    showFilters = true,
    defaultFiltersCollapsed = false,
    showBundles = true,
    showSuggestions = false,
    onDataChange,
    customApiUrl,
    // Plugin architecture props
    tableId = 'default',
    initialColumnVisibility: initialVisibilityProp,
    config: configProp,
    additionalColumns = [],
    additionalRowActions = [],
    additionalBulkActions = [],
}: TransactionsTableProps<T>) => {
    const queryClient = useQueryClient();

    // Centralized cache invalidation after any transaction mutation.
    // Ensures both the transaction list AND bundle suggestions are refreshed together.
    // Uses refetchType: 'active' to only refetch queries with mounted observers,
    // preventing unnecessary fetches for inactive cached queries from other tabs.
    const invalidateTransactionData = () => {
        queryClient.invalidateQueries({ queryKey: ['transactions'], refetchType: 'active' });
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'], refetchType: 'active' });
        queryClient.invalidateQueries({ queryKey: ['filterOptions'], refetchType: 'active' });
    };

    // Resolve table configuration with defaults
    const tableConfig = useMemo(() => resolveTableConfig(configProp), [configProp]);

    // ============== TanStack Table State ==============

    // Storage keys for persistence
    const visibilityStorageKey = `txTable:${tableId}:visibility`;
    const sortingStorageKey = `txTable:${tableId}:sorting`;

    // Load initial column visibility from prop, localStorage, or preset
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
        // Priority: prop > localStorage > preset
        if (initialVisibilityProp) {
            return initialVisibilityProp;
        }
        try {
            const stored = localStorage.getItem(visibilityStorageKey);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch { }
        // Fall back to preset-based visibility
        return presetToVisibility(
            tableConfig.columnPreset,
            tableConfig.hiddenColumns,
            tableConfig.shownColumns
        );
    });

    // Sorting state - default to date_time descending
    const [sorting, setSorting] = useState<SortingState>(() => {
        try {
            const stored = localStorage.getItem(sortingStorageKey);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch { }
        return [{ id: 'date', desc: true }];
    });

    // Map TanStack column IDs to backend sort_by values
    const SORT_COLUMN_MAP: Record<string, string> = {
        id: 'id',
        date: 'date',
        source: 'source',
        direction: 'direction',
        type: 'type',
        qty: 'qty',
        price: 'price',
        total: 'total',
        fee: 'fee',
        feeInBase: 'include_fee',
        taxability: 'taxability',
        status: 'status',
        sourceTransactionId: 'source_transaction_id',
    };

    // Persist column visibility to localStorage
    useEffect(() => {
        try {
            localStorage.setItem(visibilityStorageKey, JSON.stringify(columnVisibility));
        } catch { }
    }, [columnVisibility, visibilityStorageKey]);

    // Persist sorting to localStorage
    useEffect(() => {
        try {
            localStorage.setItem(sortingStorageKey, JSON.stringify(sorting));
        } catch { }
    }, [sorting, sortingStorageKey]);

    // Column visibility checker that uses TanStack state
    const showColumn = useCallback(
        (key: TransactionColumnKey) => columnVisibility[key] !== false,
        [columnVisibility]
    );

    // Count visible columns for colSpan calculations
    const visibleColumnCount = useMemo(() => {
        const keys: TransactionColumnKey[] = [
            'id', 'date', 'source', 'accounts', 'direction', 'type', 'asset', 'qty',
            'price', 'total', 'fee', 'taxability', 'feeInBase', 'bundle', 'tags', 'sourceTransactionId', 'status'
        ];
        // +2 for checkbox column and actions column (always visible)
        return keys.filter(k => columnVisibility[k] !== false).length + 2;
    }, [columnVisibility]);

    const { assets, refetchAssets } = useAssets();
    const { accounts, refetchAccounts } = useAccounts();
    // Cell-level editing: "txId:field" format, e.g., "123:account"
    const [editingCell, setEditingCell] = useState<string | null>(null);
    const [editValues, setEditValues] = useState<Partial<Transaction>>({});
    const editInputRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
    const editValuesRef = useRef<Partial<Transaction>>({});
    const escapePressedRef = useRef(false);

    // Use controlled filters if provided, otherwise fallback to internal state
    // Use resetFilters as initial state if provided, otherwise use defaultFilterState
    const [internalFilters, setInternalFilters] = useState<TransactionFilterState>(() => {
        const baseFilters = resetFilters || defaultFilterState;
        return {
            ...baseFilters,
            reviewStatus: defaultWorkflowFilter ? [defaultWorkflowFilter] : baseFilters.reviewStatus,
        };
    });

    const filters = controlledFilters || internalFilters;
    const rawSetFilters = onFiltersChange || setInternalFilters;

    // Single source of truth for the effective reset state.
    // Combines resetFilters (or defaultFilterState) with the workflow filter override.
    // Used by all reset paths: handleReset, onClear, and forwarded to TransactionFilters.
    const effectiveResetFilters = useMemo(() => {
        const baseFilters = resetFilters || defaultFilterState;
        return {
            ...baseFilters,
            reviewStatus: defaultWorkflowFilter ? [defaultWorkflowFilter] : baseFilters.reviewStatus,
        };
    }, [resetFilters, defaultWorkflowFilter]);

    // Wrap filter updates in startTransition so React doesn't block the main thread
    const [, startFilterTransition] = useTransition();
    const setFilters = useCallback(
        (newFilters: TransactionFilterState) => {
            startFilterTransition(() => {
                rawSetFilters(newFilters);
            });
        },
        [rawSetFilters]
    );

    // Store applied filters and metadata from backend response
    const [appliedFilters, setAppliedFilters] = useState<AppliedFilters | null>(null);
    const [filterMetadata, setFilterMetadata] = useState<FilterMetadata | null>(null);
    // Pagination via unified hook (client-side pagination for transactions table)
    const pagination = usePagination({
        storageKey: tableId || 'transactions',
        initialPageSize: DEFAULT_PAGE_SIZE,
    });
    const [selectedIds, setSelectedIds] = useState<Set<number>>(
        () => new Set<number>(initialSelectedIds ?? [])
    );

    // Notify parent of selection changes
    const onSelectionChangeRef = React.useRef(onSelectionChange);
    React.useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
    React.useEffect(() => {
        onSelectionChangeRef.current?.(selectedIds);
    }, [selectedIds]);
    // Transaction detail drawer state (replaces expandedRow)
    const [drawerTransactionId, setDrawerTransactionId] = useState<number | null>(null);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(!defaultFiltersCollapsed);

    // ============== Bundle Suggestion State ==============
    // Fetch suggestions and build tx→suggestion lookup map
    const { suggestionMap, getGroupTxIds } = useBundleSuggestionMap(showSuggestions);
    // Track which suggestion popover is open (by tx.id)
    const [openSuggestionTxId, setOpenSuggestionTxId] = useState<number | null>(null);
    // Track which suggestion group is hovered (by groupIndex) for sibling highlighting
    const [hoveredSuggestionGroup, setHoveredSuggestionGroup] = useState<number | null>(null);

    // ============== Bundle Membership State ==============
    // Track which bundle membership popover is open (by tx.id)
    const [openBundleTxId, setOpenBundleTxId] = useState<number | null>(null);
    // Track which bundle is hovered for sibling highlighting
    const [hoveredBundleId, setHoveredBundleId] = useState<number | null>(null);

    // ============== Duplicate Suspicion State ==============
    const { duplicateMap, getGroupTxIds: getDuplicateGroupTxIds } = useDuplicateMap();
    const [openDuplicateTxId, setOpenDuplicateTxId] = useState<number | null>(null);
    const [hoveredDuplicateGroup, setHoveredDuplicateGroup] = useState<number | null>(null);

    // ============== Quick-Create Dialog State ==============
    // When non-null, AccountFormDialog / AssetFormDialog is open for the given tx + field
    const [quickCreateAccount, setQuickCreateAccount] = useState<{
        txId: number;
        field: 'account_id' | 'from_account_id' | 'to_account_id';
        prefill: AccountPrefill;
        rawSource?: string;
        rawLabel?: string;
        rawNetwork?: string;
    } | null>(null);

    const [quickCreateAsset, setQuickCreateAsset] = useState<{
        txId: number;
        field: 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id';
        prefill: AssetPrefill;
        rawSource?: string;
        rawSymbol?: string;
    } | null>(null);

    // ============== Invalid Row Collapse State ==============
    // Invalid rows are collapsed by default; this set tracks which ones are expanded
    const [expandedInvalidIds, setExpandedInvalidIds] = useState<Set<number>>(new Set());

    const toggleInvalidRow = useCallback((id: number) => {
        setExpandedInvalidIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const isInvalidCollapsed = useCallback((tx: Transaction) => {
        return tx.review_status === 'invalid' && !expandedInvalidIds.has(tx.id);
    }, [expandedInvalidIds]);

    const collapseAllInvalid = useCallback(() => {
        setExpandedInvalidIds(new Set());
    }, []);

    // Use global data health context (for refresh trigger only)
    // Hook must be called at the top level (React rules of hooks)
    const { refreshHealthData } = useDataHealth();

    // Bulk action states
    const [bulkActionLoading, setBulkActionLoading] = useState(false);
    const [showBulkTypeDialog, setShowBulkTypeDialog] = useState(false);
    const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
    const [bulkType, setBulkType] = useState<string>('');
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [transactionToDelete, setTransactionToDelete] = useState<Transaction | null>(null);

    // Deletion impact check
    const [deletionImpact, setDeletionImpact] = useState<Record<string, number>>({});
    const [isImpactLoading, setIsImpactLoading] = useState(false);

    const fetchDeletionImpact = async (ids: number[]) => {
        setIsImpactLoading(true);
        setDeletionImpact({});
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/check-linked`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: ids })
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

    // Transaction editor dialog state (replaced by drawer)
    // Pencil icon now opens the detail drawer for inline editing

    // Bundle Create Dialog state
    const [showBundleCreateDialog, setShowBundleCreateDialog] = useState(false);
    const [bundleCreateDefaults, setBundleCreateDefaults] = useState<BundleCreateDefaults>({
        pattern: 'custom',
        label: 'Bundle',
        transactionIds: [],
    });

    // CSV Import state
    const [showImportDialog, setShowImportDialog] = useState(false);
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPreview, setImportPreview] = useState<TradesImportPreview | null>(null);
    const [importResult, setImportResult] = useState<TradesImportResult | null>(null);
    const [importLoading, setImportLoading] = useState(false);
    const [importStep, setImportStep] = useState<'select' | 'preview' | 'result'>('select');
    const [dryRunMode, setDryRunMode] = useState(true);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Track filter changes for pagination reset (avoids extra render from useEffect)
    const prevFilterKeyRef = useRef(JSON.stringify(filters));
    const filterKey = JSON.stringify(filters);
    if (filterKey !== prevFilterKeyRef.current) {
        prevFilterKeyRef.current = filterKey;
        pagination.firstPage();
    }

    // Reset to page 1 when sorting changes
    const prevSortingRef = useRef(JSON.stringify(sorting));
    const sortingKey = JSON.stringify(sorting);
    if (sortingKey !== prevSortingRef.current) {
        prevSortingRef.current = sortingKey;
        pagination.firstPage();
    }

    // Compute sorting params for the API
    const sortBy = sorting[0] ? (SORT_COLUMN_MAP[sorting[0].id] || 'date') : 'date';
    const sortDir = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : 'desc';

    // TanStack Query for transactions - use stable string key to avoid reference issues
    const { data: transactionResponse, isLoading: loading, error: queryError, refetch: refetchTransactions } = useQuery({
        queryKey: ['transactions', 'with-metadata', filterKey, pagination.page, pagination.pageSize, sortBy, sortDir],
        queryFn: async () => {
            const params = new URLSearchParams();
            // Apply review status filter (support multiple via comma-separated)
            if (filters.reviewStatus.length > 0) {
                params.append('review_status', filters.reviewStatus.join(','));
            }
            if (filters.taxability.length > 0) {
                params.append('taxability', filters.taxability.join(','));
            }
            if (filters.sources.length > 0) {
                params.append('source', filters.sources.join(','));
            }
            if (filters.accountIds.length > 0) {
                params.append('account_id', filters.accountIds.join(','));
            }
            if (filters.fromAccountIds && filters.fromAccountIds.length > 0) {
                params.append('from_account_id', filters.fromAccountIds.join(','));
            }
            if (filters.toAccountIds && filters.toAccountIds.length > 0) {
                params.append('to_account_id', filters.toAccountIds.join(','));
            }
            if (filters.relatedAccountIds && filters.relatedAccountIds.length > 0) {
                params.append('related_account_id', filters.relatedAccountIds.join(','));
            }
            if (filters.assetIds.length > 0) {
                params.append('asset_id', filters.assetIds.join(','));
            }
            if (filters.relatedAssetIds && filters.relatedAssetIds.length > 0) {
                params.append('related_asset_id', filters.relatedAssetIds.join(','));
            }
            if (filters.categoryIds.length > 0) {
                params.append('category_id', filters.categoryIds.join(','));
            }
            if (filters.connectorRunIds.length > 0) {
                params.append('connector_run_id', filters.connectorRunIds.join(','));
            }
            if (filters.connectorRunOutcome) {
                params.append('connector_run_outcome', filters.connectorRunOutcome);
            }
            if (filters.tagKeys.length > 0) {
                params.append('tag_key', filters.tagKeys.join(','));
            }
            if (filters.networks && filters.networks.length > 0) {
                params.append('network', filters.networks.join(','));
            }
            if (filters.transactionTypes.length > 0) {
                params.append('transaction_type', filters.transactionTypes.join(','));
            }
            if (filters.directions.length > 0) {
                params.append('direction', filters.directions.join(','));
            }
            if (filters.dateFrom) {
                params.append('date_from', filters.dateFrom);
            }
            if (filters.dateTo) {
                params.append('date_to', filters.dateTo);
            }
            // P&L audit filters
            if (filters.versionId) {
                params.append('pnl_cal_version', filters.versionId);
            }
            if (filters.inclusionStatus) {
                params.append('pnl_cal_inclusions_status', filters.inclusionStatus);
            }
            // Transaction IDs filter (for issue-specific views)
            if (filters.transactionIds && filters.transactionIds.length > 0) {
                params.append('ids', filters.transactionIds.join(','));
            }

            // Server-side pagination
            params.append('limit', String(pagination.pageSize));
            params.append('offset', String((pagination.page - 1) * pagination.pageSize));

            // Server-side sorting
            params.append('sort_by', sortBy);
            params.append('sort_dir', sortDir);

            // Use custom API URL if provided, otherwise default to /transactions
            const baseUrl = customApiUrl || `${API_URL}/transactions`;
            // Check if baseUrl already has query params, use & instead of ?
            const separator = baseUrl.includes('?') ? '&' : '?';
            const url = `${baseUrl}${separator}${params}`;

            const response = await fetch(url);
            if (!response.ok) throw new Error('Failed to fetch transactions');
            const data = await response.json() as TransactionListResponse;

            // Store applied filters and metadata
            setAppliedFilters(data.metadata.applied_filters);
            setFilterMetadata(data.metadata);

            // Update pagination total from server response
            pagination.setTotal(data.metadata.filtered_count);

            return data;
        },
    });

    const transactions = transactionResponse?.results || [];
    const error = queryError ? (queryError instanceof Error ? queryError.message : 'Unknown error') : null;

    const expandAllInvalid = useCallback(() => {
        const invalidIds = new Set(
            transactions
                .filter(tx => tx.review_status === 'invalid')
                .map(tx => tx.id)
        );
        setExpandedInvalidIds(invalidIds);
    }, [transactions]);

    // ============== TanStack Table Instance (for sorting) ==============

    // Column definitions for TanStack - all columns must be defined for the column selector to work
    const tanstackColumns = useMemo(() => [
        { id: 'id', accessorKey: 'id' },
        { id: 'date', accessorFn: (row: Transaction) => new Date(row.date_time).getTime() },
        { id: 'source', accessorKey: 'source' },
        { id: 'accounts', accessorFn: (row: Transaction) => row.from_account_id || row.to_account_id || '', enableSorting: false },
        { id: 'direction', accessorKey: 'direction' },
        { id: 'type', accessorKey: 'transaction_type' },
        { id: 'asset', accessorFn: (row: Transaction) => row.linked_asset?.symbol || row.source_asset_symbol || '', enableSorting: false },
        { id: 'qty', accessorKey: 'quantity' },
        { id: 'price', accessorKey: 'price' },
        { id: 'total', accessorKey: 'total' },
        { id: 'fee', accessorKey: 'fee' },
        { id: 'feeInBase', accessorKey: 'include_fee' },
        { id: 'taxability', accessorKey: 'disposal_taxable' },
        { id: 'bundle', accessorKey: 'user_calculation_unit_id', enableSorting: false },
        { id: 'tags', accessorKey: 'tags', enableSorting: false },
        { id: 'sourceTransactionId', accessorKey: 'source_transaction_id' },
        { id: 'status', accessorKey: 'review_status' },
    ], []);

    const tanstackTable = useReactTable({
        data: transactions,
        columns: tanstackColumns,
        state: {
            sorting,
            columnVisibility,
        },
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        getCoreRowModel: getCoreRowModel(),
        manualSorting: true,
        getRowId: (row) => String(row.id),
    });

    // Backend handles sorting — sortedTransactions is just the server-ordered list
    const sortedTransactions = transactions;

    // Keep editValuesRef in sync with editValues state
    useEffect(() => { editValuesRef.current = editValues; }, [editValues]);

    // Quick-create handlers: link newly created account/asset to the originating transaction
    const handleQuickAccountCreated = async (accountId?: number) => {
        if (accountId && quickCreateAccount) {
            try {
                const response = await fetch(`${API_URL}/transactions/${quickCreateAccount.txId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [quickCreateAccount.field]: accountId }),
                });
                if (!response.ok) throw new Error('Failed to link account');
                // Also link the raw_account
                if (quickCreateAccount.rawLabel) {
                    try {
                        await linkRawAccount({
                            source: quickCreateAccount.rawSource || '',
                            label: quickCreateAccount.rawLabel,
                            network: quickCreateAccount.rawNetwork,
                            accountId,
                        });
                    } catch { }
                }
                invalidateTransactionData();
                refetchAccounts();
            } catch (err) {
                toaster.error({ title: 'Error', description: 'Failed to link new account' });
            }
        }
        setQuickCreateAccount(null);
    };

    const handleQuickAssetCreated = async (assetId?: number) => {
        if (assetId && quickCreateAsset) {
            try {
                const response = await fetch(`${API_URL}/transactions/${quickCreateAsset.txId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [quickCreateAsset.field]: assetId }),
                });
                if (!response.ok) throw new Error('Failed to link asset');
                invalidateTransactionData();
                refetchAssets();
            } catch (err) {
                toaster.error({ title: 'Error', description: 'Failed to link new asset' });
            }
        }
        setQuickCreateAsset(null);
    };

    // Helper to update editValues state AND ref synchronously
    const updateEditValues = (updates: Partial<Transaction>) => {
        setEditValues(prev => {
            const newValues = { ...prev, ...updates };
            editValuesRef.current = newValues; // Sync ref immediately
            return newValues;
        });
    };

    // Direct save function that bypasses state/closure issues
    const saveFieldDirectly = async (txId: number, field: string, value: any) => {
        if (escapePressedRef.current) return;
        try {
            const response = await fetch(`${API_URL}/transactions/${txId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: value })
            });
            if (!response.ok) throw new Error('Failed to update');
            invalidateTransactionData();
            setEditingCell(null);
            setEditValues({});
            // Auto-collapse row when set to invalid
            if (field === 'review_status' && value === 'invalid') {
                setExpandedInvalidIds(prev => {
                    const next = new Set(prev);
                    next.delete(txId);
                    return next;
                });
            }
        } catch (err) {
            toaster.error({ title: 'Error', description: `Failed to save ${field}` });
        }
    };

    // Backend handles pagination — transactions are already the current page
    const paginatedTransactions = transactions;

    // Batch account suggestions: collect all unlinked labels for the current page
    const batchSuggestionItems = useMemo<BatchItem[]>(() => {
        const seen = new Set<string>();
        const items: BatchItem[] = [];
        for (const tx of transactions) {
            const labels = [
                { label: tx.source_account, cond: !tx.account_id },
                { label: tx.source_from_account, cond: !tx.from_account_id },
                { label: tx.source_to_account, cond: !tx.to_account_id },
            ];
            for (const { label, cond } of labels) {
                if (cond && label) {
                    const key = `${label}|${tx.source ?? ''}|${tx.network ?? ''}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        items.push({ label, source: tx.source, network: tx.network });
                    }
                }
            }
        }
        return items;
    }, [transactions]);

    const { suggestionsMap: batchSuggestionsMap } = useAccountSuggestionsBatch(batchSuggestionItems);

    // Pre-compute account lookup map for O(1) access per row
    const accountsById = useMemo(() => new Map(accounts.map(a => [a.id, a])), [accounts]);

    // Build bundle color map from visible transactions
    const { bundleColorMap } = useBundleColorMap(paginatedTransactions);

    // Start editing a specific cell
    const startCellEdit = (tx: Transaction, field: EditableField) => {
        escapePressedRef.current = false;
        setEditingCell(`${tx.id}:${field}`);
        setEditValues({
            asset_id: tx.asset_id,
            price_quote_asset_id: tx.price_quote_asset_id,
            fee_quote_asset_id: tx.fee_quote_asset_id,
            account_id: tx.account_id,
            from_account_id: tx.from_account_id,
            to_account_id: tx.to_account_id,
            source_transaction_type: tx.source_transaction_type || '',
            transaction_type: tx.transaction_type,
            direction: tx.direction,
            review_status: tx.review_status,
            review_notes: tx.review_notes || '',
            taxability_status: tx.taxability_status ?? 'unknown',
            include_fee: tx.include_fee ?? false,
            date_time: tx.date_time,
            source: tx.source,
            source_asset_symbol: tx.source_asset_symbol || '',
            quantity: tx.quantity,
            price: tx.price,
            fee: tx.fee,
            user_calculation_unit_id: tx.user_calculation_unit_id
        });
        // Focus input after render
        setTimeout(() => editInputRef.current?.focus(), 0);
    };

    // Check if a specific cell is being edited
    const isEditingCell = (txId: number, field: EditableField) => editingCell === `${txId}:${field}`;
    const getEditingTxId = () => editingCell ? parseInt(editingCell.split(':')[0]) : null;

    // Cancel editing
    const cancelEdit = useCallback(() => {
        escapePressedRef.current = true;
        setEditingCell(null);
        setEditValues({});
    }, []);

    // Global escape key listener
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && editingCell) {
                e.preventDefault();
                cancelEdit();
            }
        };
        document.addEventListener('keydown', handleGlobalKeyDown);
        return () => document.removeEventListener('keydown', handleGlobalKeyDown);
    }, [editingCell, cancelEdit]);

    // Save and close (only if not cancelled via escape)
    const saveAndClose = useCallback(async () => {
        // Skip save if escape was pressed
        if (escapePressedRef.current) {
            escapePressedRef.current = false;
            return;
        }
        const txId = getEditingTxId();
        if (txId) {
            await saveTransaction(txId);
        }
    }, [editingCell]);

    // Handle keyboard events for editing
    const handleEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            saveAndClose();
        }
    };

    // Direction options for dropdown
    const DIRECTION_OPTIONS = [
        { value: 'inflow', label: '↓' },
        { value: 'outflow', label: '↑' },
        { value: 'internal', label: '↔' }
    ];

    const saveTransaction = async (id: number) => {
        const values = editValuesRef.current;
        // Validate: cannot set status to "valid" if no asset_id
        if (values.review_status === 'valid' && !values.asset_id) {
            toaster.error({ title: 'Validation error', description: 'Cannot set status to "valid" without linking an asset. Please select or create an asset first.' });
            return;
        }

        try {
            // Convert date_time to ISO format if it's a local datetime string
            const payload = { ...values };
            if (typeof payload.date_time === 'string' && payload.date_time
                && !payload.date_time.includes('Z') && !/[+-]\d{2}:\d{2}$/.test(payload.date_time)) {
                payload.date_time = dateTimeLocalToISO(payload.date_time);
            }

            const response = await fetch(`${API_URL}/transactions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!response.ok) throw new Error('Failed to update transaction');
            invalidateTransactionData();
            setEditingCell(null);
            setEditValues({});
            // Auto-collapse row when set to invalid
            if (values.review_status === 'invalid') {
                setExpandedInvalidIds(prev => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    // Quick toggle for taxable/include_fee (saves immediately)
    const quickToggle = async (tx: Transaction, field: 'include_fee') => {
        try {
            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [field]: !tx[field] })
            });
            if (!response.ok) throw new Error('Failed to update');
            invalidateTransactionData();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    const toggleSelection = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    };

    // ===== Stable callbacks ref for TransactionTableRow (avoids re-render on callback identity change) =====
    const rowCallbacksRef = useRef({} as TransactionRowCallbacks);
    Object.assign(rowCallbacksRef.current, {
        startCellEdit, saveAndClose, updateEditValues, handleEditKeyDown,
        saveFieldDirectly, invalidateTransactionData, refetchAccounts,
        setEditingCell, setEditValues, setSelectedIds,
        setDrawerTransactionId, setIsDrawerOpen,
        setQuickCreateAccount, setQuickCreateAsset,
        setOpenSuggestionTxId, setHoveredSuggestionGroup,
        setOpenDuplicateTxId, setHoveredDuplicateGroup,
        setHoveredBundleId, setOpenBundleTxId,
        toggleInvalidRow, refetchAssets, isEditingCell,
        toggleSelection, cancelEdit, quickToggle, getEditingTxId,
        setTransactionToDelete, fetchDeletionImpact, setShowDeleteDialog,
        invalidateBundleQueries: () => queryClient.invalidateQueries({ queryKey: ['bundles'] }),
    } satisfies TransactionRowCallbacks);

    const toggleSelectAll = () => {
        // Select/deselect only items on current page
        const currentPageIds = paginatedTransactions.map(tx => tx.id);
        const allSelected = currentPageIds.every(id => selectedIds.has(id));

        if (allSelected) {
            setSelectedIds(prev => {
                const next = new Set(prev);
                currentPageIds.forEach(id => next.delete(id));
                return next;
            });
        } else {
            setSelectedIds(prev => {
                const next = new Set(prev);
                currentPageIds.forEach(id => next.add(id));
                return next;
            });
        }
    };

    // Generate a bundle label from selected transactions, mirroring grouping engine patterns
    const generateBundleLabel = (pattern: string, txIds: Set<number>): string => {
        const selectedTxs = transactions.filter(tx => txIds.has(tx.id));
        const getSymbol = (tx: Transaction) => tx.linked_asset?.symbol || tx.source_asset_symbol || '?';
        const inflowSymbols = [...new Set(selectedTxs.filter(tx => tx.direction === Direction.INFLOW).map(getSymbol))];
        const outflowSymbols = [...new Set(selectedTxs.filter(tx => tx.direction === Direction.OUTFLOW).map(getSymbol))];
        const allSymbols = [...new Set(selectedTxs.map(getSymbol))];

        if (pattern === 'swap') {
            if (outflowSymbols.length === 1 && inflowSymbols.length === 1) {
                return `${outflowSymbols[0]} → ${inflowSymbols[0]} Swap`;
            }
            if (allSymbols.length > 0) {
                return `Multi-leg Trade (${allSymbols.slice(0, 4).join(', ')})`;
            }
            return 'Swap';
        }
        if (pattern === 'internal_transfer') {
            if (allSymbols.length === 1) return `${allSymbols[0]} Transfer`;
            return `Transfer (${allSymbols.slice(0, 3).join(', ')})`;
        }
        return 'Bundle';
    };

    // Open the bundle create dialog with a specific default pattern
    const openBundleDialog = (pattern: string) => {
        if (selectedIds.size === 0) return;

        // Pre-check: warn if any selected transactions are already in a bundle
        const alreadyBundled = transactions.filter(
            (tx: Transaction) => selectedIds.has(tx.id) && tx.user_calculation_unit_id != null
        );
        if (alreadyBundled.length > 0) {
            const bundleIds = [...new Set(alreadyBundled.map((tx: Transaction) => tx.user_calculation_unit_id))];
            toaster.error({
                title: 'Cannot create bundle',
                description: `${alreadyBundled.length} selected transaction(s) already belong to bundle(s) #${bundleIds.join(', #')}. Remove them from their current bundle first or deselect them.`,
            });
            return;
        }

        setBundleCreateDefaults({
            pattern,
            label: generateBundleLabel(pattern, selectedIds),
            transactionIds: Array.from(selectedIds),
        });
        setShowBundleCreateDialog(true);
    };

    // Called after the BundleCreateDialog successfully creates a bundle
    const handleBundleCreated = async () => {
        await refetchTransactions();
        queryClient.invalidateQueries({ queryKey: ['bundles'] });
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
        refreshHealthData();
        onDataChange?.();
        setSelectedIds(new Set());
    };

    // Bulk action handlers
    const bulkUpdateStatus = async (status: string) => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    review_status: status
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            // Auto-collapse rows when bulk-set to invalid
            if (status === 'invalid') {
                setExpandedInvalidIds(prev => {
                    const next = new Set(prev);
                    selectedIds.forEach(id => next.delete(id));
                    return next;
                });
            }
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkUpdateType = async () => {
        if (selectedIds.size === 0 || !bulkType) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    transaction_type: bulkType
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
            setShowBulkTypeDialog(false);
            setBulkType('');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkUpdateTaxability = async (taxabilityStatus: string) => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    taxability_status: taxabilityStatus
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkUpdateIncludeFee = async (includeFee: boolean) => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    include_fee: includeFee
                })
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkUnbundle = async () => {
        if (selectedIds.size === 0) return;
        const selectedTxs = transactions.filter(tx => selectedIds.has(tx.id) && tx.user_calculation_unit_id != null);
        if (selectedTxs.length === 0) {
            toaster.error({ title: 'No bundled transactions', description: 'None of the selected transactions belong to a bundle.' });
            return;
        }
        setBulkActionLoading(true);
        try {
            // Group by bundle ID to make one request per bundle
            const byBundle = new Map<number, number[]>();
            for (const tx of selectedTxs) {
                const bundleId = tx.user_calculation_unit_id!;
                if (!byBundle.has(bundleId)) byBundle.set(bundleId, []);
                byBundle.get(bundleId)!.push(tx.id);
            }
            let totalRemoved = 0;
            for (const [bundleId, txIds] of byBundle) {
                const response = await fetch(`${API_URL}/bundles/${bundleId}/remove-transactions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ transaction_ids: txIds }),
                });
                if (!response.ok) throw new Error(`Failed to remove from bundle #${bundleId}`);
                const result = await response.json();
                totalRemoved += result.removed_count || 0;
            }
            toaster.success({ title: 'Unbundled', description: `${totalRemoved} transaction(s) removed from ${byBundle.size} bundle(s)` });
            invalidateTransactionData();
            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to unbundle' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const bulkDelete = async () => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds)
                })
            });
            if (!response.ok) throw new Error('Failed to delete transactions');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
            setShowBulkDeleteDialog(false);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    const handleDeleteTransaction = async () => {
        if (!transactionToDelete) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: [transactionToDelete.id]
                })
            });
            if (!response.ok) throw new Error('Failed to delete transaction');
            const result = await response.json();
            toaster.success({ title: 'Success', description: result.message });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
            setShowDeleteDialog(false);
            setTransactionToDelete(null);
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to delete transaction' });
        } finally {
            setBulkActionLoading(false);
        }
    };

    // CSV Import handlers
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

            const response = await fetch(`${API_URL}/transactions/import-csv/preview`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Preview failed');
            }

            const data: TradesImportPreview = await response.json();
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

            const response = await fetch(`${API_URL}/transactions/import-csv?${params}`, {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.detail || 'Import failed');
            }

            const data: TradesImportResult = await response.json();
            setImportResult(data);
            setImportStep('result');

            // Refresh transactions list if not a dry run
            if (!dryRunMode) {
                invalidateTransactionData();
                refreshHealthData();
                onDataChange?.();
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

    // Using formatDateTimeCompact from dateUtils for consistent date formatting

    const getRowBgColor = (tx: Transaction) => {
        if (selectedIds.has(tx.id)) return 'blue.100';
        // Highlight sibling rows when hovering a suggestion indicator
        if (hoveredSuggestionGroup !== null && showSuggestions) {
            const entry = suggestionMap.get(tx.id);
            if (entry && entry.groupIndex === hoveredSuggestionGroup) return 'teal.50';
        }
        // Highlight sibling rows when hovering a bundle membership indicator
        if (hoveredBundleId !== null && tx.user_calculation_unit_id === hoveredBundleId) return 'purple.50';
        // Highlight sibling rows when hovering a duplicate indicator
        if (hoveredDuplicateGroup !== null) {
            const dupEntry = duplicateMap.get(tx.id);
            if (dupEntry && dupEntry.groupIndex === hoveredDuplicateGroup) return 'red.50';
        }
        // Invalid rows get dark gray background to de-emphasize
        if (tx.review_status === 'invalid') return 'gray.300';
        return directionRowColors[tx.direction] || 'white';
    };

    // Review status → bottom border color
    const getRowBorderColor = (tx: Transaction) => {
        const reviewStatusBorderColors: Record<string, string> = {
            pending: 'yellow.500',
            valid: 'green.500',
            invalid: 'red.500',
        };
        return reviewStatusBorderColors[tx.review_status || 'pending'] || 'gray.300';
    };

    const currentPageIds = paginatedTransactions.map(tx => tx.id);
    const allCurrentPageSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedIds.has(id));

    // Helper to render sortable column header
    const renderSortableHeader = (columnId: string, label: string, minW?: string, extraProps?: Record<string, any>) => {
        const column = tanstackTable.getColumn(columnId);
        const isSorted = column?.getIsSorted();

        return (
            <Table.ColumnHeader
                cursor="pointer"
                onClick={() => column?.toggleSorting()}
                userSelect="none"
                minW={minW}
                _hover={{ bg: 'gray.200' }}
                {...extraProps}
            >
                <Flex align="center" gap={1}>
                    <Text>{label}</Text>
                    {isSorted === 'asc' && <LuArrowUp size={10} />}
                    {isSorted === 'desc' && <LuArrowDown size={10} />}
                    {!isSorted && <LuArrowUpDown size={10} style={{ opacity: 0.3 }} />}
                </Flex>
            </Table.ColumnHeader>
        );
    };

    const handleRefresh = () => {
        refetchTransactions();
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
        // Always refresh validation summary for Data Health Check
        refreshHealthData();
    };

    const handleReset = () => {
        setFilters(effectiveResetFilters);
    };

    const handleRetry = () => {
        // Force refetch without changing filters (useful when error occurs with same filter state)
        refetchTransactions();
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
        refreshHealthData();
    };

    // Auto-link high-confidence suggestions (≥95% match) for selected transactions
    const autoLinkHighConfidence = async () => {
        const MIN_CONFIDENCE = 0.95;
        const selectedTxs = paginatedTransactions.filter(tx => selectedIds.has(tx.id));

        let linkedCount = 0;
        const errors: string[] = [];

        setBulkActionLoading(true);

        // Collect all account labels that need suggestions (batch API call)
        const accountBatchItems: { label: string; source?: string | null; network?: string | null; txField: string; txId: number }[] = [];
        for (const tx of selectedTxs) {
            if (tx.source_from_account && !tx.from_account_id) {
                accountBatchItems.push({ label: tx.source_from_account, source: tx.source, network: tx.network, txField: 'from_account_id', txId: tx.id });
            }
            if (tx.source_to_account && !tx.to_account_id) {
                accountBatchItems.push({ label: tx.source_to_account, source: tx.source, network: tx.network, txField: 'to_account_id', txId: tx.id });
            }
            if (tx.source_account && !tx.account_id) {
                accountBatchItems.push({ label: tx.source_account, source: tx.source, network: tx.network, txField: 'account_id', txId: tx.id });
            }
        }

        // Fetch network-aware account suggestions in one batch
        const batchResults = accountBatchItems.length > 0
            ? await fetchAccountSuggestionsBatch(
                accountBatchItems.map(item => ({
                    label: item.label,
                    source: item.source,
                    network: item.network,
                    minConfidence: MIN_CONFIDENCE,
                    maxResults: 1,
                }))
            )
            : [];

        // Build a lookup: txId:field → best suggestion
        const accountSuggestionLookup = new Map<string, AccountSuggestion>();
        batchResults.forEach((result, idx) => {
            if (result.suggestions.length > 0 && result.suggestions[0].confidence >= MIN_CONFIDENCE) {
                const item = accountBatchItems[idx];
                accountSuggestionLookup.set(`${item.txId}:${item.txField}`, result.suggestions[0]);
            }
        });

        for (const tx of selectedTxs) {
            const updates: Record<string, number> = {};

            // Check asset (still client-side — no network disambiguation needed for assets)
            if (tx.source_asset_symbol && !tx.asset_id) {
                const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.asset_id = suggestions[0].item.asset_id!;
                }
            }

            // Check price quote asset
            if (tx.source_price_quote_asset_symbol && !tx.price_quote_asset_id) {
                const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.price_quote_asset_id = suggestions[0].item.asset_id!;
                }
            }

            // Check fee quote asset
            if (tx.source_fee_quote_asset_symbol && !tx.fee_quote_asset_id) {
                const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.fee_quote_asset_id = suggestions[0].item.asset_id!;
                }
            }

            // Check account fields — use network-aware batch results
            const fromSugg = accountSuggestionLookup.get(`${tx.id}:from_account_id`);
            if (fromSugg) updates.from_account_id = fromSugg.id;

            const toSugg = accountSuggestionLookup.get(`${tx.id}:to_account_id`);
            if (toSugg) updates.to_account_id = toSugg.id;

            const acctSugg = accountSuggestionLookup.get(`${tx.id}:account_id`);
            if (acctSugg) updates.account_id = acctSugg.id;

            // Apply updates if any
            if (Object.keys(updates).length > 0) {
                try {
                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(updates)
                    });
                    if (response.ok) {
                        linkedCount += Object.keys(updates).length;
                        // Also link raw accounts for account fields
                        const rawLinkPromises: Promise<void>[] = [];
                        if (updates.from_account_id && tx.source_from_account) {
                            rawLinkPromises.push(linkRawAccount({ source: tx.source, label: tx.source_from_account, network: tx.network || undefined, accountId: updates.from_account_id }).catch(() => { }));
                        }
                        if (updates.to_account_id && tx.source_to_account) {
                            rawLinkPromises.push(linkRawAccount({ source: tx.source, label: tx.source_to_account, network: tx.network || undefined, accountId: updates.to_account_id }).catch(() => { }));
                        }
                        if (updates.account_id && tx.source_account) {
                            rawLinkPromises.push(linkRawAccount({ source: tx.source, label: tx.source_account, network: tx.network || undefined, accountId: updates.account_id }).catch(() => { }));
                        }
                        await Promise.all(rawLinkPromises);
                    } else {
                        errors.push(`Transaction ${tx.id}: Failed to update`);
                    }
                } catch (err) {
                    errors.push(`Transaction ${tx.id}: ${err instanceof Error ? err.message : 'Unknown error'}`);
                }
            }
        }

        setBulkActionLoading(false);

        if (linkedCount > 0) {
            toaster.success({
                title: 'Auto-link complete',
                description: `Linked ${linkedCount} field(s) with ≥95% confidence matches${errors.length > 0 ? `. ${errors.length} error(s).` : ''}`
            });
            invalidateTransactionData();
        } else {
            toaster.info({
                title: 'No high-confidence matches',
                description: 'No unlinked fields found with ≥95% confidence match in the selected transactions.'
            });
        }
    };

    // ============== Invalid Row Collapse Counts ==============
    const invalidTransactions = useMemo(
        () => transactions.filter(tx => tx.review_status === 'invalid'),
        [transactions]
    );
    const collapsedInvalidCount = useMemo(
        () => invalidTransactions.filter(tx => !expandedInvalidIds.has(tx.id)).length,
        [invalidTransactions, expandedInvalidIds]
    );
    const totalInvalidCount = invalidTransactions.length;

    // Check if any selected transactions have unlinked fields (for auto-link visibility)
    const hasUnlinkedFields = useMemo(() => {
        if (selectedIds.size === 0) return false;
        return paginatedTransactions.some(tx => {
            if (!selectedIds.has(tx.id)) return false;
            return (
                (tx.source_from_account && !tx.from_account_id) ||
                (tx.source_to_account && !tx.to_account_id) ||
                (tx.source_account && !tx.account_id) ||
                (tx.source_asset_symbol && !tx.asset_id) ||
                (tx.source_price_quote_asset_symbol && !tx.price_quote_asset_id) ||
                (tx.source_fee_quote_asset_symbol && !tx.fee_quote_asset_id)
            );
        });
    }, [selectedIds, paginatedTransactions]);

    return (
        <Box pb={selectedIds.size > 0 && !embeddedMode ? '48px' : '0'}>
            {!embeddedMode && (
                <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                    <Box>
                        <Heading as="h2" size="md" mb={1}>{title}</Heading>
                        <Text color="gray.600" fontSize="sm">{subtitle}</Text>
                    </Box>
                    {/* Invalid row collapse indicator */}
                    {totalInvalidCount > 0 && (
                        <HStack gap={2} fontSize="xs" color="gray.500">
                            <Badge colorPalette="red" variant="subtle" size="sm">
                                <LuX size={10} />
                                {totalInvalidCount} invalid
                            </Badge>
                            {collapsedInvalidCount > 0 ? (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    color="gray.500"
                                    _hover={{ color: 'red.600' }}
                                    onClick={expandAllInvalid}
                                    title="Expand all invalid rows"
                                >
                                    <LuPlus size={12} /> Show
                                </Button>
                            ) : (
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    color="gray.500"
                                    _hover={{ color: 'red.600' }}
                                    onClick={collapseAllInvalid}
                                    title="Collapse all invalid rows"
                                >
                                    <LuMinus size={12} /> Hide
                                </Button>
                            )}
                        </HStack>
                    )}
                </Flex>
            )}

            {/* Floating Bulk Actions Bar - pinned to viewport bottom */}
            {selectedIds.size > 0 && !embeddedMode && (
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
                                    {selectedIds.size} selected
                                </Text>
                                <Flex gap={1} flexWrap="wrap" align="center">
                                    {/* Additional bulk actions from plugins (rendered first) */}
                                    {additionalBulkActions
                                        .filter(action => !action.isVisible || action.isVisible(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[]))
                                        .map(action => (
                                            <Button
                                                key={action.id}
                                                size="2xs"
                                                fontSize="xs"
                                                colorPalette={action.colorPalette || 'gray'}
                                                variant={action.variant || 'outline'}
                                                onClick={() => action.onClick(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[])}
                                                disabled={bulkActionLoading || (action.isDisabled ? action.isDisabled(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[]) : false)}
                                            >
                                                {action.icon} {action.label}
                                            </Button>
                                        ))}
                                    {additionalBulkActions.length > 0 && (
                                        <Box borderLeft="1px solid" borderColor="gray.300" h="16px" mx={0.5} />
                                    )}

                                    {/* Quick Status Actions */}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="green"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('valid')}
                                        disabled={bulkActionLoading}
                                    >
                                        ✓ Valid
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="yellow"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('pending')}
                                        disabled={bulkActionLoading}
                                    >
                                        ⏳ Pending
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="red"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('invalid')}
                                        disabled={bulkActionLoading}
                                    >
                                        ✗ Invalid
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" mx={0.5} />

                                    {/* Taxability Actions */}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="teal"
                                        variant="outline"
                                        onClick={() => bulkUpdateTaxability('taxable')}
                                        disabled={bulkActionLoading}
                                        title="Set taxability to Taxable"
                                    >
                                        💰 Taxable
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="gray"
                                        variant="outline"
                                        onClick={() => bulkUpdateTaxability('non_taxable')}
                                        disabled={bulkActionLoading}
                                        title="Set taxability to Non-Taxable"
                                    >
                                        🚫 Non-Tax
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" mx={0.5} />

                                    {/* Include Fee Actions */}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="blue"
                                        variant="outline"
                                        onClick={() => bulkUpdateIncludeFee(true)}
                                        disabled={bulkActionLoading}
                                        title="Include fee in cost basis/proceeds"
                                    >
                                        Fee ✓
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="gray"
                                        variant="outline"
                                        onClick={() => bulkUpdateIncludeFee(false)}
                                        disabled={bulkActionLoading}
                                        title="Exclude fee from cost basis/proceeds"
                                    >
                                        Fee ✗
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" mx={0.5} />

                                    {/* Quick Bundle Actions */}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="orange"
                                        variant="outline"
                                        onClick={() => openBundleDialog('swap')}
                                        disabled={bulkActionLoading}
                                    >
                                        🔄 Swap
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="blue"
                                        variant="outline"
                                        onClick={() => openBundleDialog('internal_transfer')}
                                        disabled={bulkActionLoading}
                                    >
                                        ↔ Transfer
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="purple"
                                        variant="outline"
                                        onClick={() => openBundleDialog('custom')}
                                        disabled={bulkActionLoading}
                                    >
                                        📦 Bundle
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="gray"
                                        variant="outline"
                                        onClick={bulkUnbundle}
                                        disabled={bulkActionLoading}
                                        title="Remove selected transactions from their bundles"
                                    >
                                        🔓 Unbundle
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="16px" mx={0.5} />

                                    {/* Other Actions */}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="purple"
                                        variant="outline"
                                        onClick={() => setShowBulkTypeDialog(true)}
                                    >
                                        🏷️ Type
                                    </Button>
                                    {hasUnlinkedFields && (
                                        <Button
                                            size="2xs"
                                            fontSize="xs"
                                            colorPalette="cyan"
                                            variant="outline"
                                            onClick={autoLinkHighConfidence}
                                            disabled={bulkActionLoading}
                                            title="Auto-link accounts and assets with ≥95% confidence match"
                                        >
                                            🔗 Auto-Link
                                        </Button>
                                    )}
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        colorPalette="red"
                                        variant="outline"
                                        onClick={() => {
                                            fetchDeletionImpact(Array.from(selectedIds));
                                            setShowBulkDeleteDialog(true);
                                        }}
                                    >
                                        🗑️ Delete
                                    </Button>
                                    <Button
                                        size="2xs"
                                        fontSize="xs"
                                        variant="ghost"
                                        onClick={() => setSelectedIds(new Set())}
                                    >
                                        ✕ Clear
                                    </Button>
                                </Flex>
                            </Flex>
                        </Box>
                    </Box>
                </Portal>
            )}

            {/* Transactions content */}
            <>
                {/* Transactions tab header with actions */}
                {!embeddedMode && (
                    <Flex justify="flex-end" align="center" mb={4} gap={2}>
                        {/* Column visibility picker */}
                        <ColumnVisibilityPopover
                            table={tanstackTable}
                            onReset={() => {
                                setColumnVisibility(presetToVisibility(
                                    tableConfig.columnPreset,
                                    tableConfig.hiddenColumns,
                                    tableConfig.shownColumns
                                ));
                            }}
                            size="sm"
                        />
                        <Button
                            onClick={error ? handleRetry : handleReset}
                            variant="outline"
                            colorPalette={error ? "red" : "gray"}
                            size="sm"
                        >
                            {error ? "🔄 Retry" : "↺ Reset"}
                        </Button>
                        <Button
                            onClick={() => handleRefresh()}
                            variant="outline"
                            size="sm"
                        >
                            🔄 Refresh
                        </Button>
                    </Flex>
                )}

                {showFilters && (
                    <Box mb={4}>
                        <TransactionFilters
                            filters={filters}
                            onChange={setFilters}
                            onClear={() => setFilters(effectiveResetFilters)}
                            expanded={filtersExpanded}
                            onExpandedChange={setFiltersExpanded}
                            appliedFilters={appliedFilters}
                            filterMetadata={filterMetadata}
                            resetFilters={effectiveResetFilters}
                        />
                    </Box>
                )}

                {/* Top Pagination - show when more than 15 transactions */}
                {!loading && !error && !embeddedMode && (filterMetadata?.filtered_count ?? 0) > 15 && (
                    <Box mb={4}>
                        <TablePagination
                            pagination={pagination}
                            total={filterMetadata?.filtered_count ?? 0}
                        />
                    </Box>
                )}

                {/* Error state for transactions */}
                {error && (
                    <Box textAlign="center" py={6} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200" mb={4}>
                        <Text color="red.600" fontWeight="bold">Error loading transactions</Text>
                        <Text color="red.600" fontSize="sm">{error}</Text>
                        <Button mt={3} onClick={handleRetry} colorPalette="red" size="sm">
                            🔄 Retry
                        </Button>
                    </Box>
                )}

                {/* Loading overlay for transactions */}
                {loading && !error && (
                    <Box textAlign="center" py={10} bg="gray.50" borderRadius="md" mb={4}>
                        <Spinner size="xl" color="blue.500" />
                        <Text mt={4}>Loading transactions...</Text>
                    </Box>
                )}

                {/* Legend */}
                {!loading && !error && !embeddedMode && (
                    <Flex mb={4} gap={3} align="center" flexWrap="wrap">
                        <Text fontSize="xs" color="gray.500">Dir:</Text>
                        <Flex align="center" gap={1}>
                            <Box w={3} h={3} bg="green.100" borderRadius="sm" />
                            <Text fontSize="xs">↓In</Text>
                        </Flex>
                        <Flex align="center" gap={1}>
                            <Box w={3} h={3} bg="red.100" borderRadius="sm" />
                            <Text fontSize="xs">↑Out</Text>
                        </Flex>
                        <Flex align="center" gap={1}>
                            <Box w={3} h={3} bg="gray.100" borderRadius="sm" />
                            <Text fontSize="xs">↔Int</Text>
                        </Flex>
                        <Text fontSize="xs" color="gray.500" ml={2}>Review:</Text>
                        <Flex align="center" gap={1}>
                            <Box w={1} h={3} bg="yellow.500" borderRadius="sm" />
                            <Text fontSize="xs">Pending</Text>
                        </Flex>
                        <Flex align="center" gap={1}>
                            <Box w={1} h={3} bg="green.500" borderRadius="sm" />
                            <Text fontSize="xs">Valid</Text>
                        </Flex>
                        <Flex align="center" gap={1}>
                            <Box w={1} h={3} bg="red.500" borderRadius="sm" />
                            <Text fontSize="xs">Invalid</Text>
                        </Flex>
                    </Flex>
                )}

                {/* Transaction table - only show when not loading or erroring */}
                {!loading && !error && (
                    <Box overflowX="auto" bg="white" borderRadius="md" boxShadow="sm" css={{ fontSize: '8px' }} position="relative">
                        <Table.Root size="sm" variant="line">
                            <Table.Header css={{ fontSize: '9px' }}>
                                <Table.Row>
                                    <Table.ColumnHeader position="sticky" left={0} bg="gray.100" zIndex={10} minW="50px" borderRight="2px solid" borderColor="gray.300">
                                        {(!embeddedMode || showSelectionInEmbedded) && (
                                            <Checkbox.Root
                                                checked={allCurrentPageSelected}
                                                onCheckedChange={toggleSelectAll}
                                            >
                                                <Checkbox.HiddenInput />
                                                <Checkbox.Control />
                                            </Checkbox.Root>
                                        )}
                                    </Table.ColumnHeader>
                                    {showColumn('id') && renderSortableHeader('id', 'ID')}
                                    {showColumn('date') && renderSortableHeader('date', 'Date/Time')}
                                    {showColumn('source') && renderSortableHeader('source', 'Source Info', '180px')}
                                    {showColumn('accounts') && <Table.ColumnHeader width="130px">From / To</Table.ColumnHeader>}
                                    {showColumn('direction') && renderSortableHeader('direction', 'Dir')}
                                    {showColumn('type') && renderSortableHeader('type', 'Type')}
                                    {showColumn('asset') && renderSortableHeader('asset', 'Asset', '60px')}
                                    {showColumn('qty') && renderSortableHeader('qty', 'Qty')}
                                    {showColumn('price') && renderSortableHeader('price', 'Price')}
                                    {showColumn('total') && <Table.ColumnHeader>Total</Table.ColumnHeader>}
                                    {showColumn('fee') && renderSortableHeader('fee', 'Fee')}
                                    {showColumn('taxability') && <Table.ColumnHeader>Taxable</Table.ColumnHeader>}
                                    {showColumn('feeInBase') && <Table.ColumnHeader>Include Fee</Table.ColumnHeader>}
                                    {showColumn('bundle') && <Table.ColumnHeader>Bundle</Table.ColumnHeader>}
                                    {showColumn('tags') && <Table.ColumnHeader>Tags</Table.ColumnHeader>}
                                    {showColumn('sourceTransactionId') && <Table.ColumnHeader>Source Tx ID</Table.ColumnHeader>}
                                    {/* Additional plugin columns */}
                                    {additionalColumns.map(col => (
                                        <Table.ColumnHeader key={col.id} width={col.width}>{col.header}</Table.ColumnHeader>
                                    ))}
                                    {showColumn('status') && (!embeddedMode || showSelectionInEmbedded) && renderSortableHeader('status', 'Status', undefined, { position: 'sticky', right: '50px', bg: 'gray.100', zIndex: 10, borderLeft: '2px solid', borderColor: 'gray.300', fontSize: '7px', px: 1 })}
                                    {!embeddedMode && <Table.ColumnHeader position="sticky" right={0} bg="gray.100" zIndex={10} minW="50px" px={0}></Table.ColumnHeader>}
                                </Table.Row>
                            </Table.Header>
                            <Table.Body>
                                {paginatedTransactions.length === 0 ? (
                                    <Table.Row>
                                        <Table.Cell colSpan={visibleColumnCount}>
                                            <Text textAlign="center" py={8} color="gray.500">
                                                {emptyMessage || 'No transactions found'}
                                            </Text>
                                        </Table.Cell>
                                    </Table.Row>
                                ) : (
                                    paginatedTransactions.map(tx => (
                                        <TransactionTableRow
                                            key={tx.id}
                                            tx={tx}
                                            suggestionEntry={showSuggestions ? suggestionMap.get(tx.id) : undefined}
                                            duplicateEntry={duplicateMap.get(tx.id)}
                                            rowBgColor={getRowBgColor(tx)}
                                            rowBorderColor={getRowBorderColor(tx)}
                                            isInvalidCollapsed={isInvalidCollapsed(tx)}
                                            accounts={accounts}
                                            accountsById={accountsById}
                                            assets={assets}
                                            batchSuggestionsMap={batchSuggestionsMap}
                                            showColumn={showColumn}
                                            visibleColumnCount={visibleColumnCount}
                                            embeddedMode={embeddedMode}
                                            showSuggestions={showSuggestions}
                                            showSelectionInEmbedded={showSelectionInEmbedded}
                                            additionalColumns={additionalColumns as ColumnPlugin[]}
                                            additionalRowActions={additionalRowActions as RowAction[]}
                                            editingCell={editingCell}
                                            editValues={editValues}
                                            selectedIds={selectedIds}
                                            expandedInvalidIds={expandedInvalidIds}
                                            openSuggestionTxId={openSuggestionTxId}
                                            hoveredSuggestionGroup={hoveredSuggestionGroup}
                                            openDuplicateTxId={openDuplicateTxId}
                                            hoveredDuplicateGroup={hoveredDuplicateGroup}
                                            hoveredBundleId={hoveredBundleId}
                                            openBundleTxId={openBundleTxId}
                                            bundleColorMap={bundleColorMap}
                                            editInputRef={editInputRef}
                                            escapePressedRef={escapePressedRef}
                                            editValuesRef={editValuesRef}
                                            callbacks={rowCallbacksRef.current}
                                        />
                                    ))
                                )}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                )}

                {/* Pagination Controls - show even when loading/error */}
                {!loading && !error && !embeddedMode && (
                    <TablePagination
                        pagination={pagination}
                        total={filterMetadata?.filtered_count ?? 0}
                    />
                )}
            </>

            {/* Bulk Set Type Dialog */}
            <Dialog.Root open={showBulkTypeDialog} onOpenChange={(e) => setShowBulkTypeDialog(e.open)}>
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Set Transaction Type for Selected</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text mb={4}>
                                    Set transaction type for {selectedIds.size} transaction(s)
                                </Text>
                                <ComboSelect
                                    value={bulkType}
                                    onChange={val => setBulkType(val)}
                                    options={TRANSACTION_TYPE_OPTIONS}
                                    placeholder="Select transaction type..."
                                    width="100%"
                                />
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => { setShowBulkTypeDialog(false); setBulkType(''); }}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="purple" onClick={bulkUpdateType} disabled={bulkActionLoading || !bulkType}>
                                        {bulkActionLoading ? 'Updating...' : 'Apply Type'}
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
                                <Dialog.Title>Delete Selected Transactions</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text color="red.600" fontWeight="bold" mb={2}>
                                    ⚠️ Warning: This action cannot be undone!
                                </Text>
                                <Text mb={4}>
                                    Are you sure you want to delete {selectedIds.size} transaction(s)?
                                </Text>
                                <Text fontSize="sm" color="gray.500">
                                    IDs: {Array.from(selectedIds).slice(0, 10).join(', ')}
                                    {selectedIds.size > 10 && ` ... and ${selectedIds.size - 10} more`}
                                </Text>

                                {isImpactLoading ? (
                                    <Flex align="center" gap={2} mt={4}>
                                        <Spinner size="xs" />
                                        <Text fontSize="xs" color="gray.500">Checking for linked data...</Text>
                                    </Flex>
                                ) : Object.keys(deletionImpact).length > 0 && (
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
                                            This data is linked to these transaction(s) and will be removed due to cascade deletion.
                                        </Text>
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="red" onClick={bulkDelete} disabled={bulkActionLoading}>
                                        {bulkActionLoading ? 'Deleting...' : `Delete ${selectedIds.size} Transaction(s)`}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Delete Single Transaction Dialog */}
            <Dialog.Root
                open={showDeleteDialog}
                onOpenChange={(e) => {
                    setShowDeleteDialog(e.open);
                    if (!e.open) {
                        setTransactionToDelete(null);
                        setDeletionImpact({});
                    }
                }}
            >
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content>
                            <Dialog.Header>
                                <Dialog.Title>Delete Transaction</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                <Text color="red.600" fontWeight="bold" mb={2}>
                                    ⚠️ Warning: This action cannot be undone!
                                </Text>
                                <Text mb={4}>
                                    Are you sure you want to delete this transaction?
                                </Text>
                                {transactionToDelete && (
                                    <Box p={3} bg="gray.50" borderRadius="md">
                                        <Text fontSize="sm"><strong>ID:</strong> {transactionToDelete.id}</Text>
                                        <Text fontSize="sm"><strong>Date:</strong> {formatDateTimeCompact(transactionToDelete.date_time)}</Text>
                                        <Text fontSize="sm"><strong>Type:</strong> {transactionToDelete.transaction_type}</Text>
                                        <Text fontSize="sm"><strong>Quantity:</strong> {transactionToDelete.quantity} {transactionToDelete.source_asset_symbol}</Text>
                                    </Box>
                                )}

                                {isImpactLoading ? (
                                    <Flex align="center" gap={2} mt={4}>
                                        <Spinner size="xs" />
                                        <Text fontSize="xs" color="gray.500">Checking for linked data...</Text>
                                    </Flex>
                                ) : Object.keys(deletionImpact).length > 0 && (
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
                                            This data is linked to this transaction and will be removed due to cascade deletion.
                                        </Text>
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2}>
                                    <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                                        Cancel
                                    </Button>
                                    <Button colorPalette="red" onClick={handleDeleteTransaction} disabled={bulkActionLoading}>
                                        {bulkActionLoading ? 'Deleting...' : 'Delete Transaction'}
                                    </Button>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* CSV Import Dialog */}
            <Dialog.Root open={showImportDialog} onOpenChange={(e) => setShowImportDialog(e.open)} size="xl">
                <Portal>
                    <Dialog.Backdrop />
                    <Dialog.Positioner>
                        <Dialog.Content maxW="900px">
                            <Dialog.Header>
                                <Dialog.Title>Import Trades from CSV</Dialog.Title>
                            </Dialog.Header>
                            <Dialog.Body>
                                {importStep === 'select' && (
                                    <Box>
                                        <Text mb={4}>
                                            Upload a CSV file with trades to import. The file should have columns for:
                                            Date, Transaction Type, Asset, Quantity, Unit Price, Trading Fees, Investment Account.
                                        </Text>
                                        <Box
                                            border="2px dashed"
                                            borderColor="gray.300"
                                            borderRadius="md"
                                            p={8}
                                            textAlign="center"
                                            onDrop={handleFileDrop}
                                            onDragOver={(e) => e.preventDefault()}
                                            bg={importFile ? 'green.50' : 'gray.50'}
                                            cursor="pointer"
                                            onClick={() => fileInputRef.current?.click()}
                                            _hover={{ borderColor: 'teal.400', bg: 'teal.50' }}
                                        >
                                            <input
                                                type="file"
                                                accept=".csv"
                                                onChange={handleFileSelect}
                                                ref={fileInputRef}
                                                style={{ display: 'none' }}
                                            />
                                            {importFile ? (
                                                <Box>
                                                    <Text color="green.600" fontWeight="bold">✓ {importFile.name}</Text>
                                                    <Text fontSize="sm" color="gray.500">{(importFile.size / 1024).toFixed(1)} KB</Text>
                                                </Box>
                                            ) : (
                                                <Box>
                                                    <Text fontSize="lg" mb={2}>📁 Drop CSV file here or click to browse</Text>
                                                    <Text fontSize="sm" color="gray.500">Supports .csv files</Text>
                                                </Box>
                                            )}
                                        </Box>
                                    </Box>
                                )}

                                {importStep === 'preview' && importPreview && (
                                    <Box>
                                        <Flex gap={4} mb={4} flexWrap="wrap">
                                            <Badge colorPalette="blue" fontSize="sm" p={2}>
                                                📊 {importPreview.transactions_count} Transactions
                                            </Badge>
                                            <Badge colorPalette="purple" fontSize="sm" p={2}>
                                                👤 {importPreview.accounts_count} Accounts
                                            </Badge>
                                            <Badge colorPalette="teal" fontSize="sm" p={2}>
                                                💎 {importPreview.assets_count} Assets
                                            </Badge>
                                            {importPreview.fee_transactions_count > 0 && (
                                                <Badge colorPalette="orange" fontSize="sm" p={2}>
                                                    💰 {importPreview.fee_transactions_count} Fee Transactions
                                                </Badge>
                                            )}
                                        </Flex>

                                        {importPreview.errors.length > 0 && (
                                            <Box mb={4} p={3} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                                                <Text color="red.600" fontWeight="bold" mb={2}>⚠️ Parse Errors ({importPreview.errors.length})</Text>
                                                {importPreview.errors.slice(0, 5).map((err, i) => (
                                                    <Text key={i} fontSize="sm" color="red.600">Row {err.row}: {err.error}</Text>
                                                ))}
                                                {importPreview.errors.length > 5 && (
                                                    <Text fontSize="sm" color="red.500">...and {importPreview.errors.length - 5} more errors</Text>
                                                )}
                                            </Box>
                                        )}

                                        {importPreview.warnings.length > 0 && (
                                            <Box mb={4} p={3} bg="yellow.50" borderRadius="md" borderWidth={1} borderColor="yellow.200">
                                                <Text color="yellow.700" fontWeight="bold" mb={2}>⚠️ Warnings ({importPreview.warnings.length})</Text>
                                                {importPreview.warnings.slice(0, 5).map((warn, i) => (
                                                    <Text key={i} fontSize="sm" color="yellow.700">{warn}</Text>
                                                ))}
                                            </Box>
                                        )}

                                        <Box mb={4}>
                                            <Text fontWeight="bold" mb={2}>Accounts to create as RawAccount:</Text>
                                            <Flex gap={1} flexWrap="wrap">
                                                {importPreview.accounts.map((acc, i) => (
                                                    <Badge key={i} colorPalette="purple" fontSize="xs">{acc}</Badge>
                                                ))}
                                            </Flex>
                                        </Box>

                                        <Box mb={4}>
                                            <Text fontWeight="bold" mb={2}>Assets to create as RawAsset:</Text>
                                            <Flex gap={1} flexWrap="wrap" maxH="100px" overflow="auto">
                                                {importPreview.assets.slice(0, 30).map((asset, i) => (
                                                    <Badge key={i} colorPalette="teal" fontSize="xs">{asset}</Badge>
                                                ))}
                                                {importPreview.assets.length > 30 && (
                                                    <Badge colorPalette="gray" fontSize="xs">+{importPreview.assets.length - 30} more</Badge>
                                                )}
                                            </Flex>
                                        </Box>

                                        <Box>
                                            <Text fontWeight="bold" mb={2}>Transaction Preview (first 20) - Source → Transformed:</Text>
                                            <Box maxH="350px" overflow="auto" borderWidth={1} borderRadius="md">
                                                <Table.Root size="sm">
                                                    <Table.Header>
                                                        <Table.Row>
                                                            <Table.ColumnHeader>Date</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Type</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ DB Type</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ Direction</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Asset</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ DB Asset</Table.ColumnHeader>
                                                            <Table.ColumnHeader>Qty</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="blue.50">→ Fee</Table.ColumnHeader>
                                                            <Table.ColumnHeader bg="gray.100">CSV Account</Table.ColumnHeader>
                                                        </Table.Row>
                                                    </Table.Header>
                                                    <Table.Body>
                                                        {importPreview.transactions.slice(0, 20).map((tx, i) => {
                                                            // Compute transformed values (what will actually be stored in DB)
                                                            const dbType = tx.is_fee_transaction ? 'cost' : 'trade';
                                                            const direction = tx.is_fee_transaction
                                                                ? 'neutral'
                                                                : (tx.transaction_type === 'Buy' ? 'inflow' : 'outflow');
                                                            const dbQty = tx.is_fee_transaction ? 0 : tx.quantity;
                                                            const dbFee = tx.is_fee_transaction ? tx.quantity : tx.fee;
                                                            // DB asset: None for FEES, pending RawAsset mapping for trades
                                                            const dbAsset = tx.is_fee_transaction ? null : tx.asset_ticker;

                                                            return (
                                                                <Table.Row key={i} bg={tx.is_fee_transaction ? 'orange.50' : undefined}>
                                                                    <Table.Cell fontSize="xs">{formatDateTimeCompact(tx.date_time)}</Table.Cell>
                                                                    {/* CSV Source Type */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50">
                                                                        <Badge colorPalette="gray" size="sm" variant="outline">
                                                                            {tx.transaction_type}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* → DB transaction_type */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        <Badge colorPalette={tx.is_fee_transaction ? 'orange' : 'blue'} size="sm">
                                                                            {dbType}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* → DB direction */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        <Badge
                                                                            colorPalette={direction === 'inflow' ? 'green' : direction === 'outflow' ? 'red' : 'gray'}
                                                                            size="sm"
                                                                        >
                                                                            {direction}
                                                                        </Badge>
                                                                    </Table.Cell>
                                                                    {/* CSV Source Asset */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50" maxW="100px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap" title={tx.asset_label}>
                                                                        {tx.asset_ticker}
                                                                    </Table.Cell>
                                                                    {/* → DB Asset (asset_id mapping) */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        {dbAsset ? (
                                                                            <Badge colorPalette="teal" size="sm" title="Will create RawAsset for mapping">
                                                                                {dbAsset}
                                                                            </Badge>
                                                                        ) : (
                                                                            <Text color="gray.400" fontSize="xs">None</Text>
                                                                        )}
                                                                    </Table.Cell>
                                                                    {/* Quantity */}
                                                                    <Table.Cell fontSize="xs">
                                                                        {tx.is_fee_transaction ? (
                                                                            <Text as="span" textDecoration="line-through" color="gray.400">{tx.quantity?.toFixed(2)}</Text>
                                                                        ) : (
                                                                            tx.quantity?.toFixed(4) || '-'
                                                                        )}
                                                                    </Table.Cell>
                                                                    {/* → DB Fee */}
                                                                    <Table.Cell fontSize="xs" bg="blue.50">
                                                                        {dbFee ? `€${dbFee.toFixed(2)}` : '-'}
                                                                    </Table.Cell>
                                                                    {/* CSV Account */}
                                                                    <Table.Cell fontSize="xs" bg="gray.50">{tx.account_code}</Table.Cell>
                                                                </Table.Row>
                                                            );
                                                        })}
                                                    </Table.Body>
                                                </Table.Root>
                                            </Box>
                                            <Flex mt={2} gap={4} fontSize="xs" color="gray.600">
                                                <Text><Box as="span" bg="gray.100" px={1} borderRadius="sm">Gray</Box> = CSV source values</Text>
                                                <Text><Box as="span" bg="blue.50" px={1} borderRadius="sm">Blue</Box> = Transformed DB values</Text>
                                            </Flex>
                                        </Box>

                                        <Box mt={4} p={3} bg="blue.50" borderRadius="md">
                                            <Flex align="center" gap={2}>
                                                <Switch.Root
                                                    checked={dryRunMode}
                                                    onCheckedChange={(e: { checked: boolean }) => setDryRunMode(e.checked)}
                                                >
                                                    <Switch.HiddenInput />
                                                    <Switch.Control />
                                                </Switch.Root>
                                                <Text fontWeight="bold">Dry Run Mode</Text>
                                            </Flex>
                                            <Text fontSize="sm" color="gray.600" mt={1}>
                                                {dryRunMode
                                                    ? 'Preview only - no changes will be saved to the database'
                                                    : '⚠️ Changes will be committed to the database'}
                                            </Text>
                                        </Box>
                                    </Box>
                                )}

                                {importStep === 'result' && importResult && (
                                    <Box>
                                        <Box mb={4} p={4} bg={importResult.dry_run ? 'blue.50' : 'green.50'} borderRadius="md">
                                            <Text fontSize="lg" fontWeight="bold" mb={2}>
                                                {importResult.dry_run ? '🔍 Dry Run Complete' : '✅ Import Complete'}
                                            </Text>
                                            {importResult.dry_run && (
                                                <Text fontSize="sm" color="blue.600">
                                                    No changes were saved. Run again with Dry Run disabled to commit.
                                                </Text>
                                            )}
                                        </Box>

                                        <Flex gap={4} mb={4} flexWrap="wrap">
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Transactions</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="green.600">
                                                    {importResult.transactions.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.transactions.skipped} skipped
                                                </Text>
                                            </Box>
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Raw Accounts</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="purple.600">
                                                    {importResult.raw_accounts.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.raw_accounts.skipped} skipped
                                                </Text>
                                            </Box>
                                            <Box p={3} bg="gray.50" borderRadius="md" flex="1" minW="150px">
                                                <Text fontSize="sm" color="gray.500">Raw Assets</Text>
                                                <Text fontSize="xl" fontWeight="bold" color="teal.600">
                                                    {importResult.raw_assets.created} created
                                                </Text>
                                                <Text fontSize="sm" color="gray.500">
                                                    {importResult.raw_assets.skipped} skipped
                                                </Text>
                                            </Box>
                                        </Flex>

                                        {importResult.pending_review_count > 0 && (
                                            <Box p={3} bg="yellow.50" borderRadius="md" mb={4}>
                                                <Text color="yellow.700">
                                                    ⚠️ <strong>{importResult.pending_review_count}</strong> transactions need review
                                                    (unmapped accounts or assets). Use the Raw Accounts and Raw Assets editors to map them.
                                                </Text>
                                            </Box>
                                        )}

                                        {importResult.summary.total_errors > 0 && (
                                            <Box p={3} bg="red.50" borderRadius="md">
                                                <Text color="red.600" fontWeight="bold">
                                                    ❌ {importResult.summary.total_errors} errors occurred
                                                </Text>
                                            </Box>
                                        )}
                                    </Box>
                                )}
                            </Dialog.Body>
                            <Dialog.Footer>
                                <Flex gap={2} justify="space-between" width="100%">
                                    <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                                        Close
                                    </Button>
                                    <Flex gap={2}>
                                        {importStep === 'select' && (
                                            <Button
                                                colorPalette="teal"
                                                onClick={previewImport}
                                                disabled={!importFile || importLoading}
                                            >
                                                {importLoading ? <Spinner size="sm" /> : 'Preview'}
                                            </Button>
                                        )}
                                        {importStep === 'preview' && (
                                            <>
                                                <Button variant="outline" onClick={resetImportDialog}>
                                                    ← Back
                                                </Button>
                                                <Button
                                                    colorPalette={dryRunMode ? 'blue' : 'green'}
                                                    onClick={executeImport}
                                                    disabled={importLoading}
                                                >
                                                    {importLoading ? <Spinner size="sm" /> : (dryRunMode ? 'Run Dry Import' : 'Import Now')}
                                                </Button>
                                            </>
                                        )}
                                        {importStep === 'result' && (
                                            <>
                                                <Button variant="outline" onClick={resetImportDialog}>
                                                    Import Another
                                                </Button>
                                                {importResult?.dry_run && (
                                                    <Button
                                                        colorPalette="green"
                                                        onClick={() => {
                                                            setDryRunMode(false);
                                                            setImportStep('preview');
                                                        }}
                                                    >
                                                        Commit Import
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                    </Flex>
                                </Flex>
                            </Dialog.Footer>
                        </Dialog.Content>
                    </Dialog.Positioner>
                </Portal>
            </Dialog.Root>

            {/* Transaction Detail Drawer - Always rendered, available from any tab */}
            <TransactionDetailDrawer
                transactionId={drawerTransactionId}
                isOpen={isDrawerOpen}
                onClose={() => {
                    setIsDrawerOpen(false);
                    setDrawerTransactionId(null);
                }}
                accounts={accounts}
                onNotesChange={async (txId, notes) => {
                    try {
                        const response = await fetch(`${API_URL}/transactions/${txId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ review_notes: notes }),
                        });
                        if (response.ok) {
                            const updated = await response.json();
                            // Update the transaction in-place in all cached query results
                            // to avoid triggering a storm of refetches across every mounted table
                            queryClient.setQueriesData(
                                { queryKey: ['transactions'], type: 'active' },
                                (old: any) => {
                                    if (!old?.results) return old;
                                    return { ...old, results: old.results.map((t: any) => t.id === txId ? updated : t) };
                                }
                            );
                            onDataChange?.();
                        }
                    } catch (err) {
                        console.error('Failed to update notes:', err);
                    }
                }}
                onTagsChange={async (txId, tags) => {
                    try {
                        const response = await fetch(`${API_URL}/transactions/${txId}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tags }),
                        });
                        if (response.ok) {
                            const updated = await response.json();
                            // Update the transaction in-place in all cached query results
                            // to avoid triggering a storm of refetches across every mounted table
                            queryClient.setQueriesData(
                                { queryKey: ['transactions'], type: 'active' },
                                (old: any) => {
                                    if (!old?.results) return old;
                                    return { ...old, results: old.results.map((t: any) => t.id === txId ? updated : t) };
                                }
                            );
                            onDataChange?.();
                        }
                    } catch (err) {
                        console.error('Failed to update tags:', err);
                    }
                }}
                onTransactionUpdate={() => {
                    invalidateTransactionData();
                    onDataChange?.();
                }}
            />

            {/* Quick-Create Account Dialog */}
            <AccountFormDialog
                isOpen={!!quickCreateAccount}
                onClose={handleQuickAccountCreated}
                prefill={quickCreateAccount?.prefill}
            />

            {/* Quick-Create Asset Dialog */}
            <AssetFormDialog
                isOpen={!!quickCreateAsset}
                onClose={handleQuickAssetCreated}
                prefill={quickCreateAsset?.prefill}
                rawAssetSource={quickCreateAsset?.rawSource}
                rawAssetSymbol={quickCreateAsset?.rawSymbol}
            />

            {/* Bundle Create Dialog */}
            <BundleCreateDialog
                isOpen={showBundleCreateDialog}
                onClose={() => setShowBundleCreateDialog(false)}
                onCreated={handleBundleCreated}
                defaults={bundleCreateDefaults}
                generateLabel={(pattern) => generateBundleLabel(pattern, selectedIds.size > 0 ? selectedIds : new Set(bundleCreateDefaults.transactionIds))}
            />
        </Box >
    );
};
