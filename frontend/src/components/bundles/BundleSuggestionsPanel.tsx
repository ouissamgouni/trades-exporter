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
import {
    Badge,
    Box,
    Button,
    Card,
    Flex,
    NativeSelect,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, BundleSuggestion, TaxabilityStatus } from '../../types';
import { TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../../enums';
import { BundleTransactionList } from '../BundleTransactionList';
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
};

// ============================================================================
// Component
// ============================================================================

export const BundleSuggestionsPanel: React.FC<BundleSuggestionsPanelProps> = ({
    onAccepted,
    onDismissed,
    onTransactionClick,
    maxSuggestions = 10,
    mb,
}) => {
    const queryClient = useQueryClient();
    const [expanded, setExpanded] = useState(true);
    const [taxabilityOverrides, setTaxabilityOverrides] = useState<Record<number, TaxabilityStatus>>({});
    const [acceptingIndex, setAcceptingIndex] = useState<number | null>(null);

    // Fetch suggestions
    const {
        data: suggestions = [],
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: ['bundleSuggestions', maxSuggestions],
        queryFn: async () => {
            const response = await fetch(`${API_URL}/bundles/suggestions?max_suggestions=${maxSuggestions}`);
            if (!response.ok) throw new Error('Failed to fetch suggestions');
            return response.json() as Promise<BundleSuggestion[]>;
        },
    });

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

    // Dismiss a suggestion (for now, just removes from local state via refetch)
    const dismissSuggestion = async (suggestion: BundleSuggestion, idx: number) => {
        // TODO: Implement server-side dismiss if needed
        toaster.info({
            title: 'Suggestion dismissed',
            description: 'Refresh to see updated suggestions',
        });
        onDismissed?.();
    };

    // Don't render if no suggestions
    if (!isLoading && suggestions.length === 0) {
        return null;
    }

    return (
        <Box
            mb={mb}
            borderWidth={1}
            borderColor="teal.200"
            borderRadius="md"
            bg="teal.50"
        >
            {/* Header */}
            <Flex
                p={3}
                justify="space-between"
                align="center"
                cursor="pointer"
                onClick={() => setExpanded(!expanded)}
                _hover={{ bg: 'teal.100' }}
                borderRadius="md"
            >
                <Flex align="center" gap={2}>
                    <Text fontWeight="bold" color="teal.700">
                        💡 Suggested Bundles ({isLoading ? '...' : suggestions.length})
                    </Text>
                </Flex>
                <Flex align="center" gap={2}>
                    <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="teal"
                        onClick={(e) => {
                            e.stopPropagation();
                            refetch();
                        }}
                    >
                        ↻ Refresh
                    </Button>
                    <Text color="teal.600">{expanded ? '▼' : '▶'}</Text>
                </Flex>
            </Flex>

            {/* Content */}
            {expanded && (
                <Box p={3} pt={0}>
                    {/* Loading state */}
                    {isLoading && (
                        <Flex justify="center" align="center" py={4}>
                            <Spinner size="sm" color="teal.500" />
                            <Text ml={2} color="teal.600" fontSize="sm">
                                Loading suggestions...
                            </Text>
                        </Flex>
                    )}

                    {/* Error state */}
                    {error && (
                        <Box p={3} bg="red.50" borderRadius="md">
                            <Text color="red.600" fontSize="sm">
                                Failed to load suggestions.{' '}
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    colorPalette="red"
                                    onClick={() => refetch()}
                                >
                                    Retry
                                </Button>
                            </Text>
                        </Box>
                    )}

                    {/* Empty state */}
                    {!isLoading && !error && suggestions.length === 0 && (
                        <Text color="teal.600" fontSize="sm">
                            No bundle suggestions available. Add more transactions to get pattern-based suggestions.
                        </Text>
                    )}

                    {/* Suggestion cards */}
                    {!isLoading && !error && suggestions.length > 0 && (
                        <Flex gap={3} flexWrap="wrap">
                            {suggestions.map((suggestion, idx) => {
                                const currentTaxability = taxabilityOverrides[idx] ?? suggestion.taxability_suggestion;
                                const isAccepting = acceptingIndex === idx;

                                return (
                                    <Card.Root key={idx} size="sm" width="320px" bg="white">
                                        <Card.Body p={3}>
                                            {/* Pattern and confidence */}
                                            <Flex justify="space-between" align="center" mb={2}>
                                                <Badge colorPalette={patternColors[suggestion.pattern] || 'gray'}>
                                                    {suggestion.pattern}
                                                </Badge>
                                                <Text fontSize="xs" color="gray.500">
                                                    {Math.round(suggestion.confidence * 100)}% confidence
                                                </Text>
                                            </Flex>

                                            {/* Label and reason */}
                                            <Text fontWeight="bold" fontSize="sm">
                                                {suggestion.label}
                                            </Text>
                                            <Text fontSize="xs" color="gray.600" mt={1}>
                                                {suggestion.reason}
                                            </Text>

                                            {/* Quantity info */}
                                            {suggestion.total_quantity && (
                                                <Text fontSize="xs" mt={1}>
                                                    {suggestion.total_quantity} {suggestion.asset_symbol}
                                                </Text>
                                            )}

                                            {/* Taxability selector */}
                                            <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                <Flex align="center" gap={2}>
                                                    <Text fontSize="xs" color="gray.500">
                                                        Taxability:
                                                    </Text>
                                                    <NativeSelect.Root size="sm" width="100px">
                                                        <NativeSelect.Field
                                                            value={currentTaxability || TaxabilityStatusEnum.UNKNOWN}
                                                            onChange={(e) => {
                                                                setTaxabilityOverrides(prev => ({
                                                                    ...prev,
                                                                    [idx]: e.target.value as TaxabilityStatus,
                                                                }));
                                                            }}
                                                            onClick={(e) => e.stopPropagation()}
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
                                                        </NativeSelect.Field>
                                                    </NativeSelect.Root>
                                                </Flex>
                                            </Box>

                                            {/* Transaction list */}
                                            <Box mt={2} pt={2} borderTopWidth={1} borderColor="gray.100">
                                                <Text fontSize="xs" color="gray.500" mb={1}>
                                                    {suggestion.transactions.length} transaction
                                                    {suggestion.transactions.length !== 1 ? 's' : ''}:
                                                </Text>
                                                <BundleTransactionList
                                                    transactions={suggestion.transactions}
                                                    maxVisible={3}
                                                    colorScheme="teal"
                                                    onTransactionClick={onTransactionClick}
                                                />
                                            </Box>

                                            {/* Actions */}
                                            <Flex mt={3} gap={2}>
                                                <Button
                                                    size="xs"
                                                    colorPalette="green"
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
                                                    size="xs"
                                                    variant="ghost"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        dismissSuggestion(suggestion, idx);
                                                    }}
                                                    disabled={isAccepting}
                                                >
                                                    Dismiss
                                                </Button>
                                            </Flex>
                                        </Card.Body>
                                    </Card.Root>
                                );
                            })}
                        </Flex>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default BundleSuggestionsPanel;
