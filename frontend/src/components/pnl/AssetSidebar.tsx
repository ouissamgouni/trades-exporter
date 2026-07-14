/**
 * AssetSidebar – Extracted sidebar from AssetDetailView.
 *
 * Displays a compact, sticky summary card for a single asset including:
 *   - Balance / qty with optional live comparison + delta bars
 *   - Per-account breakdown rows
 *   - Market value & cost basis metrics
 *   - P&L summary (unrealized, realized, fees)
 *   - Activity counts (lots, realized events, warnings)
 *
 * Designed to be embedded in a Grid or Flex layout alongside a main content area.
 */

import React from 'react';
import { FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { AssetPnLRow, AccountBalanceBreakdown } from './types';
import { Tooltip } from '../ui/tooltip';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { computeDelta } from './deltaUtils';
import { ValueDisplay } from '../ValueDisplay';
import { formatQuantityWithCurrency } from '../../utils/numberUtils';
import { Badge, Spinner } from '../ui/primitives';

// ─── Color tones (Chakra token -> Tailwind class + hex for inline accents) ──

interface ColorTone {
    text: string;
    hex: string;
}

const PNL_POSITIVE: ColorTone = { text: 'text-green-600', hex: '#16a34a' };
const PNL_NEGATIVE: ColorTone = { text: 'text-red-600', hex: '#dc2626' };
const BLUE_TONE: ColorTone = { text: 'text-blue-600', hex: '#2563eb' };
const ORANGE_TONE: ColorTone = { text: 'text-orange-600', hex: '#ea580c' };

// ─── MetricCard ─────────────────────────────────────────────────────────────

const MetricCard: React.FC<{
    label: string;
    value: string;
    subValue?: string;
    color?: ColorTone;
    icon?: React.ReactNode;
}> = ({ label, value, subValue, color, icon }) => (
    <div className="bg-slate-50 p-3" style={{ borderLeft: `3px solid ${color?.hex || '#cbd5e1'}` }}>
        <span className="block text-xs uppercase tracking-wide text-slate-500">
            {label}
        </span>
        <div className="flex items-center gap-2">
            {icon}
            <span className={`font-mono text-lg font-bold ${color?.text || ''}`}>
                {value}
            </span>
        </div>
        {subValue && (
            <span className="block text-xs text-slate-500">{subValue}</span>
        )}
    </div>
);

// ─── Props ──────────────────────────────────────────────────────────────────

export interface AssetSidebarProps {
    /** Asset row from the portfolio / balances endpoint. */
    asset: AssetPnLRow;
    baseCurrency: string;

    /** Per-account P&L balance breakdown for this asset. */
    accountBreakdown?: AccountBalanceBreakdown[];
    /** Aggregated live qty for this asset. */
    liveBalance?: number;
    /** Per-account live qty: accountId → qty. */
    liveAccountBalances?: Map<number, number>;
    /** True while live balances are being fetched. */
    liveBalanceLoading?: boolean;
    /** Account IDs whose live-balance fetch completed. */
    liveFetchedAccountIds?: Set<number>;
    /** Account IDs that had connector-level errors: accountId → error messages. */
    liveAccountErrors?: Map<number, string[]>;

    /** Called when user clicks an account row (e.g. to filter by that account). */
    onAccountClick?: (accountId: number) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const AssetSidebar: React.FC<AssetSidebarProps> = ({
    asset: assetPnlRow,
    baseCurrency,
    accountBreakdown,
    liveBalance,
    liveAccountBalances,
    liveBalanceLoading = false,
    liveFetchedAccountIds,
    liveAccountErrors,
    onAccountClick,
}) => {
    const unrealizedTone = assetPnlRow.unrealized_pnl >= 0 ? PNL_POSITIVE : PNL_NEGATIVE;
    const realizedTone = assetPnlRow.realized_pnl >= 0 ? PNL_POSITIVE : PNL_NEGATIVE;
    const unrealizedPct = `${assetPnlRow.unrealized_pnl_pct >= 0 ? '+' : ''}${(assetPnlRow.unrealized_pnl_pct * 100).toFixed(2)}%`;

    return (
        <div className="sticky top-[80px] border border-slate-200 bg-white">
            <div className="p-3">
                {/* ── Balances ── */}
                <div className="mb-3 flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-600">
                        Balances
                    </span>
                    {liveBalanceLoading && <Spinner size="xs" className="text-slate-400" />}
                </div>

                {/* Total row: P&L qty vs Live qty + delta */}
                {(() => {
                    const fetchDone = !liveBalanceLoading && liveFetchedAccountIds && liveFetchedAccountIds.size > 0;
                    const effectiveLive = liveBalance ?? (fetchDone ? 0 : undefined);

                    if (effectiveLive != null) {
                        const deltaInfo = computeDelta(assetPnlRow.quantity, effectiveLive);
                        const hasErrors = liveAccountErrors && liveAccountErrors.size > 0;
                        return (
                            <div className="mb-2 bg-blue-50 p-2">
                                <div className="mb-1 flex items-center justify-between">
                                    <div className="flex items-center gap-1">
                                        <span className="text-xs font-medium text-slate-500">Total</span>
                                        {hasErrors && (
                                            <Tooltip content={`${liveAccountErrors!.size} account(s) had fetch errors — live total may be incomplete`} openDelay={200}>
                                                <span className="cursor-help text-xs text-orange-500">⚠</span>
                                            </Tooltip>
                                        )}
                                    </div>
                                    <DeltaBar delta={deltaInfo} liveQty={effectiveLive} pnlQty={assetPnlRow.quantity} size="sm" />
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="font-mono text-sm font-bold">
                                        <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                                    </span>
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div className="mb-2 bg-slate-50 p-3">
                            <span className="mb-1 block text-xs text-slate-500">Quantity</span>
                            <span className="block font-mono text-sm font-bold text-blue-600">
                                <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                            </span>
                        </div>
                    );
                })()}

                {/* Per-account rows */}
                {accountBreakdown && accountBreakdown.length > 0 ? (
                    <div className="mb-2 flex flex-col gap-1">
                        {[...accountBreakdown]
                            .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty))
                            .map((acct) => {
                                const acctLiveQtyRaw = liveAccountBalances?.get(acct.account_id);
                                const acctFetched = liveFetchedAccountIds?.has(acct.account_id) ?? false;
                                const acctErrors = liveAccountErrors?.get(acct.account_id);
                                const acctLiveQty = acctLiveQtyRaw ?? (acctFetched ? 0 : undefined);
                                const acctColor = getAccountColor(acct.account_id);
                                const acctDelta = computeDelta(acct.qty, acctLiveQty);
                                let deltaNode: React.ReactNode = <DeltaBar delta={null} size="xs" />;

                                if (acctErrors && acctErrors.length > 0 && acctLiveQtyRaw == null) {
                                    deltaNode = (
                                        <Tooltip
                                            content={
                                                <div className="text-xs">
                                                    <span className="mb-1 block font-medium">Fetch error:</span>
                                                    {acctErrors.map((err, i) => <span key={i} className="block">{err}</span>)}
                                                </div>
                                            }
                                            openDelay={200}
                                        >
                                            <span className="cursor-help text-xs text-red-500">⚠ err</span>
                                        </Tooltip>
                                    );
                                } else if (acctLiveQty != null) {
                                    deltaNode = (
                                        <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={acct.qty} size="xs" />
                                    );
                                }

                                return (
                                    <div key={acct.account_id} className="bg-slate-50 px-1.5 py-1">
                                        <div className="mb-0.5 flex items-center gap-1">
                                            <div className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: acctColor }} />
                                            <span
                                                className="max-w-[120px] cursor-pointer truncate text-[10px] font-medium hover:text-blue-600 hover:underline"
                                                title={acct.account_name}
                                                onClick={() => onAccountClick?.(acct.account_id)}
                                            >
                                                {acct.account_name}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="font-mono text-xs"><ValueDisplay value={acct.qty} options={{ maxDecimals: 4 }} /></span>
                                            {deltaNode}
                                        </div>
                                    </div>
                                );
                            })}
                    </div>
                ) : (
                    <span className="block py-2 text-center text-xs text-slate-400">
                        {liveBalanceLoading ? 'Loading...' : 'No account breakdown available'}
                    </span>
                )}

                {/* Divider */}
                <div className="my-2 border-t border-slate-200" />

                <div className="flex flex-col gap-2">
                    <MetricCard
                        label="Market Value"
                        value={formatQuantityWithCurrency(assetPnlRow.market_value, baseCurrency)}
                        subValue={assetPnlRow.unit_value != null ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_value, baseCurrency)}/unit` : undefined}
                        color={BLUE_TONE}
                    />
                    <MetricCard
                        label="Cost Basis"
                        value={formatQuantityWithCurrency(assetPnlRow.cost_basis, baseCurrency)}
                        subValue={assetPnlRow.unit_cost != null && assetPnlRow.unit_cost > 0 ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_cost, baseCurrency)}/unit` : undefined}
                    />
                </div>

                <span className="mb-3 mt-4 block text-sm font-bold text-slate-600">
                    P&L Summary
                </span>
                <div className="flex flex-col gap-2">
                    <MetricCard
                        label="Unrealized P&L"
                        value={formatQuantityWithCurrency(assetPnlRow.unrealized_pnl, baseCurrency)}
                        subValue={unrealizedPct}
                        color={unrealizedTone}
                        icon={assetPnlRow.unrealized_pnl >= 0 ?
                            <FiTrendingUp color="green" size={14} /> :
                            <FiTrendingDown color="red" size={14} />
                        }
                    />
                    <MetricCard
                        label="Realized P&L"
                        value={formatQuantityWithCurrency(assetPnlRow.realized_pnl, baseCurrency)}
                        color={realizedTone}
                        icon={assetPnlRow.realized_pnl >= 0 ?
                            <FiTrendingUp color="green" size={14} /> :
                            <FiTrendingDown color="red" size={14} />
                        }
                    />
                    <MetricCard
                        label="Total Fees"
                        value={formatQuantityWithCurrency(assetPnlRow.total_fees, baseCurrency)}
                        color={ORANGE_TONE}
                    />
                </div>

                <span className="mb-3 mt-4 block text-sm font-bold text-slate-600">
                    Activity
                </span>
                <div className="flex flex-col gap-2">
                    <div className="bg-slate-50 p-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-500">Cost Lots</span>
                            <Badge colorScheme="blue">{assetPnlRow.lot_count}</Badge>
                        </div>
                    </div>
                    <div className="bg-slate-50 p-3">
                        <div className="flex items-center justify-between">
                            <span className="text-xs text-slate-500">Realized Events</span>
                            <Badge colorScheme="green">{assetPnlRow.realized_event_count}</Badge>
                        </div>
                    </div>
                    {assetPnlRow.warning_count > 0 && (
                        <div className="bg-orange-50 p-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-orange-600">Warnings</span>
                                <Badge colorScheme="orange">{assetPnlRow.warning_count}</Badge>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
