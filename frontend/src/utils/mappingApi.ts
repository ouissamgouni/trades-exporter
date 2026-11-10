/**
 * Raw asset / raw account mapping workbench API (overview, suggestions, ignore, lookup).
 */

import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { API_URL } from '../types';
import { rawAssetKeyQuery } from './rawAccountApi';

export type MappingStatus = 'suggested' | 'unmapped' | 'mapped' | 'ignored';

export type SuggestionReason =
    | 'known_contract'
    | 'official_deployment'
    | 'unverified_contract'
    | 'known_symbol'
    | 'exact_symbol'
    | 'known_label'
    | 'exact_address'
    | 'exact_name'
    | 'similar';

export interface MappingSuggestion {
    id: number;
    name: string;
    confidence: number;
    reason?: SuggestionReason | null;
}

/** Same threshold as the backend: only these may be accepted in bulk. */
export const VERIFIED_CONFIDENCE = 0.9;

export const isVerified = (s?: MappingSuggestion | null) => !!s && s.confidence >= VERIFIED_CONFIDENCE;

interface MappingRowBase {
    source: string;
    network: string;
    status: MappingStatus;
    suggestion?: MappingSuggestion | null;
    usage_count: number;
    first_seen?: string | null;
    last_seen?: string | null;
    dismissed: boolean;
    dismissed_at?: string | null;
    dismissed_reason?: string | null;
}

export interface RawAssetRow extends MappingRowBase {
    symbol: string;
    contract_address: string;
    asset_id?: number | null;
    asset_symbol?: string | null;
    asset_label?: string | null;
    spam_verdict?: 'allow' | 'block' | null;
}

export interface RawAccountRow extends MappingRowBase {
    id: number;
    label: string;
    account_id?: number | null;
    account_name?: string | null;
    account_type?: string | null;
    account_count: number;
    from_count: number;
    to_count: number;
}

export interface MappingOverview<T> {
    items: T[];
    counts: Record<MappingStatus, number>;
    /** All suggestions that may be bulk-accepted (ignores filters) */
    verified_count: number;
    sources: string[];
    networks: string[];
}

export interface MappingFilters {
    status?: MappingStatus | '';
    q?: string;
    source?: string;
    network?: string;
}

export const RAW_ASSET_OVERVIEW_KEY = ['raw-assets', 'overview'] as const;
export const RAW_ACCOUNT_OVERVIEW_KEY = ['raw-accounts', 'overview'] as const;

const filterParams = (f: MappingFilters) => {
    const p = new URLSearchParams();
    if (f.status) p.set('status', f.status);
    if (f.q?.trim()) p.set('q', f.q.trim());
    if (f.source) p.set('source', f.source);
    if (f.network) p.set('network', f.network);
    return p;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || `Request failed (${res.status})`);
    }
    return res.json() as Promise<T>;
}

const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
});

export function useRawAssetOverview(filters: MappingFilters) {
    return useQuery({
        queryKey: [...RAW_ASSET_OVERVIEW_KEY, filters],
        queryFn: () => request<MappingOverview<RawAssetRow>>(`${API_URL}/raw-assets/overview?${filterParams(filters)}`),
        placeholderData: keepPreviousData,
        staleTime: 15_000,
    });
}

export function useRawAccountOverview(filters: MappingFilters) {
    return useQuery({
        queryKey: [...RAW_ACCOUNT_OVERVIEW_KEY, filters],
        queryFn: () => request<MappingOverview<RawAccountRow>>(`${API_URL}/raw-accounts/overview?${filterParams(filters)}`),
        placeholderData: keepPreviousData,
        staleTime: 15_000,
    });
}

/** Refreshes mapping lists plus everything that shows resolved assets/accounts. */
export function useInvalidateMappings() {
    const qc = useQueryClient();
    return useCallback(() => {
        qc.invalidateQueries({ queryKey: ['raw-assets'] });
        qc.invalidateQueries({ queryKey: ['raw-accounts'] });
        qc.invalidateQueries({ queryKey: ['transactions'], refetchType: 'active' });
        qc.invalidateQueries({ queryKey: ['spamSummary'] });
    }, [qc]);
}

// --- raw assets ------------------------------------------------------------------

export type RawAssetKey = Pick<RawAssetRow, 'source' | 'symbol' | 'network' | 'contract_address'>;

const rawAssetUrl = (k: RawAssetKey, suffix = '') =>
    `${API_URL}/raw-assets/${encodeURIComponent(k.source)}/${encodeURIComponent(k.symbol)}${suffix}${rawAssetKeyQuery(k.network, k.contract_address)}`;

export const rawAssetTransactionsUrl = (k: RawAssetKey) => rawAssetUrl(k, '/transactions');

export const setRawAssetMapping = (k: RawAssetKey, assetId: number | null) =>
    request(rawAssetUrl(k), json('PATCH', { asset_id: assetId }));

export const ignoreRawAsset = (k: RawAssetKey, reason: string) =>
    request(rawAssetUrl(k, '/dismiss'), json('POST', { reason }));

export const restoreRawAsset = (k: RawAssetKey) => request(rawAssetUrl(k, '/dismiss'), { method: 'DELETE' });

export const deleteRawAsset = (k: RawAssetKey) => request(rawAssetUrl(k), { method: 'DELETE' });

export const createRawAsset = (k: RawAssetKey & { asset_id?: number | null }) =>
    request(`${API_URL}/raw-assets`, json('POST', k));

export const acceptRawAssetSuggestions = (keys?: RawAssetKey[]) =>
    request<{ applied: number; skipped_unverified: number }>(
        `${API_URL}/raw-assets/accept-suggestions`,
        json('POST', { keys: keys ?? null }),
    );

export interface RawAssetLookup {
    suggestion?: MappingSuggestion | null;
    existing: { symbol: string; source: string; network: string; contract_address: string; asset_id?: number | null }[];
}

export const lookupRawAsset = (symbol: string, network: string, contract: string) =>
    request<RawAssetLookup>(
        `${API_URL}/raw-assets/lookup?${new URLSearchParams({ symbol, network, contract_address: contract })}`,
    );

// --- raw accounts ----------------------------------------------------------------

export type RawAccountKey = Pick<RawAccountRow, 'source' | 'label' | 'network'>;

const rawAccountUrl = (k: RawAccountKey, suffix = '') =>
    `${API_URL}/raw-accounts/${encodeURIComponent(k.source)}/${encodeURIComponent(k.label)}${suffix}${k.network ? `?network=${encodeURIComponent(k.network)}` : ''}`;

export const rawAccountTransactionsUrl = (k: RawAccountKey, role: 'account' | 'from' | 'to' | 'all' = 'all') => {
    const base = rawAccountUrl(k, '/transactions');
    return `${base}${base.includes('?') ? '&' : '?'}field_type=${role}`;
};

export const setRawAccountMapping = (k: RawAccountKey, accountId: number | null) =>
    request(rawAccountUrl(k), json('PATCH', { account_id: accountId }));

export const ignoreRawAccount = (k: RawAccountKey, reason: string) =>
    request(rawAccountUrl(k, '/dismiss'), json('POST', { reason }));

export const restoreRawAccount = (k: RawAccountKey) => request(rawAccountUrl(k, '/dismiss'), { method: 'DELETE' });

export const deleteRawAccount = (k: RawAccountKey) => request(rawAccountUrl(k), { method: 'DELETE' });

export const createRawAccount = (k: RawAccountKey & { account_id?: number | null }) =>
    request(`${API_URL}/raw-accounts`, json('POST', k));

export const acceptRawAccountSuggestions = (ids?: number[]) =>
    request<{ applied: number; skipped_unverified: number }>(
        `${API_URL}/raw-accounts/accept-suggestions`,
        json('POST', { ids: ids ?? null }),
    );

export interface RawAccountLookup {
    suggestion?: MappingSuggestion | null;
    existing: { id: number; source: string; label: string; network: string; account_id?: number | null }[];
}

export const lookupRawAccount = (label: string, source: string, network: string) =>
    request<RawAccountLookup>(`${API_URL}/raw-accounts/lookup?${new URLSearchParams({ label, source, network })}`);
