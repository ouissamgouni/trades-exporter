import React, { createContext, useCallback, useContext, useState } from 'react';

interface AccountDetailPanelState {
    isOpen: boolean;
    accountId: number | null;
    pnlVersionId: number | null;
    initialTab?: string;
    /** Bumped on every open so the panel re-applies initialTab when reopened on the same account */
    openNonce: number;
}

interface AccountDetailPanelOptions {
    pnlVersionId?: number;
    initialTab?: string;
}

interface AccountDetailPanelContextValue {
    openAccountPanel: (accountId: number, opts?: AccountDetailPanelOptions) => void;
    closeAccountPanel: () => void;
    panelState: AccountDetailPanelState;
}

/** Exported for optional access from components that may render outside the provider. */
export const AccountDetailPanelContext = createContext<AccountDetailPanelContextValue | null>(null);

export const AccountDetailPanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [panelState, setPanelState] = useState<AccountDetailPanelState>({
        isOpen: false,
        accountId: null,
        pnlVersionId: null,
        openNonce: 0,
    });

    const openAccountPanel = useCallback((accountId: number, opts?: AccountDetailPanelOptions) => {
        setPanelState(prev => ({
            isOpen: true,
            accountId,
            pnlVersionId: opts?.pnlVersionId ?? null,
            initialTab: opts?.initialTab,
            openNonce: prev.openNonce + 1,
        }));
    }, []);

    const closeAccountPanel = useCallback(() => {
        setPanelState(prev => ({ ...prev, isOpen: false }));
    }, []);

    return (
        <AccountDetailPanelContext.Provider value={{ openAccountPanel, closeAccountPanel, panelState }}>
            {children}
        </AccountDetailPanelContext.Provider>
    );
};

export function useAccountDetailPanel() {
    const ctx = useContext(AccountDetailPanelContext);
    if (!ctx) {
        throw new Error('useAccountDetailPanel must be used within an AccountDetailPanelProvider');
    }
    return ctx;
}
