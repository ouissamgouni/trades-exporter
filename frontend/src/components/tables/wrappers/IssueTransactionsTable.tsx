/**
 * IssueTransactionsTable
 * 
 * A wrapper component for TransactionsTable configured for
 * displaying transactions in data health issue contexts.
 * 
 * Features:
 * - Uses 'compact' column preset by default
 * - Hides bundles and suggestions
 * - Adds optional issue-specific columns/actions
 * - Accepts transaction IDs or filter to fetch
 */

import React, { useMemo } from 'react';
import { Box, Text } from '@chakra-ui/react';
import { TransactionsTable } from '../../TransactionsTable';
import { TableConfig, ColumnPlugin, RowAction, ColumnPresetName } from '../types';
import { presetToVisibility } from '../useTransactionsTable';
import { Transaction } from '../../../types';

// ============================================================================
// Types
// ============================================================================

export interface IssueTransactionsTableProps {
    /** Issue type for context (e.g., 'missing-asset', 'unlinked-account') */
    issueType?: string;
    
    /** Title displayed in the header */
    title?: string;
    
    /** Subtitle/description */
    subtitle?: string;
    
    /** Transaction IDs to display (if provided, fetches these specific transactions) */
    transactionIds?: number[];
    
    /** Column preset. Default: 'compact' */
    columnPreset?: ColumnPresetName;
    
    /** Additional columns to hide */
    hideColumns?: string[];
    
    /** Additional columns to show */
    showColumns?: string[];
    
    /** Additional columns to render */
    additionalColumns?: ColumnPlugin<Transaction>[];
    
    /** Additional row actions */
    additionalRowActions?: RowAction<Transaction>[];
    
    /** Callback when data changes */
    onDataChange?: () => void;
    
    /** Message when no transactions found */
    emptyMessage?: string;
}

// ============================================================================
// Component
// ============================================================================

export const IssueTransactionsTable: React.FC<IssueTransactionsTableProps> = ({
    issueType,
    title,
    subtitle,
    transactionIds,
    columnPreset = 'compact',
    hideColumns = [],
    showColumns = [],
    additionalColumns = [],
    additionalRowActions = [],
    onDataChange,
    emptyMessage,
}) => {
    // Build table config based on props
    const tableConfig: TableConfig<Transaction> = useMemo(() => ({
        columnPreset,
        hiddenColumns: hideColumns as any[],
        shownColumns: showColumns as any[],
        features: {
            filters: false, // Hide filters in issue context
            selection: true,
            inlineEdit: true,
        },
    }), [columnPreset, hideColumns, showColumns]);
    
    // Initial column visibility for this table
    const initialColumnVisibility = useMemo(() => 
        presetToVisibility(columnPreset, hideColumns as any[], showColumns as any[]),
        [columnPreset, hideColumns, showColumns]
    );
    
    // If transaction IDs are provided, we need to build a custom API URL
    // For now, we'll use the standard endpoint and let the parent filter
    // In future, could add query params like ?ids=1,2,3
    
    // Default title based on issue type
    const displayTitle = title || (issueType ? `${issueType} Transactions` : 'Related Transactions');
    
    // Empty state for no transaction IDs
    if (transactionIds && transactionIds.length === 0) {
        return (
            <Box p={4} bg="gray.50" borderRadius="md" textAlign="center">
                <Text color="gray.600">{emptyMessage || 'No transactions to display'}</Text>
            </Box>
        );
    }

    return (
        <TransactionsTable
            title={displayTitle}
            subtitle={subtitle}
            tableId={`issue-${issueType || 'default'}`}
            initialColumnVisibility={initialColumnVisibility}
            config={tableConfig}
            additionalColumns={additionalColumns}
            additionalRowActions={additionalRowActions}
            showFilters={false}
            showBundles={false}
            showSuggestions={false}
            compact={true}
            emptyMessage={emptyMessage}
            onDataChange={onDataChange}
        />
    );
};

export default IssueTransactionsTable;
