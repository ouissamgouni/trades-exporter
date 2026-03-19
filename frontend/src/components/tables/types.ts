/**
 * TransactionsTable Plugin Architecture Types
 * 
 * This file defines the core types for the extensible TransactionsTable component.
 * The architecture supports:
 * - TableConfig for data source and display configuration
 * - ColumnPlugin for adding custom columns
 * - Additive action APIs for extending row/bulk actions
 */

import { ReactNode } from 'react';
import { Transaction } from '../../types';

// ============================================================================
// Column Keys - All possible transaction table columns
// ============================================================================

export type TransactionColumnKey =
    | 'id'
    | 'date'
    | 'source'
    | 'accounts'
    | 'direction'
    | 'type'
    | 'asset'
    | 'qty'
    | 'price'
    | 'total'
    | 'fee'
    | 'feeInBase'
    | 'taxability'
    | 'bundle'
    | 'tags'
    | 'sourceTransactionId'
    | 'status';

// ============================================================================
// Column Preset Names
// ============================================================================

export type ColumnPresetName = 'full' | 'compact' | 'minimal';

// ============================================================================
// Table Features Configuration
// ============================================================================

export interface TableFeatures {
    /** Show filter bar. Default: true */
    filters?: boolean;
    /** Enable row selection with checkboxes. Default: true */
    selection?: boolean;
    /** Enable inline cell editing. Default: true */
    inlineEdit?: boolean;
}

// ============================================================================
// Table Configuration
// ============================================================================

export interface TableConfig<T extends Transaction = Transaction> {
    /** 
     * Custom API endpoint to fetch transactions from.
     * Default: '/transactions'
     */
    endpoint?: string;

    /**
     * Static query parameters to append to the endpoint.
     * These are merged with dynamic filter parameters.
     */
    queryParams?: Record<string, string>;

    /**
     * Column preset defining which columns to show.
     * - 'full': All columns
     * - 'compact': Common columns, hides bundle/feeInBase
     * - 'minimal': Only essential columns (id, date, source, direction, asset, qty, status)
     * Default: 'full'
     */
    columnPreset?: ColumnPresetName;

    /**
     * Columns to hide (applied after preset).
     * Use this to hide specific columns from a preset.
     */
    hiddenColumns?: TransactionColumnKey[];

    /**
     * Columns to show (applied after hiddenColumns, overrides hidden).
     * Use this to show specific columns that would otherwise be hidden.
     */
    shownColumns?: TransactionColumnKey[];

    /**
     * Feature flags for table functionality.
     */
    features?: TableFeatures;
}

// ============================================================================
// Column Plugin - For adding custom columns
// ============================================================================

export interface ColumnPlugin<T extends Transaction = Transaction> {
    /** Unique identifier for the column */
    id: string;

    /** Column header text */
    header: string;

    /** 
     * Column width (CSS value).
     * Default: 'auto'
     */
    width?: string;

    /**
     * Render function for cell content.
     * Receives the transaction row data.
     */
    render: (tx: T) => ReactNode;
}

// ============================================================================
// Row Action - For per-row action buttons
// ============================================================================

export interface RowAction<T extends Transaction = Transaction> {
    /** Unique identifier for the action */
    id: string;

    /** Icon or emoji to display */
    icon: ReactNode;

    /** Tooltip/title text */
    label: string;

    /**
     * Action handler. Receives the transaction row.
     * Return a Promise for async actions.
     */
    onClick: (tx: T) => void | Promise<void>;

    /**
     * Optional visibility predicate.
     * Return false to hide this action for specific rows.
     */
    isVisible?: (tx: T) => boolean;

    /**
     * Optional disabled predicate.
     * Return true to show the action as disabled.
     */
    isDisabled?: (tx: T) => boolean;

    /**
     * Color palette for the button (Chakra UI color).
     * Default: 'gray'
     */
    colorPalette?: string;
}

// ============================================================================
// Bulk Action - For multi-select action buttons
// ============================================================================

export interface BulkAction<T extends Transaction = Transaction> {
    /** Unique identifier for the action */
    id: string;

    /** Button label text */
    label: string;

    /** Icon or emoji to display */
    icon?: ReactNode;

    /**
     * Action handler. Receives array of selected transaction IDs.
     * Return a Promise for async actions.
     */
    onClick: (selectedIds: number[], selectedTransactions: T[]) => void | Promise<void>;

    /**
     * Optional visibility predicate.
     * Return false to hide this action based on selection.
     */
    isVisible?: (selectedIds: number[], selectedTransactions: T[]) => boolean;

    /**
     * Optional disabled predicate.
     * Return true to show the action as disabled.
     */
    isDisabled?: (selectedIds: number[], selectedTransactions: T[]) => boolean;

    /**
     * Color palette for the button (Chakra UI color).
     * Default: 'gray'
     */
    colorPalette?: string;

    /**
     * Button variant.
     * Default: 'solid'
     */
    variant?: 'solid' | 'outline' | 'ghost';
}

// ============================================================================
// Default Configuration Values
// ============================================================================

export const DEFAULT_TABLE_CONFIG: Required<TableConfig> = {
    endpoint: '/transactions',
    queryParams: {},
    columnPreset: 'full',
    hiddenColumns: [],
    shownColumns: [],
    features: {
        filters: true,
        selection: true,
        inlineEdit: true,
    },
};

export const DEFAULT_TABLE_FEATURES: Required<TableFeatures> = {
    filters: true,
    selection: true,
    inlineEdit: true,
};

// ============================================================================
// Helper function to merge config with defaults
// ============================================================================

export const resolveTableConfig = <T extends Transaction = Transaction>(
    config?: TableConfig<T>
): Required<TableConfig<T>> => {
    if (!config) {
        return DEFAULT_TABLE_CONFIG as Required<TableConfig<T>>;
    }

    return {
        endpoint: config.endpoint ?? DEFAULT_TABLE_CONFIG.endpoint,
        queryParams: config.queryParams ?? DEFAULT_TABLE_CONFIG.queryParams,
        columnPreset: config.columnPreset ?? DEFAULT_TABLE_CONFIG.columnPreset,
        hiddenColumns: config.hiddenColumns ?? DEFAULT_TABLE_CONFIG.hiddenColumns,
        shownColumns: config.shownColumns ?? DEFAULT_TABLE_CONFIG.shownColumns,
        features: {
            ...DEFAULT_TABLE_FEATURES,
            ...config.features,
        },
    };
};
