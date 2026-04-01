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
import { Badge, Box, Card, Collapsible, Flex, SimpleGrid, Slider, Text } from '@chakra-ui/react';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { LuReceipt, LuInfo } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { Tooltip } from '../ui/tooltip';
import { HeroMetricsBar } from './HeroMetricsBar';
import { PeriodChartPanel } from './PeriodChartPanel';
import type { TimelinePoint, VersionMetricsResponse, SettledMetricsResponse, MarketMetricsResponse, PerformersResponse, RangeKey, PerformerItem as BackendPerformerItem, GroupBy } from '../../hooks/useChartData';
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
        };
    }

    if (!points.length) return null;

    let filteredPoints = points;
    const selectedRange = RANGES.find(r => r.key === rangeKey);
    if (selectedRange?.days) {
        const cutoff = new Date();
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
    /** Settled metrics (cost-lot-based, instant) */
    settledData?: SettledMetricsResponse;
    /** Market metrics (price-dependent, after prices) */
    marketData?: MarketMetricsResponse;
    /** Whether market metrics are still loading */
    isMarketLoading?: boolean;
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
    /** Unified performer click callback (replaces separate asset/category/account clicks) */
    onPerformerClick?: (id: number, groupType: string, name: string) => void;
    /** Version ID for fullscreen performance chart */
    versionId?: number | null;
    /** Assets for fullscreen performance chart */
    assets?: AssetPnLRow[];
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
    settledData,
    marketData,
    isMarketLoading,
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
    onPerformerClick,
    versionId,
    assets: assetsProp,
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

    // Pre-compute ROI% for all ranges: must use marketData (live-price-dependent)
    const allRangeRois = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        for (const r of RANGES) {
            const mkt = marketData?.ranges?.[r.key as RangeKey];
            if (mkt) {
                result[r.key] = mkt.roi_pct;
            }
            // Don't fall back to periodSummaryData — its ROI uses stale prices
        }
        return result;
    }, [marketData]);

    // Active range metrics: build from settledData + marketData (groupBy-independent)
    const metrics = useMemo(() => {
        const settled = settledData?.ranges?.[range as RangeKey];
        const market = marketData?.ranges?.[range as RangeKey];
        if (settled) {
            return {
                totalReturn: market?.total_return ?? settled.realized_pnl,
                roi: market?.roi_pct ?? 0,
                currentValue: market?.current_value ?? 0,
                costBasis: settled.cost_basis,
                unrealizedPnl: market?.unrealized_pnl ?? 0,
                realizedPnl: settled.realized_pnl,
                taxableRealizedPnl: settled.taxable_realized_pnl ?? 0,
                realizedInPeriod: settled.realized_in_period,
                taxableRealizedInPeriod: (settled as any).taxable_realized_in_period ?? 0,
                totalFees: settled.fees_in_period ?? summary?.totalFees ?? 0,
                feeEntryCount: summary?.feeEntryCount ?? 0,
                costBasisInPeriod: settled.cost_basis_in_period ?? 0,
                unrealizedInPeriod: market?.unrealized_in_period ?? 0,
                feesInPeriod: settled.fees_in_period ?? 0,
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
            } as RangeMetrics;
        }
        return computeMetricsForRange(range, points, summary);
    }, [points, range, summary, settledData, marketData, periodSummaryData]);

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
        <Box
            p={3}
            bg="white"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
        >
            {/* Timeframe selector cards */}
            <Flex gap={1.5} mb={2} overflowX="auto">
                {RANGES.map(r => {
                    const roi = allRangeRois[r.key];
                    const isActive = range === r.key;
                    return (
                        <Card.Root
                            key={r.key}
                            cursor="pointer"
                            onClick={() => onRangeChange(r.key)}
                            minW="70px"
                            flex="1"
                            variant={isActive ? 'elevated' : 'outline'}
                            borderWidth="2px"
                            borderColor={isActive ? 'blue.500' : 'gray.200'}
                            bg={isActive ? 'blue.50' : 'white'}
                            _hover={{ borderColor: isActive ? 'blue.500' : 'gray.300', shadow: 'sm' }}
                            transition="all 0.15s"
                        >
                            <Card.Body py={1.5} px={2} textAlign="center">
                                <Text fontSize="2xs" fontWeight="bold" color={isActive ? 'blue.700' : 'gray.500'}>
                                    {r.label}
                                </Text>
                                {roi !== null ? (
                                    <Text fontSize="xs" fontWeight="bold" color={roi >= 0 ? 'green.600' : 'red.600'}>
                                        {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
                                    </Text>
                                ) : (
                                    <Text fontSize="xs" color="gray.300">—</Text>
                                )}
                            </Card.Body>
                        </Card.Root>
                    );
                })}
            </Flex>

            {isLoading ? (
                <Text fontSize="xs" color="gray.400">Loading...</Text>
            ) : metrics ? (
                <>
                    {/* Hero + Metrics + PnL bar */}
                    <Box mb={2}>
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
                                        value={isMarketLoading ? '...' : fmtCurrencySigned(metrics.unrealizedInPeriod + metrics.costBasisInPeriod, baseCurrency)}
                                        color={isMarketLoading ? 'gray.400' : color(metrics.unrealizedInPeriod + metrics.costBasisInPeriod)}
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
                                    />
                                    <MetricItem
                                        label="Unrealized Δ"
                                        value={isMarketLoading ? '...' : fmtCurrencySigned(metrics.unrealizedInPeriod, baseCurrency)}
                                        color={isMarketLoading ? 'gray.400' : color(metrics.unrealizedInPeriod)}
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
                                        value={isMarketLoading ? '...' : fmtCurrency(metrics.currentValue, baseCurrency)}
                                        color={isMarketLoading ? 'gray.400' : 'gray.800'}
                                        icon={<FiDollarSign size={14} />}
                                        bg="blue.50"
                                        onClick={onMetricClick ? () => onMetricClick('total_return') : undefined}
                                    />
                                    <MetricItem label="Cost" value={fmtCurrency(metrics.costBasis, baseCurrency)} color="gray.700" icon={<LuReceipt size={14} />} bg="gray.100" onClick={onMetricClick ? () => onMetricClick('cost_basis') : undefined} />
                                    <MetricItem
                                        label="Unrealized"
                                        value={isMarketLoading ? '...' : fmtCurrencySigned(metrics.unrealizedPnl, baseCurrency)}
                                        color={isMarketLoading ? 'gray.400' : color(metrics.unrealizedPnl)}
                                        icon={metrics.unrealizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />}
                                        bg={metrics.unrealizedPnl >= 0 ? 'green.50' : 'red.50'}
                                        onClick={onMetricClick ? () => onMetricClick('unrealized') : undefined}
                                    />
                                    <MetricItem label="Realized" value={fmtCurrencySigned(metrics.realizedPnl, baseCurrency)} color={color(metrics.realizedPnl)} icon={metrics.realizedPnl >= 0 ? <FiTrendingUp size={14} /> : <FiTrendingDown size={14} />} bg={metrics.realizedPnl >= 0 ? 'green.50' : 'red.50'} subValue={`Taxable: ${fmtCurrencySigned(metrics.taxableRealizedPnl, baseCurrency)}`} onClick={onMetricClick ? () => onMetricClick('realized') : undefined} />
                                    <MetricItem label="Fees" value={fmtCurrency(metrics.totalFees, baseCurrency)} color="orange.700" icon={<LuReceipt size={14} />} bg="orange.50" subValue={`${metrics.feeEntryCount} events`} onClick={onFeesClick} />
                                </>
                            )}
                        </HeroMetricsBar>
                    </Box>

                    {/* Performers — full width below */}
                    <Box>
                        {/* Best/Worst + Period Chart — side by side */}
                        <Box display="grid" gridTemplateColumns="1fr 1fr" gap={3} alignItems="start">
                            {/* Left half: Best & Worst */}
                            {isPerformersLoading ? (
                                <Box p={2} borderRadius="md" border="1px solid" borderColor="purple.200" bg="white">
                                    <Text fontSize="xs" color="gray.400">Loading performers...</Text>
                                </Box>
                            ) : (
                                <Box p={2} borderRadius="md" border="1px solid" borderColor="purple.200" bg="white">
                                    {/* Controls row: badges left, $/%+slider right */}
                                    <Flex justify="space-between" align="center" mb={1.5} gap={2}>
                                        {/* Left: Asset/Account/Category + sort metric badges */}
                                        <Flex gap={0.5} flexWrap="wrap" align="center">
                                            <Badge
                                                cursor="pointer"
                                                variant={groupBy === 'asset' ? 'solid' : 'outline'}
                                                colorPalette={groupBy === 'asset' ? 'blue' : 'gray'}
                                                size="xs"
                                                px={1.5}
                                                onClick={() => onGroupByChange?.('asset')}
                                            >
                                                Asset
                                            </Badge>
                                            <Badge
                                                cursor="pointer"
                                                variant={groupBy === 'account' ? 'solid' : 'outline'}
                                                colorPalette={groupBy === 'account' ? 'blue' : 'gray'}
                                                size="xs"
                                                px={1.5}
                                                onClick={() => onGroupByChange?.('account')}
                                            >
                                                Account
                                            </Badge>
                                            {dimensions.map(dim => (
                                                <Badge
                                                    key={dim.id}
                                                    cursor="pointer"
                                                    variant={groupBy === 'category' && selectedDimensionId === dim.id ? 'solid' : 'outline'}
                                                    colorPalette={groupBy === 'category' && selectedDimensionId === dim.id ? 'teal' : 'gray'}
                                                    size="xs"
                                                    px={1.5}
                                                    onClick={() => {
                                                        onGroupByChange?.('category');
                                                        onDimensionChange?.(dim.id);
                                                    }}
                                                >
                                                    {dim.label}
                                                </Badge>
                                            ))}
                                            <Box w="1px" h="14px" bg="gray.300" mx={1} flexShrink={0} />
                                            {([['TR', 'Total Return'], ['U', 'Unrealized P&L'], ['MV', 'Market Value'], ['Eff', 'Efficiency']] as [PerformerMetric, string][]).map(([key, tip]) => (
                                                <Tooltip key={key} content={tip} openDelay={400}>
                                                    <Badge
                                                        cursor="pointer"
                                                        variant={sortMetric === key ? 'solid' : 'outline'}
                                                        colorPalette={sortMetric === key ? 'teal' : 'gray'}
                                                        size="xs"
                                                        px={1}
                                                        onClick={() => setSortMetric(key)}
                                                    >
                                                        {key}
                                                    </Badge>
                                                </Tooltip>
                                            ))}
                                        </Flex>

                                        {/* Right: $/%  + count slider */}
                                        <Flex align="center" gap={1.5} flexShrink={0}>
                                            <Flex gap={0.5}>
                                                {([['$', 'Dollar values'], ['%', 'Percentages']] as [PerformerDisplay, string][]).map(([key, tip]) => (
                                                    <Tooltip key={key} content={tip} openDelay={400}>
                                                        <Badge
                                                            cursor="pointer"
                                                            variant={displayFormat === key ? 'solid' : 'outline'}
                                                            colorPalette={displayFormat === key ? 'purple' : 'gray'}
                                                            size="xs"
                                                            px={1}
                                                            onClick={() => setDisplayFormat(key)}
                                                        >
                                                            {key}
                                                        </Badge>
                                                    </Tooltip>
                                                ))}
                                            </Flex>
                                            <Text fontSize="2xs" color="gray.400" whiteSpace="nowrap">
                                                {performerCount}
                                            </Text>
                                            <Slider.Root
                                                size="sm"
                                                min={3}
                                                max={Math.max(maxPerformerCount, 5)}
                                                step={1}
                                                value={[performerCount]}
                                                onValueChange={(d) => setPerformerCount(d.value[0])}
                                                width="60px"
                                            >
                                                <Slider.Control>
                                                    <Slider.Track><Slider.Range /></Slider.Track>
                                                    <Slider.Thumb index={0} />
                                                </Slider.Control>
                                            </Slider.Root>
                                        </Flex>
                                    </Flex>

                                    <Box display="grid" gridTemplateColumns="1fr 1fr" gap={2}>
                                        {/* Best */}
                                        <Box>
                                            <Flex align="center" gap={1} mb={1}>
                                                <FiTrendingUp size={11} color="var(--chakra-colors-green-500)" />
                                                <Text fontSize="2xs" fontWeight="semibold" color="green.600">Best</Text>
                                            </Flex>
                                            {visibleTop.length === 0 ? (
                                                <Text fontSize="2xs" color="gray.400">No positive returns</Text>
                                            ) : (
                                                <Box maxH="200px" overflowY="auto">
                                                    <Flex direction="column" gap={0.5}>
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
                                                    </Flex>
                                                </Box>
                                            )}
                                        </Box>

                                        {/* Worst */}
                                        <Box>
                                            <Flex align="center" gap={1} mb={1}>
                                                <FiTrendingDown size={11} color="var(--chakra-colors-red-500)" />
                                                <Text fontSize="2xs" fontWeight="semibold" color="red.600">Worst</Text>
                                            </Flex>
                                            {visibleFlop.length === 0 ? (
                                                <Text fontSize="2xs" color="gray.400">No negative returns</Text>
                                            ) : (
                                                <Box maxH="200px" overflowY="auto">
                                                    <Flex direction="column" gap={0.5}>
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
                                                    </Flex>
                                                </Box>
                                            )}
                                        </Box>
                                    </Box>
                                </Box>
                            )}

                            {/* Right half: Period chart */}
                            <Box p={2} borderRadius="md" border="1px solid" borderColor="blue.200" bg="white">
                                <PeriodChartPanel
                                    points={points}
                                    baseCurrency={baseCurrency}
                                    range={range}
                                    isLoading={isLoading}
                                    versionId={versionId}
                                    assets={assetsProp}
                                />
                            </Box>
                        </Box>
                    </Box>
                </>
            ) : (
                <Text fontSize="xs" color="gray.400">No data for this period</Text>
            )}

        </Box>
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
        <Flex
            align="center"
            gap={1}
            py={0.5}
            px={1}
            borderRadius="sm"
            cursor={onClick ? 'pointer' : 'default'}
            _hover={onClick ? { bg: 'gray.50' } : undefined}
            onClick={onClick}
            transition="background 0.15s"
        >
            <Text fontSize="2xs" color="gray.400" fontWeight="bold" minW="12px" textAlign="right">{rank}</Text>
            <Tooltip content={item.name} openDelay={300}>
                <Text fontSize="xs" fontWeight="semibold" color="gray.700" w="70px" flexShrink={0} truncate>
                    {item.name}
                </Text>
            </Tooltip>
            {onInfoClick && (
                <Box
                    as="button"
                    onClick={(e: React.MouseEvent) => { e.stopPropagation(); onInfoClick(item.id); }}
                    p={0.5}
                    borderRadius="sm"
                    color="gray.400"
                    _hover={{ color: 'blue.500', bg: 'blue.50' }}
                    title="Asset details"
                    flexShrink={0}
                >
                    <LuInfo size={11} />
                </Box>
            )}
            <Box flex="1" bg={isPositive ? 'green.50' : 'red.50'} borderRadius="sm" h="12px" overflow="hidden" position="relative">
                <Box bg={isPositive ? 'green.400' : 'red.400'} h="100%" w={`${barPct}%`} borderRadius="sm" transition="width 0.3s ease" />
                <Text position="absolute" top="50%" left="4px" transform="translateY(-50%)" fontSize="2xs" fontWeight="bold" color={barPct > 30 ? 'white' : isPositive ? 'green.700' : 'red.700'}>
                    {performerPrimaryValue(item, sortBy, baseCurrency, display)}
                </Text>
            </Box>
            <Text fontSize="2xs" fontWeight="bold" color={isPositive ? 'green.600' : 'red.600'} minW="36px" textAlign="right">
                {display === '$'
                    ? `${item.roiPct >= 0 ? '+' : ''}${item.roiPct.toFixed(1)}%`
                    : fmtCurrencySigned(item.totalReturn, baseCurrency)
                }
            </Text>
        </Flex>
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
}

export const TotalReturnScorecard: React.FC<TotalReturnScorecardProps> = ({
    points,
    baseCurrency,
    isLoading,
    summary,
    onFeesClick,
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
        <Box p={5} bg="white" borderRadius="lg" border="1px solid" borderColor="gray.200" mb={4}>
            <Flex align="center" gap={2} mb={4}>
                <Box color={metrics ? (metrics.totalReturn >= 0 ? 'green.500' : 'red.500') : 'gray.400'}><Icon size={20} /></Box>
                <Text fontSize="md" fontWeight="semibold" color="gray.700">Total Return</Text>
            </Flex>
            <Flex gap={2} mb={4} overflowX="auto">
                {RANGES.map(r => {
                    const roi = allRangeRois[r.key];
                    const isActive = range === r.key;
                    return (
                        <Card.Root key={r.key} cursor="pointer" onClick={() => setRange(r.key)} minW="90px" flex="1"
                            variant={isActive ? 'elevated' : 'outline'} borderWidth="2px"
                            borderColor={isActive ? 'blue.500' : 'gray.200'} bg={isActive ? 'blue.50' : 'white'}
                            _hover={{ borderColor: isActive ? 'blue.500' : 'gray.300', shadow: 'sm' }} transition="all 0.15s">
                            <Card.Body py={2} px={3} textAlign="center">
                                <Text fontSize="xs" fontWeight="bold" color={isActive ? 'blue.700' : 'gray.500'}>{r.label}</Text>
                                {roi !== null ? (
                                    <Text fontSize="sm" fontWeight="bold" color={roi >= 0 ? 'green.600' : 'red.600'}>{roi >= 0 ? '+' : ''}{roi.toFixed(2)}%</Text>
                                ) : (<Text fontSize="sm" color="gray.300">—</Text>)}
                            </Card.Body>
                        </Card.Root>
                    );
                })}
            </Flex>
            {isLoading ? <Text fontSize="sm" color="gray.400">Loading...</Text> : metrics ? (
                <>
                    <Flex align="baseline" gap={3} mb={4}>
                        <Text fontSize="3xl" fontWeight="bold" color={color(metrics.totalReturn)}>{fmtCurrency(metrics.totalReturn, baseCurrency)}</Text>
                        <Badge colorPalette={metrics.roi >= 0 ? 'green' : 'red'} variant="subtle" size="lg">{metrics.roi >= 0 ? '+' : ''}{metrics.roi.toFixed(2)}%</Badge>
                    </Flex>
                    <SimpleGrid columns={{ base: 2, md: 5 }} gap={4}>
                        <MetricItem label="Portfolio Value" value={fmtCurrency(metrics.currentValue, baseCurrency)} color="gray.800" icon={<FiDollarSign size={14} />} />
                        <MetricItem label="Cost Basis" value={fmtCurrency(metrics.costBasis, baseCurrency)} color="gray.600" />
                        <MetricItem label="Unrealized P&L" value={fmtCurrency(metrics.unrealizedPnl, baseCurrency)} color={color(metrics.unrealizedPnl)} />
                        <MetricItem label="Realized P&L" value={fmtCurrency(metrics.realizedPnl, baseCurrency)} color={color(metrics.realizedPnl)} subValue={`Taxable: ${fmtCurrency(metrics.taxableRealizedPnl, baseCurrency)}`} />
                        <MetricItem label="Total Fees" value={fmtCurrency(metrics.totalFees, baseCurrency)} subValue={`${metrics.feeEntryCount} fee events`} color="gray.600" onClick={onFeesClick} />
                    </SimpleGrid>
                </>
            ) : null}
        </Box>
    );
};

/* Reusable metric display component — single-line: icon label value */
export const MetricItem: React.FC<{
    label: string;
    value: string;
    color: string;
    subValue?: string;
    icon?: React.ReactNode;
    bg?: string;
    onClick?: () => void;
}> = ({ label, value, color, subValue, icon, bg, onClick }) => (
    <Flex
        align="center"
        gap={1.5}
        cursor={onClick ? 'pointer' : 'default'}
        onClick={onClick}
        _hover={onClick ? { opacity: 0.85 } : undefined}
        borderRadius="md"
        px={2}
        py={2}
        bg={bg ?? 'transparent'}
        flexShrink={0}
    >
        {icon && <Box color={color} flexShrink={0}>{icon}</Box>}
        <Text fontSize="xs" color="gray.500" fontWeight="medium" whiteSpace="nowrap">{label}</Text>
        <Text fontSize="sm" fontWeight="bold" color={color} whiteSpace="nowrap">{value}</Text>
    </Flex>
);
