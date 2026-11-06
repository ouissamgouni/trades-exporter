import type { TransactionFilterState } from '../components/TransactionFilters';
import { localFilterToUtcNaive } from './dateUtils';

/** Query params for the transaction list/groups/ids endpoints (shared so they never drift apart). */
export function buildTransactionFilterParams(filters: TransactionFilterState): URLSearchParams {
    const params = new URLSearchParams();
    const list = (key: string, values: string[] | undefined) => {
        if (values && values.length > 0) params.append(key, values.join(','));
    };

    list('review_status', filters.reviewStatus);
    list('taxability', filters.taxability);
    list('source', filters.sources);
    list('account_id', filters.accountIds);
    list('from_account_id', filters.fromAccountIds);
    list('to_account_id', filters.toAccountIds);
    list('related_account_id', filters.relatedAccountIds);
    list('asset_id', filters.assetIds);
    list('related_asset_id', filters.relatedAssetIds);
    list('attributed_asset_id', filters.attributedAssetIds);
    list('category_id', filters.categoryIds);
    list('connector_run_id', filters.connectorRunIds);
    if (filters.connectorRunOutcome) params.append('connector_run_outcome', filters.connectorRunOutcome);
    list('tag_key', filters.tagKeys);
    list('network', filters.networks);
    list('transaction_type', filters.transactionTypes);
    list('direction', filters.directions);
    if (filters.dateFrom) params.append('date_from', localFilterToUtcNaive(filters.dateFrom, 'start'));
    if (filters.dateTo) params.append('date_to', localFilterToUtcNaive(filters.dateTo, 'end'));
    if (filters.versionId) params.append('pnl_cal_version', filters.versionId);
    if (filters.inclusionStatus) params.append('pnl_cal_inclusions_status', filters.inclusionStatus);
    if (filters.transactionIds && filters.transactionIds.length > 0) {
        params.append('ids', filters.transactionIds.join(','));
    }
    if (filters.hasFees !== undefined) params.append('has_fee', String(filters.hasFees));
    if (filters.includeFee !== undefined) params.append('include_fee', String(filters.includeFee));
    if (filters.hasBundle !== undefined) params.append('has_bundle', String(filters.hasBundle));
    list('price_quote_asset_id', filters.priceQuoteAssetIds);
    list('fee_quote_asset_id', filters.feeQuoteAssetIds);
    list('bundle_pattern', filters.bundlePatterns);
    return params;
}

/** Append params to a base URL that may already carry a query string. */
export function withParams(baseUrl: string, params: URLSearchParams): string {
    const qs = params.toString();
    if (!qs) return baseUrl;
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${qs}`;
}
