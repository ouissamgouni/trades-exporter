import React, { useMemo } from 'react';
import { LuLocateFixed } from 'react-icons/lu';
import type { Transaction } from '../../types';
import type { RowAction } from './types';
import { useShowInAllTransactions } from '../../hooks/useShowInAllTransactions';

/** Row action (next to the TX id) opening the All transactions page around the transaction. */
export function useShowInContextRowAction(): RowAction<Transaction> {
    const showInAllTransactions = useShowInAllTransactions();
    return useMemo(() => ({
        id: 'show-in-context',
        icon: <LuLocateFixed size={11} />,
        label: 'Show in context (All transactions around this one)',
        placement: 'id',
        colorPalette: 'blue',
        onClick: (tx: Transaction) => showInAllTransactions(tx.id, tx.date_time),
    }), [showInAllTransactions]);
}
