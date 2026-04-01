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
import {
    Box,
    Button,
    Flex,
    Heading,
    Spinner,
    Text,
} from '@chakra-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, Bundle } from '../../types';
import { BundleTable } from '../BundleTable';
import { toaster } from '../ui/toaster';

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
        <Box>
            {/* Header — only when title is provided */}
            {title && (
                <Flex justify="space-between" align="center" mb={4}>
                    <Heading size="sm">{title} ({isLoading ? '...' : bundles.length})</Heading>
                    <Flex gap={2}>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={handleRefresh}
                            disabled={isLoading}
                        >
                            {isLoading ? <Spinner size="xs" /> : '↻'} Refresh
                        </Button>
                    </Flex>
                </Flex>
            )}

            {/* Error state */}
            {error && (
                <Box p={4} bg="red.50" borderRadius="md" textAlign="center">
                    <Text color="red.600" fontWeight="bold">
                        Error loading bundles
                    </Text>
                    <Text color="red.600" fontSize="sm">
                        {error instanceof Error ? error.message : 'Unknown error'}
                    </Text>
                    <Button
                        mt={3}
                        size="sm"
                        colorPalette="red"
                        onClick={() => refetch()}
                    >
                        🔄 Retry
                    </Button>
                </Box>
            )}

            {/* Loading state */}
            {isLoading && !error && (
                <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                    <Spinner size="lg" color="blue.500" />
                    <Text mt={4}>Loading bundles...</Text>
                </Box>
            )}

            {/* Bundle table */}
            {!isLoading && !error && (
                <>
                    {bundles.length === 0 ? (
                        <Box p={6} bg="gray.50" borderRadius="md" textAlign="center">
                            <Text color="gray.600">
                                No bundles yet. Select transactions to create a bundle, or accept a suggestion.
                            </Text>
                        </Box>
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
        </Box>
    );
};

export default BundlesListPanel;
