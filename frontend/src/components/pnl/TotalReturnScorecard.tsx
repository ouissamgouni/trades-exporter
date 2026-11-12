/**
 * TotalReturnScorecard
 *
 * Unified period-aware P&L overview:
 * - TimeframeIndicators — overview cards + accounts slot + contributors (3/5) and period chart (2/5)
 *
 * For "All" range: uses authoritative summary from the P&L engine.
 * For specific ranges (1Y, 6M, etc.): computes deltas from the timeline.
 *
 * Total Return = Unrealized P&L + Realized P&L
 * ROI% = Total Return / Cost Basis
 */
import React, { useMemo, useState } from 'react';
import { Badge } from '../ui/primitives';
import { FiTrendingUp, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import { LuBanknote } from 'react-icons/lu';
import { InfoTip, TERM_HELP } from './pnlTerms';
import { OverviewCards } from './OverviewCards';
import { ContributorsPanel } from './ContributorsPanel';
import { PeriodChartPanel } from './PeriodChartPanel';
import type { TimelinePoint, VersionMetricsResponse, BookMetricsResponse, LiveMetricsResponse, PerformersResponse, RangeKey, PerformerItem as BackendPerformerItem, GroupBy, ReturnMetricsRange } from '../../hooks/useChartData';
import type { DimensionWithCategories } from '../../types';
import type { AssetPnLRow } from './types';

/** Authoritative totals from the P&L calculation engine */
export interface ScorecardSummary {
    portfolioValue: number;
    costBasis: number;
    unrealizedPnl: number;
    realizedPnl: number;
    taxableRealizedPnl: number;
    /** Gain already counted in Realized (economic) but not yet taxed */
    deferredGain?: number;
    totalFees: number;
    feeEntryCount: number;
}

// Currency symbol mapping — shows € instead of "EUR", etc.
const CURRENCY_SYMBOLS: Record<string, string> = {
    EUR: '€', USD: '$', GBP: '£', JPY: '¥', CHF: 'CHF', CAD: 'C$', AUD: 'A$',
    CNY: '¥', KRW: '₩', INR: '₹', BRL: 'R$', RUB: '₽', TRY: '₺', PLN: 'zł',
    SEK: 'kr', NOK: 'kr', DKK: 'kr', CZK: 'Kč', HUF: 'Ft', MXN: 'Mex$',
};

export function currencySymbol(code: string): string {
    return CURRENCY_SYMBOLS[code.toUpperCase()] ?? code;
}

// Compact currency formatting
export function fmtCurrency(val: number, currency: string): string {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    const sym = currencySymbol(currency);
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M ${sym}`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K ${sym}`;
    return `${sign}${abs.toFixed(2)} ${sym}`;
}

/** Like fmtCurrency but always prefixes + or - (for total return display) */
export function fmtCurrencySigned(val: number, currency: string): string {
    const prefix = val >= 0 ? '+' : '-';
    const abs = Math.abs(val);
    const sym = currencySymbol(currency);
    if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(2)}M ${sym}`;
    if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(1)}K ${sym}`;
    return `${prefix}${abs.toFixed(2)} ${sym}`;
}

/**
 * Converts a Chakra-style dot-notation color token (e.g. "blue.700") into a Tailwind
 * utility class (e.g. "text-blue-700" / "bg-blue-700"). MetricItem's `color`/`bg` props
 * keep this token format so existing callers across the app (including files not yet
 * migrated off Chakra) don't need to change.
 */
function tokenToClass(token: string | undefined, prefix: 'text' | 'bg', fallback: string): string {
    if (!token || token === 'transparent') return prefix === 'bg' ? 'bg-transparent' : fallback;
    const parts = token.split('.');
    if (parts.length === 2) return `${prefix}-${parts[0]}-${parts[1]}`;
    return fallback;
}

export interface MetricSubLine {
    label: string;
    value: string;
    info?: string;
}

/** Taxable and (when non-zero) Deferred lines under Realized. */
export function realizedSubLines(
    m: { taxableRealizedPnl: number; deferredGain?: number },
    currency: string,
    fmt: (val: number, currency: string) => string,
): MetricSubLine[] {
    const lines: MetricSubLine[] = [{ label: 'Taxable', value: fmt(m.taxableRealizedPnl, currency), info: TERM_HELP.taxable }];
    if (m.deferredGain && Math.abs(m.deferredGain) >= 0.01) {
        lines.push({ label: 'Deferred', value: fmt(m.deferredGain, currency), info: TERM_HELP.deferred });
    }
    return lines;
}

/** "Taxable: X", plus the tax-deferred part of Realized when there is one */
export function realizedSubValue(
    m: { taxableRealizedPnl: number; deferredGain?: number },
    currency: string,
    fmt: (val: number, currency: string) => string,
): string {
    const taxable = `Taxable: ${fmt(m.taxableRealizedPnl, currency)}`;
    return m.deferredGain && Math.abs(m.deferredGain) >= 0.01
        ? `${taxable} · Deferred: ${fmt(m.deferredGain, currency)}`
        : taxable;
}

export type Range = 'all' | '3y' | '1y' | '6m' | '3m' | '1m' | '1w';
export const RANGES: { key: Range; label: string; days: number | null }[] = [
    { key: '1w', label: '1W', days: 7 },
    { key: '1m', label: '1M', days: 30 },
    { key: '3m', label: '3M', days: 90 },
    { key: '6m', label: '6M', days: 180 },
    { key: '1y', label: '1Y', days: 365 },
    { key: '3y', label: '3Y', days: 1095 },
    { key: 'all', label: 'All', days: null },
];

export interface RangeMetrics {
    totalReturn: number;
    roi: number;
    currentValue: number;
    costBasis: number;
    totalInvested: number;
    netDeposits?: number;
    unfundedSpend?: number;
    unrealizedPnl: number;
    realizedPnl: number;
    taxableRealizedPnl: number;
    deferredGain?: number;
    realizedInPeriod: number;
    taxableRealizedInPeriod: number;
    totalFees: number;
    feeEntryCount: number;
    costBasisInPeriod: number;
    unrealizedInPeriod: number;
    feesInPeriod: number;
    totalIncome: number;
    totalWithholding: number;
    incomeEventCount: number;
    incomeInPeriod: number;
    withholdingInPeriod: number;
}

/** Compute metrics for a given range from timeline points + optional authoritative summary */
export function computeMetricsForRange(
    rangeKey: Range,
    points: TimelinePoint[],
    summary: ScorecardSummary | null | undefined,
): RangeMetrics | null {
    if (rangeKey === 'all' && summary) {
        const totalReturn = summary.unrealizedPnl + summary.realizedPnl;
        const roi = summary.costBasis !== 0 ? (totalReturn / summary.costBasis) * 100 : 0;
        return {
            totalReturn,
            roi,
            currentValue: summary.portfolioValue,
            costBasis: summary.costBasis,
            totalInvested: summary.costBasis,
            unrealizedPnl: summary.unrealizedPnl,
            realizedPnl: summary.realizedPnl,
            taxableRealizedPnl: summary.taxableRealizedPnl,
            deferredGain: summary.deferredGain,
            realizedInPeriod: summary.realizedPnl,
            taxableRealizedInPeriod: summary.taxableRealizedPnl,
            totalFees: summary.totalFees,
            feeEntryCount: summary.feeEntryCount,
            costBasisInPeriod: summary.costBasis,
            unrealizedInPeriod: summary.unrealizedPnl,
            feesInPeriod: summary.totalFees,
            totalIncome: 0,
            totalWithholding: 0,
            incomeEventCount: 0,
            incomeInPeriod: 0,
            withholdingInPeriod: 0,
        };
    }

    if (!points.length) return null;

    let filteredPoints = points;
    const selectedRange = RANGES.find(r => r.key === rangeKey);
    if (selectedRange?.days) {
        const lastDate = new Date(points[points.length - 1].date + 'T00:00:00');
        const cutoff = new Date(lastDate);
        cutoff.setDate(cutoff.getDate() - selectedRange.days);
        const cutoffStr = cutoff.toISOString().split('T')[0];
        filteredPoints = points.filter(p => p.date >= cutoffStr);
        if (filteredPoints.length < 2) filteredPoints = points;
    }

    const first = filteredPoints[0];
    const last = filteredPoints[filteredPoints.length - 1];

    const unrealizedPnl = last.unrealized_pnl;
    const realizedPnl = last.cumulative_realized_pnl;
    const realizedInPeriod = last.cumulative_realized_pnl - first.cumulative_realized_pnl;
    const unrealizedChange = last.unrealized_pnl - first.unrealized_pnl;

    const totalReturn = rangeKey === 'all'
        ? unrealizedPnl + realizedPnl
        : unrealizedChange + realizedInPeriod;

    const costBasis = last.cost_basis_in_base;
    const roiBase = rangeKey === 'all' ? costBasis : (first.cost_basis_in_base || costBasis);
    const roi = roiBase !== 0 ? (totalReturn / roiBase) * 100 : 0;

    return {
        totalReturn,
        roi,
        currentValue: last.total_value_in_base,
        costBasis,
        totalInvested: costBasis,
        unrealizedPnl,
        realizedPnl,
        taxableRealizedPnl: summary?.taxableRealizedPnl ?? 0,
        realizedInPeriod,
        taxableRealizedInPeriod: 0,
        totalFees: summary?.totalFees ?? 0,
        feeEntryCount: summary?.feeEntryCount ?? 0,
        costBasisInPeriod: costBasis - (first.cost_basis_in_base || 0),
        unrealizedInPeriod: unrealizedChange,
        feesInPeriod: 0,
        totalIncome: 0,
        totalWithholding: 0,
        incomeEventCount: 0,
        incomeInPeriod: 0,
        withholdingInPeriod: 0,
    };
}

// AllTimeIndicators removed — merged into TimeframeIndicators with range="all"

// ═══════════════════════════════════════════════════════════════════
// TimeframeIndicators — unified period overview (Level 0)
// ═══════════════════════════════════════════════════════════════════

export type PerformerSort = 'return' | 'roi' | 'unrealized' | 'market_value' | 'cost' | 'fees' | 'efficiency';

export type PerformerDisplay = '$' | '%';
export type PerformerMetric = 'TR' | 'U' | 'MV' | 'Eff';

interface TimeframeIndicatorsProps {
    points: TimelinePoint[];
    baseCurrency: string;
    isLoading?: boolean;
    summary?: ScorecardSummary | null;
    /** Current selected range (controlled) */
    range: Range;
    /** Called when user clicks a different range card */
    onRangeChange: (range: Range) => void;
    /** Backend version metrics — used when available instead of client computation */
    periodSummaryData?: VersionMetricsResponse;
    /** Book metrics (cost-lot-based, instant) */
    bookData?: BookMetricsResponse;
    /** Live metrics (price-dependent, after prices) */
    liveData?: LiveMetricsResponse;
    /** Whether live metrics are still loading */
    isLiveLoading?: boolean;
    /** Standalone performers data */
    performersData?: PerformersResponse;
    /** Whether performers are still loading */
    isPerformersLoading?: boolean;
    /** Current group_by mode for performers */
    groupBy?: GroupBy;
    /** Called when user clicks a different performer type badge */
    onGroupByChange?: (groupBy: GroupBy) => void;
    /** Callback when user clicks an asset in best/worst list */
    onAssetClick?: (assetId: number) => void;
    /** Callback when user clicks a category performer */
    onCategoryClick?: (categoryId: number, categoryLabel: string) => void;
    /** Callback when user clicks an account performer */
    onAccountClick?: (accountId: number, accountLabel: string) => void;
    /** Callback when user clicks a metric for drill-down */
    onMetricClick?: (metric: 'total_return' | 'cost_basis' | 'unrealized' | 'realized') => void;
    /** Available category dimensions for grouping */
    dimensions?: DimensionWithCategories[];
    /** Currently selected dimension ID (when groupBy=category) */
    selectedDimensionId?: number | null;
    /** Called when user selects a dimension */
    onDimensionChange?: (dimensionId: number) => void;
    /** Callback when user clicks the fees metric */
    onFeesClick?: () => void;
    /** Callback when user clicks the income metric */
    onIncomeClick?: () => void;
    /** Unified performer click callback (replaces separate asset/category/account clicks) */
    onPerformerClick?: (id: number, groupType: string, name: string) => void;
    /** Version ID for fullscreen performance chart */
    versionId?: number | null;
    /** Assets for fullscreen performance chart */
    assets?: AssetPnLRow[];
    /** When true, period selector cards are hidden (rendered externally e.g. in breadcrumb row) */
    hidePeriodCards?: boolean;
    /** When true, best/worst performers and period chart are hidden (e.g. asset-level view) */
    hidePerformers?: boolean;
    /** Optional replacement content shown where performers normally appear */
    performerSlot?: React.ReactNode;
    /** Context label (e.g. asset symbol, category name) shown in chart legends */
    contextLabel?: string;
    /** Asset ID — enables Price chart tab in PeriodChartPanel */
    assetId?: number;
    /** Asset symbol — label for price chart series */
    assetSymbol?: string;
    /** Rendered between the cards and the chart row (accounts strip / balance by account) */
    accountsSlot?: React.ReactNode;
    /** TWR / IRR for the selected range */
    returnMetrics?: ReturnMetricsRange | null;
    /** Benchmark lines inside the Total return card */
    benchmarkSlot?: React.ReactNode;
    /** Page-wide main benchmark ticker for the performance chart */
    mainBenchmark?: string;
}

export const TimeframeIndicators: React.FC<TimeframeIndicatorsProps> = ({
    points,
    baseCurrency,
    isLoading,
    summary,
    range,
    onRangeChange,
    periodSummaryData,
    bookData,
    liveData,
    isLiveLoading,
    performersData,
    isPerformersLoading,
    groupBy = 'asset',
    onGroupByChange,
    onAssetClick,
    onCategoryClick,
    onAccountClick,
    onMetricClick,
    dimensions = [],
    selectedDimensionId,
    onDimensionChange,
    onFeesClick,
    onIncomeClick,
    onPerformerClick,
    versionId,
    assets: assetsProp,
    hidePeriodCards = false,
    hidePerformers = false,
    performerSlot,
    contextLabel,
    assetId,
    assetSymbol,
    accountsSlot,
    returnMetrics,
    benchmarkSlot,
    mainBenchmark,
}) => {
    const periodLabel = RANGES.find(r => r.key === range)?.label ?? 'All';
    const isPeriod = range !== 'all';

    // Pre-compute ROI% for all ranges: must use liveData (live-price-dependent)
    const allRangeRois = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        for (const r of RANGES) {
            const mkt = liveData?.ranges?.[r.key as RangeKey];
            if (mkt) {
                result[r.key] = mkt.roi_pct;
            }
            // Don't fall back to periodSummaryData — its ROI uses stale prices
        }
        return result;
    }, [liveData]);

    // Active range metrics: build from bookData + liveData (groupBy-independent)
    const metrics = useMemo(() => {
        const book = bookData?.ranges?.[range as RangeKey];
        const live = liveData?.ranges?.[range as RangeKey];
        if (book) {
            return {
                totalReturn: live?.total_return ?? book.realized_pnl,
                roi: live?.roi_pct ?? 0,
                currentValue: live?.current_value ?? 0,
                costBasis: book.cost_basis,
                totalInvested: book.total_invested ?? book.cost_basis,
                netDeposits: book.net_deposits ?? 0,
                unfundedSpend: range === 'all' ? (bookData?.summary?.unfunded_spend ?? 0) : 0,
                unrealizedPnl: live?.unrealized_pnl ?? 0,
                realizedPnl: book.realized_pnl,
                taxableRealizedPnl: book.taxable_realized_pnl ?? 0,
                deferredGain: book.deferred_gain ?? 0,
                realizedInPeriod: book.realized_in_period,
                taxableRealizedInPeriod: (book as { taxable_realized_in_period?: number }).taxable_realized_in_period ?? 0,
                totalFees: book.fees_in_period ?? summary?.totalFees ?? 0,
                feeEntryCount: summary?.feeEntryCount ?? 0,
                costBasisInPeriod: book.cost_basis_in_period ?? 0,
                unrealizedInPeriod: live?.unrealized_in_period ?? 0,
                feesInPeriod: book.fees_in_period ?? 0,
                totalIncome: bookData?.summary?.total_income ?? 0,
                totalWithholding: bookData?.summary?.total_withholding ?? 0,
                incomeEventCount: bookData?.summary?.income_event_count ?? 0,
                incomeInPeriod: book.income_in_period ?? 0,
                withholdingInPeriod: book.withholding_in_period ?? 0,
            } as RangeMetrics;
        }
        // Legacy fallback: use periodSummaryData or client computation
        const backendRange = periodSummaryData?.ranges?.[range as RangeKey];
        if (backendRange) {
            return {
                totalReturn: backendRange.total_return,
                roi: backendRange.roi_pct,
                currentValue: backendRange.current_value,
                costBasis: backendRange.cost_basis,
                totalInvested: backendRange.total_invested ?? backendRange.cost_basis,
                unrealizedPnl: backendRange.unrealized_pnl,
                realizedPnl: backendRange.realized_pnl,
                taxableRealizedPnl: backendRange.taxable_realized_pnl ?? 0,
                realizedInPeriod: backendRange.realized_in_period,
                taxableRealizedInPeriod: (backendRange as { taxable_realized_in_period?: number }).taxable_realized_in_period ?? 0,
                totalFees: backendRange.fees_in_period ?? summary?.totalFees ?? 0,
                feeEntryCount: summary?.feeEntryCount ?? 0,
                costBasisInPeriod: backendRange.cost_basis_in_period ?? 0,
                unrealizedInPeriod: backendRange.unrealized_in_period ?? 0,
                feesInPeriod: backendRange.fees_in_period ?? 0,
                totalIncome: 0,
                totalWithholding: 0,
                incomeEventCount: 0,
                incomeInPeriod: 0,
                withholdingInPeriod: 0,
            } as RangeMetrics;
        }
        return computeMetricsForRange(range, points, summary);
    }, [points, range, summary, bookData, liveData, periodSummaryData]);

    // All ranked items (top_n is large, so top + flop is the full set)
    const contributorItems = useMemo((): BackendPerformerItem[] => {
        if (performersData) return [...(performersData.top_performers ?? []), ...(performersData.flop_performers ?? [])];
        const rangeData = periodSummaryData?.ranges?.[range as RangeKey];
        return [...(rangeData?.top_performers ?? []), ...(rangeData?.flop_performers ?? [])];
    }, [performersData, periodSummaryData, range]);

    const startValue = useMemo(() => {
        const days = RANGES.find(r => r.key === range)?.days;
        if (!days || !points.length) return null;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        let v: number | null = null;
        for (const p of points) {
            if (p.date > cutoffStr) break;
            v = p.total_value_in_base;
        }
        return v ?? points[0].total_value_in_base;
    }, [points, range]);

    // Unified performer click: prefer onPerformerClick, fallback to type-specific handlers
    const handlePerformerClick = (p: BackendPerformerItem) => {
        const name = p.label || p.name;
        if (onPerformerClick) {
            onPerformerClick(p.id, groupBy, name);
        } else if (groupBy === 'asset' && onAssetClick) {
            onAssetClick(p.id);
        } else if (groupBy === 'category' && onCategoryClick) {
            onCategoryClick(p.id, name);
        } else if (groupBy === 'account' && onAccountClick) {
            onAccountClick(p.id, name);
        }
    };

    const gainsTotal = performersData?.gains_total;
    const lossesTotal = performersData?.losses_total;
    const assetCounts = groupBy === 'asset' && performersData
        ? { gains: contributorItems.filter(p => p.total_return > 0).length, losses: contributorItems.filter(p => p.total_return < 0).length }
        : null;

    const sideContent = hidePerformers
        ? performerSlot ?? null
        : (
            <ContributorsPanel
                items={contributorItems}
                baseCurrency={baseCurrency}
                isLoading={isPerformersLoading}
                periodLabel={periodLabel}
                groupBy={groupBy}
                onGroupByChange={onGroupByChange}
                dimensions={dimensions}
                selectedDimensionId={selectedDimensionId}
                onDimensionChange={onDimensionChange}
                onItemClick={handlePerformerClick}
                versionId={versionId}
            />
        );

    return (
        <div className="border border-gray-200 bg-white p-3">
            {/* Timeframe selector cards (hidden when rendered externally) */}
            {!hidePeriodCards && (
                <div className="mb-3 flex gap-1.5 overflow-x-auto">
                    {RANGES.map(r => {
                        const roi = allRangeRois[r.key];
                        const isActive = range === r.key;
                        return (
                            <div
                                key={r.key}
                                onClick={() => onRangeChange(r.key)}
                                className={`min-w-[70px] flex-1 cursor-pointer border-2 px-2 py-1.5 text-center transition-colors ${isActive ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'}`}
                            >
                                <div className={`text-[10px] font-bold ${isActive ? 'text-blue-700' : 'text-gray-500'}`}>
                                    {r.label}
                                </div>
                                {roi !== null ? (
                                    <div className={`text-xs font-bold ${roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                        {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                                    </div>
                                ) : (
                                    <div className="text-xs text-gray-300">—</div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {isLoading ? (
                <div className="flex flex-col gap-3">
                    <div className="h-16 animate-pulse bg-slate-50" />
                    <div className="h-28 animate-pulse bg-slate-50" />
                </div>
            ) : metrics ? (
                <>
                    <OverviewCards
                        metrics={metrics}
                        isPeriod={isPeriod}
                        periodLabel={periodLabel}
                        baseCurrency={baseCurrency}
                        isLiveLoading={isLiveLoading}
                        returnMetrics={returnMetrics}
                        gains={gainsTotal}
                        losses={lossesTotal}
                        gainCount={assetCounts?.gains}
                        lossCount={assetCounts?.losses}
                        isTotalsLoading={isPerformersLoading}
                        startValue={startValue}
                        assets={assetsProp}
                        benchmarkSlot={benchmarkSlot}
                        onFeesClick={onFeesClick}
                        onIncomeClick={onIncomeClick}
                    />

                    {accountsSlot && <div className="mt-3">{accountsSlot}</div>}

                    {/* Contributors (3/5) + chart (2/5) */}
                    <div className={`mt-3 grid grid-cols-1 items-start gap-3 ${sideContent ? 'lg:grid-cols-5' : ''}`}>
                        {sideContent && <div className="lg:col-span-3">{sideContent}</div>}
                        <div className={`border border-slate-200 bg-white p-2 ${sideContent ? 'lg:col-span-2' : ''}`}>
                            <PeriodChartPanel
                                    points={points}
                                    baseCurrency={baseCurrency}
                                    range={range}
                                    isLoading={isLoading}
                                    versionId={versionId}
                                    assets={assetsProp}
                                    contextLabel={contextLabel}
                                    assetId={assetId}
                                    assetSymbol={assetSymbol}
                                    mainBenchmark={mainBenchmark}
                                />
                        </div>
                    </div>
                </>
            ) : (
                <div className="text-xs text-gray-400">No data for this period</div>
            )}

        </div>
    );
};

// ═══════════════════════════════════════════════════════════════════
// Legacy export — kept for Charts tab compatibility
// ═══════════════════════════════════════════════════════════════════

interface TotalReturnScorecardProps {
    points: TimelinePoint[];
    baseCurrency: string;
    isLoading?: boolean;
    summary?: ScorecardSummary | null;
    onFeesClick?: () => void;
    onIncomeClick?: () => void;
}

export const TotalReturnScorecard: React.FC<TotalReturnScorecardProps> = ({
    points,
    baseCurrency,
    isLoading,
    summary,
    onFeesClick,
    onIncomeClick,
}) => {
    const [range, setRange] = useState<Range>('all');
    const metrics = useMemo(() => computeMetricsForRange(range, points, summary), [points, range, summary]);

    const allRangeRois = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        for (const r of RANGES) {
            const m = computeMetricsForRange(r.key, points, summary);
            result[r.key] = m ? m.roi : null;
        }
        return result;
    }, [points, summary]);

    if (!metrics && !isLoading) return null;

    const color = (val: number) => (val >= 0 ? 'green.600' : 'red.600');
    const Icon = metrics && metrics.totalReturn >= 0 ? FiTrendingUp : FiTrendingDown;

    return (
        <div className="mb-4 border border-gray-200 bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
                <div className={tokenToClass(metrics ? (metrics.totalReturn >= 0 ? 'green.500' : 'red.500') : 'gray.400', 'text', 'text-gray-400')}><Icon size={20} /></div>
                <div className="text-base font-semibold text-gray-700">Total Return</div>
            </div>
            <div className="mb-4 flex gap-2 overflow-x-auto">
                {RANGES.map(r => {
                    const roi = allRangeRois[r.key];
                    const isActive = range === r.key;
                    return (
                        <div
                            key={r.key}
                            onClick={() => setRange(r.key)}
                            className={`min-w-[90px] flex-1 cursor-pointer border-2 px-3 py-2 text-center transition-colors ${isActive ? 'border-blue-500 bg-blue-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'}`}
                        >
                            <div className={`text-xs font-bold ${isActive ? 'text-blue-700' : 'text-gray-500'}`}>{r.label}</div>
                            {roi !== null ? (
                                <div className={`text-sm font-bold ${roi >= 0 ? 'text-green-600' : 'text-red-600'}`}>{roi >= 0 ? '+' : ''}{roi.toFixed(2)}%</div>
                            ) : (<div className="text-sm text-gray-300">—</div>)}
                        </div>
                    );
                })}
            </div>
            {isLoading ? <div className="text-sm text-gray-400">Loading...</div> : metrics ? (
                <>
                    <div className="mb-4 flex items-baseline gap-3">
                        <div className={`text-3xl font-bold ${tokenToClass(color(metrics.totalReturn), 'text', 'text-gray-700')}`}>{fmtCurrency(metrics.totalReturn, baseCurrency)}</div>
                        <Badge colorScheme={metrics.roi >= 0 ? 'green' : 'red'}>{metrics.roi >= 0 ? '+' : ''}{metrics.roi.toFixed(2)}%</Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
                        <MetricItem label="Portfolio Value" value={fmtCurrency(metrics.currentValue, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} />
                        <MetricItem label="Cost Basis" value={fmtCurrency(metrics.costBasis, baseCurrency)} color="gray.600" />
                        <MetricItem label="Unrealized P&L" value={fmtCurrency(metrics.unrealizedPnl, baseCurrency)} color={color(metrics.unrealizedPnl)} />
                        <MetricItem label="Realized P&L" value={fmtCurrency(metrics.realizedPnl, baseCurrency)} color={color(metrics.realizedPnl)} info={TERM_HELP.realized} subLines={realizedSubLines(metrics, baseCurrency, fmtCurrency)} />
                        <MetricItem label="Total Fees" value={fmtCurrency(metrics.totalFees, baseCurrency)} subValue={`${metrics.feeEntryCount} fee events`} color="gray.600" onClick={onFeesClick} />
                        {metrics.incomeEventCount > 0 && (
                            <MetricItem label="Income" value={fmtCurrencySigned(metrics.totalIncome - metrics.totalWithholding, baseCurrency)} color="teal.600" icon={<LuBanknote size={14} />} bg="teal.50" subValue={`${metrics.incomeEventCount} events`} onClick={onIncomeClick} />
                        )}
                    </div>
                </>
            ) : null}
        </div>
    );
};

/* Reusable metric display component — icon label value, with optional sub-value below.
 * `color`/`bg` accept Chakra-style dot-notation tokens (e.g. "blue.700") for backward
 * compatibility with existing callers across the app; tokenToClass() converts them to
 * Tailwind utility classes internally. */
export const MetricItem: React.FC<{
    label: string;
    value: string;
    color: string;
    subValue?: string;
    subLines?: MetricSubLine[];
    info?: string;
    icon?: React.ReactNode;
    bg?: string;
    onClick?: () => void;
    compact?: boolean;
}> = ({ label, value, color, subValue, subLines, info, icon, bg, onClick, compact }) => (
    <div
        className={`flex min-w-[130px] flex-1 flex-col ${onClick ? 'cursor-pointer hover:opacity-85' : 'cursor-default'} ${compact ? 'px-1.5 py-0.5' : 'px-2 py-2'} ${tokenToClass(bg, 'bg', 'bg-transparent')}`}
        onClick={onClick}
    >
        <div className="flex items-center gap-1">
            {icon && <span className={`shrink-0 ${tokenToClass(color, 'text', 'text-gray-700')}`}>{icon}</span>}
            <span className={`whitespace-nowrap font-medium text-gray-500 ${compact ? 'text-[10px]' : 'text-xs'}`}>{label}</span>
            {info && <InfoTip text={info} />}
            <span className={`whitespace-nowrap font-bold ${compact ? 'text-xs' : 'text-sm'} ${tokenToClass(color, 'text', 'text-gray-700')}`}>{value}</span>
        </div>
        {subValue && <span className="mt-0.5 whitespace-nowrap text-[10px] text-gray-400">{subValue}</span>}
        {subLines?.map(line => (
            <span key={line.label} className="mt-0.5 inline-flex items-center gap-1 whitespace-nowrap text-[10px] text-gray-500">
                {line.label}: {line.value}
                {line.info && <InfoTip text={line.info} size={9} />}
            </span>
        ))}
    </div>
);
