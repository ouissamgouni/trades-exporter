/**
 * AssetDetailPanelContext
 *
 * Provides `openAssetPanel(assetId, opts?)` to any component in the tree
 * so asset detail panel can be opened from anywhere without prop drilling.
 */

import React, { createContext, useCallback, useContext, useState } from 'react';

export interface AssetDetailPanelOptions {
    /** Tab to open by default: 'details' | 'price-getters' | 'categories' */
    initialTab?: string;
    /** PnL version ID to use (when opened from PnL context) */
    pnlVersionId?: number;
}

interface AssetDetailPanelState {
    isOpen: boolean;
    assetId: number | null;
    initialTab: string;
    pnlVersionId: number | null;
}

interface AssetDetailPanelContextValue {
    /** Open the asset detail panel for a given asset */
    openAssetPanel: (assetId: number, opts?: AssetDetailPanelOptions) => void;
    /** Close the panel */
    closeAssetPanel: () => void;
    /** Current panel state */
    panelState: AssetDetailPanelState;
}

const AssetDetailPanelContext = createContext<AssetDetailPanelContextValue | null>(null);

/** Exported for safe optional access (e.g. AssetBadge which may render outside the provider) */
export { AssetDetailPanelContext };

export const AssetDetailPanelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [panelState, setPanelState] = useState<AssetDetailPanelState>({
        isOpen: false,
        assetId: null,
        initialTab: 'details',
        pnlVersionId: null,
    });

    const openAssetPanel = useCallback((assetId: number, opts?: AssetDetailPanelOptions) => {
        setPanelState({
            isOpen: true,
            assetId,
            initialTab: opts?.initialTab ?? 'details',
            pnlVersionId: opts?.pnlVersionId ?? null,
        });
    }, []);

    const closeAssetPanel = useCallback(() => {
        setPanelState(prev => ({ ...prev, isOpen: false }));
    }, []);

    return (
        <AssetDetailPanelContext.Provider value={{ openAssetPanel, closeAssetPanel, panelState }}>
            {children}
        </AssetDetailPanelContext.Provider>
    );
};

/**
 * Hook to access the asset detail panel from any component.
 * Returns `openAssetPanel(assetId, opts?)` and `closeAssetPanel()`.
 */
export function useAssetDetailPanel() {
    const ctx = useContext(AssetDetailPanelContext);
    if (!ctx) {
        throw new Error('useAssetDetailPanel must be used within an AssetDetailPanelProvider');
    }
    return ctx;
}
