/**
 * AssetPnLOverviewSection — Standalone PnL overview for a single asset.
 *
 * Reuses HeroMetricsBar, MetricItem, PeriodChartPanel, and AccountBadge
 * from the PnL drill-down view. Fetches data independently via React Query
 * hooks (no PnL context needed).
 */
import React, { useMemo } from 'react';
import { Badge, Spinner, Text } from './ui/primitives';
import { FiDollarSign, FiTrendingUp, FiTrendingDown, FiClock } from 'react-icons/fi';
import { LuReceipt } from 'react-icons/lu';

import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useVersionMetrics, usePortfolioTimeline } from '../hooks/useChartData';
import { usePriceGapsSummary } from '../hooks/usePriceGaps';
import { MetricItem, fmtCurrency, fmtCurrencySigned } from './pnl/TotalReturnScorecard';
import { TERM_HELP } from './pnl/pnlTerms';
import { HeroMetricsBar } from './pnl/HeroMetricsBar';
import { PeriodChartPanel } from './pnl/PeriodChartPanel';
import { GapFixPanel } from './GapFixPanel';
import { AccountBadge } from './AccountBadge';
import { formatQuantity } from '../utils/numberUtils';
import { API_URL } from '../types';
import type { AccountBalanceBreakdown, PerAccountBalanceItem } from './pnl/types';
import { useQuery } from '@tanstack/react-query';

// ─── Account balances hook (standalone, single-asset) ───────────────────────

export function useAccountBalances(versionId: number | null, assetId: number | null) {
    const result = useQuery<PerAccountBalanceItem[]>({
        queryKey: ['account-balances-asset', versionId, assetId],
        queryFn: async ({ signal }) => {
            const params = new URLSearchParams({
                group_by_asset: 'false',
                include_unsettled_negative: 'true',
            });
            const res = await fetch(
                `${API_URL}/pnl/versions/${versionId}/balances?${params}`,
                { signal },
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        },
        enabled: !!versionId && !!assetId,
        staleTime: 5 * 60_000,
    });

    const breakdowns = useMemo<AccountBalanceBreakdown[]>(() => {
        if (!result.data || !assetId) return [];
        return result.data
            .filter(b => b.asset.id === assetId)
            .map(b => ({
                account_id: b.account_id,
                account_name: b.account_name,
                qty: b.qty,
                cost_basis_in_base: b.cost_basis_in_base,
                avg_unit_cost_in_base: b.avg_unit_cost_in_base,
                lot_count: b.lot_count,
            }));
    }, [result.data, assetId]);

    return { breakdowns, isLoading: result.isLoading };
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface AssetPnLOverviewSectionProps {
    assetId: number;
    assetSymbol?: string;
    /** Explicit PnL version ID (skips latest-version fetch when provided) */
    versionId?: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const AssetPnLOverviewSection: React.FC<AssetPnLOverviewSectionProps> = ({
    assetId,
    assetSymbol,
    versionId: explicitVersionId,
}) => {
    const { version, versionId: latestVersionId, baseCurrency, isLoading: versionLoading } = useLatestPnLVersion();
    const versionId = explicitVersionId ?? latestVersionId;

    const metrics = useVersionMetrics(versionId, { assetIds: [assetId] }, !!versionId);
    const timeline = usePortfolioTimeline(versionId, { assetIds: [assetId], granularity: 'daily' }, !!versionId);
    const { breakdowns: accountBreakdowns } = useAccountBalances(versionId, assetId);
    const gapSummary = usePriceGapsSummary([assetId], !!assetId);
    const hasGaps = (gapSummary.data?.items ?? []).some(a => a.gap_count > 0);

    // Map range data → HeroMetricsBar props (same mapping as PnLDetailPanel)
    const rangeData = metrics.data?.ranges?.all;

    const scopedMetrics = useMemo(() => {
        if (!rangeData) return null;
        return {
            totalReturn: rangeData.total_return,
            roi: rangeData.roi_pct,
            currentValue: rangeData.current_value,
            costBasis: rangeData.cost_basis,
            totalInvested: rangeData.total_invested ?? rangeData.cost_basis,
            unrealizedPnl: rangeData.unrealized_pnl,
            realizedPnl: rangeData.realized_pnl,
            taxableRealizedPnl: rangeData.taxable_realized_pnl ?? 0,
            feesInPeriod: rangeData.fees_in_period ?? 0,
            totalFees: metrics.data?.summary?.total_fees ?? 0,
        };
    }, [rangeData, metrics.data?.summary]);

    // Enrich account breakdowns with market value from metrics
    const enrichedBreakdowns = useMemo<AccountBalanceBreakdown[]>(() => {
        if (!accountBreakdowns.length || !scopedMetrics) return accountBreakdowns;
        const totalQty = accountBreakdowns.reduce((s, b) => s + b.qty, 0);
        const unitValue = totalQty > 0 ? scopedMetrics.currentValue / totalQty : 0;
        return accountBreakdowns.map(b => {
            if (unitValue <= 0) return b;
            const mv = b.qty * unitValue;
            const urPnl = mv - b.cost_basis_in_base;
            const urPct = b.cost_basis_in_base > 0 ? (urPnl / b.cost_basis_in_base) * 100 : 0;
            return { ...b, market_value: mv, unrealized_pnl: urPnl, unrealized_pnl_pct: urPct };
        });
    }, [accountBreakdowns, scopedMetrics]);

    const color = (val: number) => (val >= 0 ? 'green.600' : 'red.600');

    // ── Loading / no-data states ──
    if (versionLoading || metrics.isLoading) {
        return (
            <div className="flex justify-center py-6">
                <Spinner size="sm" />
                <Text className="ml-2 text-xs text-gray-500">Loading PnL data…</Text>
            </div>
        );
    }

    if (!versionId || !scopedMetrics) {
        return (
            <Text className="block py-3 text-center text-xs text-gray-400">
                No PnL calculation available.
            </Text>
        );
    }

    const createdAt = version?.created_at
        ? new Date(version.created_at).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        })
        : 'Unknown';

    return (
        <div>
            {/* Version info banner */}
            <div className="mb-2 flex items-center gap-1.5 bg-gray-50 px-2 py-1 text-[10px] text-gray-500">
                <FiClock size={10} />
                <Text>
                    Version #{version?.version_id} · {createdAt}
                </Text>
                <Badge colorScheme="gray" className="ml-1">
                    {version?.lot_method}
                </Badge>
            </div>

            {/* Hero metrics bar — reuse from PnL drill-down */}
            <HeroMetricsBar
                totalReturn={scopedMetrics.totalReturn}
                roi={scopedMetrics.roi}
                baseCurrency={baseCurrency}
                costBasisInPeriod={scopedMetrics.costBasis}
                unrealizedInPeriod={scopedMetrics.unrealizedPnl}
                realizedInPeriod={scopedMetrics.realizedPnl}
                feesInPeriod={scopedMetrics.feesInPeriod}
                fmtCurrencySigned={fmtCurrencySigned}
                color={color}
            >
                <MetricItem label="Value" value={fmtCurrency(scopedMetrics.currentValue, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} bg="blue.50" />
                <MetricItem label="Cost" value={fmtCurrency(scopedMetrics.costBasis, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" info={TERM_HELP.cost} subLines={Math.abs(scopedMetrics.totalInvested - scopedMetrics.costBasis) > 0.01 ? [{ label: 'Total bought', value: fmtCurrency(scopedMetrics.totalInvested, baseCurrency), info: TERM_HELP.totalBought }] : undefined} />
                <MetricItem label="Unrealized" value={fmtCurrencySigned(scopedMetrics.unrealizedPnl, baseCurrency)} color={color(scopedMetrics.unrealizedPnl)} icon={scopedMetrics.unrealizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.unrealizedPnl >= 0 ? 'green.50' : 'red.50'} />
                <MetricItem label="Realized" value={fmtCurrencySigned(scopedMetrics.realizedPnl, baseCurrency)} color={color(scopedMetrics.realizedPnl)} icon={scopedMetrics.realizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={scopedMetrics.realizedPnl >= 0 ? 'green.50' : 'red.50'} info={TERM_HELP.realized} subLines={[{ label: 'Taxable', value: fmtCurrencySigned(scopedMetrics.taxableRealizedPnl, baseCurrency), info: TERM_HELP.taxable }]} />
                <MetricItem label="Fees" value={fmtCurrency(scopedMetrics.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" />
            </HeroMetricsBar>

            {/* Account breakdown cards — same layout as PnLDetailPanel */}
            {enrichedBreakdowns.length > 0 && (
                <div className="mt-2 flex flex-wrap items-stretch gap-2">
                    {enrichedBreakdowns.map(b => {
                        const urPnl = b.unrealized_pnl ?? 0;
                        return (
                            <div
                                key={b.account_id}
                                className="min-w-[140px] flex-1 border-l-[3px] border-l-blue-300 bg-gray-50 px-2.5 py-1.5"
                            >
                                <AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" />
                                <Text className="mt-1.5 block text-xs font-semibold text-gray-700">
                                    {formatQuantity(b.qty)}
                                </Text>
                                {b.market_value != null && (
                                    <Text className="mt-0.5 block text-xs text-gray-600">
                                        {fmtCurrency(b.market_value, baseCurrency)}
                                    </Text>
                                )}
                                <Text className={`mt-0.5 block text-xs ${urPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    {fmtCurrencySigned(urPnl, baseCurrency)}
                                    {b.unrealized_pnl_pct != null && (
                                        <span className="ml-1 text-gray-500">
                                            ({b.unrealized_pnl_pct >= 0 ? '+' : ''}{b.unrealized_pnl_pct.toFixed(1)}%)
                                        </span>
                                    )}
                                </Text>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Performance / Cost vs Value chart — reuse PeriodChartPanel */}
            <div className="mt-3">
                <PeriodChartPanel
                    points={timeline.data?.points || []}
                    baseCurrency={baseCurrency}
                    range="all"
                    isLoading={timeline.isLoading}
                    error={timeline.error}
                    versionId={versionId}
                    contextLabel={assetSymbol}
                    assetId={assetId}
                    assetSymbol={assetSymbol}
                />
            </div>

            {/* Price gap fix panel (when gaps detected) */}
            {hasGaps && assetSymbol && (
                <div className="mt-3">
                    <GapFixPanel assetId={assetId} symbol={assetSymbol} />
                </div>
            )}
        </div>
    );
};
