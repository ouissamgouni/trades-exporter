/**
 * useSyncConfigStore
 *
 * Persists the set of connector IDs that the user has selected for their
 * sync configuration in localStorage.  When the user adds accounts /
 * connectors via the picker modal the IDs are stored here so that the
 * selection survives page reloads.
 *
 * The store exposes a reactive hook (via useSyncExternalStore) so any
 * component that reads from it will re-render when the selection changes.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// localStorage Backing Store
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'sync-config-selected-connectors';

type Snapshot = number[];          // sorted array of connector IDs
let listeners: Array<() => void> = [];
let cached: Snapshot | null = null;

function read(): Snapshot {
    if (cached) return cached;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        cached = raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
        cached = [];
    }
    return cached;
}

function write(ids: number[]) {
    cached = ids;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
    listeners.push(listener);
    return () => {
        listeners = listeners.filter(l => l !== listener);
    };
}

function getSnapshot(): Snapshot {
    return read();
}

// ---------------------------------------------------------------------------
// Public Hook
// ---------------------------------------------------------------------------

export interface UseSyncConfigStoreReturn {
    /** The current set of selected connector IDs. */
    selectedIds: Set<number>;
    /** Raw array form (stable reference for dependency arrays). */
    selectedArray: number[];
    /** Whether there is any selection at all. */
    hasSelection: boolean;
    /** Add connector IDs to the selection. */
    addConnectors: (ids: number[]) => void;
    /** Remove connector IDs from the selection. */
    removeConnectors: (ids: number[]) => void;
    /** Remove all connectors belonging to a given account. */
    removeAccount: (accountId: number, allConnectorIds: number[]) => void;
    /** Replace the entire selection. */
    replaceAll: (ids: number[]) => void;
    /** Clear the selection entirely. */
    clearAll: () => void;
}

export function useSyncConfigStore(): UseSyncConfigStoreReturn {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    const selectedIds = useMemo(() => new Set(snapshot), [snapshot]);

    const addConnectors = useCallback((ids: number[]) => {
        const current = new Set(read());
        for (const id of ids) current.add(id);
        write(Array.from(current).sort((a, b) => a - b));
    }, []);

    const removeConnectors = useCallback((ids: number[]) => {
        const toRemove = new Set(ids);
        write(read().filter(id => !toRemove.has(id)));
    }, []);

    const removeAccount = useCallback((accountId: number, allConnectorIds: number[]) => {
        // allConnectorIds = IDs of connectors belonging to this account
        const toRemove = new Set(allConnectorIds);
        write(read().filter(id => !toRemove.has(id)));
    }, []);

    const replaceAll = useCallback((ids: number[]) => {
        write(Array.from(new Set(ids)).sort((a, b) => a - b));
    }, []);

    const clearAll = useCallback(() => {
        write([]);
    }, []);

    return useMemo(() => ({
        selectedIds,
        selectedArray: snapshot,
        hasSelection: snapshot.length > 0,
        addConnectors,
        removeConnectors,
        removeAccount,
        replaceAll,
        clearAll,
    }), [snapshot, selectedIds, addConnectors, removeConnectors, removeAccount, replaceAll, clearAll]);
}
