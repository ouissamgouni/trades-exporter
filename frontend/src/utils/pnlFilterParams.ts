/**
 * Convert a TransactionFilterState object into a Record that can be
 * spread into query params for the P&L endpoints.
 *
 * Only includes non-empty dimensions so the backend doesn't receive
 * empty strings.
 */
import type { TransactionFilterState } from '../components/TransactionFilters';

export interface PnLFilterParams {
    [key: string]: string | undefined;
    source?: string;
    account_id?: string;
    from_account_id?: string;
    to_account_id?: string;
    related_account_id?: string;
    asset_id?: string;
    related_asset_id?: string;
    category_id?: string;
    transaction_type?: string;
    direction?: string;
    connector_run_id?: string;
    tag_key?: string;
    network?: string;
    date_from?: string;
    date_to?: string;
    non_owned?: string;
    price_quote_asset_id?: string;
    fee_quote_asset_id?: string;
    include_fee?: string;
    has_bundle?: string;
    bundle_pattern?: string;
}

export function buildPnLFilterParams(
    filters: TransactionFilterState,
    nonOwned?: boolean,
): PnLFilterParams {
    const params: PnLFilterParams = {};
    const effectiveNonOwned = nonOwned ?? filters.nonOwned;

    if (filters.sources.length > 0) params.source = filters.sources.join(',');
    if (filters.accountIds.length > 0) params.account_id = filters.accountIds.join(',');
    if (filters.fromAccountIds.length > 0) params.from_account_id = filters.fromAccountIds.join(',');
    if (filters.toAccountIds.length > 0) params.to_account_id = filters.toAccountIds.join(',');
    if (filters.relatedAccountIds.length > 0) params.related_account_id = filters.relatedAccountIds.join(',');
    if (filters.assetIds.length > 0) params.asset_id = filters.assetIds.join(',');
    if (filters.relatedAssetIds.length > 0) params.related_asset_id = filters.relatedAssetIds.join(',');
    if (filters.categoryIds.length > 0) params.category_id = filters.categoryIds.join(',');
    if (filters.transactionTypes.length > 0) params.transaction_type = filters.transactionTypes.join(',');
    if (filters.directions.length > 0) params.direction = filters.directions.join(',');
    if (filters.connectorRunIds.length > 0) params.connector_run_id = filters.connectorRunIds.join(',');
    if (filters.tagKeys.length > 0) params.tag_key = filters.tagKeys.join(',');
    if (filters.networks.length > 0) params.network = filters.networks.join(',');
    if (filters.dateFrom) params.date_from = filters.dateFrom;
    if (filters.dateTo) params.date_to = filters.dateTo;
    if (effectiveNonOwned) params.non_owned = 'true';
    if (filters.priceQuoteAssetIds.length > 0) params.price_quote_asset_id = filters.priceQuoteAssetIds.join(',');
    if (filters.feeQuoteAssetIds.length > 0) params.fee_quote_asset_id = filters.feeQuoteAssetIds.join(',');
    if (filters.includeFee !== undefined) params.include_fee = String(filters.includeFee);
    if (filters.hasBundle !== undefined) params.has_bundle = String(filters.hasBundle);
    if (filters.bundlePatterns.length > 0) params.bundle_pattern = filters.bundlePatterns.join(',');

    return params;
}

/**
 * Check whether the given filter state has any active dimension.
 */
export function hasActivePnLFilters(
    filters: TransactionFilterState,
    nonOwned?: boolean,
): boolean {
    const effectiveNonOwned = nonOwned ?? filters.nonOwned;
    if (effectiveNonOwned) return true;
    return (
        filters.sources.length > 0 ||
        filters.accountIds.length > 0 ||
        filters.fromAccountIds.length > 0 ||
        filters.toAccountIds.length > 0 ||
        filters.relatedAccountIds.length > 0 ||
        filters.assetIds.length > 0 ||
        filters.relatedAssetIds.length > 0 ||
        filters.categoryIds.length > 0 ||
        filters.transactionTypes.length > 0 ||
        filters.directions.length > 0 ||
        filters.connectorRunIds.length > 0 ||
        filters.tagKeys.length > 0 ||
        filters.networks.length > 0 ||
        !!filters.dateFrom ||
        !!filters.dateTo ||
        filters.priceQuoteAssetIds.length > 0 ||
        filters.feeQuoteAssetIds.length > 0 ||
        filters.includeFee !== undefined ||
        filters.hasBundle !== undefined ||
        filters.bundlePatterns.length > 0
    );
}
