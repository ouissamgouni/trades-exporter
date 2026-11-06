import { useInfiniteQuery } from '@tanstack/react-query';
import type { TransactionListResponse } from '../../../types';
import { browserTimeZone } from '../../../utils/dateUtils';
import { withParams } from '../../../utils/transactionFilterParams';
import {
    GROUP_ROWS_PAGE_SIZE,
    GroupGranularity,
    MONTHS_PAGE_SIZE,
    TransactionGroupsResponse,
} from './types';

export interface PeriodBounds {
    from: string;
    to: string;
}

/** Narrow a period to the global date filter (all values are naive-UTC ISO strings). */
export function intersectBounds(params: URLSearchParams, bounds?: PeriodBounds): URLSearchParams {
    const next = new URLSearchParams(params);
    if (!bounds) return next;
    const globalFrom = params.get('date_from');
    const globalTo = params.get('date_to');
    next.set('date_from', globalFrom && globalFrom > bounds.from ? globalFrom : bounds.from);
    next.set('date_to', globalTo && globalTo < bounds.to ? globalTo : bounds.to);
    return next;
}

interface UseTransactionGroupsOptions {
    groupsUrl: string | null;
    params: URLSearchParams;
    granularity: GroupGranularity;
    sortDir: 'asc' | 'desc';
    bounds?: PeriodBounds;
    enabled?: boolean;
    pageSize?: number;
}

export function useTransactionGroups({
    groupsUrl,
    params,
    granularity,
    sortDir,
    bounds,
    enabled = true,
    pageSize = MONTHS_PAGE_SIZE,
}: UseTransactionGroupsOptions) {
    const scoped = intersectBounds(params, bounds);
    const tz = browserTimeZone();
    return useInfiniteQuery({
        queryKey: ['transactions', 'groups', groupsUrl, scoped.toString(), granularity, sortDir, tz, pageSize],
        enabled: enabled && !!groupsUrl,
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => {
            const p = new URLSearchParams(scoped);
            p.set('granularity', granularity);
            p.set('tz', tz);
            p.set('sort_dir', sortDir);
            p.set('limit', String(pageSize));
            p.set('offset', String(pageParam));
            const response = await fetch(withParams(groupsUrl!, p));
            if (!response.ok) throw new Error('Failed to load transaction groups');
            return response.json() as Promise<TransactionGroupsResponse>;
        },
        getNextPageParam: (last) => {
            const next = last.offset + last.limit;
            return next < last.total_groups ? next : undefined;
        },
    });
}

interface UseGroupRowsOptions {
    listUrl: string;
    params: URLSearchParams;
    bounds: PeriodBounds;
    sortDir: 'asc' | 'desc';
    enabled: boolean;
}

export function useGroupRows({ listUrl, params, bounds, sortDir, enabled }: UseGroupRowsOptions) {
    const scoped = intersectBounds(params, bounds);
    return useInfiniteQuery({
        queryKey: ['transactions', 'group-rows', listUrl, scoped.toString(), sortDir],
        enabled,
        initialPageParam: 0,
        queryFn: async ({ pageParam }) => {
            const p = new URLSearchParams(scoped);
            p.set('limit', String(GROUP_ROWS_PAGE_SIZE));
            p.set('offset', String(pageParam));
            p.set('sort_by', 'date');
            p.set('sort_dir', sortDir);
            const response = await fetch(withParams(listUrl, p));
            if (!response.ok) throw new Error('Failed to load transactions');
            return response.json() as Promise<TransactionListResponse>;
        },
        getNextPageParam: (last) => {
            const next = last.metadata.offset + last.metadata.limit;
            return next < last.metadata.filtered_count ? next : undefined;
        },
    });
}

export async function fetchGroupIds(idsUrl: string, params: URLSearchParams, bounds: PeriodBounds): Promise<{ ids: number[]; total: number; truncated: boolean }> {
    const response = await fetch(withParams(idsUrl, intersectBounds(params, bounds)));
    if (!response.ok) throw new Error('Failed to load transaction ids');
    return response.json();
}
