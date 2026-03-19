/**
 * Tables Module - Public Exports
 * 
 * This module provides the extensible TransactionsTable architecture:
 * - TableConfig for configuration
 * - ColumnPlugin for custom columns
 * - Column presets (full, compact, minimal)
 * - Wrapper components for common use cases
 */

// Types
export type {
    TableConfig,
    TableFeatures,
    ColumnPlugin,
    RowAction,
    BulkAction,
    TransactionColumnKey,
    ColumnPresetName,
} from './types';

export {
    DEFAULT_TABLE_CONFIG,
    DEFAULT_TABLE_FEATURES,
    resolveTableConfig,
} from './types';

// Column Presets
export {
    COLUMN_PRESETS,
    COLUMN_META,
    resolveColumns,
    isColumnVisible,
    createPresetConfig,
} from './columnPresets';

// TanStack Table integration
export {
    useTransactionsTable,
    presetToVisibility,
    flexRender,
} from './useTransactionsTable';

export type {
    UseTransactionsTableOptions,
    UseTransactionsTableResult,
} from './useTransactionsTable';

// Column visibility UI
export { ColumnVisibilityPopover } from './ColumnVisibilityPopover';

// Core components (to be added)
// export { TransactionTableRow } from './core/TransactionTableRow';

// Wrapper components
export { MissingDataTable } from './wrappers/MissingDataTable';
export { AccountsLinkageTable } from './wrappers/AccountsLinkageTable';
export { BundleMemberTransactionsTable } from './wrappers/BundleMemberTransactionsTable';
// export { JobTransactionsTable } from './wrappers/JobTransactionsTable';
// export { PnLTransactionsTable } from './wrappers/PnLTransactionsTable';
// export { AccountTransactionsTable } from './wrappers/AccountTransactionsTable';
