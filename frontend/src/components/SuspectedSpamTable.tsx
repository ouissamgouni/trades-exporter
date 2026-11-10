import React from 'react';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, TransactionFilterState } from './TransactionFilters';
import { Transaction } from '../types';
import { BulkAction } from './tables/types';
import { SUSPECTED_SPAM_TAG, useSpamVerdict } from '../hooks/useSpamReview';

const SPAM_FILTERS: TransactionFilterState = {
    ...defaultFilterState,
    reviewStatus: ['invalid'],
    tagKeys: [SUSPECTED_SPAM_TAG],
};

/** Suspected-spam review table (Inbox and Data Health). */
export const SuspectedSpamTable: React.FC<{ tableId: string }> = ({ tableId }) => {
    const { applyVerdict, applyTransactionVerdict, isApplying } = useSpamVerdict();
    const bulkActions = React.useMemo<BulkAction<Transaction>[]>(() => [
        {
            id: 'spam-block',
            label: 'Confirm spam',
            icon: '🚫',
            colorPalette: 'gray',
            onClick: (ids) => applyTransactionVerdict(ids, 'block'),
            isDisabled: () => isApplying,
        },
        {
            id: 'spam-allow',
            label: 'Not spam',
            icon: '✓',
            colorPalette: 'green',
            onClick: (ids) => applyTransactionVerdict(ids, 'allow'),
            isDisabled: () => isApplying,
        },
        {
            id: 'spam-allow-token',
            label: 'Not spam (whole token)',
            icon: '✓✓',
            colorPalette: 'green',
            variant: 'ghost',
            onClick: (_ids, txs) => applyVerdict(txs, 'allow'),
            isDisabled: () => isApplying,
        },
    ], [applyVerdict, applyTransactionVerdict, isApplying]);

    return (
        <>
            <p className="mb-2 text-xs text-slate-600">
                Incoming transfers your wallet did not initiate, of tokens with no price source.
                They are excluded from P&amp;L and Data Health. "Confirm spam" and "Not spam" apply to the selected
                transactions only; "Not spam (whole token)" also trusts the token for future syncs.
            </p>
            <TransactionsTable
                tableId={tableId}
                title=""
                subtitle=""
                resetFilters={SPAM_FILTERS}
                emptyMessage="No suspected spam 🎉"
                expandInvalidRows
                defaultExpandAllDays
                additionalBulkActions={bulkActions}
            />
        </>
    );
};
