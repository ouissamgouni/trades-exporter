/** Deep link to the P&L audit table centred on a transaction (consumed once by the audit view). */

export interface PendingLocate {
    txId: number;
    dateTime: string | null;
}

const PNL_PAGE = '/pnl/portfolio';
let pending: PendingLocate | null = null;
let lastSearch: string | null = null;

export function pnlLocatePath(txId: number, dateTime?: string | null): string {
    const params = new URLSearchParams({ locate: String(txId) });
    if (dateTime) params.set('locate_at', dateTime);
    return `${PNL_PAGE}?${params.toString()}`;
}

/** Locate request from the URL; re-read only when the URL changes so later rewrites don't lose it. */
export function peekPendingLocate(): PendingLocate | null {
    const search = window.location.search;
    if (search !== lastSearch && new URLSearchParams(search).has('locate')) {
        lastSearch = search;
        const params = new URLSearchParams(search);
        const txId = Number(params.get('locate'));
        pending = txId ? { txId, dateTime: params.get('locate_at') } : null;
    }
    return pending;
}

export function consumePendingLocate(): PendingLocate | null {
    const value = peekPendingLocate();
    pending = null;
    return value;
}

/** True while the current URL carries a locate request (keeps the audit section open). */
export function hasLocateInUrl(): boolean {
    return new URLSearchParams(window.location.search).has('locate');
}
