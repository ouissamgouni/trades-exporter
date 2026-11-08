import { useCallback } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';

export const SHOW_IN_CONTEXT_WINDOW_DAYS = 3;

function toLocalDateString(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-date window of ± N days around a transaction datetime, or null if unparseable. */
export function contextDateWindow(
    dateTime: string | number | null | undefined,
    windowDays = SHOW_IN_CONTEXT_WINDOW_DAYS,
): { dateFrom: string; dateTo: string } | null {
    if (!dateTime) return null;
    // Backend datetimes are naive UTC strings; numbers are epoch seconds or ms.
    const d = typeof dateTime === 'number'
        ? new Date(dateTime < 1e12 ? dateTime * 1000 : dateTime)
        : new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dateTime) ? dateTime : `${dateTime}Z`);
    if (Number.isNaN(d.getTime())) return null;
    const day = 24 * 3600 * 1000;
    return {
        dateFrom: toLocalDateString(new Date(d.getTime() - windowDays * day)),
        dateTo: toLocalDateString(new Date(d.getTime() + windowDays * day)),
    };
}

/** URL of the All transactions page centred on a transaction (date window ± N days, row highlighted). */
export function showInAllTransactionsPath(txId: number, dateTime?: string | number | null, windowDays = SHOW_IN_CONTEXT_WINDOW_DAYS): string {
    const params = new URLSearchParams({ focus: String(txId) });
    const dateWindow = contextDateWindow(dateTime, windowDays);
    if (dateWindow) {
        params.set('date_from', dateWindow.dateFrom);
        params.set('date_to', dateWindow.dateTo);
    }
    return `/all-transactions?${params.toString()}`;
}

/** Returns a callback that opens the All transactions page around a transaction. */
export function useShowInAllTransactions(): (txId: number, dateTime?: string | number | null) => void {
    const inRouter = useInRouterContext();
    // inRouter never changes for a mounted component, so the conditional hook call is stable.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const navigate = inRouter ? useNavigate() : null;
    return useCallback((txId, dateTime) => {
        const path = showInAllTransactionsPath(txId, dateTime);
        if (navigate) navigate(path);
        else window.location.assign(path);
    }, [navigate]);
}
