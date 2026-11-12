/**
 * AccountPnLCard — Card-based display for a single aggregated account row.
 *
 * Used in "By Account" card mode. Shows account-level aggregate metrics
 * with expandable per-asset detail drill-down.
 *
 * Zones:
 * 1. Header — color dot, account name, asset count badge
 * 2. Metrics — cost + value + live balance
 * 3. P&L — unrealized P&L with percentage
 * 4. Expandable — per-asset breakdown with clickable asset badges
 */

import React from 'react';
import { FiChevronRight, FiChevronDown } from 'react-icons/fi';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { formatPct } from './deltaUtils';
import { Badge } from '../ui/primitives';

// ------------------------------------------------------------------
// Types (re-declared locally to avoid circular deps — mirrors AssetPnLTable)
// ------------------------------------------------------------------

/** Aggregated row for "by account" view */
export interface AggregatedAccountRow {
    account_id: number;
    account_name: string;
    asset_count: number;
    total_cost_basis: number;
    total_market_value: number;
    total_unrealized_pnl: number;
    total_lot_count: number;
}

/** Per-asset detail row shown when an account row is expanded */
export interface AccountAssetDetail {
    asset_symbol: string;
    asset_id: number | null;
    qty: number;
    cost_basis: number;
    unit_cost: number;
    market_value: number;
    unrealized_pnl: number;
    lot_count: number;
}

type AssetLike = {
    asset: { id?: number | null; symbol?: string | null };
    unit_value?: number | null;
    cost_basis: number;
    market_value: number;
    unrealized_pnl: number;
    lot_count: number;
};
type BreakdownLike = { account_id: number; account_name: string; qty: number; cost_basis_in_base: number; avg_unit_cost_in_base: number; lot_count: number };

/** One aggregate per account (assets without a breakdown yet go to account 0 "—"), by value desc. */
export function aggregateByAccount(assets: AssetLike[], accountBalances?: Map<number, BreakdownLike[]>): AggregatedAccountRow[] {
    const map = new Map<number, AggregatedAccountRow>();
    const add = (id: number, name: string, cost: number, mv: number, lots: number) => {
        const row = map.get(id) ?? { account_id: id, account_name: name, asset_count: 0, total_cost_basis: 0, total_market_value: 0, total_unrealized_pnl: 0, total_lot_count: 0 };
        row.asset_count++;
        row.total_cost_basis += cost;
        row.total_market_value += mv;
        row.total_unrealized_pnl += mv - cost;
        row.total_lot_count += lots;
        map.set(id, row);
    };
    for (const a of assets) {
        const breakdowns = a.asset.id != null ? accountBalances?.get(a.asset.id) : undefined;
        if (breakdowns?.length) {
            for (const b of breakdowns) add(b.account_id, b.account_name, b.cost_basis_in_base, a.unit_value != null ? b.qty * a.unit_value : 0, b.lot_count);
        } else {
            add(0, '—', a.cost_basis, a.market_value, a.lot_count);
        }
    }
    return Array.from(map.values()).sort((x, y) => Math.abs(y.total_market_value) - Math.abs(x.total_market_value));
}

export function accountAssetDetails(accountId: number, assets: AssetLike[], accountBalances?: Map<number, BreakdownLike[]>): AccountAssetDetail[] {
    const details: AccountAssetDetail[] = [];
    for (const a of assets) {
        const match = a.asset.id != null ? accountBalances?.get(a.asset.id)?.find(b => b.account_id === accountId) : undefined;
        if (!match) continue;
        const mv = a.unit_value != null ? match.qty * a.unit_value : 0;
        details.push({
            asset_symbol: a.asset.symbol ?? '?',
            asset_id: a.asset.id ?? null,
            qty: match.qty,
            cost_basis: match.cost_basis_in_base,
            unit_cost: match.avg_unit_cost_in_base,
            market_value: mv,
            unrealized_pnl: mv - match.cost_basis_in_base,
            lot_count: match.lot_count,
        });
    }
    return details.sort((x, y) => Math.abs(y.market_value) - Math.abs(x.market_value));
}

/** Live value per account: Σ live qty × unit value over symbols (symbol → account → qty). */
export function liveValueByAccount(liveAccountBalances: Map<string, Map<number, number>> | undefined, assets: AssetLike[]): Map<number, number> {
    const result = new Map<number, number>();
    if (!liveAccountBalances) return result;
    const priceBySymbol = new Map(assets.map(a => [a.asset.symbol?.toUpperCase() ?? '', a.unit_value]));
    for (const [sym, accountMap] of liveAccountBalances.entries()) {
        const price = priceBySymbol.get(sym);
        if (price == null) continue;
        for (const [accountId, qty] of accountMap.entries()) result.set(accountId, (result.get(accountId) ?? 0) + qty * price);
    }
    return result;
}

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface AccountPnLCardProps {
    row: AggregatedAccountRow;
    baseCurrency: string;
    isExpanded: boolean;
    onToggleExpand: (accountId: number, e: React.MouseEvent) => void;
    onAssetClick: (assetId: number | undefined | null) => void;
    /** Detailed per-asset rows for this account (when expanded) */
    details: AccountAssetDetail[];
    /** Aggregated live balance value for this account (sum of all asset live values) */
    liveBalanceValue?: number;
    /** True while live balances are being fetched */
    liveBalanceLoading?: boolean;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

const Metric: React.FC<{
    label: string;
    children: React.ReactNode;
    flex?: string;
}> = ({ label, children, flex }) => (
    <div className="min-w-0" style={flex ? { flex } : undefined}>
        <div className="mb-0.5 truncate text-[10px] text-slate-500">{label}</div>
        {children}
    </div>
);

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const AccountPnLCard: React.FC<AccountPnLCardProps> = ({
    row,
    baseCurrency,
    isExpanded,
    onToggleExpand,
    onAssetClick,
    details,
    liveBalanceValue,
    liveBalanceLoading = false,
}) => {
    const { account_id, account_name, asset_count, total_cost_basis, total_market_value, total_unrealized_pnl, total_lot_count } = row;
    const accountColor = getAccountColor(account_id);
    const unrealizedPct = total_cost_basis > 0 ? total_unrealized_pnl / total_cost_basis : 0;

    /** Compact formatting for card display */
    const compact = { compact: true } as const;

    return (
        <div
            className={`cursor-pointer border bg-white transition-shadow hover:shadow-md ${isExpanded ? 'border-blue-300' : 'border-slate-200 hover:border-blue-200'}`}
            style={{ borderLeftWidth: '3px', borderLeftColor: accountColor }}
            onClick={(e) => onToggleExpand(account_id, e)}
        >
            <div className="px-3 py-2.5">
                {/* ── Zone 1: Header ── */}
                <div className="mb-2 flex items-center justify-between">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                        {/* Expand chevron */}
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleExpand(account_id, e);
                            }}
                            className="shrink-0 p-0.5 hover:bg-slate-200"
                        >
                            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </button>

                        {/* Account color dot + name */}
                        <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
                        <span className="max-w-[160px] truncate text-sm font-medium" title={account_name}>
                            {account_name}
                        </span>
                    </div>

                    {/* Right: asset count badge */}
                    <Badge colorScheme="gray">{asset_count} assets</Badge>
                </div>

                {/* ── Zone 2: Metrics ── */}
                <div className="mb-2 flex gap-3">
                    <Metric label="Cost" flex="1">
                        <span className="text-xs">
                            <ValueDisplay value={total_cost_basis} currency={baseCurrency} options={compact} />
                        </span>
                    </Metric>

                    <Metric label="Value" flex="1">
                        <span className="text-xs font-medium">
                            <ValueDisplay value={total_market_value} currency={baseCurrency} options={compact} />
                        </span>
                    </Metric>
                </div>

                {/* ── Zone 3: P&L ── */}
                <div className="flex gap-3">
                    <Metric label="Unrealized P&L" flex="1">
                        <span className={`text-xs font-medium ${total_unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            <ValueDisplay value={total_unrealized_pnl} currency={baseCurrency} options={compact} />
                        </span>
                        <div className="text-[10px] text-slate-500">{formatPct(unrealizedPct)}</div>
                    </Metric>
                </div>

                {/* ── Zone 4: Expandable asset breakdown ── */}
                {isExpanded && (
                    <div className="mt-2 border-t border-slate-100 pt-2">
                        {details.length > 0 ? (
                            <div className="flex flex-col gap-1">
                                {details.map((d) => {
                                    const dUnrealizedPct = d.cost_basis > 0 ? d.unrealized_pnl / d.cost_basis : 0;
                                    return (
                                        <div
                                            key={d.asset_symbol}
                                            className="cursor-pointer bg-slate-50 px-2 py-1.5 hover:bg-slate-100"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onAssetClick(d.asset_id);
                                            }}
                                        >
                                            {/* Asset name + nav chevron */}
                                            <div className="mb-1 flex items-center justify-between">
                                                <Badge colorScheme="blue" className="max-w-[80px] truncate font-bold">
                                                    {d.asset_symbol}
                                                </Badge>
                                                <span className="text-slate-400"><FiChevronRight size={10} /></span>
                                            </div>

                                            {/* Asset metrics */}
                                            <div className="flex gap-3 text-xs">
                                                <div className="flex-1">
                                                    <div className="text-[10px] text-slate-400">Qty</div>
                                                    <div className="text-slate-600"><ValueDisplay value={d.qty} options={compact} /></div>
                                                </div>
                                                <div className="flex-1">
                                                    <div className="text-[10px] text-slate-400">Cost</div>
                                                    <Tooltip
                                                        content={
                                                            <div className="p-1 text-xs">
                                                                <div className="flex justify-between gap-3">
                                                                    <span className="text-slate-400">Unit cost</span>
                                                                    <span className="font-medium">
                                                                        <ValueDisplay value={d.unit_cost} currency={baseCurrency} />
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        }
                                                        openDelay={200}
                                                    >
                                                        <span className="cursor-help text-slate-600">
                                                            <ValueDisplay value={d.cost_basis} currency={baseCurrency} options={compact} />
                                                        </span>
                                                    </Tooltip>
                                                </div>
                                                <div className="flex-1">
                                                    <div className="text-[10px] text-slate-400">Value</div>
                                                    <div className="text-slate-600">
                                                        <ValueDisplay value={d.market_value} currency={baseCurrency} options={compact} />
                                                    </div>
                                                </div>
                                                <div className="flex-1">
                                                    <div className="text-[10px] text-slate-400">P&L</div>
                                                    <div className={d.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                                                        <ValueDisplay value={d.unrealized_pnl} currency={baseCurrency} options={compact} />
                                                    </div>
                                                    <div className="text-[10px] text-slate-500">{formatPct(dUnrealizedPct)}</div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="py-2 text-center text-xs text-slate-400">
                                No asset details available
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default AccountPnLCard;
