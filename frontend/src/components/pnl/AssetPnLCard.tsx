/**
 * AssetPnLCard — Card-based display for a single asset P&L row.
 *
 * Replaces the table row in "By Asset" view with a compact card layout
 * that stacks data vertically and uses space more efficiently.
 *
 * Zones:
 * 1. Header — symbol badge, account dots, live balance + warning badges, nav chevron
 * 2. Metrics — qty + delta bar, cost + value in a 2×2 grid
 * 3. P&L — unrealized + realized side by side, fees inline
 * 4. Expandable — per-account balance breakdown
 */

import React, { useContext } from 'react';
import { Badge } from '../ui/primitives';
import { Spinner } from '../ui/primitives';
import { FiChevronRight, FiChevronDown, FiAlertCircle } from 'react-icons/fi';
import { LuInfo } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { AssetPnLRow, AccountBalanceBreakdown } from './types';
import { Account } from '../../types';
import type { AssetPeriodDelta } from '../../hooks/useChartData';
import { Tooltip } from '../ui/tooltip';
import { formatDateTimeLocale } from '../../utils/dateUtils';
import { ValueDisplay } from '../ValueDisplay';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { computeDelta, formatPct, type DeltaInfo } from './deltaUtils';

// ------------------------------------------------------------------
// Helpers (same logic as table version)
// ------------------------------------------------------------------

const isPriceStale = (fetchedAt?: string): boolean => {
    if (!fetchedAt) return false;
    const isoString = fetchedAt.endsWith('Z') ? fetchedAt : fetchedAt + 'Z';
    const fetchedTime = new Date(isoString).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    return fetchedTime < oneHourAgo;
};

// ------------------------------------------------------------------
// Props
// ------------------------------------------------------------------

export interface AssetPnLCardProps {
    row: AssetPnLRow;
    baseCurrency: string;
    onAssetClick: (assetId: number | undefined | null) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    isExpanded: boolean;
    onToggleExpand: (assetId: number, e: React.MouseEvent) => void;
    accountBalances?: AccountBalanceBreakdown[];
    accounts: Account[];
    /** Aggregated live qty for this asset's symbol */
    liveQty?: number;
    /** Pre-computed delta info */
    deltaInfo: DeltaInfo | null;
    liveBalanceLoading: boolean;
    /** Per-account live balances for this asset's symbol */
    liveAccountBalanceMap?: Map<number, number>;
    /** Account IDs with live balance fetch errors */
    liveAccountErrors?: Map<number, string[]>;
    /** Error account IDs relevant to this asset */
    assetErrorAccounts: number[];
    hasLiveErrors: boolean;
    /** Min/max unrealized PnL across all visible cards (for heatmap coloring) */
    unrealizedPnlRange?: { min: number; max: number };
    /** Period delta data for this asset (e.g. 1W change) */
    periodDelta?: AssetPeriodDelta;
    /** Period label to display (e.g. "1W") */
    periodLabel?: string;
    /** PnL version ID to pass when opening asset detail panel */
    pnlVersionId?: number;
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

/** Tiny label + value block reused across the card */
const Metric: React.FC<{
    label: string;
    children: React.ReactNode;
    flex?: string;
}> = ({ label, children, flex }) => (
    <div className="min-w-0" style={{ flex }}>
        <div className="mb-0.5 truncate text-[10px] text-gray-500">{label}</div>
        {children}
    </div>
);

/** Heatmap background: green for best, red for worst, white in the middle */
function unrealizedHeatmapBg(val: number, range: { min: number; max: number }): string {
    const span = Math.max(Math.abs(range.min), Math.abs(range.max), 1);
    const t = Math.max(-1, Math.min(1, val / span)); // -1..1
    if (t >= 0) {
        const a = Math.min(t, 1) * 0.18;
        return `rgba(56, 161, 105, ${a.toFixed(3)})`; // green
    }
    const a = Math.min(Math.abs(t), 1) * 0.18;
    return `rgba(229, 62, 62, ${a.toFixed(3)})`; // red
}

/* CostPnlBar replaced by the reusable PnLBreakdownBar component */

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export const AssetPnLCard: React.FC<AssetPnLCardProps> = ({
    row,
    baseCurrency,
    onAssetClick,
    onAccountClick,
    isExpanded,
    onToggleExpand,
    accountBalances,
    accounts,
    liveQty,
    deltaInfo,
    liveBalanceLoading,
    liveAccountBalanceMap,
    liveAccountErrors,
    assetErrorAccounts,
    hasLiveErrors,
    unrealizedPnlRange,
    periodDelta,
    periodLabel,
    pnlVersionId,
}) => {
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const assetId = row.asset.id;
    const isNoPnl = !row.has_lots;
    const isUnmapped = !!row.is_unmapped;
    const isExpandable = !isNoPnl && row.account_ids != null && row.account_ids.length >= 1;

    const stale = isPriceStale(row.price_fetched_at);
    const hasPrice = row.unit_value != null;
    const hasError = !!row.price_error;

    /** Compact formatting for card display */
    const compact = { compact: true } as const;

    return (
        <div
            className={`border border-gray-200 bg-white py-1.5 px-3 transition-shadow ${isNoPnl ? 'cursor-default bg-gray-50 hover:shadow-sm' : 'cursor-pointer hover:shadow-md hover:border-blue-200'} ${isExpanded ? 'border-blue-300' : ''} ${isUnmapped ? 'border-dashed opacity-70' : ''}`}
            onClick={isNoPnl ? undefined : () => onAssetClick(assetId)}
        >
            {/* ── Zone 1: Header ── */}
            <div className="mb-1 flex items-center justify-between">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    {/* Expand chevron */}
                    {isExpandable ? (
                        <button
                            type="button"
                            onClick={(e: React.MouseEvent) => {
                                e.stopPropagation();
                                if (assetId != null) onToggleExpand(assetId, e);
                            }}
                            className="shrink-0 rounded-sm p-0.5 hover:bg-gray-200"
                        >
                            {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                        </button>
                    ) : (
                        <div className="w-[18px] shrink-0" />
                    )}

                    {/* Symbol badge */}
                    <Tooltip content={row.asset.label || row.asset.symbol || ''} openDelay={300} disabled={!row.asset.label}>
                        <Badge colorScheme={isUnmapped ? 'gray' : 'blue'} className="max-w-[100px] truncate font-bold">
                            {row.asset.label
                                ? row.asset.label.length > 10
                                    ? row.asset.label.slice(0, 10) + '…'
                                    : row.asset.label
                                : row.asset.symbol}
                        </Badge>
                    </Tooltip>
                    {assetId != null && assetPanelCtx && (
                        <button
                            type="button"
                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); assetPanelCtx.openAssetPanel(assetId, { pnlVersionId }); }}
                            className="rounded-sm p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                            title="Asset details"
                        >
                            <LuInfo size={12} />
                        </button>
                    )}

                    {isUnmapped && (
                        <Tooltip content="This asset is not mapped in the database" openDelay={200}>
                            <span className="cursor-help text-xs text-orange-500">⚠</span>
                        </Tooltip>
                    )}

                    {/* Account color dots */}
                    {accountBalances && accountBalances.length > 1 && (
                        <div className="ml-1 flex gap-0.5">
                            {accountBalances.slice(0, 3).map((bal) => (
                                <div
                                    key={bal.account_id}
                                    className="h-[6px] w-[6px] rounded-full"
                                    style={{ backgroundColor: getAccountColor(bal.account_id) }}
                                    title={bal.account_name}
                                />
                            ))}
                            {accountBalances.length > 3 && (
                                <span className="text-[10px] text-gray-500">+{accountBalances.length - 3}</span>
                            )}
                        </div>
                    )}
                </div>

                {/* Right side: badges */}
                <div className="flex shrink-0 items-center gap-1.5">
                    {isNoPnl ? (
                        isUnmapped
                            ? <Badge colorScheme="orange">Unmapped</Badge>
                            : <Badge colorScheme="yellow">No P&L</Badge>
                    ) : (
                        <>
                            {row.warning_count > 0 && (
                                <Badge colorScheme="orange">{row.warning_count} ⚠</Badge>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* ── Zone 2: Metrics grid ── */}
            {!isNoPnl && (
                <div className="mb-1 flex gap-3">
                    {/* Qty */}
                    <Metric label="Qty" flex="1">
                        <div className="text-xs"><ValueDisplay value={row.quantity} options={compact} /></div>
                    </Metric>

                    {/* Cost */}
                    <Metric label="Cost" flex="1">
                        <Tooltip
                            content={
                                <div className="p-1 text-xs">
                                    <div className="flex justify-between gap-3">
                                        <span className="text-gray-400">Unit cost</span>
                                        <span className="font-medium">
                                            {row.unit_cost != null
                                                ? <ValueDisplay value={row.unit_cost} currency={baseCurrency} />
                                                : '—'}
                                        </span>
                                    </div>
                                </div>
                            }
                            openDelay={200}
                        >
                            <div className="cursor-help">
                                <div className="text-xs">
                                    <ValueDisplay value={row.cost_basis} currency={baseCurrency} options={compact} />
                                </div>
                                {row.total_invested != null && Math.abs(row.total_invested - row.cost_basis) > 0.01 && (
                                    <div className="text-[10px] leading-none text-gray-400">
                                        invested <ValueDisplay value={row.total_invested} currency={baseCurrency} options={compact} />
                                    </div>
                                )}
                            </div>
                        </Tooltip>
                    </Metric>

                    {/* Value */}
                    <Metric label="Value" flex="1">
                        {row.price_loading && !hasPrice ? (
                            <Spinner size="xs" className="text-gray-400" />
                        ) : (
                            <Tooltip
                                content={
                                    <div className="p-2 text-xs">
                                        <div className="mb-1 flex justify-between gap-4">
                                            <span className="text-gray-400">Unit price</span>
                                            <span className="font-medium">
                                                {hasPrice ? <ValueDisplay value={row.unit_value!} currency={baseCurrency} /> : '—'}
                                            </span>
                                        </div>
                                        <div className="mb-1 flex justify-between gap-4">
                                            <span className="text-gray-400">Source</span>
                                            <span className="font-medium">{row.price_source || 'N/A'}</span>
                                        </div>
                                        <div className="mb-1 flex justify-between gap-4">
                                            <span className="text-gray-400">Updated</span>
                                            <span className="font-medium">{formatDateTimeLocale(row.price_fetched_at)}</span>
                                        </div>
                                        {hasError && (
                                            <div className="flex justify-between gap-4">
                                                <span className="text-red-400">Error</span>
                                                <span className="max-w-[200px] break-words text-red-300">{row.price_error}</span>
                                            </div>
                                        )}
                                        {stale && <div className="mt-1 text-orange-400">⚠ Price is stale (over 1 hour old)</div>}
                                    </div>
                                }
                                openDelay={200}
                                closeDelay={100}
                            >
                                <div className="flex cursor-help items-center gap-1">
                                    <span
                                        className={`text-xs font-medium ${stale ? 'text-orange-500' : ''} ${hasPrice ? 'underline decoration-dotted' : ''}`}
                                    >
                                        {hasPrice ? <ValueDisplay value={row.market_value} currency={baseCurrency} options={compact} /> : '—'}
                                    </span>
                                    {(stale || hasError || (row.price_state && row.price_state !== 'live' && row.price_state !== 'cached')) && (
                                        <FiAlertCircle size={10} color={hasError ? '#E53E3E' : '#DD6B20'} />
                                    )}
                                </div>
                            </Tooltip>
                        )}
                    </Metric>
                </div>
            )}

            {/* ── Cost vs PnL bar ── */}
            {!isNoPnl && row.cost_basis > 0 && (
                <div className="mb-1">
                    <PnLBreakdownBar
                        costBasis={row.cost_basis}
                        unrealizedPnl={row.unrealized_pnl}
                        realizedPnl={row.realized_pnl}
                        fees={row.total_fees}
                        height={6}
                    />
                </div>
            )}

            {/* ── Zone 3: P&L row ── */}
            {!isNoPnl && (
                <div className="flex items-start gap-3">
                    <div
                        className="min-w-0 flex-1 rounded-md px-1 py-0.5"
                        style={{ backgroundColor: hasPrice && unrealizedPnlRange ? unrealizedHeatmapBg(row.unrealized_pnl, unrealizedPnlRange) : undefined }}
                    >
                        <div className="mb-0.5 truncate text-[10px] text-gray-500">Unrealized</div>
                        {hasPrice ? (
                            <>
                                <div className={`text-xs font-medium ${row.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    <ValueDisplay value={row.unrealized_pnl} currency={baseCurrency} options={compact} />
                                </div>
                                <div className="text-[10px] text-gray-500">{`${row.unrealized_pnl_pct >= 0 ? '+' : ''}${Math.round(row.unrealized_pnl_pct * 100)}%`}</div>
                                {periodDelta && periodLabel && (
                                    <div className={`text-[10px] ${periodDelta.unrealized_change >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                        {periodLabel}: <ValueDisplay value={periodDelta.unrealized_change} currency={baseCurrency} options={compact} />
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="flex items-center gap-1">
                                <span className="text-xs text-gray-400">—</span>
                                {hasError && <FiAlertCircle size={10} color="#E53E3E" />}
                            </div>
                        )}
                    </div>

                    <Metric label="Realized" flex="1">
                        <div className={`text-xs font-medium ${row.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            <ValueDisplay value={row.realized_pnl} currency={baseCurrency} options={compact} />
                        </div>
                        {row.taxable_realized_pnl !== 0 && (
                            <div className="text-[10px] text-gray-500">
                                Tax: <ValueDisplay value={row.taxable_realized_pnl} currency={baseCurrency} options={compact} />
                            </div>
                        )}
                        {periodDelta && periodLabel && (
                            <div className={`text-[10px] ${periodDelta.realized_in_period >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                {periodLabel}: <ValueDisplay value={periodDelta.realized_in_period} currency={baseCurrency} options={compact} />
                            </div>
                        )}
                    </Metric>

                    <Metric label="Fees" flex="1">
                        <div className="text-[10px] text-gray-600">
                            <ValueDisplay value={Math.round(row.total_fees)} currency={baseCurrency} options={compact} />
                        </div>
                    </Metric>
                </div>
            )}

            {/* Live balance indicator — bottom right */}
            {!isNoPnl && (
                <div className="mt-0.5 flex justify-end">
                    {liveBalanceLoading ? (
                        <Spinner size="xs" className="text-gray-400" />
                    ) : (
                        <div className="flex items-center gap-0.5">
                            <DeltaBar delta={deltaInfo} liveQty={liveQty} pnlQty={row.quantity} size="xs" />
                            {hasLiveErrors && (
                                <Tooltip
                                    content={
                                        <div className="text-xs">
                                            <div className="mb-1 font-medium">Some accounts had fetch errors</div>
                                            {assetErrorAccounts.map(accId => {
                                                const errs = liveAccountErrors?.get(accId) ?? [];
                                                const accName = accounts.find(a => a.id === accId)?.name ?? `Account ${accId}`;
                                                return errs.map((err, i) => (
                                                    <div key={`${accId}-${i}`} className="text-red-300">{accName}: {err}</div>
                                                ));
                                            })}
                                        </div>
                                    }
                                    openDelay={200}
                                >
                                    <span className="shrink-0 cursor-help text-xs text-orange-500">⚠</span>
                                </Tooltip>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* ── Zone 4: Expandable account breakdown ── */}
            {isExpandable && isExpanded && (
                <div className="mt-2 border-t border-gray-100 pt-2">
                    {accountBalances && accountBalances.length > 0 ? (
                        <div className="flex flex-col gap-1">
                            {accountBalances.map((balance) => {
                                const accountColor = getAccountColor(balance.account_id);
                                const unitPrice = row.unit_value;
                                const marketValue = unitPrice != null ? balance.qty * unitPrice : 0;
                                const unrealizedPnl = marketValue - balance.cost_basis_in_base;
                                const unrealizedPnlPct = balance.cost_basis_in_base > 0
                                    ? unrealizedPnl / balance.cost_basis_in_base
                                    : 0;

                                const acctLiveQty = liveAccountBalanceMap?.get(balance.account_id);
                                const acctDelta = computeDelta(balance.qty, acctLiveQty);
                                const acctErrors = liveAccountErrors?.get(balance.account_id);
                                const acctHasError = acctErrors && acctErrors.length > 0 && acctLiveQty == null;

                                return (
                                    <div
                                        key={balance.account_id}
                                        className="rounded-sm bg-gray-50 px-2 py-1.5"
                                        style={{ borderLeft: `3px solid ${accountColor}` }}
                                    >
                                        {/* Account name */}
                                        <div className="mb-1 flex items-center gap-1">
                                            <div className="h-[6px] w-[6px] shrink-0 rounded-full" style={{ backgroundColor: accountColor }} />
                                            <span
                                                className={`text-xs font-medium text-gray-700 ${onAccountClick ? 'cursor-pointer hover:text-blue-600 hover:underline' : ''}`}
                                                onClick={(e) => {
                                                    if (onAccountClick && assetId != null) {
                                                        e.stopPropagation();
                                                        onAccountClick(assetId, balance.account_id);
                                                    }
                                                }}
                                            >
                                                {balance.account_name}
                                            </span>
                                        </div>

                                        {/* Account-level metrics */}
                                        <div className="flex gap-3 text-xs">
                                            <div className="flex-1">
                                                <div className="text-[10px] text-gray-400">Qty</div>
                                                <div className="flex items-center gap-1">
                                                    <span className="text-gray-600"><ValueDisplay value={balance.qty} options={compact} /></span>
                                                    {acctHasError ? (
                                                        <Tooltip
                                                            content={
                                                                <div className="text-xs">
                                                                    <div className="mb-1 font-medium">Fetch error:</div>
                                                                    {acctErrors!.map((err, i) => <div key={i} className="text-red-300">{err}</div>)}
                                                                </div>
                                                            }
                                                            openDelay={200}
                                                        >
                                                            <span className="cursor-help text-xs text-red-500">⚠</span>
                                                        </Tooltip>
                                                    ) : (
                                                        <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={balance.qty} size="xs" />
                                                    )}
                                                </div>
                                            </div>
                                            <div className="flex-1">
                                                <div className="text-[10px] text-gray-400">Value</div>
                                                <div className="text-gray-600">
                                                    {unitPrice != null
                                                        ? <ValueDisplay value={marketValue} currency={baseCurrency} options={compact} />
                                                        : '—'}
                                                </div>
                                            </div>
                                            <div className="flex-1">
                                                <div className="text-[10px] text-gray-400">Unrealized</div>
                                                {unitPrice != null ? (
                                                    <>
                                                        <div className={unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                                                            <ValueDisplay value={unrealizedPnl} currency={baseCurrency} options={compact} />
                                                        </div>
                                                        <div className="text-[10px] text-gray-500">{formatPct(unrealizedPnlPct)}</div>
                                                    </>
                                                ) : (
                                                    <div className="text-gray-500">—</div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="py-2 text-center text-xs text-gray-400">
                            Loading account breakdown...
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default AssetPnLCard;
