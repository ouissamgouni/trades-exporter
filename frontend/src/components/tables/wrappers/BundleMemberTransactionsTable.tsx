/**
 * BundleMemberTransactionsTable
 *
 * Lightweight wrapper around TransactionsTable for displaying
 * a small set of transactions by ID. Used in bundle popovers,
 * suggestion cards, and duplicate groups.
 */

import React, { useMemo } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { TransactionsTable } from '../../TransactionsTable';
import { defaultFilterState } from '../../TransactionFilters';
import { TableConfig } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { Transaction } from '../../../types';

// ============================================================================
// Types
// ============================================================================

interface BundleMemberTransactionsTableProps {
    /** Transaction IDs to display */
    transactionIds: number[];
    /** Callback when a transaction row is clicked */
    onTransactionClick?: (txId: number) => void;
}

// ============================================================================
// Component
// ============================================================================

export const BundleMemberTransactionsTable: React.FC<BundleMemberTransactionsTableProps> = ({
    transactionIds,
    onTransactionClick,
}) => {
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset: 'minimal',
        shownColumns: ['accounts', 'price', 'total'],
        features: {
            filters: false,
            selection: false,
            inlineEdit: false,
        },
    }), []);

    const initialColumnVisibility = useMemo(
        () => presetToVisibility('minimal', [], ['accounts', 'price', 'total']),
        [],
    );

    if (!transactionIds || transactionIds.length === 0) {
        return (
            <Text fontSize="xs" color="gray.500" fontStyle="italic">
                No transactions
            </Text>
        );
    }

    return (
        <TransactionsTable
            tableId="bundleMembers"
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
            config={tableConfig}
        />
    );
};

export default BundleMemberTransactionsTable;
