import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDataHealth } from '../contexts/DataHealthContext';

/** Queries backing the Data Health tabs (counts and per-tab issue lists). */
export const HEALTH_QUERY_KEYS: readonly (readonly string[])[] = [
    ['dataHealthStatus'],
    ['missingDataIssues'],
    ['assetLinkageIssues'],
    ['accountLinkageIssues'],
    ['brokenBundles'],
    ['duplicateSuspicions'],
    ['spamSummary'],
];

/**
 * Any transaction mutation invalidates the ['transactions'] queries; mirror it to the
 * health queries so tab contents and counts follow edits made from inside the tabs.
 */
export function useHealthAutoRefresh(debounceMs = 400) {
    const queryClient = useQueryClient();
    const { refreshHealthData } = useDataHealth();

    useEffect(() => {
        let timer: number | undefined;
        const unsubscribe = queryClient.getQueryCache().subscribe(event => {
            if (event.type !== 'updated' || event.action.type !== 'invalidate') return;
            if (event.query.queryKey[0] !== 'transactions') return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                HEALTH_QUERY_KEYS.forEach(queryKey => queryClient.invalidateQueries({ queryKey }));
                refreshHealthData();
            }, debounceMs);
        });
        return () => {
            window.clearTimeout(timer);
            unsubscribe();
        };
    }, [queryClient, refreshHealthData, debounceMs]);
}
