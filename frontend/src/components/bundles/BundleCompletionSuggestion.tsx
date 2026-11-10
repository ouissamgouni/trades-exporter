/**
 * BundleCompletionSuggestion
 *
 * Shows the suggested missing leg(s) for a broken bundle (a suggestion whose
 * existing_bundle_id matches) with a one-click "Add to bundle" action.
 * Renders nothing when there is no completion suggestion.
 */

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_URL } from '../../types';
import { useBundleSuggestionMap } from '../../hooks/useBundleSuggestionMap';
import { BundleMemberTransactionsTable } from '../tables/wrappers/BundleMemberTransactionsTable';
import { toaster } from '../ui/toaster';
import { Button, Spinner } from '../ui/primitives';

interface BundleCompletionSuggestionProps {
    bundleId: number;
    memberIds: number[];
    enabled?: boolean;
    onTransactionClick?: (txId: number) => void;
    onCompleted?: () => void;
    className?: string;
}

export const BundleCompletionSuggestion: React.FC<BundleCompletionSuggestionProps> = ({
    bundleId,
    memberIds,
    enabled = true,
    onTransactionClick,
    onCompleted,
    className = '',
}) => {
    const queryClient = useQueryClient();
    const [completing, setCompleting] = useState(false);
    const { suggestions } = useBundleSuggestionMap(enabled);
    const completion = suggestions.find(s => s.existing_bundle_id === bundleId);
    const members = new Set(memberIds);
    const missingLegIds = completion
        ? completion.transactions.map(t => t.id).filter(id => !members.has(id))
        : [];

    if (!completion || missingLegIds.length === 0) return null;

    const handleComplete = async () => {
        setCompleting(true);
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}/add-transactions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_ids: missingLegIds }),
            });
            if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                throw new Error(errorData?.detail || 'Failed to add transactions');
            }
            for (const key of ['transactions', 'bundles', 'bundleSuggestions', 'brokenBundles']) {
                queryClient.invalidateQueries({ queryKey: [key] });
            }
            toaster.success({
                title: `Bundle #${bundleId} completed`,
                description: `Added #${missingLegIds.join(', #')}`,
            });
            onCompleted?.();
        } catch (err) {
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to complete bundle',
            });
        } finally {
            setCompleting(false);
        }
    };

    return (
        <div className={`rounded border border-dashed border-teal-300 bg-teal-50/60 p-2 ${className}`}>
            <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-teal-800">
                    Suggested missing leg{missingLegIds.length !== 1 ? 's' : ''}
                    <span className="ml-1 font-normal text-slate-600">
                        · {Math.round(completion.confidence * 100)}% · {completion.reason}
                    </span>
                </span>
                <Button
                    size="xs"
                    colorScheme="green"
                    disabled={completing}
                    onClick={(e) => {
                        e.stopPropagation();
                        handleComplete();
                    }}
                >
                    {completing ? <Spinner size="xs" /> : '✓ Add to bundle'}
                </Button>
            </div>
            <BundleMemberTransactionsTable
                transactionIds={missingLegIds}
                onTransactionClick={onTransactionClick}
            />
        </div>
    );
};

export default BundleCompletionSuggestion;
