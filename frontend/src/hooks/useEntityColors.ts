/**
 * useEntityColors
 *
 * Manages per-account and per-connector color assignments.
 * Colors are hex strings from the shared ENTITY_COLOR_PALETTE (same palette
 * style as categories). Auto-assigned via getNextAvailableColor to avoid
 * duplicates; can be overridden by the user or stored in the DB.
 *
 * Usage:
 *   const { getAccountColor, getConnectorColor, ... } = useEntityColors();
 *   <Badge style={{ background: getAccountColor(id, name, dbColor) }}>...</Badge>
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

// ============================================================================
// Color Palette – hex values, Tableau-inspired (mirrors constants/colors.ts)
// ============================================================================

/** Hex color palette for entity badges – darker tones for strong contrast. */
export const ENTITY_COLOR_PALETTE = [
    // Blues
    '#2B5C8A',
    '#1A4971',
    '#1F6F9F',
    '#1B4F72',
    // Teals & Cyans
    '#1E7A6D',
    '#1A6B60',
    '#1B7D72',
    '#217A6E',
    // Greens
    '#2E7D32',
    '#3A7D44',
    '#3B7A3E',
    '#2D6A30',
    // Yellows & Ochres
    '#A68B00',
    '#8B7A00',
    '#7D6608',
    '#9A7B00',
    // Oranges
    '#C56A00',
    '#B55A00',
    '#D46B08',
    '#A85A00',
    // Reds & Pinks
    '#C0392B',
    '#A93226',
    '#922B21',
    '#B03A2E',
    // Purples & Violets
    '#76448A',
    '#6C3483',
    '#5B2C6F',
    '#7D3C98',
    // Neutrals
    '#4A4543',
    '#4A5568',
] as const;

export type EntityColor = string;

/** Default fallback color when nothing is set */
export const DEFAULT_ENTITY_COLOR = '#2B5C8A';

/**
 * Convert a hex colour to rgba string for transparency effects.
 */
export function hexToRgba(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Returns the first color from the palette not in `usedColors`.
 * Cycles back to index 0 when all are used.
 */
export function getNextAvailableEntityColor(usedColors: string[]): string {
    const normalised = new Set(usedColors.map(c => c?.toLowerCase()));
    for (const color of ENTITY_COLOR_PALETTE) {
        if (!normalised.has(color.toLowerCase())) return color;
    }
    return ENTITY_COLOR_PALETTE[0];
}

// ============================================================================
// localStorage Store
// ============================================================================

const STORAGE_KEY_ACCOUNTS = 'entity-colors-accounts';
const STORAGE_KEY_CONNECTORS = 'entity-colors-connectors';

interface ColorOverrides {
    accounts: Record<string, string>;   // key: accountId → hex
    connectors: Record<string, string>; // key: connectorName → hex
}

let listeners: Array<() => void> = [];
let cachedOverrides: ColorOverrides | null = null;

function getOverrides(): ColorOverrides {
    if (cachedOverrides) return cachedOverrides;
    try {
        const accounts = JSON.parse(localStorage.getItem(STORAGE_KEY_ACCOUNTS) || '{}');
        const connectors = JSON.parse(localStorage.getItem(STORAGE_KEY_CONNECTORS) || '{}');
        cachedOverrides = { accounts, connectors };
    } catch {
        cachedOverrides = { accounts: {}, connectors: {} };
    }
    return cachedOverrides;
}

function saveOverrides(overrides: ColorOverrides) {
    cachedOverrides = overrides;
    localStorage.setItem(STORAGE_KEY_ACCOUNTS, JSON.stringify(overrides.accounts));
    localStorage.setItem(STORAGE_KEY_CONNECTORS, JSON.stringify(overrides.connectors));
    listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
    listeners.push(listener);
    return () => {
        listeners = listeners.filter(l => l !== listener);
    };
}

function getSnapshot(): ColorOverrides {
    return getOverrides();
}

// ============================================================================
// Deterministic Hash Color Assignment
// ============================================================================

function hashToIndex(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash) % ENTITY_COLOR_PALETTE.length;
}

// ============================================================================
// Hook
// ============================================================================

export interface UseEntityColorsReturn {
    /** Get hex color for an account. Priority: dbColor > localStorage > hash */
    getAccountColor: (accountId: number | null | undefined, accountName?: string | null, dbColor?: string | null) => string;
    /** Get hex color for a connector. Priority: dbColor > localStorage > hash */
    getConnectorColor: (connectorName: string | null | undefined, dbColor?: string | null) => string;
    /** Override color for a specific account */
    setAccountColor: (accountId: number, color: string) => void;
    /** Override color for a specific connector */
    setConnectorColor: (connectorName: string, color: string) => void;
    /** Remove account override */
    resetAccountColor: (accountId: number) => void;
    /** Remove connector override */
    resetConnectorColor: (connectorName: string) => void;
    /** Clear all overrides */
    resetAllColors: () => void;
    /** All account overrides */
    accountOverrides: Record<string, string>;
    /** All connector overrides */
    connectorOverrides: Record<string, string>;
    /** Available palette colors */
    palettes: readonly string[];
}

export function useEntityColors(): UseEntityColorsReturn {
    const overrides = useSyncExternalStore(subscribe, getSnapshot);

    const getAccountColor = useCallback(
        (accountId: number | null | undefined, accountName?: string | null, dbColor?: string | null): string => {
            if (dbColor) return dbColor;
            if (accountId == null) return DEFAULT_ENTITY_COLOR;
            const key = String(accountId);
            if (overrides.accounts[key]) return overrides.accounts[key];
            const seed = accountName || key;
            return ENTITY_COLOR_PALETTE[hashToIndex(seed)];
        },
        [overrides],
    );

    const getConnectorColor = useCallback(
        (connectorName: string | null | undefined, dbColor?: string | null): string => {
            if (dbColor) return dbColor;
            if (!connectorName) return DEFAULT_ENTITY_COLOR;
            if (overrides.connectors[connectorName]) return overrides.connectors[connectorName];
            return ENTITY_COLOR_PALETTE[hashToIndex(connectorName)];
        },
        [overrides],
    );

    const setAccountColor = useCallback((accountId: number, color: string) => {
        const current = getOverrides();
        saveOverrides({
            ...current,
            accounts: { ...current.accounts, [String(accountId)]: color },
        });
    }, []);

    const setConnectorColor = useCallback((connectorName: string, color: string) => {
        const current = getOverrides();
        saveOverrides({
            ...current,
            connectors: { ...current.connectors, [connectorName]: color },
        });
    }, []);

    const resetAccountColor = useCallback((accountId: number) => {
        const current = getOverrides();
        const { [String(accountId)]: _, ...rest } = current.accounts;
        saveOverrides({ ...current, accounts: rest });
    }, []);

    const resetConnectorColor = useCallback((connectorName: string) => {
        const current = getOverrides();
        const { [connectorName]: _, ...rest } = current.connectors;
        saveOverrides({ ...current, connectors: rest });
    }, []);

    const resetAllColors = useCallback(() => {
        saveOverrides({ accounts: {}, connectors: {} });
    }, []);

    const palettes = ENTITY_COLOR_PALETTE;

    return useMemo(() => ({
        getAccountColor,
        getConnectorColor,
        setAccountColor,
        setConnectorColor,
        resetAccountColor,
        resetConnectorColor,
        resetAllColors,
        accountOverrides: overrides.accounts,
        connectorOverrides: overrides.connectors,
        palettes,
    }), [
        getAccountColor,
        getConnectorColor,
        setAccountColor,
        setConnectorColor,
        resetAccountColor,
        resetConnectorColor,
        resetAllColors,
        overrides,
        palettes,
    ]);
}
