/**
 * TransactionDetailDrawer - Slide-in drawer for full transaction details
 * 
 * Wraps SlidePanel + TransactionDetailPanel for consistent transaction
 * detail inspection across the app. Opens from left side.
 * 
 * Usage:
 * <TransactionDetailDrawer
 *     transaction={selectedTransaction}
 *     isOpen={isDrawerOpen}
 *     onClose={() => setIsDrawerOpen(false)}
 *     accounts={accounts}
 *     onNotesChange={handleNotesChange}
 *     onTagsChange={handleTagsChange}
 * />
 */

import React, { useState, useEffect } from 'react';
import { Box, Flex, Button, Spinner, Text } from '@chakra-ui/react';
import { FiX, FiFileText } from 'react-icons/fi';
import { Transaction, Account, API_URL } from '../types';
import { TransactionDetailPanel } from './TransactionDetailPanel';

interface TransactionDetailDrawerProps {
    /** Full transaction object (if already loaded) */
    transaction?: Transaction | null;
    /** Transaction ID to fetch (alternative to passing full transaction) */
    transactionId?: number | null;
    /** Whether the drawer is open */
    isOpen: boolean;
    /** Callback when drawer is closed */
    onClose: () => void;
    /** List of accounts for display */
    accounts: Account[];
    /** Callback when notes are changed */
    onNotesChange?: (txId: number, notes: string) => void;
    /** Callback when tags are changed */
    onTagsChange?: (txId: number, tags: Record<string, unknown>[]) => void;
    /** Width of the drawer */
    width?: string;
}

export const TransactionDetailDrawer: React.FC<TransactionDetailDrawerProps> = ({
    transaction: propTransaction,
    transactionId,
    isOpen,
    onClose,
    accounts,
    onNotesChange,
    onTagsChange,
    width = '420px',
}) => {
    const [fetchedTransaction, setFetchedTransaction] = useState<Transaction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Determine which transaction to display
    const transaction = propTransaction || fetchedTransaction;
    const needsFetch = !propTransaction && transactionId != null;

    // Fetch transaction if only ID is provided
    useEffect(() => {
        if (!isOpen || !needsFetch) {
            return;
        }

        const fetchTransaction = async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await fetch(`${API_URL}/transactions/${transactionId}`);
                if (!response.ok) throw new Error('Failed to fetch transaction');
                const data = await response.json();
                setFetchedTransaction(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load transaction');
            } finally {
                setLoading(false);
            }
        };

        fetchTransaction();
    }, [isOpen, transactionId, needsFetch]);

    // Clear fetched transaction when drawer closes
    useEffect(() => {
        if (!isOpen) {
            setFetchedTransaction(null);
            setError(null);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    return (
        <>
            {/* Backdrop overlay - clicking closes the panel */}
            <Box
                position="fixed"
                inset={0}
                bg="blackAlpha.400"
                zIndex={99}
                onClick={onClose}
                cursor="pointer"
            />

            {/* Panel - opens from RIGHT side */}
            <Box
                position="fixed"
                right={0}
                top={0}
                bottom={0}
                width={width}
                maxW="90vw"
                bg="white"
                boxShadow="xl"
                zIndex={100}
                overflowY="auto"
                borderLeft="1px solid"
                borderColor="gray.200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Compact Header */}
                <Flex
                    justify="space-between"
                    align="center"
                    px={3}
                    py={2}
                    borderBottom="1px solid"
                    borderColor="gray.200"
                    bg="gray.50"
                    position="sticky"
                    top={0}
                    zIndex={1}
                >
                    <Flex align="center" gap={1.5}>
                        <FiFileText size={16} />
                        <Text fontWeight="semibold" fontSize="sm">
                            TX #{transaction?.id || transactionId || '...'}
                        </Text>
                    </Flex>
                    <Button variant="ghost" size="xs" onClick={onClose} p={1}>
                        <FiX size={16} />
                    </Button>
                </Flex>

                {/* Content */}
                <Box p={2}>
                    {loading && (
                        <Flex justify="center" align="center" py={8}>
                            <Spinner size="lg" />
                            <Text ml={3} color="gray.500">Loading transaction...</Text>
                        </Flex>
                    )}

                    {error && (
                        <Box p={4} bg="red.50" borderRadius="md" color="red.600">
                            <Text fontWeight="bold">Error loading transaction</Text>
                            <Text fontSize="sm">{error}</Text>
                        </Box>
                    )}

                    {transaction && !loading && !error && (
                        <TransactionDetailPanel
                            transaction={transaction}
                            accounts={accounts}
                            onNotesChange={onNotesChange}
                            onTagsChange={onTagsChange}
                        />
                    )}

                    {!transaction && !loading && !error && (
                        <Text color="gray.500" textAlign="center" py={8}>
                            No transaction selected
                        </Text>
                    )}
                </Box>
            </Box>
        </>
    );
};

export default TransactionDetailDrawer;
