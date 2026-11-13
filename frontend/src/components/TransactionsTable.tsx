import { Badge, Button, Spinner, type BadgeColorScheme } from './ui/primitives';
import { cn } from '../lib/cn';
import { LuArrowUp, LuArrowDown, LuArrowUpDown, LuBan, LuCalendarDays, LuFilter, LuList, LuLocateFixed, LuPlus, LuMinus, LuX } from 'react-icons/lu';
import React, { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import * as RadixDialog from '@radix-ui/react-dialog';
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
import { PageSection } from './ui/PageSection';
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
import { InfoTip } from './pnl/pnlTerms';
import { TableConfig, ColumnPlugin, RowAction, BulkAction, TransactionColumnKey, resolveTableConfig, presetToVisibility, ColumnVisibilityPopover } from './tables';
import { useDuplicateMap } from '../hooks/useDuplicateMap';
import AccountFormDialog, { AccountPrefill } from './AccountFormDialog';
import AssetFormDialog, { AssetPrefill } from './AssetFormDialog';
import { BundleCreateDialog, BundleCreateDefaults } from './bundles/BundleCreateDialog';
import { TransactionTableRow, TransactionRowCallbacks, EditableField } from './TransactionTableRow';
import { buildTransactionFilterParams } from '../utils/transactionFilterParams';
import { contextDateWindow, useShowInAllTransactions } from '../hooks/useShowInAllTransactions';
import {
    GroupedTransactionsBody,
    PageDayGroupedRows,
    ActivityHeader,
    StickyScrollContainer,
    groupsUrlFor,
    idsUrlFor,
    withoutInvalid,
    FACET_FILTER_KEY,
    type GroupingMode,
    type GroupFacetSelection,
    type ReviewedOverlayEntry,
} from './tables/grouped';

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

// Small pill-style bulk-action button classes (replaces Chakra Button size="2xs" variant="outline"/"solid")
const BULK_ACTION_BASE = 'inline-flex items-center gap-1 px-2 py-1 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed';
const BULK_ACTION_OUTLINE: Record<string, string> = {
    gray: 'border border-slate-300 text-slate-700 hover:bg-slate-50',
    green: 'border border-green-300 text-green-700 hover:bg-green-50',
    yellow: 'border border-yellow-300 text-yellow-700 hover:bg-yellow-50',
    red: 'border border-red-300 text-red-700 hover:bg-red-50',
    teal: 'border border-teal-300 text-teal-700 hover:bg-teal-50',
    blue: 'border border-blue-300 text-blue-700 hover:bg-blue-50',
    orange: 'border border-orange-300 text-orange-700 hover:bg-orange-50',
    purple: 'border border-purple-300 text-purple-700 hover:bg-purple-50',
    cyan: 'border border-cyan-300 text-cyan-700 hover:bg-cyan-50',
};
const BULK_ACTION_SOLID: Record<string, string> = {
    gray: 'bg-slate-600 text-white hover:bg-slate-700',
    green: 'bg-green-600 text-white hover:bg-green-700',
    yellow: 'bg-yellow-500 text-white hover:bg-yellow-600',
    red: 'bg-red-600 text-white hover:bg-red-700',
    teal: 'bg-teal-600 text-white hover:bg-teal-700',
    blue: 'bg-blue-600 text-white hover:bg-blue-700',
    orange: 'bg-orange-600 text-white hover:bg-orange-700',
    purple: 'bg-purple-600 text-white hover:bg-purple-700',
    cyan: 'bg-cyan-600 text-white hover:bg-cyan-700',
};
const getBulkActionClass = (color: string | undefined, variant: string | undefined) => {
    if (variant === 'ghost') return 'text-slate-500 hover:text-slate-700';
    if (variant === 'solid') return BULK_ACTION_SOLID[color || 'gray'] || BULK_ACTION_SOLID.gray;
    return BULK_ACTION_OUTLINE[color || 'gray'] || BULK_ACTION_OUTLINE.gray;
};

const GROUPING_OPTIONS = [
    { mode: 'month-day', label: 'By month & day', Icon: LuCalendarDays, hint: 'Group transactions by month, then day' },
    { mode: 'off', label: 'Flat list', Icon: LuList, hint: 'Paginated list without date groups' },
] as const;

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
    /** Hide the direction/review legend bar */
    hideLegend?: boolean;
    /** Keep the column picker available when the legend/actions bar is hidden */
    showColumnPicker?: boolean;
    /** Pin the Date/Time column next to the checkbox on horizontal scroll */
    pinDateColumn?: boolean;
    /** Initial date grouping when the user has no saved preference (default: month-day) */
    defaultGrouping?: GroupingMode;
    /** Base currency symbol shown next to realized P&L in group recaps */
    baseCurrency?: string;
    /** Show invalid rows expanded instead of collapsed (e.g. spam review) */
    expandInvalidRows?: boolean;
    /** Highlight this transaction and scroll it into view once rendered */
    focusTransactionId?: number;
    /** Datetime of the focused transaction, so its month/day groups open */
    focusDateTime?: string;
    /** Open every month and day group on mount (review tables) */
    defaultExpandAllDays?: boolean;
    /** Row action next to the TX id showing the transaction among its neighbours: in All transactions, or 'locate' in this table */
    showInContext?: boolean | 'locate';

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
    defaultFiltersCollapsed = true,
    showBundles = true,
    showSuggestions = false,
    onDataChange,
    customApiUrl,
    hideLegend = false,
    showColumnPicker = false,
    pinDateColumn = false,
    defaultGrouping = 'month-day',
    baseCurrency,
    expandInvalidRows = false,
    focusTransactionId,
    focusDateTime,
    defaultExpandAllDays = false,
    showInContext = true,
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

    const withPluginDefaults = (v: VisibilityState): VisibilityState => {
        const next = { ...v };
        for (const col of additionalColumns) {
            if (col.defaultHidden && next[col.id] === undefined) next[col.id] = false;
        }
        return next;
    };

    // Load initial column visibility from prop, localStorage, or preset
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
        // Priority: prop > localStorage > preset
        if (initialVisibilityProp) {
            return initialVisibilityProp;
        }
        try {
            const stored = localStorage.getItem(visibilityStorageKey);
            const migrationKey = `${visibilityStorageKey}:accountsDefault`;
            const needsMigration = !localStorage.getItem(migrationKey);
            localStorage.setItem(migrationKey, '1');
            if (stored) {
                const parsed: VisibilityState = JSON.parse(stored);
                // One-time: From/To became a default column after users had saved prefs.
                if (needsMigration && !tableConfig.hiddenColumns?.includes('accounts')) parsed.accounts = true;
                return withPluginDefaults(parsed);
            }
        } catch { }
        // Fall back to preset-based visibility
        return withPluginDefaults(presetToVisibility(
            tableConfig.columnPreset,
            tableConfig.hiddenColumns,
            tableConfig.shownColumns
        ));
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
        const plugins = additionalColumns.filter(c => columnVisibility[c.id] !== false).length;
        // +2 for checkbox column and actions column (always visible)
        return keys.filter(k => columnVisibility[k] !== false).length + plugins + 2;
    }, [columnVisibility, additionalColumns]);

    // Visible plugin columns, with right offsets for the sticky ones (rightmost first).
    const visiblePlugins = useMemo(() => {
        const visible = additionalColumns.filter(c => columnVisibility[c.id] !== false);
        const statusShown = columnVisibility.status !== false && (!embeddedMode || showSelectionInEmbedded);
        let offset = (embeddedMode ? 0 : 50) + (statusShown ? 70 : 0);
        const offsets = new Map<string, number>();
        for (let i = visible.length - 1; i >= 0; i--) {
            const col = visible[i];
            if (col.sticky !== 'right') continue;
            offsets.set(col.id, offset);
            offset += parseInt(col.width || '80', 10);
        }
        const firstSticky = visible.find(c => offsets.has(c.id))?.id;
        return visible.map(c => offsets.has(c.id)
            ? { ...c, stickyOffset: offsets.get(c.id), stickyEdge: c.id === firstSticky }
            : c);
    }, [additionalColumns, columnVisibility, embeddedMode, showSelectionInEmbedded]);

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

    // Locate by id: highlighted row, optionally shown in a temporary context view when filtered out
    const [locate, setLocate] = useState<{ txId: number; dateTime: string | null; temp: boolean; nonce: number } | null>(null);
    const preLocateFiltersRef = useRef<TransactionFilterState | null>(null);
    const locateInputRef = useRef<HTMLInputElement>(null);
    const tableRootRef = useRef<HTMLDivElement>(null);
    const [locateInput, setLocateInput] = useState('');
    const effectiveFocusId = locate?.txId ?? focusTransactionId;
    const effectiveFocusDate = locate?.dateTime ?? focusDateTime;

    // Rows may arrive asynchronously (grouped server pages), so poll briefly for the focused row.
    useEffect(() => {
        if (effectiveFocusId == null) return;
        let tries = 0;
        const timer = window.setInterval(() => {
            const row = (tableRootRef.current ?? document).querySelector(`tr[data-tx-id="${effectiveFocusId}"]`);
            if (row || ++tries > 40) {
                window.clearInterval(timer);
                row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }, 250);
        return () => window.clearInterval(timer);
    }, [effectiveFocusId, locate?.nonce]);

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
        rawNetwork?: string | null;
        rawContract?: string | null;
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
        return !expandInvalidRows && tx.review_status === 'invalid' && !expandedInvalidIds.has(tx.id);
    }, [expandedInvalidIds, expandInvalidRows]);

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

    const groupingStorageKey = `txTable:${tableId}:grouping`;
    const [groupingMode, setGroupingMode] = useState<GroupingMode>(() => {
        const stored = localStorage.getItem(groupingStorageKey);
        return stored === 'off' || stored === 'month-day' ? stored : defaultGrouping;
    });
    useEffect(() => {
        try {
            localStorage.setItem(groupingStorageKey, groupingMode);
        } catch { }
    }, [groupingMode, groupingStorageKey]);
    const groupsUrl = useMemo(() => groupsUrlFor(customApiUrl), [customApiUrl]);
    const groupingActive = groupingMode !== 'off' && sortBy === 'date';
    const serverGrouping = groupingActive && !embeddedMode && !!groupsUrl;
    const pageGrouping = groupingActive && !serverGrouping;
    const filterParams = useMemo(() => buildTransactionFilterParams(filters), [filterKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const [showInvalidGroups, setShowInvalidGroups] = useState(expandInvalidRows);
    const [excludedInvalidCount, setExcludedInvalidCount] = useState<number | null>(null);
    const canHideInvalidGroups = serverGrouping && withoutInvalid(filterParams) !== null;

    // TanStack Query for transactions - use stable string key to avoid reference issues
    const { data: transactionResponse, isLoading: loading, error: queryError, refetch: refetchTransactions } = useQuery({
        queryKey: ['transactions', 'with-metadata', filterKey, pagination.page, pagination.pageSize, sortBy, sortDir, customApiUrl],
        enabled: !serverGrouping,
        queryFn: async () => {
            const params = buildTransactionFilterParams(filters);

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

    const [groupRows, setGroupRows] = useState<Map<string, Transaction[]>>(() => new Map());
    const handleGroupRowsLoaded = useCallback((key: string, rows: Transaction[] | null) => {
        setGroupRows(prev => {
            if (rows === null) {
                if (!prev.has(key)) return prev;
                const next = new Map(prev);
                next.delete(key);
                return next;
            }
            if (prev.get(key) === rows) return prev;
            const next = new Map(prev);
            next.set(key, rows);
            return next;
        });
    }, []);
    const loadedGroupRows = useMemo(() => [...groupRows.values()].flat(), [groupRows]);
    const transactions = serverGrouping ? loadedGroupRows : (transactionResponse?.results || []);

    // Inbox triage: rows just marked reviewed stay visible (grayed, with Undo) until refresh.
    const isInbox = defaultWorkflowFilter === 'pending';
    const [reviewedOverlay, setReviewedOverlay] = useState<Map<number, ReviewedOverlayEntry>>(() => new Map());
    const addReviewedOverlay = useCallback((txs: Transaction[], newStatus: string) => {
        setReviewedOverlay(prev => {
            const next = new Map(prev);
            txs.forEach(tx => next.set(tx.id, { tx, previousStatus: tx.review_status || 'pending', newStatus }));
            return next;
        });
    }, []);
    useEffect(() => {
        setReviewedOverlay(new Map());
    }, [filterKey]);
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
        ...additionalColumns.map(col => ({ id: col.id, accessorFn: () => null, enableSorting: false })),
    ], [additionalColumns]);

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
        { value: 'neutral', label: '↔' }
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

        const selectedTxsForDefaults = transactions.filter(tx => selectedIds.has(tx.id));
        const getSymbolForDefaults = (tx: Transaction) => tx.linked_asset?.symbol || tx.source_asset_symbol || '?';
        const uniqueAssetSymbols = [...new Set(selectedTxsForDefaults.map(getSymbolForDefaults))];

        setBundleCreateDefaults({
            pattern,
            label: generateBundleLabel(pattern, selectedIds),
            transactionIds: Array.from(selectedIds),
            selectedAssetSymbols: uniqueAssetSymbols,
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
            if (isInbox && serverGrouping && status !== 'pending') {
                addReviewedOverlay(transactions.filter(tx => selectedIds.has(tx.id)), status);
            }
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

    const bulkClearAccounts = async () => {
        if (selectedIds.size === 0) return;
        setBulkActionLoading(true);
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction_ids: Array.from(selectedIds),
                    clear_from_account: true,
                    clear_to_account: true,
                }),
            });
            if (!response.ok) throw new Error('Failed to clear accounts');
            const result = await response.json();
            toaster.success({ title: 'Cleared', description: `From/To accounts cleared on ${result.affected_count} transaction(s)` });
            invalidateTransactionData();
            onDataChange?.();
            setSelectedIds(new Set());
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to clear accounts' });
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

    // Row background is consumed as a literal CSS color by TransactionTableRow (via inline style),
    // since that component no longer depends on Chakra design tokens.
    const getRowBgColor = (tx: Transaction) => {
        if (selectedIds.has(tx.id)) return '#dbeafe'; // blue-100
        if (tx.id === effectiveFocusId) return '#fef9c3'; // yellow-100
        // Highlight sibling rows when hovering a suggestion indicator
        if (hoveredSuggestionGroup !== null && showSuggestions) {
            const entry = suggestionMap.get(tx.id);
            if (entry && entry.groupIndex === hoveredSuggestionGroup) return '#f0fdfa'; // teal-50
        }
        // Highlight sibling rows when hovering a bundle membership indicator
        if (hoveredBundleId !== null && tx.user_calculation_unit_id === hoveredBundleId) return '#faf5ff'; // purple-50
        // Highlight sibling rows when hovering a duplicate indicator
        if (hoveredDuplicateGroup !== null) {
            const dupEntry = duplicateMap.get(tx.id);
            if (dupEntry && dupEntry.groupIndex === hoveredDuplicateGroup) return '#fef2f2'; // red-50
        }
        // Status is carried by the left band and direction by the Dir column; only de-emphasize invalid rows.
        if (tx.review_status === 'invalid') return '#f8fafc'; // slate-50, lighter than day headers (slate-100)
        return '#ffffff';
    };

    // Review status → bottom border color (literal hex, consumed via inline style)
    const getRowBorderColor = (tx: Transaction) => {
        const reviewStatusBorderColors: Record<string, string> = {
            pending: '#eab308', // yellow-500
            valid: '#22c55e', // green-500
            invalid: '#ef4444', // red-500
        };
        return reviewStatusBorderColors[tx.review_status || 'pending'] || '#cbd5e1';
    };

    const currentPageIds = paginatedTransactions.map(tx => tx.id);
    const allCurrentPageSelected = currentPageIds.length > 0 && currentPageIds.every(id => selectedIds.has(id));

    // Helper to render sortable column header
    const renderSortableHeader = (columnId: string, label: string, minWClassName?: string, extraClassName?: string) => {
        const column = tanstackTable.getColumn(columnId);
        const isSorted = column?.getIsSorted();

        return (
            <th
                className={cn('cursor-pointer select-none hover:bg-slate-200', minWClassName, extraClassName)}
                onClick={() => column?.toggleSorting()}
            >
                <div className="flex items-center gap-1">
                    <span>{label}</span>
                    {isSorted === 'asc' && <LuArrowUp size={10} />}
                    {isSorted === 'desc' && <LuArrowDown size={10} />}
                    {!isSorted && <LuArrowUpDown size={10} style={{ opacity: 0.3 }} />}
                </div>
            </th>
        );
    };

    const handleRefresh = () => {
        setReviewedOverlay(new Map());
        refetchTransactions();
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
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

    const showInAllTransactions = useShowInAllTransactions();
    const handleLocateRef = useRef<(txId: number) => void>(() => { });
    const rowActions = useMemo<RowAction[]>(() => {
        const extra = additionalRowActions as RowAction[];
        if (!showInContext || extra.some(a => a.id === 'show-in-context')) return extra;
        const action: RowAction = {
            id: 'show-in-context',
            icon: <LuLocateFixed size={11} />,
            label: 'Show in context (All transactions around this one)',
            placement: 'id',
            colorPalette: 'blue',
            onClick: (tx: Transaction) => {
                if (showInContext === 'locate') handleLocateRef.current(tx.id);
                else showInAllTransactions(tx.id, tx.date_time);
            },
        };
        return [action, ...extra];
    }, [additionalRowActions, showInContext, showInAllTransactions]);

    const renderRow = (tx: Transaction) => (
        <TransactionTableRow
            key={tx.id}
            tx={tx}
            suggestionEntry={showSuggestions ? suggestionMap.get(tx.id) : undefined}
            duplicateEntry={duplicateMap.get(tx.id)}
            rowBgColor={getRowBgColor(tx)}
            isFocused={tx.id === effectiveFocusId || (isDrawerOpen && tx.id === drawerTransactionId)}
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
            additionalColumns={visiblePlugins as ColumnPlugin[]}
            pinDate={pinDateColumn}
            additionalRowActions={rowActions}
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
            dateMode={serverGrouping ? 'time' : 'full'}
        />
    );

    const applyFacetsGlobally = (selection: GroupFacetSelection) => {
        const next = { ...filters };
        (Object.keys(selection) as (keyof typeof FACET_FILTER_KEY)[]).forEach(key => {
            const values = selection[key];
            if (values && values.length > 0) next[FACET_FILTER_KEY[key]] = values;
        });
        setFilters(next);
    };

    const markGroupReviewed = async (ids: number[]) => {
        if (ids.length === 0) return;
        try {
            const response = await fetch(`${API_URL}/transactions/bulk/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: ids, review_status: 'valid' }),
            });
            if (!response.ok) throw new Error('Failed to update transactions');
            const idSet = new Set(ids);
            addReviewedOverlay(transactions.filter(tx => idSet.has(tx.id) && tx.review_status === 'pending'), 'valid');
            toaster.success({ title: 'Marked as valid', description: `${ids.length} transaction(s) marked valid` });
            invalidateTransactionData();
            refreshHealthData();
            onDataChange?.();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to update' });
        }
    };

    const undoReviewed = async (id: number) => {
        const entry = reviewedOverlay.get(id);
        if (!entry) return;
        try {
            const response = await fetch(`${API_URL}/transactions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ review_status: entry.previousStatus }),
            });
            if (!response.ok) throw new Error('Failed to undo');
            setReviewedOverlay(prev => {
                const next = new Map(prev);
                next.delete(id);
                return next;
            });
            invalidateTransactionData();
            refreshHealthData();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to undo' });
        }
    };

    const filtersPanel = (
        <TransactionFilters
            filters={filters}
            onChange={setFilters}
            onClear={() => setFilters(effectiveResetFilters)}
            expanded={filtersExpanded}
            onExpandedChange={setFiltersExpanded}
            appliedFilters={appliedFilters}
            filterMetadata={filterMetadata}
            resetFilters={effectiveResetFilters}
            className={embeddedMode ? undefined : ''}
        />
    );

    const columnPicker = (
        <ColumnVisibilityPopover
            table={tanstackTable}
            onReset={() => {
                setColumnVisibility(withPluginDefaults(presetToVisibility(
                    tableConfig.columnPreset,
                    tableConfig.hiddenColumns,
                    tableConfig.shownColumns
                )));
            }}
            size="xs"
            extraColumns={additionalColumns.map(c => ({ id: c.id, label: c.header }))}
            extraGroupLabel="P&L"
        />
    );

    const handleLocate = async (txId: number) => {
        setDrawerTransactionId(txId);
        setIsDrawerOpen(true);
        if (customApiUrl) {
            setLocate({ txId, dateTime: null, temp: false, nonce: Date.now() });
            return;
        }
        let info: { date_time: string | null; review_status: string; matches_filters: boolean; index: number | null };
        try {
            const res = await fetch(`${API_URL}/transactions/locate/${txId}?${filterParams.toString()}&sort_dir=${sortDir}`);
            if (res.status === 404) {
                toaster.error({ title: 'Not found', description: `Transaction #${txId} does not exist` });
                setIsDrawerOpen(false);
                return;
            }
            if (!res.ok) throw new Error('Failed to locate transaction');
            info = await res.json();
        } catch (err) {
            toaster.error({ title: 'Error', description: err instanceof Error ? err.message : 'Failed to locate transaction' });
            return;
        }
        if (info.review_status === 'invalid') {
            setShowInvalidGroups(true);
            setExpandedInvalidIds(prev => new Set(prev).add(txId));
        }
        if (info.matches_filters) {
            if (!serverGrouping && sortBy === 'date' && info.index != null) {
                pagination.setPage(Math.floor(info.index / pagination.pageSize) + 1);
            }
            setLocate(prev => ({ txId, dateTime: info.date_time, temp: prev?.temp ?? false, nonce: Date.now() }));
            return;
        }
        // Hidden by the current filters: temporary view around it; "Back" restores the user's filters.
        if (!locate?.temp) preLocateFiltersRef.current = filters;
        const dateWindow = contextDateWindow(info.date_time);
        setFilters({
            ...effectiveResetFilters,
            reviewStatus: [],
            ...(dateWindow ? { dateFrom: dateWindow.dateFrom, dateTo: dateWindow.dateTo } : {}),
        });
        setLocate({ txId, dateTime: info.date_time, temp: true, nonce: Date.now() });
    };

    handleLocateRef.current = handleLocate;

    const [slidePanelEl, setSlidePanelEl] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setSlidePanelEl(tableRootRef.current?.closest<HTMLElement>('[data-slide-panel]') ?? null);
    }, []);

    const exitLocate = () => {
        if (locate?.temp && preLocateFiltersRef.current) setFilters(preLocateFiltersRef.current);
        preLocateFiltersRef.current = null;
        setLocate(null);
    };

    // Ctrl/Cmd+G focuses the locate box (main tables only)
    useEffect(() => {
        if (embeddedMode) return;
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
                e.preventDefault();
                locateInputRef.current?.focus();
                locateInputRef.current?.select();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [embeddedMode]);

    // Prev/next follow the rows as displayed (works for grouped and flat layouts)
    const displayedRowIds = (): number[] =>
        Array.from(tableRootRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-tx-id]') ?? [])
            .map(r => Number(r.dataset.txId));
    const [drawerNeighbors, setDrawerNeighbors] = useState({ prev: false, next: false });
    useEffect(() => {
        if (!isDrawerOpen || drawerTransactionId == null) return;
        const ids = displayedRowIds();
        const i = ids.indexOf(drawerTransactionId);
        setDrawerNeighbors({ prev: i > 0, next: i >= 0 && i < ids.length - 1 });
    }, [isDrawerOpen, drawerTransactionId, transactions]);
    const navigateDrawer = (direction: -1 | 1) => {
        const ids = displayedRowIds();
        const i = drawerTransactionId == null ? -1 : ids.indexOf(drawerTransactionId);
        const nextId = i < 0 ? undefined : ids[i + direction];
        if (nextId == null) return;
        setDrawerTransactionId(nextId);
        tableRootRef.current?.querySelector(`tr[data-tx-id="${nextId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };

    const locateBox = !embeddedMode && (
        <form
            className="ml-auto flex items-center gap-1"
            onSubmit={(e) => {
                e.preventDefault();
                const id = parseInt(locateInput.replace('#', '').trim(), 10);
                if (id) { handleLocate(id); setLocateInput(''); }
            }}
        >
            <LuLocateFixed size={14} className="text-slate-400" />
            <input
                ref={locateInputRef}
                value={locateInput}
                onChange={(e) => setLocateInput(e.target.value)}
                placeholder="Locate #id"
                aria-label="Locate transaction by id"
                title="Locate a transaction by id (Ctrl/Cmd+G)"
                inputMode="numeric"
                className="h-7 w-28 border border-slate-300 bg-white px-2 text-sm focus:border-blue-400 focus:outline-none"
            />
            {locate && !locate.temp && (
                <button type="button" className="text-slate-400 hover:text-slate-700" title="Clear highlight" onClick={exitLocate}>
                    <LuX size={14} />
                </button>
            )}
        </form>
    );

    const groupingBar = (
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-3 py-2">
            <div className="inline-flex border border-slate-300 bg-slate-100 p-0.5" role="group" aria-label="Transactions layout">
                {GROUPING_OPTIONS.map(({ mode, label, Icon, hint }) => (
                    <button
                        key={mode}
                        type="button"
                        aria-pressed={groupingMode === mode}
                        title={hint}
                        onClick={() => setGroupingMode(mode)}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3 py-1 text-sm transition-colors',
                            groupingMode === mode
                                ? 'bg-white font-medium text-blue-700 shadow-sm'
                                : 'text-slate-600 hover:text-slate-900',
                        )}
                    >
                        <Icon size={15} /> {label}
                    </button>
                ))}
            </div>
            {groupingMode !== 'off' && sortBy !== 'date' && (
                <button
                    type="button"
                    className="text-xs text-amber-700 hover:text-blue-600"
                    title="Date grouping needs date sorting"
                    onClick={() => setSorting([{ id: 'date', desc: true }])}
                >
                    Grouping paused (sorted by {sortBy}) · sort by date
                </button>
            )}
            {locateBox}
        </div>
    );

    const tableActions = (
        <>
            {columnPicker}
            <Button
                onClick={error ? handleRetry : handleReset}
                variant="outline"
                colorScheme={error ? "red" : "gray"}
                size="xs"
            >
                {error ? "🔄 Retry" : "↺ Reset"}
            </Button>
            <Button
                onClick={() => handleRefresh()}
                variant="outline"
                size="xs"
            >
                🔄 Refresh
            </Button>
        </>
    );

    const invalidControl = serverGrouping ? (
        canHideInvalidGroups && (showInvalidGroups || !!excludedInvalidCount) && (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <LuBan size={12} className="text-slate-400" />
                {showInvalidGroups ? 'Rejected shown' : `${excludedInvalidCount} rejected hidden`}
                <button
                    type="button"
                    className="inline-flex items-center gap-0.5 border border-slate-200 bg-white px-1.5 py-px text-slate-700 hover:bg-slate-50"
                    onClick={() => setShowInvalidGroups(v => !v)}
                >
                    {showInvalidGroups ? <><LuMinus size={12} /> Hide</> : <><LuPlus size={12} /> Show</>}
                </button>
            </span>
        )
    ) : (
        totalInvalidCount > 0 && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
                <Badge colorScheme="red">
                    <LuX size={10} />
                    {totalInvalidCount} rejected
                </Badge>
                {collapsedInvalidCount > 0 ? (
                    <button
                        type="button"
                        onClick={expandAllInvalid}
                        title="Expand all rejected rows"
                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600"
                    >
                        <LuPlus size={12} /> Show
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={collapseAllInvalid}
                        title="Collapse all rejected rows"
                        className="flex items-center gap-1 text-xs text-slate-500 hover:text-red-600"
                    >
                        <LuMinus size={12} /> Hide
                    </button>
                )}
            </div>
        )
    );

    const tableContent = (
        <>
            {!embeddedMode && !hideLegend && groupingBar}
            {!embeddedMode && hideLegend && locateBox && <div className="flex px-3 py-1">{locateBox}</div>}
            {locate?.temp && (
                <div className="mx-3 my-2 flex items-center gap-2 border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    <LuLocateFixed size={12} />
                    <span>
                        <b>#{locate.txId}</b> is hidden by your filters. Showing a temporary view around it (all statuses, ±3 days).
                    </span>
                    <button type="button" className="ml-auto flex items-center gap-1 font-medium text-amber-700 hover:text-amber-900" onClick={exitLocate}>
                        <LuX size={12} /> Back to my filters
                    </button>
                </div>
            )}

            {/* Top Pagination - show when more than 15 transactions */}
            {!loading && !error && !embeddedMode && !serverGrouping && (filterMetadata?.filtered_count ?? 0) > 15 && (
                <div className="mb-2">
                    <TablePagination
                        pagination={pagination}
                        total={filterMetadata?.filtered_count ?? 0}
                    />
                </div>
            )}

            {/* Error state for transactions */}
            {error && (
                <div className="mb-4 border border-red-200 bg-red-50 py-6 text-center">
                    <span className="block font-bold text-red-600">Error loading transactions</span>
                    <span className="block text-sm text-red-600">{error}</span>
                    <Button className="mt-3" onClick={handleRetry} colorScheme="gray" size="sm">
                        🔄 Retry
                    </Button>
                </div>
            )}

            {/* Loading overlay for transactions */}
            {loading && !error && (
                <div className="mb-4 bg-slate-50 py-10 text-center">
                    <Spinner size="lg" className="text-blue-500" />
                    <span className="mt-4 block">Loading transactions...</span>
                </div>
            )}



            {/* Transaction table - only show when not loading or erroring */}
            {!loading && !error && (
                <StickyScrollContainer className={cn('relative overflow-x-auto bg-white text-xs', embeddedMode ? 'border border-slate-200 shadow-sm' : 'max-h-[75vh] overflow-y-auto')}>
                    <table className="w-full">
                        <thead className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 [&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:bg-slate-100 [&_th]:py-1.5">
                            <tr>
                                <th className="sticky left-0 z-10 min-w-[50px] border-r-2 border-slate-300 bg-slate-100">
                                    {(!embeddedMode || showSelectionInEmbedded) && (
                                        <input
                                            type="checkbox"
                                            title="Select all on page"
                                            className="h-3.5 w-3.5 cursor-pointer accent-blue-500"
                                            checked={allCurrentPageSelected}
                                            onChange={toggleSelectAll}
                                        />
                                    )}
                                </th>
                                {showColumn('id') && renderSortableHeader('id', 'ID')}
                                {showColumn('date') && renderSortableHeader('date', 'Date/Time', undefined, pinDateColumn ? 'pr-1 sticky left-[50px] z-30 border-r border-slate-300' : 'pr-1')}
                                {showColumn('source') && renderSortableHeader('source', 'Source Info', 'min-w-[180px]', 'pr-1')}
                                {showColumn('accounts') && <th className="w-[130px]">From / To</th>}
                                {showColumn('direction') && renderSortableHeader('direction', 'Dir')}
                                {showColumn('type') && renderSortableHeader('type', 'Type')}
                                {showColumn('asset') && renderSortableHeader('asset', 'Asset', 'min-w-[60px]')}
                                {showColumn('qty') && renderSortableHeader('qty', 'Qty')}
                                {showColumn('price') && renderSortableHeader('price', 'Price')}
                                {showColumn('total') && <th>Total</th>}
                                {showColumn('fee') && renderSortableHeader('fee', 'Fee')}
                                {showColumn('taxability') && <th>Taxable</th>}
                                {showColumn('feeInBase') && <th>Include Fee</th>}
                                {showColumn('bundle') && <th>Bundle</th>}
                                {showColumn('tags') && <th>Tags</th>}
                                {showColumn('sourceTransactionId') && <th>Source Tx ID</th>}
                                {/* Additional plugin columns */}
                                {visiblePlugins.map(col => (
                                    <th
                                        key={col.id}
                                        className={cn(col.stickyOffset != null && 'z-30', col.stickyEdge && 'border-l-2 border-slate-300')}
                                        style={{
                                            width: col.width,
                                            minWidth: col.stickyOffset != null ? col.width : undefined,
                                            ...(col.stickyOffset != null ? { position: 'sticky', right: col.stickyOffset } : {}),
                                            ...(col.headerBg ? { backgroundColor: col.headerBg } : {}),
                                        }}
                                    >
                                        <span className="inline-flex items-center gap-0.5">
                                            {col.header}
                                            {col.info && <InfoTip text={col.info} />}
                                        </span>
                                    </th>
                                ))}
                                {showColumn('status') && (!embeddedMode || showSelectionInEmbedded) && renderSortableHeader('status', 'Status', undefined, 'sticky right-[50px] z-10 w-[1%] whitespace-nowrap border-l-2 border-slate-300 bg-slate-100 px-1')}
                                {!embeddedMode && <th className="sticky right-0 z-10 min-w-[50px] bg-slate-100 px-0" />}
                            </tr>
                        </thead>
                        <tbody>
                            {serverGrouping && groupsUrl ? (
                                <GroupedTransactionsBody
                                    key={effectiveFocusId ?? 'no-focus'}
                                    focusDate={effectiveFocusDate}
                                    defaultExpandAll={defaultExpandAllDays}
                                    groupsUrl={groupsUrl}
                                    listUrl={(customApiUrl || `${API_URL}/transactions`)}
                                    idsUrl={idsUrlFor(customApiUrl)}
                                    params={filterParams}
                                    sortDir={sortDir}
                                    colSpan={visibleColumnCount}
                                    selectable={!embeddedMode || showSelectionInEmbedded}
                                    renderRow={renderRow}
                                    onRowsLoaded={handleGroupRowsLoaded}
                                    selectedIds={selectedIds}
                                    setSelectedIds={setSelectedIds}
                                    onApplyFacetsGlobally={applyFacetsGlobally}
                                    onMarkGroupReviewed={isInbox ? markGroupReviewed : undefined}
                                    reviewedOverlay={reviewedOverlay}
                                    onUndoReviewed={undoReviewed}
                                    emptyMessage={emptyMessage}
                                    baseCurrency={baseCurrency}
                                    hideInvalid={!showInvalidGroups}
                                    onExcludedInvalidCount={setExcludedInvalidCount}
                                />
                            ) : paginatedTransactions.length === 0 ? (
                                <tr>
                                    <td colSpan={visibleColumnCount}>
                                        <span className="block py-8 text-center text-slate-500">
                                            {emptyMessage || 'No transactions found'}
                                        </span>
                                    </td>
                                </tr>
                            ) : (
                                pageGrouping ? (
                                    <PageDayGroupedRows transactions={paginatedTransactions} colSpan={visibleColumnCount} renderRow={renderRow} />
                                ) : (
                                    paginatedTransactions.map(tx => renderRow(tx))
                                )
                            )}
                        </tbody>
                    </table>
                </StickyScrollContainer>
            )}

            {/* Pagination Controls - show even when loading/error */}
            {!loading && !error && !embeddedMode && !serverGrouping && (
                <TablePagination
                    pagination={pagination}
                    total={filterMetadata?.filtered_count ?? 0}
                />
            )}
        </>
    );

    return (
        <div ref={tableRootRef} className="pb-0" style={selectedIds.size > 0 && !embeddedMode ? { paddingBottom: '48px' } : undefined}>
            {!embeddedMode && (title || subtitle) && (
                <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-2">
                    <div>
                        <h2 className="mb-1 text-lg font-semibold">{title}</h2>
                        <span className="block text-sm text-slate-600">{subtitle}</span>
                    </div>
                </div>
            )}

            {/* Floating Bulk Actions Bar - pinned to the viewport bottom, or to the bottom of the enclosing slide panel */}
            {selectedIds.size > 0 && !embeddedMode && createPortal(
                <div
                    className={cn(
                        'inset-x-0 bottom-0 animate-slide-up border-t border-slate-200 bg-white/85 shadow-[0_-2px_8px_rgba(0,0,0,0.08)] backdrop-blur-sm',
                        slidePanelEl ? 'absolute z-[3]' : 'fixed z-[1000]',
                    )}
                >
                    <div className="mx-auto max-w-[1400px] px-4 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-1.5">
                            <span className="text-sm font-semibold text-blue-700">
                                {selectedIds.size} selected
                            </span>
                            <div className="flex flex-wrap items-center gap-1">
                                {/* Additional bulk actions from plugins (rendered first) */}
                                {additionalBulkActions
                                    .filter(action => !action.isVisible || action.isVisible(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[]))
                                    .map(action => (
                                        <button
                                            key={action.id}
                                            type="button"
                                            className={cn(BULK_ACTION_BASE, getBulkActionClass(action.colorPalette, action.variant))}
                                            onClick={() => action.onClick(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[])}
                                            disabled={bulkActionLoading || (action.isDisabled ? action.isDisabled(Array.from(selectedIds), paginatedTransactions.filter(tx => selectedIds.has(tx.id)) as T[]) : false)}
                                        >
                                            {action.icon} {action.label}
                                        </button>
                                    ))}
                                {additionalBulkActions.length > 0 && (
                                    <div className="mx-0.5 h-4 border-l border-slate-300" />
                                )}

                                {/* Quick Status Actions */}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.green)}
                                    onClick={() => bulkUpdateStatus('valid')}
                                    disabled={bulkActionLoading}
                                >
                                    ✓ Valid
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.yellow)}
                                    onClick={() => bulkUpdateStatus('pending')}
                                    disabled={bulkActionLoading}
                                >
                                    ⏳ Pending
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.red)}
                                    onClick={() => bulkUpdateStatus('invalid')}
                                    disabled={bulkActionLoading}
                                >
                                    ✗ Rejected
                                </button>

                                <div className="mx-0.5 h-4 border-l border-slate-300" />

                                {/* Taxability Actions */}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.teal)}
                                    onClick={() => bulkUpdateTaxability('taxable')}
                                    disabled={bulkActionLoading}
                                    title="Set taxability to Taxable"
                                >
                                    💰 Taxable
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.gray)}
                                    onClick={() => bulkUpdateTaxability('non_taxable')}
                                    disabled={bulkActionLoading}
                                    title="Set taxability to Non-Taxable"
                                >
                                    🚫 Non-Tax
                                </button>

                                <div className="mx-0.5 h-4 border-l border-slate-300" />

                                {/* Include Fee Actions */}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.blue)}
                                    onClick={() => bulkUpdateIncludeFee(true)}
                                    disabled={bulkActionLoading}
                                    title="Include fee in cost basis/proceeds"
                                >
                                    Fee ✓
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.gray)}
                                    onClick={() => bulkUpdateIncludeFee(false)}
                                    disabled={bulkActionLoading}
                                    title="Exclude fee from cost basis/proceeds"
                                >
                                    Fee ✗
                                </button>

                                <div className="mx-0.5 h-4 border-l border-slate-300" />

                                {/* Quick Bundle Actions */}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.orange)}
                                    onClick={() => openBundleDialog('swap')}
                                    disabled={bulkActionLoading}
                                >
                                    🔄 Swap
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.blue)}
                                    onClick={() => openBundleDialog('internal_transfer')}
                                    disabled={bulkActionLoading}
                                >
                                    ↔ Transfer
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.purple)}
                                    onClick={() => openBundleDialog('custom')}
                                    disabled={bulkActionLoading}
                                >
                                    📦 Bundle
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.gray)}
                                    onClick={bulkUnbundle}
                                    disabled={bulkActionLoading}
                                    title="Remove selected transactions from their bundles"
                                >
                                    🔓 Unbundle
                                </button>

                                <div className="mx-0.5 h-4 border-l border-slate-300" />

                                {/* Other Actions */}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.purple)}
                                    onClick={() => setShowBulkTypeDialog(true)}
                                >
                                    🏷️ Type
                                </button>
                                {hasUnlinkedFields && (
                                    <button
                                        type="button"
                                        className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.cyan)}
                                        onClick={autoLinkHighConfidence}
                                        disabled={bulkActionLoading}
                                        title="Auto-link accounts and assets with ≥95% confidence match"
                                    >
                                        🔗 Auto-Link
                                    </button>
                                )}
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.orange)}
                                    onClick={bulkClearAccounts}
                                    disabled={bulkActionLoading}
                                    title="Clear From/To account links on selected transactions"
                                >
                                    ✕ Accounts
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, BULK_ACTION_OUTLINE.red)}
                                    onClick={() => {
                                        fetchDeletionImpact(Array.from(selectedIds));
                                        setShowBulkDeleteDialog(true);
                                    }}
                                >
                                    🗑️ Delete
                                </button>
                                <button
                                    type="button"
                                    className={cn(BULK_ACTION_BASE, 'text-slate-500 hover:text-slate-700')}
                                    onClick={() => setSelectedIds(new Set())}
                                >
                                    ✕ Clear
                                </button>
                            </div>
                        </div>
                    </div>
                </div>,
                slidePanelEl ?? document.body
            )}

            {/* Transactions content */}
            <div className={cn(!embeddedMode && 'flex flex-col gap-4')}>
                {showFilters && (embeddedMode ? (
                    <div className="mb-2">{filtersPanel}</div>
                ) : (
                    <PageSection icon={<LuFilter size={14} />} title="Filters" bodyClassName="p-3">
                        {filtersPanel}
                    </PageSection>
                ))}

                {serverGrouping && groupsUrl && showFilters && !hideLegend && (
                    <ActivityHeader
                        groupsUrl={groupsUrl}
                        params={filterParams}
                        dateFrom={filters.dateFrom}
                        dateTo={filters.dateTo}
                        onSelectRange={(from, to) => setFilters({ ...filters, dateFrom: from, dateTo: to })}
                    />
                )}

                {embeddedMode ? tableContent : (
                    <PageSection
                        icon={<LuList size={14} />}
                        title="Transactions"
                        meta={invalidControl}
                        actions={hideLegend ? (showColumnPicker ? columnPicker : undefined) : tableActions}
                    >
                        {tableContent}
                    </PageSection>
                )}
            </div>

            {/* Bulk Set Type Dialog */}
            <RadixDialog.Root open={showBulkTypeDialog} onOpenChange={(open) => setShowBulkTypeDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 p-4">
                            <RadixDialog.Title className="text-base font-semibold">Set Transaction Type for Selected</RadixDialog.Title>
                        </div>
                        <div className="p-4">
                            <span className="mb-4 block">
                                Set transaction type for {selectedIds.size} transaction(s)
                            </span>
                            <ComboSelect
                                value={bulkType}
                                onChange={val => setBulkType(val)}
                                options={TRANSACTION_TYPE_OPTIONS}
                                placeholder="Select transaction type..."
                                width="100%"
                            />
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => { setShowBulkTypeDialog(false); setBulkType(''); }}>
                                Cancel
                            </Button>
                            <Button colorScheme="gray" className="bg-purple-600 text-white hover:bg-purple-700" onClick={bulkUpdateType} disabled={bulkActionLoading || !bulkType}>
                                {bulkActionLoading ? 'Updating...' : 'Apply Type'}
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
                        <div className="border-b border-slate-200 p-4">
                            <RadixDialog.Title className="text-base font-semibold">Delete Selected Transactions</RadixDialog.Title>
                        </div>
                        <div className="p-4">
                            <span className="mb-2 block font-bold text-red-600">
                                ⚠️ Warning: This action cannot be undone!
                            </span>
                            <span className="mb-4 block">
                                Are you sure you want to delete {selectedIds.size} transaction(s)?
                            </span>
                            <span className="block text-sm text-slate-500">
                                IDs: {Array.from(selectedIds).slice(0, 10).join(', ')}
                                {selectedIds.size > 10 && ` ... and ${selectedIds.size - 10} more`}
                            </span>

                            {isImpactLoading ? (
                                <div className="mt-4 flex items-center gap-2">
                                    <Spinner size="xs" />
                                    <span className="text-xs text-slate-500">Checking for linked data...</span>
                                </div>
                            ) : Object.keys(deletionImpact).length > 0 && (
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
                                        This data is linked to these transaction(s) and will be removed due to cascade deletion.
                                    </span>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowBulkDeleteDialog(false)}>
                                Cancel
                            </Button>
                            <Button colorScheme="red" onClick={bulkDelete} disabled={bulkActionLoading}>
                                {bulkActionLoading ? 'Deleting...' : `Delete ${selectedIds.size} Transaction(s)`}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Delete Single Transaction Dialog */}
            <RadixDialog.Root
                open={showDeleteDialog}
                onOpenChange={(open) => {
                    setShowDeleteDialog(open);
                    if (!open) {
                        setTransactionToDelete(null);
                        setDeletionImpact({});
                    }
                }}
            >
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] w-full max-w-[480px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 p-4">
                            <RadixDialog.Title className="text-base font-semibold">Delete Transaction</RadixDialog.Title>
                        </div>
                        <div className="p-4">
                            <span className="mb-2 block font-bold text-red-600">
                                ⚠️ Warning: This action cannot be undone!
                            </span>
                            <span className="mb-4 block">
                                Are you sure you want to delete this transaction?
                            </span>
                            {transactionToDelete && (
                                <div className="bg-slate-50 p-3">
                                    <span className="block text-sm"><strong>ID:</strong> {transactionToDelete.id}</span>
                                    <span className="block text-sm"><strong>Date:</strong> {formatDateTimeCompact(transactionToDelete.date_time)}</span>
                                    <span className="block text-sm"><strong>Type:</strong> {transactionToDelete.transaction_type}</span>
                                    <span className="block text-sm"><strong>Quantity:</strong> {transactionToDelete.quantity} {transactionToDelete.source_asset_symbol}</span>
                                </div>
                            )}

                            {isImpactLoading ? (
                                <div className="mt-4 flex items-center gap-2">
                                    <Spinner size="xs" />
                                    <span className="text-xs text-slate-500">Checking for linked data...</span>
                                </div>
                            ) : Object.keys(deletionImpact).length > 0 && (
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
                                        This data is linked to this transaction and will be removed due to cascade deletion.
                                    </span>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-3 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
                                Cancel
                            </Button>
                            <Button colorScheme="red" onClick={handleDeleteTransaction} disabled={bulkActionLoading}>
                                {bulkActionLoading ? 'Deleting...' : 'Delete Transaction'}
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* CSV Import Dialog */}
            <RadixDialog.Root open={showImportDialog} onOpenChange={(open) => setShowImportDialog(open)}>
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2500] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2500] max-h-[85vh] w-full max-w-[900px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-slate-200 p-4">
                            <RadixDialog.Title className="text-base font-semibold">Import Trades from CSV</RadixDialog.Title>
                        </div>
                        <div className="p-4">
                            {importStep === 'select' && (
                                <div>
                                    <span className="mb-4 block">
                                        Upload a CSV file with trades to import. The file should have columns for:
                                        Date, Transaction Type, Asset, Quantity, Unit Price, Trading Fees, Investment Account.
                                    </span>
                                    <div
                                        className={cn(
                                            'cursor-pointer border-2 border-dashed border-slate-300 p-8 text-center hover:border-teal-400 hover:bg-teal-50',
                                            importFile ? 'bg-green-50' : 'bg-slate-50',
                                        )}
                                        onDrop={handleFileDrop}
                                        onDragOver={(e) => e.preventDefault()}
                                        onClick={() => fileInputRef.current?.click()}
                                    >
                                        <input
                                            type="file"
                                            accept=".csv"
                                            title="Select CSV file to import"
                                            onChange={handleFileSelect}
                                            ref={fileInputRef}
                                            style={{ display: 'none' }}
                                        />
                                        {importFile ? (
                                            <div>
                                                <span className="block font-bold text-green-600">✓ {importFile.name}</span>
                                                <span className="block text-sm text-slate-500">{(importFile.size / 1024).toFixed(1)} KB</span>
                                            </div>
                                        ) : (
                                            <div>
                                                <span className="mb-2 block text-lg">📁 Drop CSV file here or click to browse</span>
                                                <span className="block text-sm text-slate-500">Supports .csv files</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {importStep === 'preview' && importPreview && (
                                <div>
                                    <div className="mb-4 flex flex-wrap gap-4">
                                        <Badge colorScheme="blue" className="p-2 text-sm">
                                            📊 {importPreview.transactions_count} Transactions
                                        </Badge>
                                        <Badge colorScheme="purple" className="p-2 text-sm">
                                            👤 {importPreview.accounts_count} Accounts
                                        </Badge>
                                        <Badge colorScheme="green" className="p-2 text-sm">
                                            💎 {importPreview.assets_count} Assets
                                        </Badge>
                                        {importPreview.fee_transactions_count > 0 && (
                                            <Badge colorScheme="orange" className="p-2 text-sm">
                                                💰 {importPreview.fee_transactions_count} Fee Transactions
                                            </Badge>
                                        )}
                                    </div>

                                    {importPreview.errors.length > 0 && (
                                        <div className="mb-4 border border-red-200 bg-red-50 p-3">
                                            <span className="mb-2 block font-bold text-red-600">⚠️ Parse Errors ({importPreview.errors.length})</span>
                                            {importPreview.errors.slice(0, 5).map((err, i) => (
                                                <span key={i} className="block text-sm text-red-600">Row {err.row}: {err.error}</span>
                                            ))}
                                            {importPreview.errors.length > 5 && (
                                                <span className="block text-sm text-red-500">...and {importPreview.errors.length - 5} more errors</span>
                                            )}
                                        </div>
                                    )}

                                    {importPreview.warnings.length > 0 && (
                                        <div className="mb-4 border border-yellow-200 bg-yellow-50 p-3">
                                            <span className="mb-2 block font-bold text-yellow-700">⚠️ Warnings ({importPreview.warnings.length})</span>
                                            {importPreview.warnings.slice(0, 5).map((warn, i) => (
                                                <span key={i} className="block text-sm text-yellow-700">{warn}</span>
                                            ))}
                                        </div>
                                    )}

                                    <div className="mb-4">
                                        <span className="mb-2 block font-bold">Accounts to create as RawAccount:</span>
                                        <div className="flex flex-wrap gap-1">
                                            {importPreview.accounts.map((acc, i) => (
                                                <Badge key={i} colorScheme="purple" className="text-xs">{acc}</Badge>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="mb-4">
                                        <span className="mb-2 block font-bold">Assets to create as RawAsset:</span>
                                        <div className="flex max-h-[100px] flex-wrap gap-1 overflow-auto">
                                            {importPreview.assets.slice(0, 30).map((asset, i) => (
                                                <Badge key={i} colorScheme="green" className="text-xs">{asset}</Badge>
                                            ))}
                                            {importPreview.assets.length > 30 && (
                                                <Badge colorScheme="gray" className="text-xs">+{importPreview.assets.length - 30} more</Badge>
                                            )}
                                        </div>
                                    </div>

                                    <div>
                                        <span className="mb-2 block font-bold">Transaction Preview (first 20) - Source → Transformed:</span>
                                        <div className="max-h-[350px] overflow-auto border border-slate-200">
                                            <table className="w-full">
                                                <thead>
                                                    <tr>
                                                        <th>Date</th>
                                                        <th className="bg-slate-100">CSV Type</th>
                                                        <th className="bg-blue-50">→ DB Type</th>
                                                        <th className="bg-blue-50">→ Direction</th>
                                                        <th className="bg-slate-100">CSV Asset</th>
                                                        <th className="bg-blue-50">→ DB Asset</th>
                                                        <th>Qty</th>
                                                        <th className="bg-blue-50">→ Fee</th>
                                                        <th className="bg-slate-100">CSV Account</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
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
                                                            <tr key={i} style={tx.is_fee_transaction ? { backgroundColor: '#fff7ed' } : undefined}>
                                                                <td className="text-xs">{formatDateTimeCompact(tx.date_time)}</td>
                                                                {/* CSV Source Type */}
                                                                <td className="bg-slate-50 text-xs">
                                                                    <Badge colorScheme="gray" className="border border-slate-300 bg-white">
                                                                        {tx.transaction_type}
                                                                    </Badge>
                                                                </td>
                                                                {/* → DB transaction_type */}
                                                                <td className="bg-blue-50 text-xs">
                                                                    <Badge colorScheme={tx.is_fee_transaction ? 'orange' : 'blue'}>
                                                                        {dbType}
                                                                    </Badge>
                                                                </td>
                                                                {/* → DB direction */}
                                                                <td className="bg-blue-50 text-xs">
                                                                    <Badge
                                                                        colorScheme={direction === 'inflow' ? 'green' : direction === 'outflow' ? 'red' : 'gray'}
                                                                    >
                                                                        {direction}
                                                                    </Badge>
                                                                </td>
                                                                {/* CSV Source Asset */}
                                                                <td className="max-w-[100px] overflow-hidden text-ellipsis whitespace-nowrap bg-slate-50 text-xs" title={tx.asset_label}>
                                                                    {tx.asset_ticker}
                                                                </td>
                                                                {/* → DB Asset (asset_id mapping) */}
                                                                <td className="bg-blue-50 text-xs">
                                                                    {dbAsset ? (
                                                                        <Badge colorScheme="green" title="Will create RawAsset for mapping">
                                                                            {dbAsset}
                                                                        </Badge>
                                                                    ) : (
                                                                        <span className="text-xs text-slate-400">None</span>
                                                                    )}
                                                                </td>
                                                                {/* Quantity */}
                                                                <td className="text-xs">
                                                                    {tx.is_fee_transaction ? (
                                                                        <span className="text-slate-400 line-through">{tx.quantity?.toFixed(2)}</span>
                                                                    ) : (
                                                                        tx.quantity?.toFixed(4) || '-'
                                                                    )}
                                                                </td>
                                                                {/* → DB Fee */}
                                                                <td className="bg-blue-50 text-xs">
                                                                    {dbFee ? `€${dbFee.toFixed(2)}` : '-'}
                                                                </td>
                                                                {/* CSV Account */}
                                                                <td className="bg-slate-50 text-xs">{tx.account_code}</td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                        <div className="mt-2 flex gap-4 text-xs text-slate-600">
                                            <span><span className="rounded-sm bg-slate-100 px-1">Gray</span> = CSV source values</span>
                                            <span><span className="rounded-sm bg-blue-50 px-1">Blue</span> = Transformed DB values</span>
                                        </div>
                                    </div>

                                    <div className="mt-4 bg-blue-50 p-3">
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                role="switch"
                                                aria-checked={dryRunMode}
                                                aria-label="Dry Run Mode"
                                                onClick={() => setDryRunMode(!dryRunMode)}
                                                className={cn(
                                                    'relative inline-flex h-[14px] w-[26px] items-center transition-colors',
                                                    dryRunMode ? 'bg-blue-500' : 'bg-slate-300',
                                                )}
                                            >
                                                <span
                                                    className={cn(
                                                        'inline-block h-[10px] w-[10px] transform bg-white transition-transform',
                                                        dryRunMode ? 'translate-x-[14px]' : 'translate-x-[2px]',
                                                    )}
                                                />
                                            </button>
                                            <span className="font-bold">Dry Run Mode</span>
                                        </div>
                                        <span className="mt-1 block text-sm text-slate-600">
                                            {dryRunMode
                                                ? 'Preview only - no changes will be saved to the database'
                                                : '⚠️ Changes will be committed to the database'}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {importStep === 'result' && importResult && (
                                <div>
                                    <div className={cn('mb-4 p-4', importResult.dry_run ? 'bg-blue-50' : 'bg-green-50')}>
                                        <span className="mb-2 block text-lg font-bold">
                                            {importResult.dry_run ? '🔍 Dry Run Complete' : '✅ Import Complete'}
                                        </span>
                                        {importResult.dry_run && (
                                            <span className="block text-sm text-blue-600">
                                                No changes were saved. Run again with Dry Run disabled to commit.
                                            </span>
                                        )}
                                    </div>

                                    <div className="mb-4 flex flex-wrap gap-4">
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="block text-sm text-slate-500">Transactions</span>
                                            <span className="block text-xl font-bold text-green-600">
                                                {importResult.transactions.created} created
                                            </span>
                                            <span className="block text-sm text-slate-500">
                                                {importResult.transactions.skipped} skipped
                                            </span>
                                        </div>
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="block text-sm text-slate-500">Raw Accounts</span>
                                            <span className="block text-xl font-bold text-purple-600">
                                                {importResult.raw_accounts.created} created
                                            </span>
                                            <span className="block text-sm text-slate-500">
                                                {importResult.raw_accounts.skipped} skipped
                                            </span>
                                        </div>
                                        <div className="min-w-[150px] flex-1 bg-slate-50 p-3">
                                            <span className="block text-sm text-slate-500">Raw Assets</span>
                                            <span className="block text-xl font-bold text-teal-600">
                                                {importResult.raw_assets.created} created
                                            </span>
                                            <span className="block text-sm text-slate-500">
                                                {importResult.raw_assets.skipped} skipped
                                            </span>
                                        </div>
                                    </div>

                                    {importResult.pending_review_count > 0 && (
                                        <div className="mb-4 bg-yellow-50 p-3">
                                            <span className="text-yellow-700">
                                                ⚠️ <strong>{importResult.pending_review_count}</strong> transactions need review
                                                (unmapped accounts or assets). Use the Raw Accounts and Raw Assets editors to map them.
                                            </span>
                                        </div>
                                    )}

                                    {importResult.summary.total_errors > 0 && (
                                        <div className="bg-red-50 p-3">
                                            <span className="block font-bold text-red-600">
                                                ❌ {importResult.summary.total_errors} errors occurred
                                            </span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                        <div className="flex w-full items-center justify-between gap-2 border-t border-slate-200 p-4">
                            <Button variant="outline" onClick={() => setShowImportDialog(false)}>
                                Close
                            </Button>
                            <div className="flex gap-2">
                                {importStep === 'select' && (
                                    <Button
                                        colorScheme="gray"
                                        className={BULK_ACTION_SOLID.teal}
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
                                            colorScheme={dryRunMode ? 'blue' : 'green'}
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
                                                colorScheme="green"
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
                            </div>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>

            {/* Transaction Detail Drawer - Always rendered, available from any tab */}
            <TransactionDetailDrawer
                transactionId={drawerTransactionId}
                isOpen={isDrawerOpen}
                onNavigate={navigateDrawer}
                hasPrev={drawerNeighbors.prev}
                hasNext={drawerNeighbors.next}
                onGoTo={embeddedMode ? undefined : handleLocate}
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
                rawAssetNetwork={quickCreateAsset?.rawNetwork}
                rawAssetContract={quickCreateAsset?.rawContract}
            />

            {/* Bundle Create Dialog */}
            <BundleCreateDialog
                isOpen={showBundleCreateDialog}
                onClose={() => setShowBundleCreateDialog(false)}
                onCreated={handleBundleCreated}
                defaults={bundleCreateDefaults}
                generateLabel={(pattern) => generateBundleLabel(pattern, selectedIds.size > 0 ? selectedIds : new Set(bundleCreateDefaults.transactionIds))}
            />
        </div>
    );
};
