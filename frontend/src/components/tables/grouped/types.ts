export type GroupGranularity = 'month' | 'day';

export interface GroupAssetNet {
    asset_id: number | null;
    symbol: string;
    net_quantity: number;
    tx_count: number;
}

export interface GroupAccountRecap {
    account_id: number | null;
    account_name: string | null;
    inflow_count: number;
    outflow_count: number;
    neutral_count: number;
    internal_transfer_count: number;
    assets: GroupAssetNet[];
    more_assets_count: number;
}

export interface GroupFacetValue {
    value: string;
    label: string;
    count: number;
}

export interface TransactionGroupFacets {
    accounts: GroupFacetValue[];
    assets: GroupFacetValue[];
    networks: GroupFacetValue[];
    sources: GroupFacetValue[];
}

export interface TransactionGroup {
    period_start: string;
    date_from: string;
    date_to: string;
    total_count: number;
    pending_count: number;
    valid_count: number;
    invalid_count: number;
    health_issue_count: number;
    accounts: GroupAccountRecap[];
    facets: TransactionGroupFacets;
    realized_pnl_in_base: number | null;
}

export interface TransactionGroupsResponse {
    granularity: GroupGranularity;
    timezone: string;
    groups: TransactionGroup[];
    total_groups: number;
    limit: number;
    offset: number;
}

export type FacetKey = keyof TransactionGroupFacets;

/** Group-local facet selection (values per dimension). */
export type GroupFacetSelection = Partial<Record<FacetKey, string[]>>;

export type GroupingMode = 'month-day' | 'off';

/** Rows of a group fit on screen without collapsing its days. */
export const AUTO_EXPAND_DAYS_MAX = 50;
/** Facet bar shows by default only for groups at least this large. */
export const FACET_BAR_MIN_TX = 20;
export const GROUP_ROWS_PAGE_SIZE = 50;
export const MONTHS_PAGE_SIZE = 24;
