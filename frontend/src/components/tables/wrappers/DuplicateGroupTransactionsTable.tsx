/**
 * DuplicateGroupTransactionsTable
 *
 * Lightweight wrapper around TransactionsTable for displaying
 * duplicate group transactions with checkbox row selection.
 * Used in DuplicatePopover and DuplicateResolutionPanel group cards.
 *
 * Selection is exposed via `onSelectionChange`.
 * Pass `preselectIds` (+ change the component's `key`) to force-reset
 * selection to a preset from a "smart suggestion" action.
 */

import React, { useMemo } from 'react';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { Transaction } from '../../../types';

// ============================================================================
// Types
// ============================================================================

interface DuplicateGroupTransactionsTableProps {
    /** Transaction IDs to display */
    transactionIds: number[];
    /** Callback when a transaction row is clicked (opens detail drawer) */
    onTransactionClick?: (txId: number) => void;
    /** Fired whenever the checkbox selection changes */
    onSelectionChange?: (ids: Set<number>) => void;
    /** Pre-select these IDs on mount.
     *  To re-apply (e.g. after a "smart suggestion" click), change the
     *  parent's `key` prop on this component. */
    preselectIds?: number[];
}

// ============================================================================
// Component
// ============================================================================

export const DuplicateGroupTransactionsTable: React.FC<DuplicateGroupTransactionsTableProps> = ({
    transactionIds,
    onTransactionClick,
    onSelectionChange,
    preselectIds,
}) => {
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset: 'minimal',
        // status is already in minimal preset; ensure it appears
        features: {
            filters: false,
            selection: false, // native feature flag unused – we use embeddedMode+showSelectionInEmbedded
            inlineEdit: false,
        },
    }), []);

    const initialColumnVisibility = useMemo(
        () => presetToVisibility('minimal'),
        [],
    );

    if (!transactionIds || transactionIds.length === 0) {
        return (
            <span className="text-xs italic text-slate-500">
                No transactions
            </span>
        );
    }

    return (
        <TransactionsTable
            tableId="duplicateGroupMembers"
            initialColumnVisibility={initialColumnVisibility}
            filters={{
                ...defaultFilterState,
                transactionIds,
                reviewStatus: [],
            }}
            showFilters={false}
            showBundles={false}
            showSuggestions={false}
            compact={true}
            embeddedMode={true}
            showSelectionInEmbedded={true}
            initialSelectedIds={preselectIds}
            onSelectionChange={onSelectionChange}
            config={tableConfig}
        />
    );
};

export default DuplicateGroupTransactionsTable;
