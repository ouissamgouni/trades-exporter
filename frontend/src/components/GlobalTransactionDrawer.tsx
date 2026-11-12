import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTransactionDetailPanel } from '../contexts/TransactionDetailPanelContext';
import { useAccounts } from '../hooks/useAccounts';
import { TransactionDetailDrawer } from './TransactionDetailDrawer';

/** Mounted once in App.tsx; driven by TransactionDetailPanelContext. */
export const GlobalTransactionDrawer: React.FC = () => {
    const { transactionId, closeTransactionPanel } = useTransactionDetailPanel();
    const isOpen = transactionId != null;
    const { accounts } = useAccounts(isOpen);
    const queryClient = useQueryClient();
    return (
        <TransactionDetailDrawer
            transactionId={transactionId}
            isOpen={isOpen}
            onClose={closeTransactionPanel}
            accounts={accounts}
            onTransactionUpdate={() => queryClient.invalidateQueries({ queryKey: ['transactions'], refetchType: 'active' })}
        />
    );
};
