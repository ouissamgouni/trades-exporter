/**
 * BundleSuggestionsPanel
 * 
 * Displays AI-generated bundle suggestions with accept/dismiss actions.
 * Extracted from TransactionsTable to separate concerns.
 * 
 * Features:
 * - Fetches suggestions from /bundles/suggestions endpoint
 * - Displays suggestion cards with pattern, confidence, transactions
 * - Allows taxability override before accepting
 * - Accept creates a bundle from the suggestion
 * - Collapsible panel
 */

import React, { useState } from 'react';
import { Badge, type BadgeColorScheme, Button, Spinner } from '../ui/primitives';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, BundleSuggestion, TaxabilityStatus } from '../../types';
import { TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../../enums';
import { BundleMemberTransactionsTable } from '../tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from '../ui/toaster';

// ============================================================================
// Types
// ============================================================================

interface BundleSuggestionsPanelProps {
    /** Callback when a suggestion is accepted */
    onAccepted?: () => void;
    /** Callback when a suggestion is dismissed */
    onDismissed?: () => void;
    /** Callback when a transaction in the suggestion is clicked */
    onTransactionClick?: (txId: number) => void;
    /** Maximum number of suggestions to fetch */
    maxSuggestions?: number;
    /** Margin bottom (Chakra spacing) */
    mb?: number | string;
}

// Pattern colors for suggestion cards
const patternColors: Record<string, string> = {
    [UnitPattern.INTERNAL_TRANSFER]: 'blue',
    [UnitPattern.SWAP]: 'orange',
    [UnitPattern.SPLIT]: 'purple',
    [UnitPattern.FLOW]: 'cyan',
    [UnitPattern.SPINOFF]: 'pink',
};

// `cyan`/`pink` above aren't valid BadgeColorScheme values - coerce with a safe fallback.
const VALID_BADGE_COLORS: BadgeColorScheme[] = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toBadgeColor = (color: string): BadgeColorScheme =>
    (VALID_BADGE_COLORS as string[]).includes(color) ? (color as BadgeColorScheme) : 'blue';

// ============================================================================
// Component
// ============================================================================

export const BundleSuggestionsPanel: React.FC<BundleSuggestionsPanelProps> = ({
    onAccepted,
    onDismissed,
    onTransactionClick,
    maxSuggestions = 100,
    mb,
}) => {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(true);
    const [taxabilityOverrides, setTaxabilityOverrides] = useState<Record<number, TaxabilityStatus>>({});
    const [acceptingIndex, setAcceptingIndex] = useState<number | null>(null);

    // Fetch suggestions — shares the ['bundleSuggestions'] cache with App.tsx
    const {
        data: allSuggestions = [],
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: ['bundleSuggestions'],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/bundles/suggestions?max_suggestions=100`);
            if (!response.ok) throw new Error('Failed to fetch suggestions');
            return response.json() as Promise<BundleSuggestion[]>;
        },
    });

    // Slice client-side to the requested max
    const suggestions = allSuggestions.slice(0, maxSuggestions);

    // Accept a suggestion
    const acceptSuggestion = async (suggestion: BundleSuggestion, idx: number) => {
        setAcceptingIndex(idx);
        try {
            const taxabilityOverride = taxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
            const response = await fetch(`${API_URL}/bundles/accept-suggestion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transactions.map(t => t.id),
                    label: suggestion.label,
                    taxability_override: taxabilityOverride,
                }),
            });

            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                queryClient.invalidateQueries({ queryKey: ['bundles'] });
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
                queryClient.invalidateQueries({ queryKey: ['filterOptions'] });

                // Clear override for this suggestion
                setTaxabilityOverrides(prev => {
                    const newOverrides = { ...prev };
                    delete newOverrides[idx];
                    return newOverrides;
                });

                toaster.success({
                    title: 'Bundle created',
                    description: suggestion.label,
                });

                onAccepted?.();
            } else {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to accept suggestion');
            }
        } catch (err) {
            console.error('Failed to accept suggestion:', err);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to create bundle',
            });
        } finally {
            setAcceptingIndex(null);
        }
    };

    // Dismiss a suggestion (persists server-side)
    const dismissSuggestion = async (suggestion: BundleSuggestion, idx: number) => {
        try {
            const response = await fetch(`${API_URL}/bundles/suggestions/dismiss`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transactions.map(t => t.id),
                    label: suggestion.label,
                }),
            });

            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
                toaster.info({
                    title: 'Suggestion dismissed',
                    description: suggestion.label,
                });
                onDismissed?.();
            } else {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to dismiss suggestion');
            }
        } catch (err) {
            console.error('Failed to dismiss suggestion:', err);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to dismiss suggestion',
            });
        }
    };

    // Don't render if no suggestions
    if (!isLoading && suggestions.length === 0) {
        return null;
    }

    return (
        <div
            style={mb !== undefined ? { marginBottom: typeof mb === 'number' ? `${mb * 4}px` : mb } : undefined}
            className="border border-teal-200 bg-teal-50"
        >
            {/* Header */}
            <div
                className="flex cursor-pointer items-center justify-between p-3 hover:bg-teal-100"
                onClick={() => setExpanded(!expanded)}
            >
                <div className="flex items-center gap-2">
                    <span className="font-bold text-teal-700">
                        💡 Suggested Bundles ({isLoading ? '...' : suggestions.length})
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="ghost"
                        colorScheme="gray"
                        className="text-teal-600 hover:bg-teal-50"
                        onClick={(e) => {
                            e.stopPropagation();
                            refetch();
                        }}
                    >
                        ↻ Refresh
                    </Button>
                    <span className="text-teal-600">{expanded ? '▼' : '▶'}</span>
                </div>
            </div>

            {/* Content */}
            {expanded && (
                <div className="p-3 pt-0">
                    {/* Loading state */}
                    {isLoading && (
                        <div className="flex items-center justify-center py-4">
                            <Spinner size="sm" />
                            <span className="ml-2 text-sm text-teal-600">
                                Loading suggestions...
                            </span>
                        </div>
                    )}

                    {/* Error state */}
                    {error && (
                        <div className="bg-red-50 p-3">
                            <span className="text-sm text-red-600">
                                Failed to load suggestions.{' '}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    colorScheme="gray"
                                    onClick={() => refetch()}
                                >
                                    Retry
                                </Button>
                            </span>
                        </div>
                    )}

                    {/* Empty state */}
                    {!isLoading && !error && suggestions.length === 0 && (
                        <span className="text-sm text-teal-600">
                            No bundle suggestions available. Add more transactions to get pattern-based suggestions.
                        </span>
                    )}

                    {/* Suggestion cards */}
                    {!isLoading && !error && suggestions.length > 0 && (
                        <div className="flex flex-wrap gap-3">
                            {suggestions.map((suggestion, idx) => {
                                const currentTaxability = taxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
                                const isAccepting = acceptingIndex === idx;

                                return (
                                    <div key={idx} className="w-[320px] border border-slate-200 bg-white p-3">
                                        {/* Pattern and confidence */}
                                        <div className="mb-2 flex items-center justify-between">
                                            <Badge colorScheme={toBadgeColor(patternColors[suggestion.pattern] || 'gray')}>
                                                {suggestion.pattern}
                                            </Badge>
                                            <span className="text-xs text-slate-500">
                                                {Math.round(suggestion.confidence * 100)}% confidence
                                            </span>
                                        </div>

                                        {/* Label and reason */}
                                        <div className="text-sm font-bold">
                                            {suggestion.label}
                                        </div>
                                        <div className="mt-1 text-xs text-slate-600">
                                            {suggestion.reason}
                                        </div>

                                        {/* Quantity info */}
                                        {suggestion.total_quantity && (
                                            <div className="mt-1 text-xs">
                                                {suggestion.total_quantity} {suggestion.asset_symbol}
                                            </div>
                                        )}

                                        {/* Taxability selector */}
                                        <div className="mt-2 border-t border-slate-100 pt-2">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-slate-500">
                                                    Taxability:
                                                </span>
                                                <select
                                                    value={currentTaxability || TaxabilityStatusEnum.UNKNOWN}
                                                    onChange={(e) => {
                                                        setTaxabilityOverrides(prev => ({
                                                            ...prev,
                                                            [idx]: e.target.value as TaxabilityStatus,
                                                        }));
                                                    }}
                                                    onClick={(e) => e.stopPropagation()}
                                                    className="w-[100px]"
                                                    style={{
                                                        fontSize: '10px',
                                                        padding: '2px 4px',
                                                        backgroundColor:
                                                            currentTaxability === TaxabilityStatusEnum.TAXABLE
                                                                ? '#FED7AA'
                                                                : currentTaxability === TaxabilityStatusEnum.NON_TAXABLE
                                                                    ? '#C6F6D5'
                                                                    : '#FEFCBF',
                                                        borderRadius: '4px',
                                                    }}
                                                >
                                                    <option value={TaxabilityStatusEnum.UNKNOWN}>Unknown</option>
                                                    <option value={TaxabilityStatusEnum.TAXABLE}>Taxable</option>
                                                    <option value={TaxabilityStatusEnum.NON_TAXABLE}>Non-Tax</option>
                                                </select>
                                            </div>
                                        </div>

                                        {/* Transaction list */}
                                        <div className="mt-2 border-t border-slate-100 pt-2">
                                            <span className="mb-1 block text-xs text-slate-500">
                                                {suggestion.transactions.length} transaction
                                                {suggestion.transactions.length !== 1 ? 's' : ''}:
                                            </span>
                                            <BundleMemberTransactionsTable
                                                transactionIds={suggestion.transactions.map(t => t.id)}
                                                onTransactionClick={onTransactionClick}
                                            />
                                        </div>

                                        {/* Actions */}
                                        <div className="mt-3 flex gap-2">
                                            <Button
                                                size="sm"
                                                colorScheme="green"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    acceptSuggestion(suggestion, idx);
                                                }}
                                                disabled={isAccepting}
                                            >
                                                {isAccepting ? (
                                                    <Spinner size="xs" />
                                                ) : (
                                                    '✓ Create Bundle'
                                                )}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    dismissSuggestion(suggestion, idx);
                                                }}
                                                disabled={isAccepting}
                                            >
                                                Dismiss
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default BundleSuggestionsPanel;
