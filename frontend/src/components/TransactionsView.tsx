import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useInRouterContext, useSearchParams } from 'react-router-dom';
import { LuLocateFixed, LuX } from 'react-icons/lu';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { BundlesListPanel, BundleSuggestionsPanel } from './bundles';
import { API_URL, BundleSuggestion } from '../types';
import { Badge, Tabs, TabsList, TabsTrigger, TabsContent } from './ui/primitives';
import { useSuspectedSpamCount } from '../hooks/useSpamReview';
import { SuspectedSpamTable } from './SuspectedSpamTable';
import { BrokenBundlesPanel, useCompletableBundleCount } from './BrokenBundlesPanel';
import { useDataHealth } from '../contexts/DataHealthContext';

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
    /** Show the suspected-spam review tab */
    showSpam?: boolean;
    /** Open every month/day group of the main table on mount */
    expandAllDays?: boolean;
}

const VIEW_PRESETS: Record<string, ViewPreset> = {
    inbox: {
        heading: '📥 Inbox',
        description: 'Review pending transactions and accept bundle suggestions. Mark as valid or rejected.',
        tableId: 'inbox-pending',
        defaultWorkflowFilter: 'pending',
        resetFilters: defaultFilterState,
        showSuggestions: true,
        bundlesTitle: '📦 Your Bundles',
        showSpam: true,
        expandAllDays: true,
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
export const TransactionsView: React.FC<TransactionsViewProps> = (props) => {
    const inRouter = useInRouterContext();
    return inRouter ? <RoutedTransactionsView {...props} /> : <TransactionsViewInner {...props} />;
};

/** Reads ?focus=&date_from=&date_to= (set by "Show in All transactions"). */
const RoutedTransactionsView: React.FC<TransactionsViewProps> = (props) => {
    const [searchParams, setSearchParams] = useSearchParams();
    const focus = Number(searchParams.get('focus')) || undefined;
    if (props.mode !== 'all' || !focus) return <TransactionsViewInner {...props} />;
    return (
        <TransactionsViewInner
            {...props}
            focus={{
                txId: focus,
                dateFrom: searchParams.get('date_from') || '',
                dateTo: searchParams.get('date_to') || '',
                onClear: () => setSearchParams({}),
            }}
        />
    );
};

interface FocusContext {
    txId: number;
    dateFrom: string;
    dateTo: string;
    onClear: () => void;
}

const TransactionsViewInner: React.FC<TransactionsViewProps & { focus?: FocusContext }> = ({ mode, focus }) => {
    const preset = VIEW_PRESETS[mode];
    const [activeTab, setActiveTab] = React.useState('transactions');
    const focusFilters = React.useMemo<TransactionFilterState | undefined>(
        () => focus ? { ...preset.resetFilters, dateFrom: focus.dateFrom, dateTo: focus.dateTo } : undefined,
        [focus, preset.resetFilters],
    );

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

    const spamCount = useSuspectedSpamCount();
    const completableCount = useCompletableBundleCount();
    const bundleHintCount = suggestions.length + (preset.showSuggestions ? completableCount : 0);
    const { validationSummary } = useDataHealth();
    const pendingCount = preset.defaultWorkflowFilter === 'pending' ? validationSummary?.pending_count ?? 0 : 0;

    return (
        <div className="flex flex-col gap-1 p-2 pt-0">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="mb-2">
                    <TabsTrigger value="transactions">
                        {preset.heading ? `${preset.heading}` : '📋 Transactions'}
                        {pendingCount > 0 && (
                            <Badge colorScheme="blue" className="ml-2" title="Pending review">{pendingCount}</Badge>
                        )}
                    </TabsTrigger>
                    <TabsTrigger value="bundles">
                        📦 Bundles
                        {bundleHintCount > 0 && (
                            <Badge colorScheme="green" className="ml-2" title="Bundle suggestions and bundles that can be completed">{bundleHintCount} 💡</Badge>
                        )}
                    </TabsTrigger>
                    {preset.showSpam && (
                        <TabsTrigger value="spam">
                            🚫 Suspected spam
                            {spamCount > 0 && (
                                <Badge colorScheme="orange" className="ml-2">{spamCount}</Badge>
                            )}
                        </TabsTrigger>
                    )}
                </TabsList>

                <TabsContent value="transactions">
                    {focus && (
                        <div className="mb-2 flex items-center gap-2 border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                            <LuLocateFixed size={12} />
                            <span>
                                Showing transactions around <b>#{focus.txId}</b>
                                {focus.dateFrom && focus.dateTo && <> ({focus.dateFrom} → {focus.dateTo})</>}
                            </span>
                            <button
                                type="button"
                                className="ml-auto flex items-center gap-1 text-amber-700 hover:text-amber-900"
                                onClick={focus.onClear}
                            >
                                <LuX size={12} /> Show all
                            </button>
                        </div>
                    )}
                    <TransactionsTable
                        key={focus ? `focus-${focus.txId}-${focus.dateFrom}-${focus.dateTo}` : 'all'}
                        tableId={preset.tableId}
                        title=""
                        subtitle=""
                        defaultWorkflowFilter={preset.defaultWorkflowFilter}
                        resetFilters={focusFilters ?? preset.resetFilters}
                        showSuggestions={preset.showSuggestions}
                        focusTransactionId={focus?.txId}
                        defaultExpandAllDays={preset.expandAllDays}
                    />
                </TabsContent>

                <TabsContent value="bundles">
                    {preset.showSuggestions && <BundleSuggestionsPanel mb={2} />}
                    {preset.showSuggestions && (
                        <div className="mb-2">
                            <BrokenBundlesPanel onlyCompletable />
                        </div>
                    )}
                    <BundlesListPanel title="" />
                </TabsContent>

                {preset.showSpam && (
                    <TabsContent value="spam">
                        <SuspectedSpamTable tableId="inbox-spam" />
                    </TabsContent>
                )}
            </Tabs>
        </div>
    );
};

export default TransactionsView;
