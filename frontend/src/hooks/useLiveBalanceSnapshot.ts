import { useSyncExternalStore } from 'react';
import { liveEntryKey, type AccountBalance } from '../types';

/** Last live-balance fetch (key = liveEntryKey → qty), shared so views outside the P&L provider can show it. */
export interface LiveBalanceSnapshot {
    qtyByKey: Map<string, number>;
    /** key → accountId → qty */
    byAccount: Map<string, Map<number, number>>;
    fetchedAccountIds: Set<number>;
    fetchedAt: number;
}

let snapshot: LiveBalanceSnapshot | null = null;
const listeners = new Set<() => void>();

function emit(next: LiveBalanceSnapshot) {
    snapshot = next;
    listeners.forEach(l => l());
}

export function publishLiveBalanceSnapshot(
    qtyByKey: Map<string, number>,
    byAccount: Map<string, Map<number, number>> = new Map(),
    fetchedAccountIds: Set<number> = new Set(),
): void {
    emit({ qtyByKey, byAccount, fetchedAccountIds, fetchedAt: Date.now() });
}

/** Replaces the given accounts' live balances in the snapshot (other accounts are kept). */
export function mergeAccountLiveBalances(balances: AccountBalance[]): void {
    const byAccount = new Map<string, Map<number, number>>();
    for (const [key, accts] of snapshot?.byAccount ?? []) byAccount.set(key, new Map(accts));
    const fetched = new Set(snapshot?.fetchedAccountIds ?? []);
    for (const ab of balances) {
        fetched.add(ab.account_id);
        for (const accts of byAccount.values()) accts.delete(ab.account_id);
        for (const cb of ab.connector_balances) {
            for (const entry of cb.entries) {
                const key = liveEntryKey(entry);
                if (!byAccount.has(key)) byAccount.set(key, new Map());
                const accts = byAccount.get(key)!;
                accts.set(ab.account_id, (accts.get(ab.account_id) ?? 0) + (parseFloat(entry.total) || 0));
            }
        }
    }
    const qtyByKey = new Map<string, number>();
    for (const [key, accts] of byAccount) {
        let total = 0;
        for (const q of accts.values()) total += q;
        qtyByKey.set(key, total);
    }
    emit({ qtyByKey, byAccount, fetchedAccountIds: fetched, fetchedAt: Date.now() });
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function useLiveBalanceSnapshot(): LiveBalanceSnapshot | null {
    return useSyncExternalStore(subscribe, () => snapshot);
}
