import {
    Badge, Box,
    Button, Checkbox, Dialog, Flex,
    Heading, HStack, Input, NativeSelect, Portal, Spinner,
    Switch, Table, Text, Progress, VStack
} from '@chakra-ui/react';
import { BiTransfer } from 'react-icons/bi';
import { RiExchangeFundsLine } from 'react-icons/ri';
import { FaQuestion } from 'react-icons/fa';
import { LuPencil, LuUpload, LuArrowUp, LuArrowDown, LuArrowUpDown, LuPackageX, LuCheck } from 'react-icons/lu';
import { FiActivity, FiFileText, FiCopy } from 'react-icons/fi';
import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    SortingState,
    VisibilityState,
} from '@tanstack/react-table';
import { API_URL, Account, Asset, Transaction, TransactionStatus, WorkflowStatus, TaxabilityStatus, TransactionListResponse, FilterMetadata, AppliedFilters, ValidationWarning } from '../types';
import { Direction, ReviewStatus, TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../enums';
import { useDataHealth } from '../contexts/DataHealthContext';
import { AssetSelector } from './AssetSelector';
import { AccountSelector } from './AccountSelector';
import { ACCOUNT_OPTIONS, ComboSelect, TRANSACTION_TYPE_OPTIONS } from './ComboSelect';
import { TransactionEditorDialog } from './TransactionEditorDialog';


import { TransactionDetailDrawer } from './TransactionDetailDrawer';
import { TransactionFilters, TransactionFilterState, defaultFilterState } from './TransactionFilters';
import { toaster } from './ui/toaster';
import { Tooltip } from './ui/tooltip';
import { AssetBadge } from './AssetBadge';
import { AccountBadge } from './AccountBadge';
import { SourceInfoCell } from './SourceInfoCell';
import { getAccountSuggestions, getAssetSuggestions, getConfidenceColor, formatConfidence, SuggestedMatch } from '../utils/similarity';
import {
    formatDateTimeCompact,
    toDateTimeLocalString,
    dateTimeLocalToISO,
} from '../utils/dateUtils';
import { usePagination, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from '../hooks/usePagination';
import { useBundleSuggestionMap } from '../hooks/useBundleSuggestionMap';
import { useBundleColorMap } from '../hooks/useBundleColorMap';
import { TablePagination } from './TablePagination';
import { ValueDisplay } from './ValueDisplay';
import { TableConfig, ColumnPlugin, RowAction, BulkAction, TransactionColumnKey, resolveTableConfig, presetToVisibility, ColumnVisibilityPopover } from './tables';
import { BundleSuggestionIcon, SuggestionPopover, BundleMembershipPopover } from './bundles';
import { LuPackage2 } from 'react-icons/lu';

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

// Status badge color mapping (for review_status column display)
const statusBadgeColors: Record<TransactionStatus, string> = {
    [ReviewStatus.VALID]: 'green',
    [ReviewStatus.PENDING]: 'yellow',
    [ReviewStatus.INVALID]: 'red',
};

// Review status options for filter dropdown (same as TransactionStatus)
const reviewStatusOptions = [
    { value: '', label: 'All Status' },
    { value: ReviewStatus.PENDING, label: 'Pending' },
    { value: ReviewStatus.VALID, label: 'Valid' },
    { value: ReviewStatus.INVALID, label: 'Invalid' },
];

// Taxability colors
const taxabilityColors: Record<TaxabilityStatus, string> = {
    [TaxabilityStatusEnum.TAXABLE]: 'orange',
    [TaxabilityStatusEnum.NON_TAXABLE]: 'green',
    [TaxabilityStatusEnum.UNKNOWN]: 'yellow',
};

// Helper functions for duplicate detection tags
const getDuplicateTags = (tx: Transaction): any[] => {
    if (!tx.tags || typeof tx.tags !== 'object') return [];

    // Tags can be an array or an object with array values
    if (Array.isArray(tx.tags)) {
        return tx.tags;
    }

    // If tags is an object, it might have a 'tags' property or be keyed
    const tagArray = tx.tags.tags || Object.values(tx.tags);
    return Array.isArray(tagArray) ? tagArray : [];
};

const hasPotentialDuplicateTag = (tx: Transaction): boolean => {
    const tags = getDuplicateTags(tx);
    return tags.some((tag: any) =>
        tag && typeof tag === 'object' && tag.dup_group
    );
};

const getDuplicateResolutionTag = (tx: Transaction): any | null => {
    const tags = getDuplicateTags(tx);

    // Check for new format (dup_resolution key)
    const resolutionTag = tags.find((tag: any) =>
        tag && typeof tag === 'object' && tag.dup_resolution
    );
    if (resolutionTag) {
        return {
            dup_resolution: resolutionTag.dup_resolution,
            group_hash: tags.find((t: any) => t?.dup_group)?.dup_group,
            dup_resolved_at: tags.find((t: any) => t?.dup_resolved_at)?.dup_resolved_at,
        };
    }

    return null;
};

const getDuplicateGroupHash = (tx: Transaction): string | null => {
    const tags = getDuplicateTags(tx);

    // Check for new format (dup_group key)
    const groupTag = tags.find((tag: any) =>
        tag && typeof tag === 'object' && tag.dup_group
    );
    return groupTag?.dup_group || null;
};

// Pattern colors for suggestions (simplified to swap and transfer)
const patternColors: Record<string, string> = {
    [UnitPattern.INTERNAL_TRANSFER]: 'blue',
    [UnitPattern.SWAP]: 'orange',
    [UnitPattern.SPLIT]: 'purple',
    [UnitPattern.FLOW]: 'cyan',
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
    /** Whether to show the filter bar */
    showFilters?: boolean;
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

// Editable cell types
type EditableField = 'account_id' | 'from_account_id' | 'to_account_id' | 'source_transaction_type' | 'direction' | 'transaction_type' | 'asset_id' | 'price_quote_asset_id' | 'fee_quote_asset_id' | 'review_status' | 'review_notes' | 'date_time' | 'source' | 'source_asset_symbol' | 'quantity' | 'price' | 'fee' | 'user_calculation_unit_id';

export const TransactionsTable = <T extends Transaction = Transaction>({
    title = 'Transactions',
    subtitle = 'View, filter, and edit transaction details. Select transactions to create a bundle.',
    defaultWorkflowFilter = '',
    filters: controlledFilters,
    onFiltersChange,
    resetFilters,
    emptyMessage,
    compact = false,
    showFilters = true,
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
    const invalidateTransactionData = () => {
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
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

    const [assets, setAssets] = useState<Asset[]>([]);
    const [accounts, setAccounts] = useState<Account[]>([]);
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
        storageKey: 'transactions',
        initialPageSize: DEFAULT_PAGE_SIZE,
    });
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    // Transaction detail drawer state (replaces expandedRow)
    const [drawerTransactionId, setDrawerTransactionId] = useState<number | null>(null);
    const [isDrawerOpen, setIsDrawerOpen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(true);

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

    // Transaction editor dialog state
    const [showEditorDialog, setShowEditorDialog] = useState(false);
    const [transactionToEdit, setTransactionToEdit] = useState<Transaction | null>(null);

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

    // TanStack Query for transactions - use stable string key to avoid reference issues
    const { data: transactionResponse, isLoading: loading, error: queryError, refetch: refetchTransactions } = useQuery({
        queryKey: ['transactions', 'with-metadata', filterKey],
        queryFn: async () => {
            const params = new URLSearchParams();
            // Apply review status filter (support multiple via comma-separated)
            if (filters.reviewStatus.length > 0) {
                // If only one, use it directly; otherwise API doesn't support multiple review_status currently
                // So we just take the first one for now (or could send comma-separated if backend supports)
                params.append('review_status', filters.reviewStatus[0]);
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
            if (filters.assetIds.length > 0) {
                params.append('asset_id', filters.assetIds.join(','));
            }
            if (filters.categoryIds.length > 0) {
                params.append('category_id', filters.categoryIds.join(','));
            }
            if (filters.connectorRunIds.length > 0) {
                params.append('connector_run_id', filters.connectorRunIds.join(','));
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
            if (filters.pnlCalVersion) {
                params.append('pnl_cal_version', filters.pnlCalVersion);
            }
            if (filters.pnlCalInclusionsStatus) {
                params.append('pnl_cal_inclusions_status', filters.pnlCalInclusionsStatus);
            }
            // Transaction IDs filter (for issue-specific views)
            if (filters.transactionIds && filters.transactionIds.length > 0) {
                params.append('ids', filters.transactionIds.join(','));
            }

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

            return data;
        },
    });

    const transactions = transactionResponse?.results || [];
    const error = queryError ? (queryError instanceof Error ? queryError.message : 'Unknown error') : null;

    // ============== TanStack Table Instance (for sorting) ==============

    // Column definitions for TanStack - all columns must be defined for the column selector to work
    const tanstackColumns = useMemo(() => [
        { id: 'id', accessorKey: 'id' },
        { id: 'date', accessorFn: (row: Transaction) => new Date(row.date_time).getTime() },
        { id: 'source', accessorKey: 'source' },
        { id: 'accounts', accessorFn: (row: Transaction) => row.from_account_id || row.to_account_id || '' },
        { id: 'direction', accessorKey: 'direction' },
        { id: 'type', accessorKey: 'transaction_type' },
        { id: 'asset', accessorFn: (row: Transaction) => row.linked_asset?.symbol || row.source_asset_symbol || '' },
        { id: 'qty', accessorKey: 'quantity' },
        { id: 'price', accessorKey: 'price' },
        { id: 'total', accessorKey: 'total' },
        { id: 'fee', accessorKey: 'fee' },
        { id: 'feeInBase', accessorKey: 'include_fee' },
        { id: 'taxability', accessorKey: 'disposal_taxable' },
        { id: 'bundle', accessorKey: 'user_calculation_unit_id' },
        { id: 'tags', accessorKey: 'tags' },
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
        getSortedRowModel: getSortedRowModel(),
        getRowId: (row) => String(row.id),
    });

    // Get sorted transactions from TanStack
    // Use transactions + sorting as deps (not getRowModel().rows which is a new ref every render)
    const sortedTransactions = useMemo(() => {
        return tanstackTable.getRowModel().rows.map(row => row.original);
    }, [transactions, sorting]);

    // Fetch static data once on mount
    useEffect(() => {
        fetchAssets();
        fetchAccounts();
    }, []);

    // Keep editValuesRef in sync with editValues state
    useEffect(() => { editValuesRef.current = editValues; }, [editValues]);

    const fetchAssets = async () => {
        try {
            const response = await fetch(`${API_URL}/assets?limit=10000`);
            if (response.ok) {
                const data = await response.json();
                setAssets(data);
            }
        } catch (err) {
            console.error('Failed to fetch assets:', err);
        }
    };

    const fetchAccounts = async () => {
        try {
            const response = await fetch(`${API_URL}/accounts/`);
            if (response.ok) {
                const data = await response.json();
                setAccounts(data);
            }
        } catch (err) {
            console.error('Failed to fetch accounts:', err);
        }
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
        } catch (err) {
            toaster.error({ title: 'Error', description: `Failed to save ${field}` });
        }
    };

    // Pagination calculations (uses sorted transactions)
    const paginatedTransactions = pagination.paginate(sortedTransactions);

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
            disposal_taxable: tx.disposal_taxable ?? false,
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
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to save' });
        }
    };

    // Quick toggle for taxable/include_fee (saves immediately)
    const quickToggle = async (tx: Transaction, field: 'disposal_taxable' | 'include_fee') => {
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

    const createBundle = async (pattern: string, label: string) => {
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

        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/bundles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label,
                    pattern,
                    transaction_ids: Array.from(selectedIds)
                })
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to create bundle');
            }
            toaster.success({ title: 'Bundle created', description: `"${label}" with ${selectedIds.size} transaction(s)` });
            await refetchTransactions();
            queryClient.invalidateQueries({ queryKey: ["bundles"] });
            queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
            refreshHealthData();
            onDataChange?.();
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to create bundle' });
        } finally {
            setBulkActionLoading(false);
        }
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
            await refetchTransactions();
            queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
            refreshHealthData();
            onDataChange?.();
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
            setSelectedIds(new Set());
            setShowBulkTypeDialog(false);
            setBulkType('');
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
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

        for (const tx of selectedTxs) {
            const updates: Record<string, number> = {};

            // Check asset
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

            // Check from_account
            if (tx.source_from_account && !tx.from_account_id) {
                const suggestions = getAccountSuggestions(tx.source_from_account, accounts, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.from_account_id = suggestions[0].item.id;
                }
            }

            // Check to_account
            if (tx.source_to_account && !tx.to_account_id) {
                const suggestions = getAccountSuggestions(tx.source_to_account, accounts, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.to_account_id = suggestions[0].item.id;
                }
            }

            // Check ownership account
            if (tx.source_account && !tx.account_id) {
                const suggestions = getAccountSuggestions(tx.source_account, accounts, MIN_CONFIDENCE, 1);
                if (suggestions.length > 0 && suggestions[0].confidence >= MIN_CONFIDENCE) {
                    updates.account_id = suggestions[0].item.id;
                }
            }

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

    return (
        <Box pb={selectedIds.size > 0 ? '72px' : '0'}>
            <Flex justify="space-between" align="center" mb={6} borderBottom="1px" borderColor="gray.200" pb={2}>
                <Box>
                    <Heading as="h2" size="md" mb={1}>{title}</Heading>
                    <Text color="gray.600" fontSize="sm">{subtitle}</Text>
                </Box>
            </Flex>

            {/* Floating Bulk Actions Bar - pinned to viewport bottom */}
            {selectedIds.size > 0 && (
                <Portal>
                    <Box
                        position="fixed"
                        bottom={0}
                        left={0}
                        right={0}
                        zIndex={1000}
                        bg="white"
                        borderTop="1px solid"
                        borderColor="gray.200"
                        boxShadow="0 -4px 12px rgba(0,0,0,0.1)"
                        animation="slideUp 200ms ease-out"
                        css={{
                            '@keyframes slideUp': {
                                from: { transform: 'translateY(100%)' },
                                to: { transform: 'translateY(0)' },
                            },
                        }}
                    >
                        <Box maxW="1400px" mx="auto" px={6} py={3}>
                            <Flex justify="space-between" align="center" flexWrap="wrap" gap={3}>
                                <Text fontWeight="semibold" color="blue.700" fontSize="sm">
                                    {selectedIds.size} transaction(s) selected
                                </Text>
                                <Flex gap={2} flexWrap="wrap" align="center">
                                    {/* Quick Status Actions */}
                                    <Button
                                        size="sm"
                                        colorPalette="green"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('valid')}
                                        disabled={bulkActionLoading}
                                    >
                                        ✓ Valid
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorPalette="yellow"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('pending')}
                                        disabled={bulkActionLoading}
                                    >
                                        ⏳ Pending
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorPalette="red"
                                        variant="outline"
                                        onClick={() => bulkUpdateStatus('invalid')}
                                        disabled={bulkActionLoading}
                                    >
                                        ✗ Invalid
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="24px" mx={1} />

                                    {/* Quick Bundle Actions */}
                                    <Button
                                        size="sm"
                                        colorPalette="orange"
                                        variant="outline"
                                        onClick={() => createBundle('swap', generateBundleLabel('swap', selectedIds))}
                                        disabled={bulkActionLoading}
                                    >
                                        🔄 Swap
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorPalette="blue"
                                        variant="outline"
                                        onClick={() => createBundle('internal_transfer', generateBundleLabel('internal_transfer', selectedIds))}
                                        disabled={bulkActionLoading}
                                    >
                                        ↔ Transfer
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorPalette="purple"
                                        variant="outline"
                                        onClick={() => createBundle('custom', generateBundleLabel('custom', selectedIds))}
                                        disabled={bulkActionLoading}
                                    >
                                        📦 Bundle
                                    </Button>

                                    <Box borderLeft="1px solid" borderColor="gray.300" h="24px" mx={1} />

                                    {/* Other Actions */}
                                    <Button
                                        size="sm"
                                        colorPalette="purple"
                                        variant="outline"
                                        onClick={() => setShowBulkTypeDialog(true)}
                                    >
                                        🏷️ Set Type
                                    </Button>
                                    <Button
                                        size="sm"
                                        colorPalette="cyan"
                                        variant="outline"
                                        onClick={autoLinkHighConfidence}
                                        disabled={bulkActionLoading}
                                        title="Auto-link accounts and assets with ≥95% confidence match"
                                    >
                                        🔗 Auto-Link
                                    </Button>
                                    <Button
                                        size="sm"
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
                                        size="sm"
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
                {!loading && !error && transactions.length > 15 && (
                    <Box mb={4}>
                        <TablePagination
                            pagination={pagination}
                            total={transactions.length}
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
                {!loading && !error && (
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
                                        <Checkbox.Root
                                            checked={allCurrentPageSelected}
                                            onCheckedChange={toggleSelectAll}
                                        >
                                            <Checkbox.HiddenInput />
                                            <Checkbox.Control />
                                        </Checkbox.Root>
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
                                    {showColumn('status') && renderSortableHeader('status', 'Status', undefined, { position: 'sticky', right: '50px', bg: 'gray.100', zIndex: 10, borderLeft: '2px solid', borderColor: 'gray.300', fontSize: '7px', px: 1 })}
                                    <Table.ColumnHeader position="sticky" right={0} bg="gray.100" zIndex={10} minW="50px" px={0}></Table.ColumnHeader>
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
                                    paginatedTransactions.map(tx => {
                                        const suggestionEntry = showSuggestions ? suggestionMap.get(tx.id) : undefined;
                                        return (
                                            <React.Fragment key={tx.id}>
                                                <Table.Row
                                                    bg={getRowBgColor(tx)}
                                                    _hover={{ bg: 'blue.50' }}
                                                    onMouseEnter={() => {
                                                        if (suggestionEntry) setHoveredSuggestionGroup(suggestionEntry.groupIndex);
                                                        if (tx.user_calculation_unit_id && !suggestionEntry) setHoveredBundleId(tx.user_calculation_unit_id);
                                                    }}
                                                    onMouseLeave={() => {
                                                        if (suggestionEntry) setHoveredSuggestionGroup(null);
                                                        if (tx.user_calculation_unit_id && !suggestionEntry) setHoveredBundleId(null);
                                                    }}
                                                >
                                                    <Table.Cell position="sticky" left={0} bg={getRowBgColor(tx)} zIndex={5} borderRight="2px solid" borderColor="gray.300" p={0}>
                                                        {/* Review status band — full cell height */}
                                                        <Box
                                                            position="absolute"
                                                            left={0}
                                                            top={0}
                                                            bottom={0}
                                                            width="4px"
                                                            bg={getRowBorderColor(tx)}
                                                        />
                                                        {/* Suggestion / Bundle color band — right next to review status (mutually exclusive) */}
                                                        {suggestionEntry ? (
                                                            <Box
                                                                position="absolute"
                                                                left="5px"
                                                                top={0}
                                                                bottom={0}
                                                                width="4px"
                                                                bg={suggestionEntry.color}
                                                                borderRadius="2px"
                                                                zIndex={1}
                                                            />
                                                        ) : (tx.user_calculation_unit_id != null) ? (
                                                            <Box
                                                                position="absolute"
                                                                left="5px"
                                                                top={0}
                                                                bottom={0}
                                                                width="4px"
                                                                bg={bundleColorMap.get(tx.user_calculation_unit_id) || 'purple.400'}
                                                                borderRadius="2px"
                                                                zIndex={1}
                                                            />
                                                        ) : null}
                                                        <Flex gap={1} align="center" pl={(suggestionEntry || tx.user_calculation_unit_id) ? '12px' : '7px'} pr={1} minH="28px">
                                                            {/* Suggestion band icon — clickable, opens popover */}
                                                            {suggestionEntry && (
                                                                <SuggestionPopover
                                                                    suggestion={suggestionEntry.suggestion}
                                                                    open={openSuggestionTxId === tx.id}
                                                                    onOpenChange={(open) => setOpenSuggestionTxId(open ? tx.id : null)}
                                                                    onAccepted={() => setOpenSuggestionTxId(null)}
                                                                    onDismissed={() => setOpenSuggestionTxId(null)}
                                                                    onTransactionClick={(txId) => {
                                                                        setDrawerTransactionId(txId);
                                                                        setIsDrawerOpen(true);
                                                                    }}
                                                                >
                                                                    <Box
                                                                        as="button"
                                                                        display="flex"
                                                                        alignItems="center"
                                                                        p={0}
                                                                        cursor="pointer"
                                                                        color={suggestionEntry.color}
                                                                        _hover={{ opacity: 0.7 }}
                                                                        title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                                                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                                                    >
                                                                        <BundleSuggestionIcon size={12} />
                                                                    </Box>
                                                                </SuggestionPopover>
                                                            )}
                                                            {/* Bundle membership badge — clickable, opens popover */}
                                                            {!suggestionEntry && tx.user_calculation_unit_id && (
                                                                <BundleMembershipPopover
                                                                    bundleId={tx.user_calculation_unit_id}
                                                                    color={bundleColorMap.get(tx.user_calculation_unit_id) || 'purple.400'}
                                                                    open={openBundleTxId === tx.id}
                                                                    onOpenChange={(open) => setOpenBundleTxId(open ? tx.id : null)}
                                                                    onTransactionClick={(txId) => {
                                                                        setDrawerTransactionId(txId);
                                                                        setIsDrawerOpen(true);
                                                                    }}
                                                                >
                                                                    <Badge
                                                                        as="button"
                                                                        size="xs"
                                                                        fontSize="7px"
                                                                        colorPalette="purple"
                                                                        variant="subtle"
                                                                        cursor="pointer"
                                                                        _hover={{ opacity: 0.7 }}
                                                                        title={`Bundle #${tx.user_calculation_unit_id}`}
                                                                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                                                    >
                                                                        📦 #{tx.user_calculation_unit_id}
                                                                    </Badge>
                                                                </BundleMembershipPopover>
                                                            )}
                                                            <Checkbox.Root
                                                                checked={selectedIds.has(tx.id)}
                                                                onCheckedChange={() => toggleSelection(tx.id)}
                                                            >
                                                                <Checkbox.HiddenInput />
                                                                <Checkbox.Control />
                                                            </Checkbox.Root>
                                                            {/* Details button - opens drawer */}
                                                            <Button
                                                                size="xs"
                                                                variant="ghost"
                                                                onClick={() => {
                                                                    setDrawerTransactionId(tx.id);
                                                                    setIsDrawerOpen(true);
                                                                }}
                                                                p={0}
                                                                minW="16px"
                                                                h="16px"
                                                                color="gray.400"
                                                                _hover={{ color: 'blue.500' }}
                                                                title="View transaction details"
                                                            >
                                                                <FiFileText size={12} />
                                                            </Button>
                                                        </Flex>
                                                    </Table.Cell>
                                                    {showColumn('id') && (
                                                        <Table.Cell py={1}>
                                                            <Text fontSize="8px" fontFamily="mono" color="gray.500">{tx.id}</Text>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Date/Time - click to edit */}
                                                    {showColumn('date') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'date_time') && startCellEdit(tx, 'date_time')} cursor="pointer">
                                                            {isEditingCell(tx.id, 'date_time') ? (
                                                                <Input
                                                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                    size="xs"
                                                                    type="datetime-local"
                                                                    value={toDateTimeLocalString(editValues.date_time)}
                                                                    onChange={e => updateEditValues({ date_time: e.target.value })}
                                                                    onKeyDown={handleEditKeyDown}
                                                                    onBlur={saveAndClose}
                                                                    width="130px"
                                                                    fontSize="8px"
                                                                    px={1}
                                                                />
                                                            ) : (
                                                                <Text fontSize="8px">{formatDateTimeCompact(tx.date_time)}</Text>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Source Info - merged column with Source Account, Source, Source Type, Source Symbol */}
                                                    {showColumn('source') && (
                                                        <Table.Cell py={1} cursor="pointer">
                                                            {isEditingCell(tx.id, 'account_id') ? (
                                                                <Flex direction="column" gap={1} minW="120px">
                                                                    <AccountSelector
                                                                        value={editValues.account_id ?? null}
                                                                        onChange={(accountId) => {
                                                                            if (!escapePressedRef.current) {
                                                                                updateEditValues({ account_id: accountId ?? undefined });
                                                                                saveAndClose();
                                                                            }
                                                                        }}
                                                                        accounts={accounts}
                                                                        onAccountCreated={fetchAccounts}
                                                                        defaultName={tx.source_account || ''}
                                                                        placeholder="Link account..."
                                                                        rawAccountSource={tx.source}
                                                                        rawAccountLabel={tx.source_account}
                                                                    />
                                                                    {/* Show asset suggestions below the selector when editing */}
                                                                    {tx.source_account && !tx.account_id && (() => {
                                                                        const suggestions = getAccountSuggestions(tx.source_account, accounts);
                                                                        return suggestions.length > 0 ? (
                                                                            <HStack gap={1} flexWrap="wrap" mt={1}>
                                                                                <Text fontSize="7px" color="gray.500">Suggestions:</Text>
                                                                                {suggestions.map((s, idx) => (
                                                                                    <Tooltip
                                                                                        key={idx}
                                                                                        content={`${formatConfidence(s.confidence)} match`}
                                                                                        openDelay={100}
                                                                                    >
                                                                                        <Badge
                                                                                            size="xs"
                                                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                            cursor="pointer"
                                                                                            fontSize="7px"
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                updateEditValues({ account_id: s.item.id });
                                                                                                saveAndClose();
                                                                                            }}
                                                                                        >
                                                                                            {s.item.name.slice(0, 12)}{s.item.name.length > 12 ? '…' : ''}
                                                                                            {s.confidence >= 0.9 && ' ✓'}
                                                                                        </Badge>
                                                                                    </Tooltip>
                                                                                ))}
                                                                            </HStack>
                                                                        ) : null;
                                                                    })()}
                                                                    {/* Secondary info shown when editing */}
                                                                    <Text fontSize="7px" color="gray.400">
                                                                        {[tx.source, tx.source_transaction_type].filter(Boolean).join(' · ')}
                                                                    </Text>
                                                                </Flex>
                                                            ) : (
                                                                <SourceInfoCell
                                                                    sourceAccount={tx.source_account}
                                                                    accountId={tx.account_id}
                                                                    resolvedAccount={accounts.find(a => a.id === tx.account_id)}
                                                                    resolvedAccountName={accounts.find(a => a.id === tx.account_id)?.name}
                                                                    source={tx.source}
                                                                    sourceType={tx.source_transaction_type}
                                                                    sourceSymbol={tx.source_asset_symbol}
                                                                    connectorName={tx.connector_name}
                                                                    runDatetime={tx.run_datetime}
                                                                    syncConnectorRunId={tx.sync_connector_run_id}
                                                                    network={tx.network}
                                                                    onClick={() => startCellEdit(tx, 'account_id')}
                                                                    accountSuggestions={
                                                                        !tx.account_id && tx.source_account
                                                                            ? getAccountSuggestions(tx.source_account, accounts, 0.5, 2)
                                                                            : []
                                                                    }
                                                                    onAcceptSuggestion={async (accountId) => {
                                                                        try {
                                                                            const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                method: 'PATCH',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ account_id: accountId })
                                                                            });
                                                                            if (!response.ok) throw new Error('Failed to update');
                                                                            // Also link the raw_account if it exists
                                                                            if (tx.source_account) {
                                                                                try {
                                                                                    await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_account)}`, {
                                                                                        method: 'PATCH',
                                                                                        headers: { 'Content-Type': 'application/json' },
                                                                                        body: JSON.stringify({ account_id: accountId })
                                                                                    });
                                                                                } catch (linkErr) {
                                                                                    console.warn('Failed to link raw account:', linkErr);
                                                                                }
                                                                            }
                                                                            invalidateTransactionData();
                                                                        } catch (err) {
                                                                            toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                        }
                                                                    }}
                                                                />
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* From / To Accounts - merged column showing both in 2 lines with inline editing */}
                                                    {showColumn('accounts') && (
                                                        <Table.Cell py={1}>
                                                            <VStack gap={0.5} align="center">
                                                                {/* From Account - editable */}
                                                                {isEditingCell(tx.id, 'from_account_id') ? (
                                                                    <Flex direction="column" gap={1} minW="100px">
                                                                        <AccountSelector
                                                                            value={editValues.from_account_id ?? null}
                                                                            onChange={async (accountId) => {
                                                                                if (!escapePressedRef.current) {
                                                                                    try {
                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                            method: 'PATCH',
                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                            body: JSON.stringify({ from_account_id: accountId })
                                                                                        });
                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                        invalidateTransactionData();
                                                                                        setEditingCell(null);
                                                                                        setEditValues({});
                                                                                    } catch (err) {
                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                    }
                                                                                }
                                                                            }}
                                                                            accounts={accounts}
                                                                            onAccountCreated={fetchAccounts}
                                                                            defaultName={tx.source_from_account || ''}
                                                                            placeholder="From..."
                                                                            size="sm"
                                                                            rawAccountSource={tx.source}
                                                                            rawAccountLabel={tx.source_from_account}
                                                                        />
                                                                        {/* Suggestion badges when editing */}
                                                                        {tx.source_from_account && !tx.from_account_id && (() => {
                                                                            const suggestions = getAccountSuggestions(tx.source_from_account, accounts, 0.5, 3);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={1} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.name} (${formatConfidence(s.confidence)} match)`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ from_account_id: s.item.id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        invalidateTransactionData();
                                                                                                        setEditingCell(null);
                                                                                                        setEditValues({});
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.name.slice(0, 10)}{s.item.name.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : (tx.from_account_id || tx.source_from_account) ? (
                                                                    <Flex direction="column" gap={0.5} align="start">
                                                                        <Tooltip
                                                                            content={
                                                                                tx.from_account_id
                                                                                    ? `From: ${tx.from_account_name || 'Account'}${tx.source_from_account ? ` — Source: ${tx.source_from_account}` : ''} — Click to edit`
                                                                                    : `From: ${tx.source_from_account} - Click to link`
                                                                            }
                                                                            openDelay={200}
                                                                        >
                                                                            <Badge
                                                                                size="xs"
                                                                                colorPalette={tx.from_account_id ? 'cyan' : 'orange'}
                                                                                variant="subtle"
                                                                                cursor="pointer"
                                                                                onClick={() => startCellEdit(tx, 'from_account_id')}
                                                                            >
                                                                                {tx.from_account_id ? (
                                                                                    (tx.from_account_name || `#${tx.from_account_id}`).slice(0, 10)
                                                                                ) : (
                                                                                    <>⚠ {(tx.source_from_account || '').slice(0, 8)}{(tx.source_from_account || '').length > 8 && '…'}</>
                                                                                )}
                                                                            </Badge>
                                                                        </Tooltip>
                                                                        {/* Always-visible suggestion badges for unlinked from_account */}
                                                                        {tx.source_from_account && !tx.from_account_id && (() => {
                                                                            const suggestions = getAccountSuggestions(tx.source_from_account, accounts, 0.5, 2);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={0.5} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.name} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ from_account_id: s.item.id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        // Also link the raw_account
                                                                                                        if (tx.source_from_account) {
                                                                                                            try {
                                                                                                                await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_from_account)}`, {
                                                                                                                    method: 'PATCH',
                                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                                    body: JSON.stringify({ account_id: s.item.id })
                                                                                                                });
                                                                                                            } catch { }
                                                                                                        }
                                                                                                        invalidateTransactionData();
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.name.slice(0, 10)}{s.item.name.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : (
                                                                    <Badge
                                                                        size="xs"
                                                                        colorPalette="gray"
                                                                        variant="outline"
                                                                        cursor="pointer"
                                                                        onClick={() => startCellEdit(tx, 'from_account_id')}
                                                                    >
                                                                        + From
                                                                    </Badge>
                                                                )}
                                                                {/* Arrow separator between from and to */}
                                                                <Text fontSize="10px" color="gray.400" lineHeight="1">↓</Text>
                                                                {/* To Account - editable */}
                                                                {isEditingCell(tx.id, 'to_account_id') ? (
                                                                    <Flex direction="column" gap={1} minW="100px">
                                                                        <AccountSelector
                                                                            value={editValues.to_account_id ?? null}
                                                                            onChange={async (accountId) => {
                                                                                if (!escapePressedRef.current) {
                                                                                    try {
                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                            method: 'PATCH',
                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                            body: JSON.stringify({ to_account_id: accountId })
                                                                                        });
                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                        invalidateTransactionData();
                                                                                        setEditingCell(null);
                                                                                        setEditValues({});
                                                                                    } catch (err) {
                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                    }
                                                                                }
                                                                            }}
                                                                            accounts={accounts}
                                                                            onAccountCreated={fetchAccounts}
                                                                            defaultName={tx.source_to_account || ''}
                                                                            placeholder="To..."
                                                                            size="sm"
                                                                            rawAccountSource={tx.source}
                                                                            rawAccountLabel={tx.source_to_account}
                                                                        />
                                                                        {/* Suggestion badges when editing */}
                                                                        {tx.source_to_account && !tx.to_account_id && (() => {
                                                                            const suggestions = getAccountSuggestions(tx.source_to_account, accounts, 0.5, 3);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={1} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.name} (${formatConfidence(s.confidence)} match)`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ to_account_id: s.item.id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        invalidateTransactionData();
                                                                                                        setEditingCell(null);
                                                                                                        setEditValues({});
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.name.slice(0, 10)}{s.item.name.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : (tx.to_account_id || tx.source_to_account) ? (
                                                                    <Flex direction="column" gap={0.5} align="start">
                                                                        <Tooltip
                                                                            content={
                                                                                tx.to_account_id
                                                                                    ? `To: ${tx.to_account_name || 'Account'}${tx.source_to_account ? ` — Source: ${tx.source_to_account}` : ''} — Click to edit`
                                                                                    : `To: ${tx.source_to_account} - Click to link`
                                                                            }
                                                                            openDelay={200}
                                                                        >
                                                                            <Badge
                                                                                size="xs"
                                                                                colorPalette={tx.to_account_id ? 'cyan' : 'orange'}
                                                                                variant="subtle"
                                                                                cursor="pointer"
                                                                                onClick={() => startCellEdit(tx, 'to_account_id')}
                                                                            >
                                                                                {tx.to_account_id ? (
                                                                                    (tx.to_account_name || `#${tx.to_account_id}`).slice(0, 10)
                                                                                ) : (
                                                                                    <>⚠ {(tx.source_to_account || '').slice(0, 8)}{(tx.source_to_account || '').length > 8 && '…'}</>
                                                                                )}
                                                                            </Badge>
                                                                        </Tooltip>
                                                                        {/* Always-visible suggestion badges for unlinked to_account */}
                                                                        {tx.source_to_account && !tx.to_account_id && (() => {
                                                                            const suggestions = getAccountSuggestions(tx.source_to_account, accounts, 0.5, 2);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={0.5} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.name} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ to_account_id: s.item.id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        // Also link the raw_account
                                                                                                        if (tx.source_to_account) {
                                                                                                            try {
                                                                                                                await fetch(`${API_URL}/raw-accounts/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_to_account)}`, {
                                                                                                                    method: 'PATCH',
                                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                                    body: JSON.stringify({ account_id: s.item.id })
                                                                                                                });
                                                                                                            } catch { }
                                                                                                        }
                                                                                                        invalidateTransactionData();
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link account' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.name.slice(0, 10)}{s.item.name.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : (
                                                                    <Badge
                                                                        size="xs"
                                                                        colorPalette="gray"
                                                                        variant="outline"
                                                                        cursor="pointer"
                                                                        onClick={() => startCellEdit(tx, 'to_account_id')}
                                                                    >
                                                                        + To
                                                                    </Badge>
                                                                )}
                                                            </VStack>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Direction - click to edit */}
                                                    {showColumn('direction') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'direction') && startCellEdit(tx, 'direction')} cursor="pointer">
                                                            {isEditingCell(tx.id, 'direction') ? (
                                                                <NativeSelect.Root size="sm" width="45px">
                                                                    <NativeSelect.Field
                                                                        value={editValues.direction || tx.direction}
                                                                        onChange={async e => {
                                                                            const newDir = e.target.value;
                                                                            // Save directly with the new value
                                                                            try {
                                                                                const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                    method: 'PATCH',
                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                    body: JSON.stringify({ direction: newDir })
                                                                                });
                                                                                if (!response.ok) throw new Error('Failed to update');
                                                                                invalidateTransactionData();
                                                                                setEditingCell(null);
                                                                                setEditValues({});
                                                                            } catch (err) {
                                                                                toaster.error({ title: 'Error', description: 'Failed to save direction' });
                                                                            }
                                                                        }}
                                                                        onBlur={() => {
                                                                            if (!escapePressedRef.current) {
                                                                                setEditingCell(null);
                                                                                setEditValues({});
                                                                            }
                                                                        }}
                                                                        style={{ fontSize: '8px', padding: '2px' }}
                                                                        autoFocus
                                                                    >
                                                                        {DIRECTION_OPTIONS.map(opt => (
                                                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                                        ))}
                                                                    </NativeSelect.Field>
                                                                </NativeSelect.Root>
                                                            ) : (
                                                                <Badge size="sm" colorPalette={tx.direction === 'inflow' ? 'green' : tx.direction === 'outflow' ? 'red' : 'gray'}>
                                                                    {tx.direction === 'inflow' ? '↓' : tx.direction === 'outflow' ? '↑' : '↔'}
                                                                </Badge>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Type - click to edit */}
                                                    {showColumn('type') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'transaction_type') && startCellEdit(tx, 'transaction_type')} cursor="pointer">
                                                            {isEditingCell(tx.id, 'transaction_type') ? (
                                                                <NativeSelect.Root size="sm" width="80px">
                                                                    <NativeSelect.Field
                                                                        value={editValues.transaction_type || tx.transaction_type}
                                                                        onChange={async e => {
                                                                            const newType = e.target.value;
                                                                            try {
                                                                                const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                    method: 'PATCH',
                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                    body: JSON.stringify({ transaction_type: newType })
                                                                                });
                                                                                if (!response.ok) throw new Error('Failed to update');
                                                                                invalidateTransactionData();
                                                                                setEditingCell(null);
                                                                                setEditValues({});
                                                                            } catch (err) {
                                                                                toaster.error({ title: 'Error', description: 'Failed to save type' });
                                                                            }
                                                                        }}
                                                                        onBlur={() => {
                                                                            if (!escapePressedRef.current) {
                                                                                setEditingCell(null);
                                                                                setEditValues({});
                                                                            }
                                                                        }}
                                                                        style={{ fontSize: '8px', padding: '2px' }}
                                                                        autoFocus
                                                                    >
                                                                        {TRANSACTION_TYPE_OPTIONS.map(opt => (
                                                                            <option key={opt} value={opt}>{opt}</option>
                                                                        ))}
                                                                    </NativeSelect.Field>
                                                                </NativeSelect.Root>
                                                            ) : (
                                                                <Flex align="center" gap={1}>
                                                                    {tx.transaction_type === 'transfer' ? (
                                                                        <BiTransfer color="#805AD5" size={12} title="Transfer" />
                                                                    ) : tx.transaction_type === 'trade' ? (
                                                                        <RiExchangeFundsLine color="#3182CE" size={12} title="Trade" />
                                                                    ) : tx.transaction_type === 'technical' ? (
                                                                        <FaQuestion color="#A0AEC0" size={10} title="Technical (approval, contract call)" />
                                                                    ) : (
                                                                        <FaQuestion color="#718096" size={10} title="Other" />
                                                                    )}
                                                                    <Badge size="xs" colorPalette="blue">{tx.transaction_type?.substring(0, 6)}</Badge>
                                                                </Flex>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Linked Asset - click to edit */}
                                                    {showColumn('asset') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'asset_id') && startCellEdit(tx, 'asset_id')} cursor="pointer">
                                                            {isEditingCell(tx.id, 'asset_id') ? (
                                                                <Flex direction="column" gap={1} minW="90px">
                                                                    <AssetSelector
                                                                        value={editValues.asset_id ?? null}
                                                                        onChange={(assetId) => {
                                                                            if (!escapePressedRef.current) {
                                                                                updateEditValues({ asset_id: assetId ?? undefined });
                                                                                saveAndClose();
                                                                            }
                                                                        }}
                                                                        assets={assets}
                                                                        onAssetCreated={fetchAssets}
                                                                        defaultSymbol={tx.source_asset_symbol || ''}
                                                                        placeholder="Link..."
                                                                        rawAssetSource={tx.source}
                                                                        rawAssetSymbol={tx.source_asset_symbol}
                                                                    />
                                                                    {/* Show asset suggestions when editing unlinked asset */}
                                                                    {tx.source_asset_symbol && !tx.asset_id && (() => {
                                                                        const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 3);
                                                                        return suggestions.length > 0 ? (
                                                                            <HStack gap={1} flexWrap="wrap">
                                                                                <Text fontSize="7px" color="gray.500">Suggestions:</Text>
                                                                                {suggestions.map((s, idx) => (
                                                                                    <Tooltip
                                                                                        key={idx}
                                                                                        content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                                                        openDelay={100}
                                                                                    >
                                                                                        <Badge
                                                                                            size="xs"
                                                                                            colorPalette={getConfidenceColor(s.confidence)}
                                                                                            variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                            cursor="pointer"
                                                                                            fontSize="7px"
                                                                                            onClick={(e) => {
                                                                                                e.stopPropagation();
                                                                                                updateEditValues({ asset_id: s.item.asset_id });
                                                                                                saveAndClose();
                                                                                            }}
                                                                                        >
                                                                                            {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}
                                                                                            {s.confidence >= 0.9 && ' ✓'}
                                                                                        </Badge>
                                                                                    </Tooltip>
                                                                                ))}
                                                                            </HStack>
                                                                        ) : null;
                                                                    })()}
                                                                </Flex>
                                                            ) : (
                                                                tx.linked_asset_symbol ? (
                                                                    <AssetBadge
                                                                        asset={tx.linked_asset}
                                                                        size="sm"
                                                                        colorPalette="purple"
                                                                        maxLength={10}
                                                                        onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}
                                                                    />
                                                                ) : tx.source_asset_symbol ? (
                                                                    <Flex direction="column" gap={0.5} align="start">
                                                                        <Tooltip content={`${tx.source_asset_symbol} - Click to link`} openDelay={200}>
                                                                            <Text color="orange.500" fontWeight="bold" fontSize="8px" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'asset_id'); }}>
                                                                                ⚠ {tx.source_asset_symbol.slice(0, 8)}{tx.source_asset_symbol.length > 8 && '…'}
                                                                            </Text>
                                                                        </Tooltip>
                                                                        {/* Always-visible suggestion badges for unlinked asset */}
                                                                        {(() => {
                                                                            const suggestions = getAssetSuggestions(tx.source_asset_symbol, assets, 0.5, 2);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={0.5} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        // Also link the raw_asset
                                                                                                        if (tx.source_asset_symbol) {
                                                                                                            try {
                                                                                                                await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_asset_symbol)}`, {
                                                                                                                    method: 'PATCH',
                                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                                    body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                                                });
                                                                                                            } catch { }
                                                                                                        }
                                                                                                        invalidateTransactionData();
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : (
                                                                    <Text color="gray.400" fontSize="8px">-</Text>
                                                                )
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Quantity - click to edit */}
                                                    {showColumn('qty') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'quantity') && startCellEdit(tx, 'quantity')} cursor="pointer">
                                                            {isEditingCell(tx.id, 'quantity') ? (
                                                                <Input
                                                                    ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                    size="xs"
                                                                    type="number"
                                                                    step="any"
                                                                    value={editValues.quantity ?? tx.quantity ?? ''}
                                                                    onChange={e => updateEditValues({ quantity: parseFloat(e.target.value) || 0 })}
                                                                    onKeyDown={e => {
                                                                        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                        else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity); }
                                                                    }}
                                                                    onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'quantity', editValuesRef.current.quantity)}
                                                                    width="60px"
                                                                    fontSize="8px"
                                                                    px={1}
                                                                />
                                                            ) : (
                                                                <Text fontSize="8px"><ValueDisplay value={tx.quantity} /></Text>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Price - click to edit value, click badge to edit quote asset */}
                                                    {showColumn('price') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'price') && !isEditingCell(tx.id, 'price_quote_asset_id') && startCellEdit(tx, 'price')} cursor="pointer">
                                                            <Flex direction="column" gap={0}>
                                                                {isEditingCell(tx.id, 'price') ? (
                                                                    <Input
                                                                        ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                        size="xs"
                                                                        type="number"
                                                                        step="any"
                                                                        value={editValues.price ?? tx.price ?? ''}
                                                                        onChange={e => updateEditValues({ price: parseFloat(e.target.value) || 0 })}
                                                                        onKeyDown={e => {
                                                                            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                            else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'price', editValuesRef.current.price); }
                                                                        }}
                                                                        onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'price', editValuesRef.current.price)}
                                                                        width="60px"
                                                                        fontSize="8px"
                                                                        px={1}
                                                                    />
                                                                ) : (
                                                                    <Text fontSize="8px">
                                                                        {tx.price ? <ValueDisplay value={tx.price} /> : '-'}
                                                                    </Text>
                                                                )}
                                                                {isEditingCell(tx.id, 'price_quote_asset_id') ? (
                                                                    <Flex direction="column" gap={1} minW="70px">
                                                                        <AssetSelector
                                                                            value={editValues.price_quote_asset_id ?? null}
                                                                            onChange={(assetId) => {
                                                                                if (!escapePressedRef.current) {
                                                                                    updateEditValues({ price_quote_asset_id: assetId ?? undefined });
                                                                                    saveAndClose();
                                                                                }
                                                                            }}
                                                                            assets={assets}
                                                                            onAssetCreated={fetchAssets}
                                                                            defaultSymbol={tx.source_price_quote_asset_symbol || ''}
                                                                            placeholder="Quote..."
                                                                            rawAssetSource={tx.source}
                                                                            rawAssetSymbol={tx.source_price_quote_asset_symbol}
                                                                        />
                                                                        {/* Show asset suggestions when editing unlinked price quote asset */}
                                                                        {tx.source_price_quote_asset_symbol && !tx.price_quote_asset_id && (() => {
                                                                            const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 3);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={1} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip
                                                                                            key={idx}
                                                                                            content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                                                            openDelay={100}
                                                                                        >
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    updateEditValues({ price_quote_asset_id: s.item.asset_id });
                                                                                                    saveAndClose();
                                                                                                }}
                                                                                            >
                                                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : tx.linked_price_quote_asset_symbol ? (
                                                                    <AssetBadge
                                                                        asset={tx.price_quote_asset}
                                                                        size="xs"
                                                                        colorPalette="cyan"
                                                                        maxLength={10}
                                                                        onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}
                                                                    />
                                                                ) : tx.source_price_quote_asset_symbol ? (
                                                                    <Flex direction="column" gap={0.5} align="start">
                                                                        <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'price_quote_asset_id'); }}>⚠ {tx.source_price_quote_asset_symbol}</Text>
                                                                        {/* Always-visible suggestion badges for unlinked price quote asset */}
                                                                        {(() => {
                                                                            const suggestions = getAssetSuggestions(tx.source_price_quote_asset_symbol, assets, 0.5, 2);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={0.5} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ price_quote_asset_id: s.item.asset_id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        // Also link the raw_asset
                                                                                                        if (tx.source_price_quote_asset_symbol) {
                                                                                                            try {
                                                                                                                await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_price_quote_asset_symbol)}`, {
                                                                                                                    method: 'PATCH',
                                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                                    body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                                                });
                                                                                                            } catch { }
                                                                                                        }
                                                                                                        invalidateTransactionData();
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : null}
                                                            </Flex>
                                                        </Table.Cell>
                                                    )}
                                                    {showColumn('total') && (
                                                        <Table.Cell py={1}>
                                                            <Text fontSize="8px">
                                                                {tx.total ? <ValueDisplay value={tx.total} /> : '-'}
                                                            </Text>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Fee - click to edit value, click badge to edit quote asset */}
                                                    {showColumn('fee') && (
                                                        <Table.Cell py={1} onClick={() => !isEditingCell(tx.id, 'fee') && !isEditingCell(tx.id, 'fee_quote_asset_id') && startCellEdit(tx, 'fee')} cursor="pointer">
                                                            <Flex direction="column" gap={0}>
                                                                {isEditingCell(tx.id, 'fee') ? (
                                                                    <Input
                                                                        ref={editInputRef as React.RefObject<HTMLInputElement>}
                                                                        size="xs"
                                                                        type="number"
                                                                        step="any"
                                                                        value={editValues.fee ?? tx.fee ?? ''}
                                                                        onChange={e => updateEditValues({ fee: parseFloat(e.target.value) || 0 })}
                                                                        onKeyDown={e => {
                                                                            if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                                                                            else if (e.key === 'Enter') { e.preventDefault(); saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee); }
                                                                        }}
                                                                        onBlur={() => !escapePressedRef.current && saveFieldDirectly(tx.id, 'fee', editValuesRef.current.fee)}
                                                                        width="60px"
                                                                        fontSize="8px"
                                                                        px={1}
                                                                    />
                                                                ) : (
                                                                    <Text fontSize="8px">
                                                                        {tx.fee ? <ValueDisplay value={tx.fee} /> : '-'}
                                                                    </Text>
                                                                )}
                                                                {isEditingCell(tx.id, 'fee_quote_asset_id') ? (
                                                                    <Flex direction="column" gap={1} minW="70px">
                                                                        <AssetSelector
                                                                            value={editValues.fee_quote_asset_id ?? null}
                                                                            onChange={(assetId) => {
                                                                                if (!escapePressedRef.current) {
                                                                                    updateEditValues({ fee_quote_asset_id: assetId ?? undefined });
                                                                                    saveAndClose();
                                                                                }
                                                                            }}
                                                                            assets={assets}
                                                                            onAssetCreated={fetchAssets}
                                                                            defaultSymbol={tx.source_fee_quote_asset_symbol || ''}
                                                                            placeholder="Fee..."
                                                                            rawAssetSource={tx.source}
                                                                            rawAssetSymbol={tx.source_fee_quote_asset_symbol}
                                                                        />
                                                                        {/* Show asset suggestions when editing unlinked fee quote asset */}
                                                                        {tx.source_fee_quote_asset_symbol && !tx.fee_quote_asset_id && (() => {
                                                                            const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 3);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={1} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip
                                                                                            key={idx}
                                                                                            content={`${s.item.symbol} (${formatConfidence(s.confidence)} match)`}
                                                                                            openDelay={100}
                                                                                        >
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={(e) => {
                                                                                                    e.stopPropagation();
                                                                                                    updateEditValues({ fee_quote_asset_id: s.item.asset_id });
                                                                                                    saveAndClose();
                                                                                                }}
                                                                                            >
                                                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : tx.linked_fee_quote_asset_symbol ? (
                                                                    <AssetBadge
                                                                        asset={tx.fee_quote_asset}
                                                                        size="xs"
                                                                        colorPalette="cyan"
                                                                        maxLength={10}
                                                                        onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}
                                                                    />
                                                                ) : tx.source_fee_quote_asset_symbol ? (
                                                                    <Flex direction="column" gap={0.5} align="start">
                                                                        <Text fontSize="8px" color="orange.500" fontWeight="bold" cursor="pointer" onClick={(e) => { e.stopPropagation(); startCellEdit(tx, 'fee_quote_asset_id'); }}>⚠ {tx.source_fee_quote_asset_symbol}</Text>
                                                                        {/* Always-visible suggestion badges for unlinked fee quote asset */}
                                                                        {(() => {
                                                                            const suggestions = getAssetSuggestions(tx.source_fee_quote_asset_symbol, assets, 0.5, 2);
                                                                            return suggestions.length > 0 ? (
                                                                                <HStack gap={0.5} flexWrap="wrap">
                                                                                    {suggestions.map((s, idx) => (
                                                                                        <Tooltip key={idx} content={`${s.item.symbol} (${formatConfidence(s.confidence)} match) - Click to link`} openDelay={100}>
                                                                                            <Badge
                                                                                                size="xs"
                                                                                                colorPalette={getConfidenceColor(s.confidence)}
                                                                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                                                                cursor="pointer"
                                                                                                fontSize="6px"
                                                                                                onClick={async (e) => {
                                                                                                    e.stopPropagation();
                                                                                                    try {
                                                                                                        const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                                            method: 'PATCH',
                                                                                                            headers: { 'Content-Type': 'application/json' },
                                                                                                            body: JSON.stringify({ fee_quote_asset_id: s.item.asset_id })
                                                                                                        });
                                                                                                        if (!response.ok) throw new Error('Failed to update');
                                                                                                        // Also link the raw_asset
                                                                                                        if (tx.source_fee_quote_asset_symbol) {
                                                                                                            try {
                                                                                                                await fetch(`${API_URL}/raw-assets/${encodeURIComponent(tx.source)}/${encodeURIComponent(tx.source_fee_quote_asset_symbol)}`, {
                                                                                                                    method: 'PATCH',
                                                                                                                    headers: { 'Content-Type': 'application/json' },
                                                                                                                    body: JSON.stringify({ asset_id: s.item.asset_id })
                                                                                                                });
                                                                                                            } catch { }
                                                                                                        }
                                                                                                        invalidateTransactionData();
                                                                                                    } catch (err) {
                                                                                                        toaster.error({ title: 'Error', description: 'Failed to link asset' });
                                                                                                    }
                                                                                                }}
                                                                                            >
                                                                                                {s.item.symbol.slice(0, 10)}{s.item.symbol.length > 10 ? '…' : ''}{s.confidence >= 0.9 && '✓'}
                                                                                            </Badge>
                                                                                        </Tooltip>
                                                                                    ))}
                                                                                </HStack>
                                                                            ) : null;
                                                                        })()}
                                                                    </Flex>
                                                                ) : null}
                                                            </Flex>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Taxable - always toggle, saves immediately */}
                                                    {showColumn('taxability') && (
                                                        <Table.Cell py={1}>
                                                            <Switch.Root
                                                                size="sm"
                                                                checked={tx.disposal_taxable ?? false}
                                                                onCheckedChange={() => quickToggle(tx, 'disposal_taxable')}
                                                            >
                                                                <Switch.HiddenInput />
                                                                <Switch.Control />
                                                            </Switch.Root>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Include Fee - always toggle, saves immediately */}
                                                    {showColumn('feeInBase') && (
                                                        <Table.Cell py={1}>
                                                            <Switch.Root
                                                                size="sm"
                                                                checked={tx.include_fee ?? false}
                                                                onCheckedChange={() => quickToggle(tx, 'include_fee')}
                                                            >
                                                                <Switch.HiddenInput />
                                                                <Switch.Control />
                                                            </Switch.Root>
                                                        </Table.Cell>
                                                    )}
                                                    {/* Bundle - read only */}
                                                    {showColumn('bundle') && (
                                                        <Table.Cell py={1}>
                                                            {tx.user_calculation_unit_id ? <Badge size="sm" colorPalette="purple">📦 #{tx.user_calculation_unit_id}</Badge> : <Text fontSize="8px" color="gray.400">-</Text>}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Tags - display only */}
                                                    {showColumn('tags') && (
                                                        <Table.Cell py={1}>
                                                            {tx.tags && Object.keys(tx.tags).length > 0 ? (
                                                                <Tooltip
                                                                    content={
                                                                        <VStack gap={0.5} align="start">
                                                                            {Object.entries(tx.tags).map(([key, value]) => (
                                                                                <Text key={key} fontSize="xs">
                                                                                    {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                                                                </Text>
                                                                            ))}
                                                                        </VStack>
                                                                    }
                                                                    openDelay={200}
                                                                >
                                                                    <HStack gap={0.5} flexWrap="wrap" maxW="100px">
                                                                        {Object.entries(tx.tags).slice(0, 2).map(([key, value]) => (
                                                                            <Badge key={key} size="xs" colorPalette="blue" variant="subtle">
                                                                                {key === 'value' ? String(value).slice(0, 8) : key.slice(0, 6)}
                                                                            </Badge>
                                                                        ))}
                                                                        {Object.keys(tx.tags).length > 2 && (
                                                                            <Text fontSize="7px" color="gray.500">+{Object.keys(tx.tags).length - 2}</Text>
                                                                        )}
                                                                    </HStack>
                                                                </Tooltip>
                                                            ) : (
                                                                <Text fontSize="8px" color="gray.400">-</Text>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Source Transaction ID - display only */}
                                                    {showColumn('sourceTransactionId') && (
                                                        <Table.Cell py={1}>
                                                            {tx.source_transaction_id ? (
                                                                <Tooltip content={tx.source_transaction_id} openDelay={200}>
                                                                    <Text fontSize="8px" color="gray.600" cursor="pointer">
                                                                        {tx.source_transaction_id.slice(0, 12)}{tx.source_transaction_id.length > 12 && '…'}
                                                                    </Text>
                                                                </Tooltip>
                                                            ) : (
                                                                <Text fontSize="8px" color="gray.400">-</Text>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Additional plugin columns */}
                                                    {additionalColumns.map(col => (
                                                        <Table.Cell key={col.id} py={1}>
                                                            {col.render(tx as T)}
                                                        </Table.Cell>
                                                    ))}
                                                    {/* Status - click to edit */}
                                                    {showColumn('status') && (
                                                        <Table.Cell position="sticky" right="50px" bg={getRowBgColor(tx)} zIndex={5} borderLeft="2px solid" borderColor="gray.300" onClick={() => !isEditingCell(tx.id, 'review_status') && startCellEdit(tx, 'review_status')} cursor="pointer" px={1} py={0}>
                                                            {isEditingCell(tx.id, 'review_status') ? (
                                                                <NativeSelect.Root size="sm" width="55px">
                                                                    <NativeSelect.Field
                                                                        value={editValues.review_status || tx.review_status}
                                                                        onChange={e => updateEditValues({ review_status: e.target.value as TransactionStatus })}
                                                                        onKeyDown={handleEditKeyDown}
                                                                        onBlur={saveAndClose}
                                                                        style={{ fontSize: '7px', padding: '1px' }}
                                                                    >
                                                                        <option value="valid">Valid</option>
                                                                        <option value="pending">Pending</option>
                                                                        <option value="invalid">Invalid</option>
                                                                    </NativeSelect.Field>
                                                                </NativeSelect.Root>
                                                            ) : (
                                                                <Flex direction="column" gap={0}>
                                                                    <Badge size="xs" colorPalette={statusBadgeColors[tx.review_status] || 'gray'} fontSize="6px">
                                                                        {tx.review_status}
                                                                    </Badge>
                                                                    {/* Quick set valid button */}
                                                                    {tx.review_status !== 'valid' && (
                                                                        <Button
                                                                            size="2xs"
                                                                            variant="ghost"
                                                                            colorPalette="green"
                                                                            onClick={async (e) => {
                                                                                e.stopPropagation();
                                                                                try {
                                                                                    const response = await fetch(`${API_URL}/transactions/${tx.id}`, {
                                                                                        method: 'PATCH',
                                                                                        headers: { 'Content-Type': 'application/json' },
                                                                                        body: JSON.stringify({ review_status: 'valid' }),
                                                                                    });
                                                                                    if (!response.ok) throw new Error('Failed to update');
                                                                                    invalidateTransactionData();
                                                                                } catch (err) {
                                                                                    toaster.error({ title: 'Error', description: 'Failed to set status' });
                                                                                }
                                                                            }}
                                                                            title="Set valid"
                                                                            p={0}
                                                                            minW="14px"
                                                                            h="12px"
                                                                        >
                                                                            <LuCheck size={8} />
                                                                        </Button>
                                                                    )}
                                                                    {/* Duplicate indicators */}
                                                                    {hasPotentialDuplicateTag(tx) && (() => {
                                                                        const resolutionTag = getDuplicateResolutionTag(tx);
                                                                        const groupHash = getDuplicateGroupHash(tx);

                                                                        if (resolutionTag) {
                                                                            // Read dup_resolution field from new format
                                                                            const resolution = resolutionTag.dup_resolution;
                                                                            const status = resolutionTag.data?.status;

                                                                            if (resolution === 'kept' || resolution === 'keep_selected') {
                                                                                return (
                                                                                    <Tooltip content={`Kept (${status || 'resolved'})`}>
                                                                                        <Badge size="xs" colorPalette="green" variant="outline" fontSize="7px">
                                                                                            <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                                                            Kept
                                                                                        </Badge>
                                                                                    </Tooltip>
                                                                                );
                                                                            } else if (resolution === 'dismissed' || resolution === 'dismiss_selected') {
                                                                                return (
                                                                                    <Tooltip content={`Dismissed (${status || 'resolved'})`}>
                                                                                        <Badge size="xs" colorPalette="gray" variant="outline" fontSize="7px">
                                                                                            <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                                                            Dismissed
                                                                                        </Badge>
                                                                                    </Tooltip>
                                                                                );
                                                                            } else if (resolution === 'merged') {
                                                                                return (
                                                                                    <Tooltip content={`Merged (${status || 'resolved'})`}>
                                                                                        <Badge size="xs" colorPalette="purple" variant="outline" fontSize="7px">
                                                                                            <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                                                            Merged
                                                                                        </Badge>
                                                                                    </Tooltip>
                                                                                );
                                                                            }
                                                                        }

                                                                        // Show pending duplicate indicator
                                                                        return (
                                                                            <Tooltip content={`Potential duplicate (group: ${groupHash?.slice(0, 8)}...)`}>
                                                                                <Badge size="xs" colorPalette="orange" variant="solid" fontSize="7px">
                                                                                    <FiCopy size={8} style={{ marginRight: '2px' }} />
                                                                                    Duplicate?
                                                                                </Badge>
                                                                            </Tooltip>
                                                                        );
                                                                    })()}
                                                                </Flex>
                                                            )}
                                                        </Table.Cell>
                                                    )}
                                                    {/* Actions - show cancel when editing */}
                                                    <Table.Cell position="sticky" right={0} bg={getRowBgColor(tx)} zIndex={5} minW="50px" px={0} py={0}>
                                                        <Flex gap={0}>
                                                            {/* Unbundle action — remove tx from bundle */}
                                                            {!suggestionEntry && tx.user_calculation_unit_id && (
                                                                <Button
                                                                    size="2xs"
                                                                    variant="ghost"
                                                                    colorPalette="red"
                                                                    onClick={async (e) => {
                                                                        e.stopPropagation();
                                                                        try {
                                                                            const response = await fetch(`${API_URL}/bundles/${tx.user_calculation_unit_id}/remove-transactions`, {
                                                                                method: 'POST',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                body: JSON.stringify({ transaction_ids: [tx.id] }),
                                                                            });
                                                                            if (!response.ok) throw new Error('Failed to unbundle');
                                                                            invalidateTransactionData();
                                                                            queryClient.invalidateQueries({ queryKey: ['bundles'] });
                                                                            toaster.success({ title: 'Unbundled', description: `Transaction #${tx.id} removed from bundle` });
                                                                        } catch (err) {
                                                                            toaster.error({ title: 'Error', description: 'Failed to remove from bundle' });
                                                                        }
                                                                    }}
                                                                    onMouseEnter={() => setHoveredBundleId(tx.user_calculation_unit_id!)}
                                                                    onMouseLeave={() => setHoveredBundleId(null)}
                                                                    title={`Remove from bundle #${tx.user_calculation_unit_id}`}
                                                                    p={0}
                                                                    minW="16px"
                                                                    h="16px"
                                                                >
                                                                    <LuPackageX size={10} />
                                                                </Button>
                                                            )}
                                                            {/* Bundle suggestion icon in actions */}
                                                            {suggestionEntry && (
                                                                <Button
                                                                    size="2xs"
                                                                    variant="ghost"
                                                                    colorPalette="teal"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        setOpenSuggestionTxId(openSuggestionTxId === tx.id ? null : tx.id);
                                                                    }}
                                                                    onMouseEnter={() => setHoveredSuggestionGroup(suggestionEntry.groupIndex)}
                                                                    onMouseLeave={() => setHoveredSuggestionGroup(null)}
                                                                    title={`Bundle suggestion: ${suggestionEntry.suggestion.label}`}
                                                                    p={0}
                                                                    minW="16px"
                                                                    h="16px"
                                                                >
                                                                    <BundleSuggestionIcon size={10} color={suggestionEntry.color} />
                                                                </Button>
                                                            )}
                                                            {getEditingTxId() === tx.id ? (
                                                                <Button size="2xs" variant="ghost" onClick={cancelEdit} title="Cancel (Esc)" p={0} minW="16px" h="16px">
                                                                    ✗
                                                                </Button>
                                                            ) : (
                                                                <>
                                                                    <Button
                                                                        size="2xs"
                                                                        variant="ghost"
                                                                        colorPalette="blue"
                                                                        onClick={() => {
                                                                            setTransactionToEdit(tx);
                                                                            setShowEditorDialog(true);
                                                                        }}
                                                                        title="Edit all fields"
                                                                        p={0}
                                                                        minW="16px"
                                                                        h="16px"
                                                                    >
                                                                        <LuPencil size={10} />
                                                                    </Button>
                                                                    <Button
                                                                        size="2xs"
                                                                        variant="ghost"
                                                                        colorPalette="red"
                                                                        onClick={() => {
                                                                            setTransactionToDelete(tx);
                                                                            fetchDeletionImpact([tx.id]);
                                                                            setShowDeleteDialog(true);
                                                                        }}
                                                                        title="Delete transaction"
                                                                        p={0}
                                                                        minW="16px"
                                                                        h="16px"
                                                                    >
                                                                        🗑️
                                                                    </Button>
                                                                </>
                                                            )}
                                                            {/* Additional plugin row actions */}
                                                            {additionalRowActions.map(action => {
                                                                const isVisible = action.isVisible ? action.isVisible(tx as T) : true;
                                                                const isDisabled = action.isDisabled ? action.isDisabled(tx as T) : false;
                                                                if (!isVisible) return null;
                                                                return (
                                                                    <Button
                                                                        key={action.id}
                                                                        size="2xs"
                                                                        variant="ghost"
                                                                        colorPalette={action.colorPalette || 'gray'}
                                                                        onClick={() => action.onClick(tx as T)}
                                                                        disabled={isDisabled}
                                                                        title={action.label}
                                                                        p={0}
                                                                        minW="16px"
                                                                        h="16px"
                                                                    >
                                                                        {action.icon}
                                                                    </Button>
                                                                );
                                                            })}
                                                        </Flex>
                                                    </Table.Cell>
                                                </Table.Row>
                                            </React.Fragment>
                                        );
                                    })
                                )}
                            </Table.Body>
                        </Table.Root>
                    </Box>
                )}

                {/* Pagination Controls - show even when loading/error */}
                {!loading && !error && (
                    <TablePagination
                        pagination={pagination}
                        total={transactions.length}
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

            {/* Transaction Editor Dialog */}
            <TransactionEditorDialog
                transaction={transactionToEdit}
                isOpen={showEditorDialog}
                onClose={() => {
                    setShowEditorDialog(false);
                    setTransactionToEdit(null);
                }}
            />

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
                                                            const dbType = tx.is_fee_transaction ? 'technical' : 'trade';
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
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ review_notes: notes }),
                        });
                        if (response.ok) {
                            invalidateTransactionData();
                            onDataChange?.();
                        }
                    } catch (err) {
                        console.error('Failed to update notes:', err);
                    }
                }}
                onTagsChange={async (txId, tags) => {
                    try {
                        const response = await fetch(`${API_URL}/transactions/${txId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tags }),
                        });
                        if (response.ok) {
                            invalidateTransactionData();
                            onDataChange?.();
                        }
                    } catch (err) {
                        console.error('Failed to update tags:', err);
                    }
                }}
            />
        </Box >
    );
};
