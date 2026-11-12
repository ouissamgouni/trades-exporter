/**
 * Column Presets for TransactionsTable
 * 
 * Defines which columns are visible for each preset:
 * - full: All columns for comprehensive view
 * - compact: Common columns for embedded/detail views
 * - minimal: Essential columns for tight spaces
 * 
 * Resolution order: preset → remove hidden → add shown (shown wins)
 */

import { TransactionColumnKey, ColumnPresetName, TableConfig } from './types';
import { Transaction } from '../../types';

// ============================================================================
// Preset Definitions
// ============================================================================

export const COLUMN_PRESETS: Record<ColumnPresetName, TransactionColumnKey[]> = {
    /**
     * Full preset - all columns visible
     * Use for: Main transactions page, detailed audit views
     */
    full: [
        'date',
        'source',
        'accounts',
        'direction',
        'type',
        'asset',
        'qty',
        'price',
        'total',
        'fee',
        'feeInBase',
        'taxability',
        'status',
    ],

    /**
     * Compact preset - common columns, hides rarely-needed ones
     * Use for: Embedded tables, job details, P&L audit
     */
    compact: [
        'date',
        'source',
        'accounts',
        'direction',
        'type',
        'asset',
        'qty',
        'price',
        'total',
        'fee',
        'taxability',
        'status',
    ],

    /**
     * Minimal preset - essential columns only
     * Use for: Very tight spaces, summaries, tooltips
     */
    minimal: [
        'date',
        'source',
        'accounts',
        'direction',
        'asset',
        'qty',
        'status',
    ],
};

// ============================================================================
// Column Resolution
// ============================================================================

/**
 * Resolve which columns should be visible based on config.
 * 
 * Resolution order:
 * 1. Start with preset columns
 * 2. Remove hiddenColumns
 * 3. Add shownColumns (overrides hidden - explicit show wins)
 * 
 * @param config - TableConfig with preset and overrides
 * @returns Array of column keys to display
 */
export const resolveColumns = <T extends Transaction = Transaction>(
    config: TableConfig<T>
): TransactionColumnKey[] => {
    // Start with preset (default to 'full')
    const presetName = config.columnPreset ?? 'full';
    const baseColumns = [...COLUMN_PRESETS[presetName]];

    // Remove hidden columns
    const hiddenSet = new Set(config.hiddenColumns ?? []);
    const afterHidden = baseColumns.filter(col => !hiddenSet.has(col));

    // Add shown columns (deduplicated, maintains order)
    const shownColumns = config.shownColumns ?? [];
    const resultSet = new Set(afterHidden);
    const result = [...afterHidden];

    for (const col of shownColumns) {
        if (!resultSet.has(col)) {
            result.push(col);
            resultSet.add(col);
        }
    }

    return result;
};

// ============================================================================
// Column Metadata (for headers, widths, etc.)
// ============================================================================

export interface ColumnMeta {
    key: TransactionColumnKey;
    header: string;
    width?: string;
    sticky?: 'left' | 'right';
}

export const COLUMN_META: Record<TransactionColumnKey, ColumnMeta> = {
    id: { key: 'id', header: 'ID', width: '50px' },
    date: { key: 'date', header: 'Date/Time', width: '100px' },
    source: { key: 'source', header: 'Source Info', width: '180px' },
    accounts: { key: 'accounts', header: 'From / To', width: '130px' },
    direction: { key: 'direction', header: 'Direction', width: '50px' },
    type: { key: 'type', header: 'Type', width: '80px' },
    asset: { key: 'asset', header: 'Asset', width: '60px' },
    qty: { key: 'qty', header: 'Quantity', width: '80px' },
    price: { key: 'price', header: 'Price', width: '80px' },
    total: { key: 'total', header: 'Total', width: '80px' },
    fee: { key: 'fee', header: 'Fee', width: '70px' },
    feeInBase: { key: 'feeInBase', header: 'Include Fee', width: '70px' },
    taxability: { key: 'taxability', header: 'Taxable', width: '60px' },
    bundle: { key: 'bundle', header: 'Bundle', width: '70px' },
    tags: { key: 'tags', header: 'Tags', width: '100px' },
    sourceTransactionId: { key: 'sourceTransactionId', header: 'Source Tx ID', width: '120px' },
    status: { key: 'status', header: 'Status', width: '70px', sticky: 'right' },
};

// ============================================================================
// Helper: Check if a column is visible
// ============================================================================

export const isColumnVisible = <T extends Transaction = Transaction>(
    column: TransactionColumnKey,
    config: TableConfig<T>
): boolean => {
    const visibleColumns = resolveColumns(config);
    return visibleColumns.includes(column);
};

// ============================================================================
// Helper: Create a custom config based on a preset
// ============================================================================

export const createPresetConfig = <T extends Transaction = Transaction>(
    preset: ColumnPresetName,
    overrides?: Partial<TableConfig<T>>
): TableConfig<T> => ({
    columnPreset: preset,
    ...overrides,
});
