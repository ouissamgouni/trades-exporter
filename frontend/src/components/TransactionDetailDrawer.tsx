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
import { FiX, FiFileText, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import { LuLocateFixed } from 'react-icons/lu';
import { useShowInAllTransactions } from '../hooks/useShowInAllTransactions';
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
    /** Step to the previous (-1) / next (1) transaction of the host list (also ↑/↓ keys) */
    onNavigate?: (direction: -1 | 1) => void;
    hasPrev?: boolean;
    hasNext?: boolean;
    /** Host-provided "Go to #id" (e.g. locate in the table); defaults to opening it in this drawer */
    onGoTo?: (txId: number) => void;
}

const isTypingTarget = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

export const TransactionDetailDrawer: React.FC<TransactionDetailDrawerProps> = ({
    transaction: propTransaction,
    transactionId,
    isOpen,
    onClose,
    accounts,
    onNotesChange,
    onTagsChange,
    onTransactionUpdate,
    width = '560px',
    onNavigate,
    hasPrev = false,
    hasNext = false,
    onGoTo,
}) => {
    const [goToId, setGoToId] = useState<number | null>(null);
    const [goToInput, setGoToInput] = useState('');
    const [fetchedTransaction, setFetchedTransaction] = useState<Transaction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const showInAllTransactions = useShowInAllTransactions();

    // Determine which transaction to display
    const transaction = goToId != null ? fetchedTransaction : (propTransaction || fetchedTransaction);
    const effectiveId = goToId ?? transactionId;
    const needsFetch = goToId != null || (!propTransaction && transactionId != null);

    useEffect(() => { setGoToId(null); }, [transactionId, propTransaction?.id]);

    useEffect(() => {
        if (!isOpen || !onNavigate) return;
        const onKey = (e: KeyboardEvent) => {
            if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === 'ArrowUp' && hasPrev) { e.preventDefault(); onNavigate(-1); }
            if (e.key === 'ArrowDown' && hasNext) { e.preventDefault(); onNavigate(1); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onNavigate, hasPrev, hasNext]);

    const submitGoTo = () => {
        const id = parseInt(goToInput.replace('#', '').trim(), 10);
        if (!id) return;
        setGoToInput('');
        if (onGoTo) onGoTo(id);
        else setGoToId(id);
    };

    // Fetch transaction if only ID is provided
    useEffect(() => {
        if (!isOpen || !needsFetch) {
            return;
        }

        const fetchTransaction = async () => {
            setLoading(true);
            setError(null);
            try {
                const response = await fetch(`${API_URL}/transactions/${effectiveId}`);
                if (!response.ok) throw new Error(response.status === 404 ? `Transaction #${effectiveId} not found` : 'Failed to fetch transaction');
                const data = await response.json();
                setFetchedTransaction(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load transaction');
            } finally {
                setLoading(false);
            }
        };

        fetchTransaction();
    }, [isOpen, effectiveId, needsFetch]);

    // Clear fetched transaction when drawer closes
    useEffect(() => {
        if (!isOpen) {
            setFetchedTransaction(null);
            setError(null);
            setGoToId(null);
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
                className="fixed inset-x-0 bottom-0 top-auto z-[2001] flex max-h-[90vh] w-full max-w-full flex-col overflow-hidden border-t border-slate-200 bg-white shadow-xl sm:inset-x-auto sm:right-0 sm:top-0 sm:bottom-0 sm:max-h-none sm:w-[var(--sheet-w)] sm:max-w-[90vw] sm:border-l sm:border-t-0"
                style={{ ['--sheet-w' as string]: width }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Compact Header */}
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="flex items-center gap-1.5">
                        <FiFileText size={16} />
                        <span className="text-sm font-semibold">
                            TX #{transaction?.id || effectiveId || '...'}
                        </span>
                        {onNavigate && (
                            <span className="ml-1 inline-flex border border-slate-200 bg-white">
                                <button
                                    type="button"
                                    className="p-1 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                                    title="Previous transaction (↑)"
                                    disabled={!hasPrev}
                                    onClick={() => onNavigate(-1)}
                                >
                                    <FiChevronUp size={14} />
                                </button>
                                <button
                                    type="button"
                                    className="border-l border-slate-200 p-1 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
                                    title="Next transaction (↓)"
                                    disabled={!hasNext}
                                    onClick={() => onNavigate(1)}
                                >
                                    <FiChevronDown size={14} />
                                </button>
                            </span>
                        )}
                        <form
                            className="ml-1"
                            onSubmit={(e) => { e.preventDefault(); submitGoTo(); }}
                        >
                            <input
                                value={goToInput}
                                onChange={(e) => setGoToInput(e.target.value)}
                                placeholder="Go to #id"
                                aria-label="Go to transaction id"
                                inputMode="numeric"
                                className="h-6 w-24 border border-slate-200 bg-white px-1.5 text-xs focus:border-blue-400 focus:outline-none"
                            />
                        </form>
                    </div>
                    <div className="flex items-center gap-1">
                        {transaction && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1 p-1 text-xs text-slate-600"
                                title="Open in All transactions, with the transactions around it"
                                onClick={() => {
                                    onClose();
                                    showInAllTransactions(transaction.id, transaction.date_time);
                                }}
                            >
                                <LuLocateFixed size={14} /> Show in context
                            </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={onClose} className="p-1">
                            <FiX size={16} />
                        </Button>
                    </div>
                </div>

                {/* Content */}
                <div className="flex min-h-0 flex-1 flex-col">
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
