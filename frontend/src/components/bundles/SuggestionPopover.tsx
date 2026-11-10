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
import * as RadixPopover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, BundleSuggestion, TaxabilityStatus } from '../../types';
import { TaxabilityStatus as TaxabilityStatusEnum, UnitPattern } from '../../enums';
import { BundleMemberTransactionsTable } from '../tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from '../ui/toaster';
import { Button, Spinner } from '../ui/primitives';

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
    const [selectedPattern, setSelectedPattern] = useState<string>(suggestion.pattern);
    const [accepting, setAccepting] = useState(false);

    const acceptSuggestion = async () => {
        setAccepting(true);
        try {
            const response = await fetch(`${API_URL}/bundles/accept-suggestion`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: selectedPattern,
                    transaction_ids: suggestion.transactions.map((t) => t.id),
                    label: suggestion.label,
                    taxability_override: taxability,
                }),
            });

            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['transactions'] });
                queryClient.invalidateQueries({ queryKey: ['bundles'] });
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
                queryClient.invalidateQueries({ queryKey: ['filterOptions'] });

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

    const dismissSuggestion = async () => {
        try {
            const response = await fetch(`${API_URL}/bundles/suggestions/dismiss`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pattern: suggestion.pattern,
                    transaction_ids: suggestion.transactions.map((t) => t.id),
                    label: suggestion.label,
                }),
            });

            if (response.ok) {
                queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
                onOpenChange(false);
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

    return (
        <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
            <RadixPopover.Trigger asChild>
                {children}
            </RadixPopover.Trigger>
            <RadixPopover.Portal>
                <RadixPopover.Content
                    side="right"
                    align="start"
                    sideOffset={4}
                    className="z-[2100] w-[680px] border border-teal-200 bg-white p-0 shadow-lg"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                    <RadixPopover.Arrow className="fill-white" />

                    {/* Header */}
                    <div className="border-b border-teal-100 bg-teal-50 p-3">
                        <div className="mb-1 flex items-center justify-between">
                            <select
                                value={selectedPattern}
                                onChange={(e) => setSelectedPattern(e.target.value)}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                style={{
                                    fontSize: '11px',
                                    padding: '2px 6px',
                                    fontWeight: 600,
                                    backgroundColor: {
                                        [UnitPattern.INTERNAL_TRANSFER]: '#BEE3F8',
                                        [UnitPattern.SWAP]: '#FEEBC8',
                                        [UnitPattern.SPLIT]: '#E9D8FD',
                                        [UnitPattern.FLOW]: '#C6F6D5',
                                        [UnitPattern.SPINOFF]: '#FED7E2',
                                        [UnitPattern.CUSTOM]: '#E2E8F0',
                                        [UnitPattern.UNKNOWN]: '#EDF2F7',
                                    }[selectedPattern] || '#EDF2F7',
                                    borderRadius: '4px',
                                }}
                            >
                                <option value={UnitPattern.SWAP}>Swap</option>
                                <option value={UnitPattern.INTERNAL_TRANSFER}>Internal Transfer</option>
                                <option value={UnitPattern.SPLIT}>Split</option>
                                <option value={UnitPattern.FLOW}>Flow</option>
                                <option value={UnitPattern.SPINOFF}>Spin-Off</option>
                                <option value={UnitPattern.CUSTOM}>Custom</option>
                                <option value={UnitPattern.UNKNOWN}>Unknown</option>
                            </select>
                            <span className="text-xs font-medium text-slate-500">
                                {Math.round(suggestion.confidence * 100)}% confidence
                            </span>
                        </div>
                        <span className="block text-sm font-bold text-teal-800">
                            {suggestion.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-slate-600">
                            {suggestion.reason}
                        </span>
                        {suggestion.total_quantity != null && (
                            <span className="mt-0.5 block font-mono text-xs text-teal-700">
                                {suggestion.total_quantity} {suggestion.asset_symbol}
                            </span>
                        )}
                    </div>

                    {/* Transactions */}
                    <div className="p-3">
                        <span className="mb-1 block text-xs font-medium text-slate-500">
                            {suggestion.transactions.length} transaction
                            {suggestion.transactions.length !== 1 ? 's' : ''}
                        </span>
                        <BundleMemberTransactionsTable
                            transactionIds={suggestion.transactions.map(t => t.id)}
                            onTransactionClick={onTransactionClick}
                        />
                    </div>

                    {/* Taxability + Actions */}
                    <div className="p-3 pt-0">
                        <div className="mb-3 flex items-center gap-2">
                            <span className="text-xs text-slate-500">
                                Taxability:
                            </span>
                            <select
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
                            </select>
                        </div>

                        <div className="flex gap-2">
                            <Button
                                size="sm"
                                colorScheme="green"
                                className="flex-1"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    acceptSuggestion();
                                }}
                                disabled={accepting}
                            >
                                {accepting ? <Spinner size="xs" /> : '✓ Create Bundle'}
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    dismissSuggestion();
                                }}
                                disabled={accepting}
                            >
                                Dismiss
                            </Button>
                        </div>
                    </div>
                </RadixPopover.Content>
            </RadixPopover.Portal>
        </RadixPopover.Root>
    );
};

export default SuggestionPopover;
