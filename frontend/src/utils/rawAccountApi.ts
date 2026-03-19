/**
 * Shared raw account linking utilities.
 *
 * Centralizes the PATCH-then-POST-fallback pattern for mapping a raw account
 * label to a normalized account. Previously duplicated across:
 * - AccountSelector
 * - TransactionsTable (inline PATCH calls)
 * - DataHealthCheckDrawer (mapRawItem)
 * - IssueActionRenderers (mapRawItem)
 */

import { API_URL } from '../types';

export interface LinkRawAccountParams {
    /** Source platform identifier (e.g. 'binance_trx', 'blockscout') */
    source: string;
    /** Raw account label/address from the source */
    label: string;
    /** Network/chain for disambiguation (e.g. 'bsc', 'ethereum'). Pass empty string or undefined to skip. */
    network?: string;
    /** Normalized account ID to link to */
    accountId: number;
}

/**
 * Link a raw account label to a normalized account.
 *
 * Tries PATCH first (update existing raw account). If the raw account doesn't
 * exist yet (404), creates it via POST. Always passes the `network` query
 * param when available so the backend can disambiguate same-address accounts
 * on different chains.
 *
 * @throws Error if the API call fails (non-404 error on PATCH, or POST fails)
 */
export async function linkRawAccount({
    source,
    label,
    network,
    accountId,
}: LinkRawAccountParams): Promise<void> {
    const networkParam = network
        ? `?network=${encodeURIComponent(network)}`
        : '';

    const patchUrl = `${API_URL}/raw-accounts/${encodeURIComponent(source)}/${encodeURIComponent(label)}${networkParam}`;

    const patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId }),
    });

    if (patchResponse.status === 404) {
        // Raw account doesn't exist yet — create it
        const createResponse = await fetch(`${API_URL}/raw-accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                label,
                source,
                network: network || '',
                account_id: accountId,
            }),
        });
        if (!createResponse.ok) {
            throw new Error('Failed to create raw account mapping');
        }
    } else if (!patchResponse.ok) {
        throw new Error('Failed to update raw account mapping');
    }
}

export interface LinkRawAssetParams {
    source: string;
    symbol: string;
    network?: string;
    assetId: number;
}

/**
 * Link a raw asset symbol to a normalized asset.
 * Same PATCH-then-POST pattern as linkRawAccount.
 */
export async function linkRawAsset({
    source,
    symbol,
    network,
    assetId,
}: LinkRawAssetParams): Promise<void> {
    const networkParam = network
        ? `?network=${encodeURIComponent(network)}`
        : '';

    const patchUrl = `${API_URL}/raw-assets/${encodeURIComponent(source)}/${encodeURIComponent(symbol)}${networkParam}`;

    const patchResponse = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_id: assetId }),
    });

    if (patchResponse.status === 404) {
        const createResponse = await fetch(`${API_URL}/raw-assets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbol,
                source,
                network: network || '',
                asset_id: assetId,
            }),
        });
        if (!createResponse.ok) {
            throw new Error('Failed to create raw asset mapping');
        }
    } else if (!patchResponse.ok) {
        throw new Error('Failed to update raw asset mapping');
    }
}
