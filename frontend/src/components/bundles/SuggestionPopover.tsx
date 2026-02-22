/**
 * SuggestionPopover
 * 
 * A Chakra Popover that displays bundle suggestion details and actions.
 * Can be triggered from either the left border band or the action icon —
 * both share the same popover via controlled open state.
 * 
 * Content:
 * - Pattern badge + confidence %
 * - Label + reason
 * - Transaction list (BundleTransactionList)
 * - Taxability selector
 * - Accept / Dismiss actions
 */

import React, { useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    NativeSelect,
    Popover,
    Portal,
    Spinner,
    Text,
    VStack,
} from '@chakra-ui/react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, BundleSuggestion, TaxabilityStatus } from '../../types';
import { TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../../enums';
import { BundleTransactionList } from '../BundleTransactionList';
import { toaster } from '../ui/toaster';

// Pattern colors (same as BundleSuggestionsPanel)
const patternColors: Record<string, string> = {
    [UnitPattern.INTERNAL_TRANSFER]: 'blue',
    [UnitPattern.SWAP]: 'orange',
    [UnitPattern.SPLIT]: 'purple',
    [UnitPattern.FLOW]: 'cyan',
};

interface SuggestionPopoverProps {
    /** The suggestion to display */
    suggestion: BundleSuggestion;
    /** Whether the popover is open (controlled) */
    open: boolean;
    /** Callback to close the popover */
    onOpenChange: (open: boolean) => void;
    /** Callback after accepting (parent should refresh) */
    onAccepted?: () => void;
    /** Callback after dismissing */
    onDismissed?: () => void;
    /** Callback when a transaction in the list is clicked */
    onTransactionClick?: (txId: number) => void;
    /** The trigger element(s) */
    children: React.ReactNode;
}

export const SuggestionPopover: React.FC<SuggestionPopoverProps> = ({
    suggestion,
    open,
    onOpenChange,
    onAccepted,
    onDismissed,
    onTransactionClick,
    children,
}) => {
    const queryClient = useQueryClient();
    const [taxability, setTaxability] = useState<TaxabilityStatus>(
        suggestion.taxability_suggestion || TaxabilityStatusEnum.UNKNOWN,
    );
    const [accepting, setAccepting] = useState(false);

    const acceptSuggestion = async () => {
        setAccepting(true);
        try {
            const response = await fetch(`${API_URL}/bundles/accept-suggestion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transactions.map((t) => t.id),
                    label: suggestion.label,
                    taxability_override: taxability,
                }),
            });

            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                queryClient.invalidateQueries({ queryKey: ['bundles'] });
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });

                toaster.success({
                    title: 'Bundle created',
                    description: suggestion.label,
                });

                onOpenChange(false);
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
            setAccepting(false);
        }
    };

    const dismissSuggestion = () => {
        onOpenChange(false);
        toaster.info({
            title: 'Suggestion dismissed',
            description: 'Refresh to see updated suggestions',
        });
        onDismissed?.();
    };

    return (
        <Popover.Root
            open={open}
            onOpenChange={(e) => onOpenChange(e.open)}
            positioning={{ placement: 'right-start' }}
        >
            <Popover.Trigger asChild>
                {children}
            </Popover.Trigger>
            <Portal>
                <Popover.Positioner>
                    <Popover.Content
                        width="340px"
                        shadow="lg"
                        borderWidth={1}
                        borderColor="teal.200"
                        bg="white"
                        p={0}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                        <Popover.Arrow>
                            <Popover.ArrowTip />
                        </Popover.Arrow>

                        {/* Header */}
                        <Box p={3} bg="teal.50" borderBottomWidth={1} borderColor="teal.100">
                            <Flex justify="space-between" align="center" mb={1}>
                                <Badge colorPalette={patternColors[suggestion.pattern] || 'gray'} size="sm">
                                    {suggestion.pattern}
                                </Badge>
                                <Text fontSize="xs" color="gray.500" fontWeight="medium">
                                    {Math.round(suggestion.confidence * 100)}% confidence
                                </Text>
                            </Flex>
                            <Text fontWeight="bold" fontSize="sm" color="teal.800">
                                {suggestion.label}
                            </Text>
                            <Text fontSize="xs" color="gray.600" mt={0.5}>
                                {suggestion.reason}
                            </Text>
                            {suggestion.total_quantity != null && (
                                <Text fontSize="xs" color="teal.700" mt={0.5} fontFamily="mono">
                                    {suggestion.total_quantity} {suggestion.asset_symbol}
                                </Text>
                            )}
                        </Box>

                        {/* Transactions */}
                        <Box p={3}>
                            <Text fontSize="xs" color="gray.500" mb={1} fontWeight="medium">
                                {suggestion.transactions.length} transaction
                                {suggestion.transactions.length !== 1 ? 's' : ''}
                            </Text>
                            <BundleTransactionList
                                transactions={suggestion.transactions}
                                maxVisible={4}
                                colorScheme="teal"
                                onTransactionClick={onTransactionClick}
                            />
                        </Box>

                        {/* Taxability + Actions */}
                        <Box p={3} pt={0}>
                            <Flex align="center" gap={2} mb={3}>
                                <Text fontSize="xs" color="gray.500">
                                    Taxability:
                                </Text>
                                <NativeSelect.Root size="sm" width="110px">
                                    <NativeSelect.Field
                                        value={taxability}
                                        onChange={(e) =>
                                            setTaxability(e.target.value as TaxabilityStatus)
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        style={{
                                            fontSize: '11px',
                                            padding: '2px 6px',
                                            backgroundColor:
                                                taxability === TaxabilityStatusEnum.TAXABLE
                                                    ? '#FED7AA'
                                                    : taxability === TaxabilityStatusEnum.NON_TAXABLE
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

                            <Flex gap={2}>
                                <Button
                                    size="xs"
                                    colorPalette="green"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        acceptSuggestion();
                                    }}
                                    disabled={accepting}
                                    flex={1}
                                >
                                    {accepting ? <Spinner size="xs" /> : '✓ Create Bundle'}
                                </Button>
                                <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        dismissSuggestion();
                                    }}
                                    disabled={accepting}
                                >
                                    Dismiss
                                </Button>
                            </Flex>
                        </Box>
                    </Popover.Content>
                </Popover.Positioner>
            </Portal>
        </Popover.Root>
    );
};

export default SuggestionPopover;
