/**
 * BundlesListPanel
 * 
 * Displays existing bundles with management capabilities.
 * Extracted from TransactionsTable to separate concerns.
 * 
 * Features:
 * - Fetches bundles from /bundles endpoint
 * - Displays bundle table using BundleTable component
 * - Edit/delete bundles
 * - Remove transactions from bundles
 * - Refresh functionality
 */

import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Bundle } from '../../types';
import { BundleTable } from '../BundleTable';
import { toaster } from '../ui/toaster';
import { Button, Spinner } from '../ui/primitives';

// ============================================================================
// Types
// ============================================================================

interface BundlesListPanelProps {
    /** Callback when bundles are modified */
    onDataChange?: () => void;
    /** Callback when a transaction in a bundle is clicked */
    onTransactionClick?: (txId: number) => void;
    /** Optional title */
    title?: string;
    /** Minimum transaction count to show bundles */
    minTransactionCount?: number;
}

// ============================================================================
// Component
// ============================================================================

export const BundlesListPanel: React.FC<BundlesListPanelProps> = ({
    onDataChange,
    onTransactionClick,
    title = '📦 Bundles',
    minTransactionCount = 1,
}) => {
    const queryClient = useQueryClient();

    // Fetch bundles
    const {
        data: bundles = [],
        isLoading,
        error,
        refetch,
    } = useQuery({
        queryKey: ['bundles', minTransactionCount],
        queryFn: async () => {
            const response = await fetch(
                `${API_URL}/bundles?min_transaction_count=${minTransactionCount}`
            );
            if (!response.ok) throw new Error('Failed to fetch bundles');
            return response.json() as Promise<Bundle[]>;
        },
    });

    // Bundle update handler
    const handleBundleUpdate = async (bundleId: number, updates: Partial<Bundle>) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            if (!response.ok) throw new Error('Failed to update bundle');

            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            toaster.success({
                title: 'Bundle updated',
                description: 'Changes saved successfully',
            });
            onDataChange?.();
        } catch (err) {
            console.error('Failed to update bundle:', err);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to update bundle',
            });
        }
    };

    // Bundle delete handler
    const handleBundleDelete = async (bundleId: number) => {
        try {
            const response = await fetch(`${API_URL}/bundles/${bundleId}`, {
                method: 'DELETE',
            });
            if (!response.ok) throw new Error('Failed to delete bundle');

            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
            toaster.success({
                title: 'Bundle deleted',
            });
            onDataChange?.();
        } catch (err) {
            console.error('Failed to delete bundle:', err);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to delete bundle',
            });
        }
    };

    // Remove transaction from bundle handler
    const handleRemoveTransactionFromBundle = async (bundleId: number, transactionId: number) => {
        try {
            const response = await fetch(`${API_URL}/transactions/${transactionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_calculation_unit_id: null }),
            });
            if (!response.ok) throw new Error('Failed to remove transaction from bundle');

            queryClient.invalidateQueries({ queryKey: ['transactions'] });
            queryClient.invalidateQueries({ queryKey: ['bundles'] });
            queryClient.invalidateQueries({ queryKey: ['filterOptions'] });
            toaster.success({
                title: 'Transaction removed from bundle',
            });
            onDataChange?.();
        } catch (err) {
            console.error('Failed to remove transaction from bundle:', err);
            toaster.error({
                title: 'Error',
                description: err instanceof Error ? err.message : 'Failed to remove transaction',
            });
        }
    };

    const handleRefresh = () => {
        refetch();
        queryClient.invalidateQueries({ queryKey: ['bundleSuggestions'] });
    };

    return (
        <div>
            {/* Header — only when title is provided */}
            {title && (
                <div className="mb-4 flex items-center justify-between">
                    <span className="text-sm font-semibold">{title} ({isLoading ? '...' : bundles.length})</span>
                    <div className="flex gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRefresh}
                            disabled={isLoading}
                        >
                            {isLoading ? <Spinner size="xs" /> : '↻'} Refresh
                        </Button>
                    </div>
                </div>
            )}

            {/* Error state */}
            {error && (
                <div className="bg-red-50 p-4 text-center">
                    <span className="block font-bold text-red-600">
                        Error loading bundles
                    </span>
                    <span className="block text-sm text-red-600">
                        {error instanceof Error ? error.message : 'Unknown error'}
                    </span>
                    <Button
                        className="mt-3"
                        size="sm"
                        colorScheme="red"
                        onClick={() => refetch()}
                    >
                        🔄 Retry
                    </Button>
                </div>
            )}

            {/* Loading state */}
            {isLoading && !error && (
                <div className="bg-slate-50 py-10 text-center">
                    <Spinner size="lg" className="text-blue-500" />
                    <span className="mt-4 block">Loading bundles...</span>
                </div>
            )}

            {/* Bundle table */}
            {!isLoading && !error && (
                <>
                    {bundles.length === 0 ? (
                        <div className="bg-slate-50 p-6 text-center">
                            <span className="text-slate-600">
                                No bundles yet. Select transactions to create a bundle, or accept a suggestion.
                            </span>
                        </div>
                    ) : (
                        <BundleTable
                            bundles={bundles}
                            onBundleUpdate={handleBundleUpdate}
                            onBundleDelete={handleBundleDelete}
                            onRemoveTransaction={handleRemoveTransactionFromBundle}
                            onRefresh={handleRefresh}
                            onTransactionClick={onTransactionClick}
                        />
                    )}
                </>
            )}
        </div>
    );
};

export default BundlesListPanel;
