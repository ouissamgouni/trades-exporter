import { API_URL } from '../../../types';
import {
    AUTO_EXPAND_DAYS_MAX,
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

export function shouldAutoExpandDays(month: TransactionGroup): boolean {
    return groupRowCount(month) <= AUTO_EXPAND_DAYS_MAX;
}

export function formatNetQty(value: number): string {
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;
    const formatted = abs.toLocaleString('en-US', { maximumFractionDigits: digits });
    if (value > 0) return `+${formatted}`;
    if (value < 0) return `−${formatted}`;
    return '0';
}

/**
 * Group-level money amount: 2 decimals, no leading sign for positives (colour carries direction),
 * dust below 0.01 shown as `<0.01`. Pair with {@link formatGroupAmountExact} as the tooltip.
 */
export function formatGroupAmount(value: number): string {
    const abs = Math.abs(value);
    if (abs === 0) return '0.00';
    if (abs < 0.01) return value > 0 ? '<0.01' : '>−0.01';
    const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return value < 0 ? `−${formatted}` : formatted;
}

/** Exact value (up to 6 significant digits, never exponent notation) for tooltips. */
export function formatGroupAmountExact(value: number): string {
    return value.toLocaleString('en-US', { maximumSignificantDigits: 6 });
}

export function truncateSymbol(symbol: string, max = 8): string {
    return symbol.length > max ? `${symbol.slice(0, max)}…` : symbol;
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

/** Same params without invalid rows, or null when the status filter only keeps invalid ones. */
export function withoutInvalid(params: URLSearchParams): URLSearchParams | null {
    const current = params.get('review_status');
    const statuses = (current ? current.split(',') : ['pending', 'valid', 'invalid']).filter(s => s && s !== 'invalid');
    if (statuses.length === 0) return null;
    const next = new URLSearchParams(params);
    next.set('review_status', statuses.join(','));
    return next;
}
