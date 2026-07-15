/**
 * TotalReturnScorecard
 *
 * Unified period-aware P&L overview:
 * - TimeframeIndicators — period selector + hero metrics + best/worst performers
 *
 * For "All" range: uses authoritative summary from the P&L engine.
 * For specific ranges (1Y, 6M, etc.): computes deltas from the timeline.
 *
 * Total Return = Unrealized P&L + Realized P&L
 * ROI% = Total Return / Cost Basis
 */
import React, { useContext, useMemo, useState } from 'react';
import { Badge } from '../ui/primitives';
import { FiTrendingUp, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import { LuReceipt, LuInfo, LuBanknote } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { Tooltip } from '../ui/tooltip';
import { HeroMetricsBar } from './HeroMetricsBar';
import { PeriodChartPanel } from './PeriodChartPanel';
import type { TimelinePoint, VersionMetricsResponse, BookMetricsResponse, LiveMetricsResponse, PerformersResponse, RangeKey, PerformerItem as BackendPerformerItem, GroupBy } from '../../hooks/useChartData';
import type { DimensionWithCategories } from '../../types';
import type { AssetPnLRow } from './types';

/** Authoritative totals from the P&L calculation engine */
export interface ScorecardSummary {
    portfolioValue: number;
    costBasis: number;
    unrealizedPnl: number;
    realizedPnl: number;
    taxableRealizedPnl: number;
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
    unrealizedPnl: number;
    realizedPnl: number;
    taxableRealizedPnl: number;
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
}

interface PerformerItem {
    id: number;
    name: string;
    totalReturn: number;
    roiPct: number;
    unrealizedPnl: number;
    marketValue: number;
    costBasis: number;
    totalFees: number;
    efficiency: number;
}

/** Map backend performer to local display shape */
function toLocalPerformer(p: BackendPerformerItem): PerformerItem {
    return {
        id: p.id,
        name: p.label || p.name,
        totalReturn: p.total_return,
        roiPct: p.roi_pct,
        unrealizedPnl: p.unrealized_pnl ?? 0,
        marketValue: p.market_value ?? 0,
        costBasis: p.cost_basis ?? 0,
        totalFees: p.total_fees ?? 0,
        efficiency: p.efficiency ?? 0,
    };
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
}) => {
    const [performerCount, setPerformerCount] = useState(7);
    const [displayFormat, setDisplayFormat] = useState<PerformerDisplay>('$');
    const [sortMetric, setSortMetric] = useState<PerformerMetric>('TR');

    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const handleInfoClick = groupBy === 'asset' && assetPanelCtx
        ? (assetId: number) => assetPanelCtx.openAssetPanel(assetId, { pnlVersionId: versionId ?? undefined })
        : undefined;

    // Map sortMetric to PerformerSort for internal helpers
    const performerSort: PerformerSort = sortMetric === 'U' ? 'unrealized' : sortMetric === 'MV' ? 'market_value' : sortMetric === 'Eff' ? 'efficiency' : 'return';

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
                unrealizedPnl: live?.unrealized_pnl ?? 0,
                realizedPnl: book.realized_pnl,
                taxableRealizedPnl: book.taxable_realized_pnl ?? 0,
                realizedInPeriod: book.realized_in_period,
                taxableRealizedInPeriod: (book as any).taxable_realized_in_period ?? 0,
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
                taxableRealizedInPeriod: (backendRange as any).taxable_realized_in_period ?? 0,
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

    const color = (val: number) => (val >= 0 ? 'green.600' : 'red.600');

    // Build performer lists: prefer standalone performers endpoint, fallback to periodSummaryData
    const { topItems, flopItems, maxPerformerCount } = useMemo(() => {
        if (performersData) {
            const topRaw = (performersData.top_performers ?? []).map(toLocalPerformer);
            const flopRaw = (performersData.flop_performers ?? []).map(toLocalPerformer);
            const maxCount = performersData.total_count ?? Math.max(topRaw.length, flopRaw.length, 3);
            return { topItems: topRaw, flopItems: flopRaw, maxPerformerCount: maxCount };
        }
        const rangeData = periodSummaryData?.ranges?.[range as RangeKey];
        const topRaw = (rangeData?.top_performers ?? []).map(toLocalPerformer);
        const flopRaw = (rangeData?.flop_performers ?? []).map(toLocalPerformer);
        const maxCount = Math.max(topRaw.length, flopRaw.length, 3);
        return { topItems: topRaw, flopItems: flopRaw, maxPerformerCount: maxCount };
    }, [performersData, periodSummaryData, range]);

    // Sort performers based on selected sort metric
    const sortFn = (a: PerformerItem, b: PerformerItem) => {
        switch (performerSort) {
            case 'unrealized': return Math.abs(b.unrealizedPnl) - Math.abs(a.unrealizedPnl);
            case 'market_value': return Math.abs(b.marketValue) - Math.abs(a.marketValue);
            case 'efficiency': return Math.abs(b.efficiency) - Math.abs(a.efficiency);
            default: return Math.abs(b.totalReturn) - Math.abs(a.totalReturn);
        }
    };

    const visibleTop = [...topItems].sort(sortFn).slice(0, performerCount);
    const visibleFlop = [...flopItems].sort(sortFn).slice(0, performerCount);
    const maxAbsReturn = Math.max(
        ...visibleTop.map(p => performerBarValue(p, performerSort)),
        ...visibleFlop.map(p => performerBarValue(p, performerSort)),
        1,
    );

    // Unified performer click: prefer onPerformerClick, fallback to type-specific handlers
    const handlePerformerClick = (p: PerformerItem) => {
        if (onPerformerClick) {
            onPerformerClick(p.id, groupBy, p.name);
        } else if (groupBy === 'asset' && onAssetClick) {
            onAssetClick(p.id);
        } else if (groupBy === 'category' && onCategoryClick) {
            onCategoryClick(p.id, p.name);
        } else if (groupBy === 'account' && onAccountClick) {
            onAccountClick(p.id, p.name);
        }
    };

    return (
        <div className="border border-gray-200 bg-white p-3">
            {/* Timeframe selector cards (hidden when rendered externally) */}
            {!hidePeriodCards && (
                <div className="mb-2 flex gap-1.5 overflow-x-auto">
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
                <div className="text-xs text-gray-400">Loading...</div>
            ) : metrics ? (
                <>
                    {/* Hero + Metrics + PnL bar */}
                    <div className="mb-2">
                        <HeroMetricsBar
                            totalReturn={metrics.totalReturn}
                            roi={metrics.roi}
                            baseCurrency={baseCurrency}
                            costBasisInPeriod={metrics.costBasisInPeriod}
                            unrealizedInPeriod={metrics.unrealizedInPeriod}
                            realizedInPeriod={metrics.realizedInPeriod}
                            feesInPeriod={metrics.feesInPeriod}
                            fmtCurrencySigned={fmtCurrencySigned}
                            color={color}
                        >
                            {range !== 'all' ? (
                                <>
                                    <MetricItem
                                        label="Value Δ"
                                        value={isLiveLoading ? '...' : fmtCurrencySigned(metrics.unrealizedInPeriod + metrics.costBasisInPeriod, baseCurrency)}
                                        color={isLiveLoading ? 'gray.400' : color(metrics.unrealizedInPeriod + metrics.costBasisInPeriod)}
                                        icon={<FiDollarSign size={14} />}
                                        bg="blue.50"
                                        onClick={onMetricClick ? () => onMetricClick('total_return') : undefined}
                                    />
                                    <MetricItem
                                        label="Cost Δ"
                                        value={fmtCurrencySigned(metrics.costBasisInPeriod, baseCurrency)}
                                        color="gray.700"
                                        icon={<LuReceipt size={14} />}
                                        bg="gray.100"
                                        onClick={onMetricClick ? () => onMetricClick('cost_basis') : undefined}
                                        subValue={Math.abs(metrics.totalInvested - metrics.costBasisInPeriod) > 0.01 ? `invested ${fmtCurrencySigned(metrics.totalInvested, baseCurrency)}` : undefined}
                                    />
                                    <MetricItem
                                        label="Unrealized Δ"
                                        value={isLiveLoading ? '...' : fmtCurrencySigned(metrics.unrealizedInPeriod, baseCurrency)}
                                        color={isLiveLoading ? 'gray.400' : color(metrics.unrealizedInPeriod)}
                                        icon={metrics.unrealizedInPeriod >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />}
                                        bg={metrics.unrealizedInPeriod >= 0 ? 'green.50' : 'red.50'}
                                        onClick={onMetricClick ? () => onMetricClick('unrealized') : undefined}
                                    />
                                    <MetricItem
                                        label="Realized Δ"
                                        value={fmtCurrencySigned(metrics.realizedInPeriod, baseCurrency)}
                                        color={color(metrics.realizedInPeriod)}
                                        icon={metrics.realizedInPeriod >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />}
                                        bg={metrics.realizedInPeriod >= 0 ? 'green.50' : 'red.50'}
                                        subValue={`Taxable: ${fmtCurrencySigned(metrics.taxableRealizedInPeriod, baseCurrency)}`}
                                        onClick={onMetricClick ? () => onMetricClick('realized') : undefined}
                                    />
                                    <MetricItem
                                        label="Fees Δ"
                                        value={fmtCurrencySigned(metrics.feesInPeriod, baseCurrency)}
                                        color={metrics.feesInPeriod !== 0 ? 'orange.700' : 'gray.600'}
                                        icon={<LuReceipt size={14} />}
                                        bg="orange.50"
                                        onClick={onFeesClick}
                                    />
                                </>
                            ) : (
                                <>
                                    <MetricItem
                                        label="Value"
                                        value={isLiveLoading ? '...' : fmtCurrency(metrics.currentValue, baseCurrency)}
                                        color={isLiveLoading ? 'gray.400' : 'gray.800'}
                                        icon={<FiDollarSign size={14} />}
                                        bg="blue.50"
                                        onClick={onMetricClick ? () => onMetricClick('total_return') : undefined}
                                    />
                                    <MetricItem label="Cost" value={fmtCurrency(metrics.costBasis, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" onClick={onMetricClick ? () => onMetricClick('cost_basis') : undefined} subValue={Math.abs(metrics.totalInvested - metrics.costBasis) > 0.01 ? `invested ${fmtCurrency(metrics.totalInvested, baseCurrency)}` : undefined} />
                                    <MetricItem
                                        label="Unrealized"
                                        value={isLiveLoading ? '...' : fmtCurrencySigned(metrics.unrealizedPnl, baseCurrency)}
                                        color={isLiveLoading ? 'gray.400' : color(metrics.unrealizedPnl)}
                                        icon={metrics.unrealizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />}
                                        bg={metrics.unrealizedPnl >= 0 ? 'green.50' : 'red.50'}
                                        onClick={onMetricClick ? () => onMetricClick('unrealized') : undefined}
                                    />
                                    <MetricItem label="Realized" value={fmtCurrencySigned(metrics.realizedPnl, baseCurrency)} color={color(metrics.realizedPnl)} icon={metrics.realizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={metrics.realizedPnl >= 0 ? 'green.50' : 'red.50'} subValue={`Taxable: ${fmtCurrencySigned(metrics.taxableRealizedPnl, baseCurrency)}`} onClick={onMetricClick ? () => onMetricClick('realized') : undefined} />
                                    <MetricItem label="Fees" value={fmtCurrency(metrics.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" subValue={`${metrics.feeEntryCount} events`} onClick={onFeesClick} />
                                    {metrics.incomeEventCount > 0 && (
                                        <MetricItem label="Income" value={fmtCurrencySigned(metrics.totalIncome - metrics.totalWithholding, baseCurrency)} color="teal.600" icon={<LuBanknote size={14} />} bg="teal.50" subValue={`${metrics.incomeEventCount} events`} onClick={onIncomeClick} />
                                    )}
                                </>
                            )}
                        </HeroMetricsBar>
                    </div>

                    {/* Performers / custom slot — full width below */}
                    {hidePerformers ? (
                        <div>
                            {/* Custom slot + Period Chart — side by side */}
                            <div className={`grid items-start gap-3 ${performerSlot ? 'grid-cols-2' : 'grid-cols-1'}`}>
                                {performerSlot && <div>{performerSlot}</div>}
                                {/* Period chart */}
                                <div className="border border-blue-200 bg-white p-2">
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
                                    />
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div>
                            {/* Best/Worst + Period Chart — side by side */}
                            <div className="grid grid-cols-2 items-start gap-3">
                                {/* Left half: Best & Worst */}
                                {isPerformersLoading ? (
                                    <div className="border border-purple-200 bg-white p-2">
                                        <div className="text-xs text-gray-400">Loading performers...</div>
                                    </div>
                                ) : (
                                    <div className="border border-purple-200 bg-white p-2">
                                        {/* Controls row: badges left, $/%+slider right */}
                                        <div className="mb-1.5 flex items-center justify-between gap-2">
                                            {/* Left: Asset/Account/Category + sort metric badges */}
                                            <div className="flex flex-wrap items-center gap-0.5">
                                                <Badge
                                                    colorScheme={groupBy === 'asset' ? 'blue' : 'gray'}
                                                    className={`cursor-pointer px-1.5 ${groupBy === 'asset' ? 'ring-2 ring-blue-400' : ''}`}
                                                    onClick={() => onGroupByChange?.('asset')}
                                                >
                                                    Asset
                                                </Badge>
                                                <Badge
                                                    colorScheme={groupBy === 'account' ? 'blue' : 'gray'}
                                                    className={`cursor-pointer px-1.5 ${groupBy === 'account' ? 'ring-2 ring-blue-400' : ''}`}
                                                    onClick={() => onGroupByChange?.('account')}
                                                >
                                                    Account
                                                </Badge>
                                                {dimensions.map(dim => (
                                                    <Badge
                                                        key={dim.id}
                                                        colorScheme={groupBy === 'category' && selectedDimensionId === dim.id ? 'green' : 'gray'}
                                                        className={`cursor-pointer px-1.5 ${groupBy === 'category' && selectedDimensionId === dim.id ? 'ring-2 ring-green-400' : ''}`}
                                                        onClick={() => {
                                                            onGroupByChange?.('category');
                                                            onDimensionChange?.(dim.id);
                                                        }}
                                                    >
                                                        {dim.label}
                                                    </Badge>
                                                ))}
                                                <div className="mx-1 h-3.5 w-px shrink-0 bg-gray-300" />
                                                {([['TR', 'Total Return'], ['U', 'Unrealized P&L'], ['MV', 'Market Value'], ['Eff', 'Efficiency']] as [PerformerMetric, string][]).map(([key, tip]) => (
                                                    <Tooltip key={key} content={tip} openDelay={400}>
                                                        <Badge
                                                            colorScheme={sortMetric === key ? 'green' : 'gray'}
                                                            className={`cursor-pointer px-1 ${sortMetric === key ? 'ring-2 ring-green-400' : ''}`}
                                                            onClick={() => setSortMetric(key)}
                                                        >
                                                            {key}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </div>

                                            {/* Right: $/%  + count slider */}
                                            <div className="flex shrink-0 items-center gap-1.5">
                                                <div className="flex gap-0.5">
                                                    {([['$', 'Dollar values'], ['%', 'Percentages']] as [PerformerDisplay, string][]).map(([key, tip]) => (
                                                        <Tooltip key={key} content={tip} openDelay={400}>
                                                            <Badge
                                                                colorScheme={displayFormat === key ? 'purple' : 'gray'}
                                                                className={`cursor-pointer px-1 ${displayFormat === key ? 'ring-2 ring-purple-400' : ''}`}
                                                                onClick={() => setDisplayFormat(key)}
                                                            >
                                                                {key}
                                                            </Badge>
                                                        </Tooltip>
                                                    ))}
                                                </div>
                                                <div className="whitespace-nowrap text-[10px] text-gray-400">
                                                    {performerCount}
                                                </div>
                                                <input
                                                    type="range"
                                                    min={3}
                                                    max={Math.max(maxPerformerCount, 5)}
                                                    step={1}
                                                    value={performerCount}
                                                    onChange={(e) => setPerformerCount(Number(e.target.value))}
                                                    className="h-1 w-[60px] accent-blue-500"
                                                />
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-2">
                                            {/* Best */}
                                            <div>
                                                <div className="mb-1 flex items-center gap-1">
                                                    <FiTrendingUp size={11} color="#38A169" />
                                                    <span className="text-[10px] font-semibold text-green-600">Best</span>
                                                </div>
                                                {visibleTop.length === 0 ? (
                                                    <div className="text-[10px] text-gray-400">No positive returns</div>
                                                ) : (
                                                    <div className="max-h-[200px] overflow-y-auto">
                                                        <div className="flex flex-col gap-0.5">
                                                            {visibleTop.map((p, i) => (
                                                                <PerformerMiniRow
                                                                    key={p.id}
                                                                    rank={i + 1}
                                                                    item={p}
                                                                    maxAbs={maxAbsReturn}
                                                                    baseCurrency={baseCurrency}
                                                                    isPositive
                                                                    sortBy={performerSort}
                                                                    display={displayFormat}
                                                                    onClick={() => handlePerformerClick(p)}
                                                                    onInfoClick={handleInfoClick}
                                                                />
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            {/* Worst */}
                                            <div>
                                                <div className="mb-1 flex items-center gap-1">
                                                    <FiTrendingDown size={11} color="#E53E3E" />
                                                    <span className="text-[10px] font-semibold text-red-600">Worst</span>
                                                </div>
                                                {visibleFlop.length === 0 ? (
                                                    <div className="text-[10px] text-gray-400">No negative returns</div>
                                                ) : (
                                                    <div className="max-h-[200px] overflow-y-auto">
                                                        <div className="flex flex-col gap-0.5">
                                                            {visibleFlop.map((p, i) => (
                                                                <PerformerMiniRow
                                                                    key={p.id}
                                                                    rank={i + 1}
                                                                    item={p}
                                                                    maxAbs={maxAbsReturn}
                                                                    baseCurrency={baseCurrency}
                                                                    isPositive={false}
                                                                    sortBy={performerSort}
                                                                    display={displayFormat}
                                                                    onClick={() => handlePerformerClick(p)}
                                                                    onInfoClick={handleInfoClick}
                                                                />
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Right half: Period chart */}
                                <div className="border border-blue-200 bg-white p-2">
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
                                    />
                                </div>
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="text-xs text-gray-400">No data for this period</div>
            )}

        </div>
    );
};

/** Get the primary display value for a performer based on display format */
function performerPrimaryValue(item: PerformerItem, sortBy: PerformerSort, baseCurrency: string, display: PerformerDisplay = '$'): string {
    if (display === '%') {
        return `${item.roiPct >= 0 ? '+' : ''}${item.roiPct.toFixed(1)}%`;
    }
    // Dollar mode: show the value matching the sort metric
    switch (sortBy) {
        case 'unrealized': return fmtCurrencySigned(item.unrealizedPnl, baseCurrency);
        case 'market_value': return fmtCurrency(item.marketValue, baseCurrency);
        case 'efficiency': return item.efficiency.toFixed(2) + 'x';
        default: return fmtCurrencySigned(item.totalReturn, baseCurrency);
    }
}

/** Get the abs value used for bar sizing */
function performerBarValue(item: PerformerItem, sortBy: PerformerSort): number {
    switch (sortBy) {
        case 'unrealized': return Math.abs(item.unrealizedPnl);
        case 'market_value': return Math.abs(item.marketValue);
        case 'efficiency': return Math.abs(item.efficiency);
        default: return Math.abs(item.totalReturn);
    }
}

/** Inline mini performer row for best/worst inside TimeframeIndicators */
const PerformerMiniRow: React.FC<{
    rank: number;
    item: PerformerItem;
    maxAbs: number;
    baseCurrency: string;
    isPositive: boolean;
    sortBy?: PerformerSort;
    display?: PerformerDisplay;
    onClick?: () => void;
    onInfoClick?: (id: number) => void;
}> = ({ rank, item, maxAbs, baseCurrency, isPositive, sortBy = 'return', display = '$', onClick, onInfoClick }) => {
    const barVal = performerBarValue(item, sortBy);
    const barPct = maxAbs > 0 ? Math.max((barVal / maxAbs) * 100, 4) : 4;

    return (
        <div
            className={`flex items-center gap-1 px-1 py-0.5 transition-colors ${onClick ? 'cursor-pointer hover:bg-gray-50' : 'cursor-default'}`}
            onClick={onClick}
        >
            <div className="min-w-[12px] text-right text-[10px] font-bold text-gray-400">{rank}</div>
            <Tooltip content={item.name} openDelay={300}>
                <div className="w-[70px] shrink-0 truncate text-xs font-semibold text-gray-700">
                    {item.name}
                </div>
            </Tooltip>
            {onInfoClick && (
                <button
                    type="button"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); onInfoClick(item.id); }}
                    className="shrink-0 p-0.5 text-gray-400 hover:bg-blue-50 hover:text-blue-500"
                    title="Asset details"
                >
                    <LuInfo size={11} />
                </button>
            )}
            <div className={`relative h-3 flex-1 overflow-hidden ${isPositive ? 'bg-green-50' : 'bg-red-50'}`}>
                <div className={`h-full transition-all duration-300 ${isPositive ? 'bg-green-400' : 'bg-red-400'}`} style={{ width: `${barPct}%` }} />
                <div className={`absolute left-1 top-1/2 -translate-y-1/2 text-[10px] font-bold ${barPct > 30 ? 'text-white' : isPositive ? 'text-green-700' : 'text-red-700'}`}>
                    {performerPrimaryValue(item, sortBy, baseCurrency, display)}
                </div>
            </div>
            <div className={`min-w-[36px] text-right text-[10px] font-bold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                {display === '$'
                    ? `${item.roiPct >= 0 ? '+' : ''}${item.roiPct.toFixed(1)}%`
                    : fmtCurrencySigned(item.totalReturn, baseCurrency)
                }
            </div>
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
                        <MetricItem label="Realized P&L" value={fmtCurrency(metrics.realizedPnl, baseCurrency)} color={color(metrics.realizedPnl)} subValue={`Taxable: ${fmtCurrency(metrics.taxableRealizedPnl, baseCurrency)}`} />
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
    icon?: React.ReactNode;
    bg?: string;
    onClick?: () => void;
    compact?: boolean;
}> = ({ label, value, color, subValue, icon, bg, onClick, compact }) => (
    <div
        className={`flex min-w-0 flex-1 flex-col ${onClick ? 'cursor-pointer hover:opacity-85' : 'cursor-default'} ${compact ? 'px-1.5 py-0.5' : 'px-2 py-2'} ${tokenToClass(bg, 'bg', 'bg-transparent')}`}
        onClick={onClick}
    >
        <div className="flex items-center gap-1">
            {icon && <span className={`shrink-0 ${tokenToClass(color, 'text', 'text-gray-700')}`}>{icon}</span>}
            <span className={`whitespace-nowrap font-medium text-gray-500 ${compact ? 'text-[10px]' : 'text-xs'}`}>{label}</span>
            <span className={`whitespace-nowrap font-bold ${compact ? 'text-xs' : 'text-sm'} ${tokenToClass(color, 'text', 'text-gray-700')}`}>{value}</span>
        </div>
        {subValue && <span className="mt-0.5 whitespace-nowrap text-[10px] text-gray-400">{subValue}</span>}
    </div>
);
