import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { BundlesListPanel, BundleSuggestionsPanel } from './bundles';
import { API_URL, BundleSuggestion } from '../types';
import { Badge, Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';

// ============================================================================
// View Presets
// ============================================================================

/** All filter fields set to empty — shows everything, no pre-filtering. */
const EMPTY_FILTERS: TransactionFilterState = {
    reviewStatus: [],
    taxability: [],
    sources: [],
    accountIds: [],
    fromAccountIds: [],
    toAccountIds: [],
    relatedAccountIds: [],
    assetIds: [],
    relatedAssetIds: [],
    attributedAssetIds: [],
    categoryIds: [],
    transactionTypes: [],
    directions: [],
    connectorRunIds: [],
    tagKeys: [],
    networks: [],
    dateFrom: '',
    dateTo: '',
    nonOwned: false,
    priceQuoteAssetIds: [],
    feeQuoteAssetIds: [],
    bundlePatterns: [],
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
    const [activeTab, setActiveTab] = React.useState('transactions');

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
        <div className="flex flex-col gap-1 p-2 pt-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-2">
                    <TabsTrigger value="transactions">
                        {preset.heading ? `${preset.heading}` : '📋 Transactions'}
                    </TabsTrigger>
                    <TabsTrigger value="bundles">
                        📦 Bundles
                        {suggestions.length > 0 && (
                            <Badge colorScheme="green" className="ml-2">{suggestions.length} 💡</Badge>
                        )}
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="transactions">
                    <TransactionsTable
                        tableId={preset.tableId}
                        title=""
                        subtitle=""
                        defaultWorkflowFilter={preset.defaultWorkflowFilter}
                        resetFilters={preset.resetFilters}
                        showSuggestions={preset.showSuggestions}
                    />
                </TabsContent>

                <TabsContent value="bundles">
                    {preset.showSuggestions && <BundleSuggestionsPanel mb={2} />}
                    <BundlesListPanel title="" />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default TransactionsView;
