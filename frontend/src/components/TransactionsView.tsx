import React from 'react';
import { Box, Heading, Text, VStack, Tabs, Badge } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { BundlesListPanel, BundleSuggestionsPanel } from './bundles';
import { API_URL, BundleSuggestion } from '../types';

// ============================================================================
// View Presets
// ============================================================================

/** All filter fields set to empty — shows everything, no pre-filtering. */
const EMPTY_FILTERS: TransactionFilterState = {
    reviewStatus: [],
    taxability: [],
    sources: [],
    accountIds: [],
    assetIds: [],
    categoryIds: [],
    transactionTypes: [],
    directions: [],
    connectorRunIds: [],
    tagKeys: [],
    networks: [],
    dateFrom: '',
    dateTo: '',
};

interface ViewPreset {
    /** Tab label shown to the user */
    heading: string;
    /** Description below heading (optional) */
    description?: string;
    /** TransactionsTable tableId for localStorage persistence */
    tableId: string;
    /** Workflow filter applied on mount (e.g. 'pending') */
    defaultWorkflowFilter?: string;
    /** Base filter state used for initialization and reset */
    resetFilters: TransactionFilterState;
    /** Show bundle suggestions in the Bundles tab */
    showSuggestions: boolean;
    /** Bundles tab title */
    bundlesTitle: string;
}

const VIEW_PRESETS: Record<string, ViewPreset> = {
    inbox: {
        heading: '📥 Inbox',
        description: 'Review pending transactions and accept bundle suggestions. Mark as reviewed or excluded.',
        tableId: 'inbox-pending',
        defaultWorkflowFilter: 'pending',
        resetFilters: defaultFilterState,
        showSuggestions: true,
        bundlesTitle: '📦 Your Bundles',
    },
    all: {
        heading: '',
        description: undefined,
        tableId: 'all-transactions',
        resetFilters: EMPTY_FILTERS,
        showSuggestions: true,
        bundlesTitle: '📦 All Bundles',
    },
};

// ============================================================================
// Component
// ============================================================================

export interface TransactionsViewProps {
    /** Which preset to use: 'inbox' or 'all' */
    mode: keyof typeof VIEW_PRESETS;
}

/**
 * Unified transactions view — replaces InboxView and AllTransactionsView.
 *
 * Both views share the same structure:
 *   Tabs → { TransactionsTable, BundlesListPanel }
 *
 * The `mode` prop selects a preset that configures filters, reset behavior,
 * bundle suggestions visibility, and display labels — ensuring consistent
 * behavior without per-view prop tuning.
 */
export const TransactionsView: React.FC<TransactionsViewProps> = ({ mode }) => {
    const preset = VIEW_PRESETS[mode];

    // Read suggestion count from shared cache (App.tsx owns the query)
    const { data: suggestions = [] } = useQuery({
        queryKey: ['bundleSuggestions'],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/bundles/suggestions?max_suggestions=100`);
            if (!response.ok) return [];
            return response.json() as Promise<BundleSuggestion[]>;
        },
        // Only enable when suggestions are needed; otherwise just reads from cache
        enabled: preset.showSuggestions,
        staleTime: 60_000, // Avoid refetching if App.tsx already populated the cache
    });

    return (
        <VStack gap={4} align="stretch" p={4}>
            {/* Header — only rendered when there's content */}
            {preset.heading && (
                <Box>
                    <Heading size="lg">{preset.heading}</Heading>
                    {preset.description && (
                        <Text color="gray.600" fontSize="sm">
                            {preset.description}
                        </Text>
                    )}
                </Box>
            )}

            <Tabs.Root defaultValue="transactions">
                <Tabs.List mb={4}>
                    <Tabs.Trigger value="transactions">
                        📋 Transactions
                    </Tabs.Trigger>
                    <Tabs.Trigger value="bundles">
                        📦 Bundles
                        {suggestions.length > 0 && (
                            <Badge colorPalette="teal" ml={2}>{suggestions.length} 💡</Badge>
                        )}
                    </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="transactions">
                    <TransactionsTable
                        tableId={preset.tableId}
                        title=""
                        subtitle=""
                        defaultWorkflowFilter={preset.defaultWorkflowFilter}
                        resetFilters={preset.resetFilters}
                        showSuggestions={preset.showSuggestions}
                    />
                </Tabs.Content>

                <Tabs.Content value="bundles">
                    {preset.showSuggestions && <BundleSuggestionsPanel mb={4} />}
                    <BundlesListPanel title={preset.bundlesTitle} />
                </Tabs.Content>
            </Tabs.Root>
        </VStack>
    );
};

export default TransactionsView;
