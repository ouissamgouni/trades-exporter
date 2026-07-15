/**
 * TanStack React Table Hook for TransactionsTable
 * 
 * Provides table state management with:
 * - Column visibility (localStorage persisted)
 * - Column sizing (localStorage persisted)
 * - Sorting (default: date_time desc)
 * - Row selection
 * - Pagination (client-side)
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
    useReactTable,
    getCoreRowModel,
    getSortedRowModel,
    getPaginationRowModel,
    ColumnDef,
    SortingState,
    ColumnSizingState,
    VisibilityState,
    RowSelectionState,
    Table,
    flexRender,
} from '@tanstack/react-table';
import { Transaction } from '../../types';
import { TransactionColumnKey } from './types';
import { COLUMN_PRESETS } from './columnPresets';

// Re-export flexRender for convenience
export { flexRender };
export type { Table, ColumnDef };

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_PREFIX = 'txTable';

const getStorageKey = (tableId: string, suffix: string) => 
    `${STORAGE_PREFIX}:${tableId}:${suffix}`;

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_SORTING: SortingState = [
    { id: 'date', desc: true }
];

const DEFAULT_PAGE_SIZE = 50;

// ============================================================================
// Local Storage Helpers
// ============================================================================

const loadFromStorage = <T>(key: string, fallback: T): T => {
    try {
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : fallback;
    } catch {
        return fallback;
    }
};

const saveToStorage = <T>(key: string, value: T): void => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.warn('Failed to save to localStorage:', e);
    }
};

// ============================================================================
// Column Visibility Preset to TanStack VisibilityState
// ============================================================================

/**
 * Convert column preset + overrides to TanStack VisibilityState
 */
export const presetToVisibility = (
    preset: keyof typeof COLUMN_PRESETS = 'full',
    hiddenColumns: TransactionColumnKey[] = [],
    shownColumns: TransactionColumnKey[] = []
): VisibilityState => {
    const presetColumns = COLUMN_PRESETS[preset];
    const hiddenSet = new Set(hiddenColumns);
    const shownSet = new Set(shownColumns);
    
    // All possible columns
    const allColumns: TransactionColumnKey[] = [
        'id', 'date', 'source', 'accounts', 'direction', 'type', 'asset', 'qty',
        'price', 'total', 'fee', 'feeInBase',
        'taxability', 'bundle', 'tags', 'sourceTransactionId', 'status'
    ];
    
    const visibility: VisibilityState = {};
    
    for (const col of allColumns) {
        // Start with preset visibility
        let isVisible = presetColumns.includes(col);
        
        // Apply hidden override
        if (hiddenSet.has(col)) {
            isVisible = false;
        }
        
        // Apply shown override (wins over hidden)
        if (shownSet.has(col)) {
            isVisible = true;
        }
        
        visibility[col] = isVisible;
    }
    
    return visibility;
};

// ============================================================================
// Hook Options
// ============================================================================

export interface UseTransactionsTableOptions<T extends Transaction = Transaction> {
    /**
     * Unique identifier for this table instance.
     * Used for localStorage keys. Example: 'inbox', 'all', 'assetLinkage'
     */
    tableId: string;
    
    /**
     * Transaction data to display
     */
    data: T[];
    
    /**
     * TanStack column definitions
     */
    columns: ColumnDef<T, any>[];
    
    /**
     * Initial column visibility (overrides localStorage on first load).
     * Uses TanStack VisibilityState format: { columnId: boolean }
     */
    initialColumnVisibility?: VisibilityState;
    
    /**
     * Initial sorting. Default: [{ id: 'date', desc: true }]
     */
    initialSorting?: SortingState;
    
    /**
     * Initial page size. Default: 50
     */
    initialPageSize?: number;
    
    /**
     * Enable column resizing. Default: true
     */
    enableColumnResizing?: boolean;
    
    /**
     * Column resize mode. Default: 'onEnd' (better performance)
     */
    columnResizeMode?: 'onChange' | 'onEnd';
    
    /**
     * Callback when row selection changes
     */
    onRowSelectionChange?: (selectedIds: number[]) => void;
}

// ============================================================================
// Hook Result
// ============================================================================

export interface UseTransactionsTableResult<T extends Transaction = Transaction> {
    /**
     * TanStack table instance
     */
    table: Table<T>;
    
    /**
     * Current sorting state
     */
    sorting: SortingState;
    
    /**
     * Current column visibility state
     */
    columnVisibility: VisibilityState;
    
    /**
     * Current column sizing state
     */
    columnSizing: ColumnSizingState;
    
    /**
     * Current row selection state
     */
    rowSelection: RowSelectionState;
    
    /**
     * Array of selected transaction IDs
     */
    selectedIds: number[];
    
    /**
     * Reset column visibility to initial/default
     */
    resetColumnVisibility: () => void;
    
    /**
     * Reset sorting to default (date desc)
     */
    resetSorting: () => void;
    
    /**
     * Clear row selection
     */
    clearSelection: () => void;
    
    /**
     * Select specific rows by ID
     */
    selectRows: (ids: number[]) => void;
}

// ============================================================================
// Main Hook
// ============================================================================

export const useTransactionsTable = <T extends Transaction = Transaction>(
    options: UseTransactionsTableOptions<T>
): UseTransactionsTableResult<T> => {
    const {
        tableId,
        data,
        columns,
        initialColumnVisibility,
        initialSorting = DEFAULT_SORTING,
        initialPageSize = DEFAULT_PAGE_SIZE,
        enableColumnResizing = true,
        columnResizeMode = 'onEnd',
        onRowSelectionChange,
    } = options;
    
    // Storage keys for this table instance
    const visibilityKey = getStorageKey(tableId, 'visibility');
    const sizingKey = getStorageKey(tableId, 'sizing');
    const sortingKey = getStorageKey(tableId, 'sorting');
    
    // ========== State ==========
    
    // Column visibility - load from storage or use initial
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
        const stored = loadFromStorage<VisibilityState | null>(visibilityKey, null);
        // If we have stored visibility and no explicit initial, use stored
        // If we have explicit initial, use it (allows prop to override storage)
        if (initialColumnVisibility) {
            return initialColumnVisibility;
        }
        return stored ?? presetToVisibility('full');
    });
    
    // Column sizing - load from storage
    const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => 
        loadFromStorage<ColumnSizingState>(sizingKey, {})
    );
    
    // Sorting - load from storage or use initial
    const [sorting, setSorting] = useState<SortingState>(() => {
        const stored = loadFromStorage<SortingState | null>(sortingKey, null);
        return stored ?? initialSorting;
    });
    
    // Row selection
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    
    // ========== Persist to Storage ==========
    
    useEffect(() => {
        saveToStorage(visibilityKey, columnVisibility);
    }, [columnVisibility, visibilityKey]);
    
    useEffect(() => {
        saveToStorage(sizingKey, columnSizing);
    }, [columnSizing, sizingKey]);
    
    useEffect(() => {
        saveToStorage(sortingKey, sorting);
    }, [sorting, sortingKey]);
    
    // ========== Selection Change Callback ==========
    
    const selectedIds = useMemo(() => {
        return Object.keys(rowSelection)
            .filter(key => rowSelection[key])
            .map(key => {
                const row = data[parseInt(key)];
                return row?.id;
            })
            .filter((id): id is number => id !== undefined);
    }, [rowSelection, data]);
    
    useEffect(() => {
        onRowSelectionChange?.(selectedIds);
    }, [selectedIds, onRowSelectionChange]);
    
    // ========== Table Instance ==========
    
    const table = useReactTable({
        data,
        columns,
        state: {
            sorting,
            columnVisibility,
            columnSizing,
            rowSelection,
        },
        onSortingChange: setSorting,
        onColumnVisibilityChange: setColumnVisibility,
        onColumnSizingChange: setColumnSizing,
        onRowSelectionChange: setRowSelection,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        getPaginationRowModel: getPaginationRowModel(),
        enableColumnResizing,
        columnResizeMode,
        // Use row id as the row key for selection
        getRowId: (row) => String(row.id),
        initialState: {
            pagination: {
                pageSize: initialPageSize,
            },
        },
    });
    
    // ========== Actions ==========
    
    const resetColumnVisibility = useCallback(() => {
        const defaultVis = initialColumnVisibility ?? presetToVisibility('full');
        setColumnVisibility(defaultVis);
    }, [initialColumnVisibility]);
    
    const resetSorting = useCallback(() => {
        setSorting(DEFAULT_SORTING);
    }, []);
    
    const clearSelection = useCallback(() => {
        setRowSelection({});
    }, []);
    
    const selectRows = useCallback((ids: number[]) => {
        const newSelection: RowSelectionState = {};
        data.forEach((row, index) => {
            if (ids.includes(row.id)) {
                newSelection[index] = true;
            }
        });
        setRowSelection(newSelection);
    }, [data]);
    
    return {
        table,
        sorting,
        columnVisibility,
        columnSizing,
        rowSelection,
        selectedIds,
        resetColumnVisibility,
        resetSorting,
        clearSelection,
        selectRows,
    };
};
