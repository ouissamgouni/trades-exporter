/**
 * Drill-Down State Management
 *
 * Separate sub-reducer and context for the P&L drill-down navigation.
 * Keeps drill state decoupled from the main PnLState to avoid bloat
 * and allow reuse in different layouts (sidebar, stacked, fullscreen).
 *
 * Drill levels:
 *  L0 = Portfolio (asset table / charts / audit)
 *  L1 = Asset detail (lots, realized entries)
 *  L2 = Lot / Realized event (individual transaction impact)
 */

import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';
import type { AssetPnLRow, PnLImpactEvent } from './types';


// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type DrillLevel = 'portfolio' | 'asset' | 'event';

export interface DrillBreadcrumb {
    level: DrillLevel;
    label: string;
    /** Restore data needed when navigating back to this level */
    assetId?: number;
}

export interface DrillDownState {
    /** Current drill level */
    level: DrillLevel;

    /** Navigation stack for breadcrumb */
    breadcrumbs: DrillBreadcrumb[];

    /** L1: Selected asset for detail view */
    selectedAsset: AssetPnLRow | null;
    selectedAssetId: number | null;
    /** Optional account filter when drilling from account breakdown */
    accountFilter: number | undefined;

    /** L2: Selected event for impact view */
    selectedEvent: PnLImpactEvent | null;
    selectedEventId: string | null;

    /** Sidebar visibility (responsive) */
    sidebarOpen: boolean;
}


// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════

export type DrillAction =
    | { type: 'DRILL_TO_ASSET'; asset: AssetPnLRow; accountFilter?: number }
    | { type: 'DRILL_TO_EVENT'; event: PnLImpactEvent; label: string }
    | { type: 'DRILL_BACK' }
    | { type: 'DRILL_TO_LEVEL'; level: DrillLevel }
    | { type: 'DRILL_RESET' }
    | { type: 'SET_SIDEBAR_OPEN'; value: boolean }
    | { type: 'UPDATE_SELECTED_ASSET'; asset: AssetPnLRow };


// ═══════════════════════════════════════════════════════════════════════════
// Initial State
// ═══════════════════════════════════════════════════════════════════════════

export function createInitialDrillState(): DrillDownState {
    return {
        level: 'portfolio',
        breadcrumbs: [{ level: 'portfolio', label: 'Portfolio' }],
        selectedAsset: null,
        selectedAssetId: null,
        accountFilter: undefined,
        selectedEvent: null,
        selectedEventId: null,
        sidebarOpen: false,
    };
}


// ═══════════════════════════════════════════════════════════════════════════
// Reducer
// ═══════════════════════════════════════════════════════════════════════════

export function drillReducer(state: DrillDownState, action: DrillAction): DrillDownState {
    switch (action.type) {
        case 'DRILL_TO_ASSET': {
            const label = action.asset.asset.symbol ?? `Asset #${action.asset.asset.id}`;
            return {
                ...state,
                level: 'asset',
                breadcrumbs: [
                    { level: 'portfolio', label: 'Portfolio' },
                    { level: 'asset', label, assetId: action.asset.asset.id ?? undefined },
                ],
                selectedAsset: action.asset,
                selectedAssetId: action.asset.asset.id ?? null,
                accountFilter: action.accountFilter,
                selectedEvent: null,
                selectedEventId: null,
            };
        }

        case 'DRILL_TO_EVENT': {
            return {
                ...state,
                level: 'event',
                breadcrumbs: [
                    ...state.breadcrumbs.filter(b => b.level !== 'event'),
                    { level: 'event', label: action.label },
                ],
                selectedEvent: action.event,
                selectedEventId: action.event.id,
            };
        }

        case 'DRILL_BACK': {
            if (state.breadcrumbs.length <= 1) return state;
            const newBreadcrumbs = state.breadcrumbs.slice(0, -1);
            const targetLevel = newBreadcrumbs[newBreadcrumbs.length - 1].level;

            if (targetLevel === 'portfolio') {
                return {
                    ...state,
                    level: 'portfolio',
                    breadcrumbs: newBreadcrumbs,
                    selectedAsset: null,
                    selectedAssetId: null,
                    accountFilter: undefined,
                    selectedEvent: null,
                    selectedEventId: null,
                };
            }

            if (targetLevel === 'asset') {
                return {
                    ...state,
                    level: 'asset',
                    breadcrumbs: newBreadcrumbs,
                    selectedEvent: null,
                    selectedEventId: null,
                };
            }

            return state;
        }

        case 'DRILL_TO_LEVEL': {
            const targetIdx = state.breadcrumbs.findIndex(b => b.level === action.level);
            if (targetIdx < 0) return state;
            const newBreadcrumbs = state.breadcrumbs.slice(0, targetIdx + 1);
            const targetLevel = action.level;

            if (targetLevel === 'portfolio') {
                return {
                    ...state,
                    level: 'portfolio',
                    breadcrumbs: newBreadcrumbs,
                    selectedAsset: null,
                    selectedAssetId: null,
                    accountFilter: undefined,
                    selectedEvent: null,
                    selectedEventId: null,
                };
            }

            if (targetLevel === 'asset') {
                return {
                    ...state,
                    level: 'asset',
                    breadcrumbs: newBreadcrumbs,
                    selectedEvent: null,
                    selectedEventId: null,
                };
            }

            return state;
        }

        case 'DRILL_RESET':
            return createInitialDrillState();

        case 'SET_SIDEBAR_OPEN':
            return { ...state, sidebarOpen: action.value };

        case 'UPDATE_SELECTED_ASSET':
            return state.selectedAsset
                ? { ...state, selectedAsset: action.asset }
                : state;

        default:
            return state;
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// Context
// ═══════════════════════════════════════════════════════════════════════════

export interface DrillContextValue {
    drillState: DrillDownState;
    drillDispatch: React.Dispatch<DrillAction>;
    /** Navigate to an asset detail */
    drillToAsset: (asset: AssetPnLRow, accountFilter?: number) => void;
    /** Navigate to an event impact view */
    drillToEvent: (event: PnLImpactEvent, label: string) => void;
    /** Go back one level */
    drillBack: () => void;
    /** Jump to a specific breadcrumb level */
    drillToLevel: (level: DrillLevel) => void;
    /** Reset to portfolio level */
    drillReset: () => void;
}

const DrillContext = createContext<DrillContextValue | null>(null);

export function useDrill(): DrillContextValue {
    const ctx = useContext(DrillContext);
    if (!ctx) throw new Error('useDrill must be used within <DrillProvider>');
    return ctx;
}


// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

interface DrillProviderProps {
    children: React.ReactNode;
}

export const DrillProvider: React.FC<DrillProviderProps> = ({ children }) => {
    const [drillState, drillDispatch] = useReducer(drillReducer, undefined, createInitialDrillState);

    const drillToAsset = useCallback((asset: AssetPnLRow, accountFilter?: number) => {
        drillDispatch({ type: 'DRILL_TO_ASSET', asset, accountFilter });
    }, []);

    const drillToEvent = useCallback((event: PnLImpactEvent, label: string) => {
        drillDispatch({ type: 'DRILL_TO_EVENT', event, label });
    }, []);

    const drillBack = useCallback(() => {
        drillDispatch({ type: 'DRILL_BACK' });
    }, []);

    const drillToLevel = useCallback((level: DrillLevel) => {
        drillDispatch({ type: 'DRILL_TO_LEVEL', level });
    }, []);

    const drillReset = useCallback(() => {
        drillDispatch({ type: 'DRILL_RESET' });
    }, []);

    const value = useMemo<DrillContextValue>(() => ({
        drillState,
        drillDispatch,
        drillToAsset,
        drillToEvent,
        drillBack,
        drillToLevel,
        drillReset,
    }), [drillState, drillToAsset, drillToEvent, drillBack, drillToLevel, drillReset]);

    return (
        <DrillContext.Provider value={value}>
            {children}
        </DrillContext.Provider>
    );
};
