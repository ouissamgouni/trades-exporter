/**
 * DrillSidebar — Context-Aware Sidebar
 *
 * Adapts its content based on drill state:
 * - Category: aggregate stats for category, list of contained assets
 * - Account: aggregate stats for account, per-asset breakdown
 * - Metric: portfolio metric breakdown, top contributors
 * - Asset (L2): full asset detail with per-account breakdown
 * - Not shown at L0
 */

import React, { useMemo } from 'react';
import { FiArrowRight, FiTrendingUp, FiTrendingDown, FiAlertTriangle } from 'react-icons/fi';
import { Badge, Heading } from '../ui/primitives';
import { usePnL } from './PnLContext';
import { fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import type { DrillDownState } from './pnlState';
import type { AssetPnLRow } from './types';

interface DrillSidebarProps {
    drill: DrillDownState;
    onAssetClick: (assetId: number, assetSymbol: string) => void;
    onAccountFilterClick?: (accountId: number) => void;
}

/** Small metric display for sidebar */
const SidebarMetric: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
    <div className="py-1">
        <span className="block text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
        <span className={`block font-mono text-sm font-bold ${color ?? 'text-slate-800'}`}>{value}</span>
    </div>
);

/** Clickable asset row in sidebar */
const SidebarAssetRow: React.FC<{
    asset: AssetPnLRow;
    baseCurrency: string;
    onClick: () => void;
}> = ({ asset, baseCurrency, onClick }) => {
    const returnColor = asset.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600';
    return (
        <div
            className="flex cursor-pointer items-center justify-between px-2 py-1.5 hover:bg-slate-50"
            onClick={onClick}
        >
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-xs font-semibold text-slate-700">
                    {asset.asset.symbol}
                </span>
                {asset.warning_count > 0 && (
                    <span className="text-orange-500"><FiAlertTriangle size={10} /></span>
                )}
            </div>
            <div className="flex items-center gap-2">
                <span className={`text-xs font-bold ${returnColor}`}>
                    {fmtCurrencySigned(asset.unrealized_pnl, baseCurrency)}
                </span>
                <span className="text-slate-400"><FiArrowRight size={10} /></span>
            </div>
        </div>
    );
};

export const DrillSidebar: React.FC<DrillSidebarProps> = ({
    drill,
    onAssetClick,
    onAccountFilterClick,
}) => {
    const { state, assets } = usePnL();
    const baseCurrency = state.config.base_currency_symbol;

    // Rank assets by metric (hoisted before conditionals to satisfy rules of hooks)
    const rankedAssets = useMemo(() => {
        if (!drill.metric) return [];
        const sorted = [...assets].filter(a => a.asset.id != null);
        switch (drill.metric) {
            case 'cost_basis': sorted.sort((a, b) => b.cost_basis - a.cost_basis); break;
            case 'unrealized': sorted.sort((a, b) => Math.abs(b.unrealized_pnl) - Math.abs(a.unrealized_pnl)); break;
            case 'realized': sorted.sort((a, b) => Math.abs(b.realized_pnl) - Math.abs(a.realized_pnl)); break;
            case 'fees': sorted.sort((a, b) => b.total_fees - a.total_fees); break;
            case 'total_return': sorted.sort((a, b) => Math.abs(b.unrealized_pnl + b.realized_pnl) - Math.abs(a.unrealized_pnl + a.realized_pnl)); break;
            case 'warnings': sorted.sort((a, b) => b.warning_count - a.warning_count); break;
        }
        return sorted.slice(0, 15);
    }, [assets, drill.metric]);

    // Don't render at L0
    if (drill.level === 0) return null;

    // ── Asset Mode (L2) ──
    if (drill.level === 2 && drill.assetId != null) {
        const asset = assets.find(a => a.asset.id === drill.assetId);
        if (!asset) return null;

        const accountBreakdown = asset.asset.id != null
            ? state.accountBalances.get(asset.asset.id)
            : undefined;

        const returnColor = asset.unrealized_pnl >= 0 ? 'text-green-600' : 'text-red-600';
        const totalReturn = asset.unrealized_pnl + asset.realized_pnl;

        return (
            <div className="h-full border border-slate-200 bg-white p-3">
                <Heading className="mb-2 text-sm">{asset.asset.symbol}</Heading>
                {asset.asset.label && <span className="mb-2 block text-xs text-slate-500">{asset.asset.label}</span>}

                <div className="mb-3 grid grid-cols-2 gap-1">
                    <SidebarMetric label="Market Value" value={fmtCurrency(asset.market_value, baseCurrency)} />
                    <SidebarMetric label="Cost Basis" value={fmtCurrency(asset.cost_basis, baseCurrency)} />
                    <SidebarMetric label="Unrealized" value={fmtCurrencySigned(asset.unrealized_pnl, baseCurrency)} color={returnColor} />
                    <SidebarMetric label="Realized" value={fmtCurrencySigned(asset.realized_pnl, baseCurrency)} color={asset.realized_pnl >= 0 ? 'text-green-600' : 'text-red-600'} />
                    <SidebarMetric label="Total Return" value={fmtCurrencySigned(totalReturn, baseCurrency)} color={totalReturn >= 0 ? 'text-green-600' : 'text-red-600'} />
                    <SidebarMetric label="Fees" value={fmtCurrency(asset.total_fees, baseCurrency)} />
                </div>

                <div className="mb-3 flex flex-wrap gap-1">
                    <Badge colorScheme="blue">{asset.lot_count} lots</Badge>
                    <Badge colorScheme="purple">{asset.realized_event_count} realized</Badge>
                    {asset.warning_count > 0 && (
                        <Badge colorScheme="orange">{asset.warning_count} warnings</Badge>
                    )}
                </div>

                {/* Per-account breakdown */}
                {accountBreakdown && accountBreakdown.length > 0 && (
                    <div>
                        <span className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">
                            Accounts
                        </span>
                        {accountBreakdown.map(ab => {
                            const acct = state.accounts.find(a => a.id === ab.account_id);
                            const isActive = drill.accountFilter === ab.account_id;
                            return (
                                <div
                                    key={ab.account_id}
                                    className={`flex cursor-pointer items-center justify-between px-2 py-1 ${isActive ? 'bg-blue-50 hover:bg-blue-50' : 'hover:bg-slate-50'
                                        }`}
                                    onClick={() => onAccountFilterClick?.(ab.account_id)}
                                >
                                    <span className="text-xs text-slate-700">{acct?.name ?? `#${ab.account_id}`}</span>
                                    <span className="font-mono text-xs text-slate-600">
                                        {ab.qty.toFixed(4)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    // ── Category Mode (L1) ──
    if (drill.entityType === 'category' && drill.entityId != null) {
        const categoryAssets = assets.filter(a => a.category_ids.includes(drill.entityId!));
        const totals = aggregateAssets(categoryAssets);

        return (
            <SidebarAggregateView
                title={drill.entityLabel ?? 'Category'}
                totals={totals}
                assetList={categoryAssets}
                baseCurrency={baseCurrency}
                onAssetClick={onAssetClick}
            />
        );
    }

    // ── Account Mode (L1) ──
    if (drill.entityType === 'account' && drill.entityId != null) {
        const accountAssets = assets.filter(a => a.account_ids.includes(drill.entityId!));
        const totals = aggregateAssets(accountAssets);

        return (
            <SidebarAggregateView
                title={drill.entityLabel ?? 'Account'}
                totals={totals}
                assetList={accountAssets}
                baseCurrency={baseCurrency}
                onAssetClick={onAssetClick}
            />
        );
    }

    // ── Metric Mode (L1) ──
    if (drill.metric) {
        const metricLabel = drill.metric.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase());

        const totals = aggregateAssets(assets);

        return (
            <div className="h-full border border-slate-200 bg-white p-3">
                <Heading className="mb-2 text-sm">{metricLabel}</Heading>
                {state.timeframeRange !== 'all' && (
                    <Badge colorScheme="blue" className="mb-2">
                        {state.timeframeRange.toUpperCase()}
                    </Badge>
                )}

                <div className="mb-3 grid grid-cols-2 gap-1">
                    <SidebarMetric label="Total Value" value={fmtCurrency(totals.marketValue, baseCurrency)} />
                    <SidebarMetric label="Cost Basis" value={fmtCurrency(totals.costBasis, baseCurrency)} />
                    <SidebarMetric label="Unrealized" value={fmtCurrencySigned(totals.unrealizedPnl, baseCurrency)} color={totals.unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'} />
                    <SidebarMetric label="Realized" value={fmtCurrencySigned(totals.realizedPnl, baseCurrency)} color={totals.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'} />
                </div>

                <span className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">
                    Top Contributors
                </span>
                {rankedAssets.map(a => (
                    <SidebarAssetRow
                        key={a.asset.id}
                        asset={a}
                        baseCurrency={baseCurrency}
                        onClick={() => a.asset.id != null && a.asset.symbol && onAssetClick(a.asset.id, a.asset.symbol)}
                    />
                ))}
            </div>
        );
    }

    return null;
};

// ── Helpers ──

function aggregateAssets(assetList: AssetPnLRow[]) {
    return assetList.reduce(
        (acc, a) => ({
            marketValue: acc.marketValue + a.market_value,
            costBasis: acc.costBasis + a.cost_basis,
            unrealizedPnl: acc.unrealizedPnl + a.unrealized_pnl,
            realizedPnl: acc.realizedPnl + a.realized_pnl,
            totalFees: acc.totalFees + a.total_fees,
            lotCount: acc.lotCount + a.lot_count,
            warningCount: acc.warningCount + a.warning_count,
            assetCount: acc.assetCount + 1,
        }),
        { marketValue: 0, costBasis: 0, unrealizedPnl: 0, realizedPnl: 0, totalFees: 0, lotCount: 0, warningCount: 0, assetCount: 0 },
    );
}

/** Reusable aggregate sidebar for category/account modes */
const SidebarAggregateView: React.FC<{
    title: string;
    totals: ReturnType<typeof aggregateAssets>;
    assetList: AssetPnLRow[];
    baseCurrency: string;
    onAssetClick: (assetId: number, assetSymbol: string) => void;
}> = ({ title, totals, assetList, baseCurrency, onAssetClick }) => (
    <div className="h-full border border-slate-200 bg-white p-3">
        <Heading className="mb-1 text-sm">{title}</Heading>
        <span className="mb-2 block text-xs text-slate-500">{totals.assetCount} assets</span>

        <div className="mb-3 grid grid-cols-2 gap-1">
            <SidebarMetric label="Total Value" value={fmtCurrency(totals.marketValue, baseCurrency)} />
            <SidebarMetric label="Cost Basis" value={fmtCurrency(totals.costBasis, baseCurrency)} />
            <SidebarMetric
                label="Unrealized"
                value={fmtCurrencySigned(totals.unrealizedPnl, baseCurrency)}
                color={totals.unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}
            />
            <SidebarMetric
                label="Realized"
                value={fmtCurrencySigned(totals.realizedPnl, baseCurrency)}
                color={totals.realizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}
            />
            <SidebarMetric label="Fees" value={fmtCurrency(totals.totalFees, baseCurrency)} />
            <SidebarMetric label="Lots" value={String(totals.lotCount)} />
        </div>

        {totals.warningCount > 0 && (
            <div className="mb-2 flex items-center gap-1">
                <span className="text-orange-500"><FiAlertTriangle size={12} /></span>
                <span className="text-xs text-orange-600">{totals.warningCount} warnings</span>
            </div>
        )}

        <span className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">
            Assets
        </span>
        <div className="max-h-[300px] overflow-y-auto">
            {assetList.map(a => (
                <SidebarAssetRow
                    key={a.asset.id ?? a.asset.symbol}
                    asset={a}
                    baseCurrency={baseCurrency}
                    onClick={() => a.asset.id != null && a.asset.symbol && onAssetClick(a.asset.id, a.asset.symbol)}
                />
            ))}
        </div>
    </div>
);
