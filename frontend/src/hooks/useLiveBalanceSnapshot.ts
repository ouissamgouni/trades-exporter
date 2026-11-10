import { useSyncExternalStore } from 'react';

/** Last live-balance fetch (key = liveEntryKey → qty), shared so views outside the P&L provider can show it. */
export interface LiveBalanceSnapshot {
    qtyByKey: Map<string, number>;
    fetchedAt: number;
}

let snapshot: LiveBalanceSnapshot | null = null;
const listeners = new Set<() => void>();

export function publishLiveBalanceSnapshot(qtyByKey: Map<string, number>): void {
    snapshot = { qtyByKey, fetchedAt: Date.now() };
    listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useLiveBalanceSnapshot(): LiveBalanceSnapshot | null {
    return useSyncExternalStore(subscribe, () => snapshot);
}
