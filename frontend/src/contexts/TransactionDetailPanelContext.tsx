import React, { createContext, useCallback, useContext, useState } from 'react';

interface TransactionDetailPanelContextValue {
    openTransactionPanel: (transactionId: number) => void;
    closeTransactionPanel: () => void;
    transactionId: number | null;
}

/** Exported for optional access from components that may render outside the provider. */
export const TransactionDetailPanelContext = createContext<TransactionDetailPanelContextValue | null>(null);

export const TransactionDetailPanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [transactionId, setTransactionId] = useState<number | null>(null);
    const openTransactionPanel = useCallback((id: number) => setTransactionId(id), []);
    const closeTransactionPanel = useCallback(() => setTransactionId(null), []);
    return (
        <TransactionDetailPanelContext.Provider value={{ openTransactionPanel, closeTransactionPanel, transactionId }}>
            {children}
        </TransactionDetailPanelContext.Provider>
    );
};

export function useTransactionDetailPanel() {
    const ctx = useContext(TransactionDetailPanelContext);
    if (!ctx) {
        throw new Error('useTransactionDetailPanel must be used within a TransactionDetailPanelProvider');
    }
    return ctx;
}
