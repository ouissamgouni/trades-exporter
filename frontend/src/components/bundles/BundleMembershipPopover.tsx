/**
 * BundleMembershipPopover
 *
 * A Chakra Popover that displays bundle details for transactions already
 * belonging to a bundle. Fetches full bundle data (pattern, label, notes,
 * transactions) lazily when opened.
 *
 * Content:
 * - Pattern badge + bundle ID
 * - Label + notes
 * - Transaction list (BundleTransactionList)
 * - "Remove from bundle" action
 */

import React, { useEffect, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL, Bundle } from '../../types';
import { TaxabilityStatus, UnitPattern } from '../../enums';
import { BundleMemberTransactionsTable } from '../tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from '../ui/toaster';
import { Badge, Button, Spinner } from '../ui/primitives';
import { BundleCompletionSuggestion } from './BundleCompletionSuggestion';

interface BundleMembershipPopoverProps {
    /** The bundle ID to display */
    bundleId: number;
    /** Color token for the bundle band */
    color: string;
    /** Whether the popover is open (controlled) */
    open: boolean;
    /** Callback to toggle open state */
    onOpenChange: (open: boolean) => void;
    /** Callback when a transaction in the list is clicked */
    onTransactionClick?: (txId: number) => void;
    /** The trigger element(s) */
    children: React.ReactNode;
}

export const BundleMembershipPopover: React.FC<BundleMembershipPopoverProps> = ({
    bundleId,
    color,
    open,
    onOpenChange,
    onTransactionClick,
    children,
}) => {
    const queryClient = useQueryClient();
    const [bundle, setBundle] = useState<Bundle | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [taxability, setTaxability] = useState<string>(TaxabilityStatus.UNKNOWN);
    const [taxabilityLoading, setTaxabilityLoading] = useState(false);
    const [pattern, setPattern] = useState<string>(UnitPattern.UNKNOWN);

    // Fetch bundle details lazily when opened
    useEffect(() => {
        if (!open) return;
        let cancelled = false;

        const fetchBundle = async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await fetch(`${API_URL}/bundles/${bundleId}`);
                if (!response.ok) throw new Error('Failed to fetch bundle');
                const data = await response.json();
                if (!cancelled) setBundle(data);
                if (!cancelled) setTaxability(data.taxability_override || TaxabilityStatus.UNKNOWN);
                if (!cancelled) setPattern(data.pattern || UnitPattern.UNKNOWN);
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        fetchBundle();
        return () => { cancelled = true; };
    }, [open, bundleId]);

    // Update bundle field via PATCH
    const patchBundle = async (updates: Record<string, any>, label: string) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            if (!response.ok) throw new Error(`Failed to update ${label}`);

            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });

            toaster.success({
                title: `${label} updated`,
                description: `Bundle #${bundleId}`,
            });
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : `Failed to update ${label}`,
            });
            throw err;
        }
    };

    const handleTaxabilityChange = async (newValue: string) => {
        const prev = taxability;
        setTaxability(newValue);
        setTaxabilityLoading(true);
        try {
            await patchBundle(
                { taxability_override: newValue === TaxabilityStatus.UNKNOWN ? null : newValue },
                'Taxability',
            );
        } catch {
            setTaxability(prev);
        } finally {
            setTaxabilityLoading(false);
        }
    };

    const handlePatternChange = async (newValue: string) => {
        const prev = pattern;
        setPattern(newValue);
        try {
            await patchBundle({ pattern: newValue }, 'Pattern');
        } catch {
            setPattern(prev);
        }
    };

    const handleRemoveFromBundle = async (txId: number) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}/remove-transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: [txId] }),
            });
            if (!response.ok) throw new Error('Failed to remove transaction');

            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
            queryClient.invalidateQueries({ queryKey: ['filterOptions'] });

            toaster.success({
                title: 'Removed from bundle',
                description: `Transaction #${txId} removed`,
            });

            // Refresh bundle data
            const updated = await fetch(`${API_URL}/bundles/${bundleId}`);
            if (updated.ok) {
                setBundle(await updated.json());
            }
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to remove transaction',
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
                    className="z-[2100] w-[680px] border border-purple-200 bg-white p-0 shadow-lg"
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                    <RadixPopover.Arrow className="fill-white" />

                    {/* Header */}
                    <div className="border-b border-purple-100 bg-purple-50 p-3">
                        <div className="mb-1 flex items-center justify-between">
                            {loading ? (
                                <Spinner size="xs" />
                            ) : bundle ? (
                                <select
                                    value={pattern}
                                    onChange={(e) => handlePatternChange(e.target.value)}
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
                                        }[pattern] || '#EDF2F7',
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
                            ) : null}
                            <Badge colorScheme="purple">
                                📦 #{bundleId}
                            </Badge>
                        </div>
                        {error && (
                            <span className="block text-xs text-red-500">{error}</span>
                        )}
                        {bundle && (
                            <>
                                <span className="block text-sm font-bold text-purple-800">
                                    {bundle.label || `Bundle #${bundleId}`}
                                </span>
                                {bundle.notes && (
                                    <span className="mt-0.5 block text-xs text-slate-600">
                                        {bundle.notes}
                                    </span>
                                )}
                                {/* Taxability Override */}
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="shrink-0 text-xs text-slate-500">
                                        Taxability:
                                    </span>
                                    <select
                                        value={taxability}
                                        onChange={(e) => handleTaxabilityChange(e.target.value)}
                                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                        style={{
                                            fontSize: '11px',
                                            padding: '2px 6px',
                                            backgroundColor:
                                                taxability === TaxabilityStatus.TAXABLE
                                                    ? '#FED7AA'
                                                    : taxability === TaxabilityStatus.NON_TAXABLE
                                                        ? '#C6F6D5'
                                                        : '#FEFCBF',
                                            borderRadius: '4px',
                                        }}
                                    >
                                        <option value={TaxabilityStatus.UNKNOWN}>Unknown</option>
                                        <option value={TaxabilityStatus.TAXABLE}>Taxable</option>
                                        <option value={TaxabilityStatus.NON_TAXABLE}>Non-Taxable</option>
                                    </select>
                                </div>
                            </>
                        )}
                    </div>

                    {/* Transactions */}
                    <div className="p-3">
                        {loading ? (
                            <div className="flex items-center gap-2">
                                <Spinner size="xs" />
                                <span className="text-xs text-slate-500">Loading...</span>
                            </div>
                        ) : bundle ? (
                            <>
                                <span className="mb-1 block text-xs font-medium text-slate-500">
                                    {bundle.transaction_count} transaction
                                    {bundle.transaction_count !== 1 ? 's' : ''}
                                </span>
                                <BundleMemberTransactionsTable
                                    transactionIds={bundle.transactions.map(t => t.id)}
                                    onTransactionClick={onTransactionClick}
                                />
                            </>
                        ) : null}
                    </div>

                    {bundle && (
                        <BundleCompletionSuggestion
                            bundleId={bundleId}
                            memberIds={bundle.transactions.map(t => t.id)}
                            enabled={open}
                            onTransactionClick={onTransactionClick}
                            onCompleted={async () => {
                                const updated = await fetch(`${API_URL}/bundles/${bundleId}`);
                                if (updated.ok) setBundle(await updated.json());
                            }}
                            className="mx-3 mb-3"
                        />
                    )}

                    {/* Actions */}
                    {bundle && (
                        <div className="p-3 pt-0">
                            <div className="flex gap-2">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    colorScheme="red"
                                    className="flex-1"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        // Remove the triggering tx from the bundle
                                        // We don't know which tx triggered, so we close for now
                                        onOpenChange(false);
                                    }}
                                >
                                    Close
                                </Button>
                            </div>
                        </div>
                    )}
                </RadixPopover.Content>
            </RadixPopover.Portal>
        </RadixPopover.Root>
    );
};

export default BundleMembershipPopover;
