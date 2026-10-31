/**
 * TransactionDetailDrawer - Slide-in drawer for viewing & editing transactions.
 *
 * Wraps TransactionSidePanel for unified transaction inspection + inline
 * editing across the app. Opens from right side at 450px width.
 *
 * Usage:
 * <TransactionDetailDrawer
 *     transaction={selectedTransaction}
 *     isOpen={isDrawerOpen}
 *     onClose={() => setIsDrawerOpen(false)}
 *     accounts={accounts}
 *     onNotesChange={handleNotesChange}
 *     onTagsChange={handleTagsChange}
 *     onTransactionUpdate={handleTransactionUpdate}
 * />
 */

import React, { useState, useEffect } from 'react';
import { FiX, FiFileText } from 'react-icons/fi';
import { Transaction, Account, API_URL } from '../types';
import { TransactionSidePanel } from './TransactionSidePanel';
import { Button, Spinner } from './ui/primitives';

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
    /** Callback when a transaction field is updated inline */
    onTransactionUpdate?: (updated: Transaction) => void;
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
    onTransactionUpdate,
    width = '450px',
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
            <div
                className="fixed inset-0 z-[2000] cursor-pointer bg-black/40"
                onClick={onClose}
            />

            {/* Panel: bottom sheet on mobile, right-side panel on sm+ */}
            <div
                className="fixed inset-x-0 bottom-0 top-auto z-[2001] max-h-[90vh] w-full max-w-full overflow-y-auto border-t border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[90vw] sm:border-l sm:border-t-0"
                style={{ ['--sheet-w' as string]: width }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Compact Header */}
                <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                        <FiFileText size={16} />
                        <span className="text-sm font-semibold">
                            TX #{transaction?.id || transactionId || '...'}
                        </span>
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose} className="p-1">
                        <FiX size={16} />
                    </Button>
                </div>

                {/* Content */}
                <div className="p-2">
                    {loading && (
                        <div className="flex items-center justify-center py-8">
                            <Spinner size="lg" />
                            <span className="ml-3 text-slate-500">Loading transaction...</span>
                        </div>
                    )}

                    {error && (
                        <div className="bg-red-50 p-4 text-red-600">
                            <span className="block font-bold">Error loading transaction</span>
                            <span className="block text-sm">{error}</span>
                        </div>
                    )}

                    {transaction && !loading && !error && (
                        <TransactionSidePanel
                            transaction={transaction}
                            accounts={accounts}
                            onNotesChange={onNotesChange}
                            onTagsChange={onTagsChange}
                            onTransactionUpdate={(updated) => {
                                // Update local state if we fetched the transaction
                                if (needsFetch) setFetchedTransaction(updated);
                                onTransactionUpdate?.(updated);
                            }}
                        />
                    )}

                    {!transaction && !loading && !error && (
                        <span className="block py-8 text-center text-slate-500">
                            No transaction selected
                        </span>
                    )}
                </div>
            </div>
        </>
    );
};

export default TransactionDetailDrawer;
