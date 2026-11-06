import { API_URL } from '../../../types';
import {
    AUTO_EXPAND_DAYS_MAX,
    FACET_BAR_MIN_TX,
    FacetKey,
    GroupFacetSelection,
    TransactionGroup,
} from './types';

export const FACET_PARAM: Record<FacetKey, string> = {
    accounts: 'account_id',
    assets: 'asset_id',
    networks: 'network',
    sources: 'source',
};

export const FACET_FILTER_KEY = {
    accounts: 'accountIds',
    assets: 'assetIds',
    networks: 'networks',
    sources: 'sources',
} as const satisfies Record<FacetKey, string>;

export const FACET_LABEL: Record<FacetKey, string> = {
    accounts: 'Accounts',
    assets: 'Assets',
    networks: 'Networks',
    sources: 'Connectors',
};

const FACET_ORDER: FacetKey[] = ['accounts', 'assets', 'networks', 'sources'];

/** Group-local facets override the matching global filter dimension. */
export function applyFacetSelection(params: URLSearchParams, selection?: GroupFacetSelection): URLSearchParams {
    const next = new URLSearchParams(params);
    if (!selection) return next;
    for (const key of FACET_ORDER) {
        const values = selection[key];
        if (values && values.length > 0) next.set(FACET_PARAM[key], values.join(','));
    }
    return next;
}

export function hasFacetSelection(selection?: GroupFacetSelection): boolean {
    return !!selection && FACET_ORDER.some(k => (selection[k]?.length ?? 0) > 0);
}

export function groupRowCount(group: TransactionGroup): number {
    return group.total_count + group.invalid_count;
}

/** Dimensions worth filtering on: only those with at least two distinct values. */
export function facetDimensions(group: TransactionGroup): FacetKey[] {
    return FACET_ORDER.filter(k => group.facets[k].length >= 2);
}

export function shouldAutoShowFacetBar(group: TransactionGroup): boolean {
    return groupRowCount(group) >= FACET_BAR_MIN_TX && facetDimensions(group).length > 0;
}

export function shouldAutoExpandDays(month: TransactionGroup): boolean {
    return groupRowCount(month) <= AUTO_EXPAND_DAYS_MAX;
}

export interface StatusChip {
    key: 'pending' | 'valid' | 'invalid';
    label: string;
    count: number;
}

export function statusChips(group: TransactionGroup): StatusChip[] {
    const chips: StatusChip[] = [
        { key: 'pending', label: 'pending', count: group.pending_count },
        { key: 'valid', label: 'valid', count: group.valid_count },
        { key: 'invalid', label: 'invalid', count: group.invalid_count },
    ];
    return chips.filter(c => c.count > 0);
}

export function formatNetQty(value: number): string {
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;
    const formatted = abs.toLocaleString('en-US', { maximumFractionDigits: digits });
    if (value > 0) return `+${formatted}`;
    if (value < 0) return `−${formatted}`;
    return '0';
}

/** Server-side grouping endpoint for a table data source, or null when only page-local grouping is possible. */
export function groupsUrlFor(customApiUrl?: string): string | null {
    if (!customApiUrl) return `${API_URL}/transactions/groups`;
    const [path, query] = customApiUrl.split('?');
    if (!path.endsWith('/enriched-transactions')) return null;
    return query ? `${path}/groups?${query}` : `${path}/groups`;
}

export function idsUrlFor(customApiUrl?: string): string | null {
    return customApiUrl ? null : `${API_URL}/transactions/ids`;
}
