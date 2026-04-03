/**
 * ContextView — Unified scoped view for all drill levels.
 *
 * Layout (top to bottom):
 *   1. Breadcrumb row + period cards (scoped ROI%) — always visible
 *   2. Tree-style section toggles:
 *      ├── [±] Overview   — hero metrics, charts, best/worst (scoped)
 *      ├── [±] Assets     — asset list + treemap/pie (scoped, with local filters)
 *      └── [±] PnL Audit  — investigation view (scoped)
 *
 * The ContextScope (derived from navigation) drives ALL sections uniformly.
 * Period cards show ROI% scoped to the current breadcrumb context.
 * Clicking best/worst item or asset name updates scope for the whole view.
 */
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Box, Card, Flex, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight, FiTrendingUp, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import { LuInfo, LuReceipt } from 'react-icons/lu';
import { usePnL } from './PnLContext';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { SectionToggle } from './PnLDetailPanel';
import { TimeframeIndicators, RANGES, MetricItem, fmtCurrency, fmtCurrencySigned } from './TotalReturnScorecard';
import { AccountBadge } from '../AccountBadge';
import { PnLBreakdownBar } from './PnLBreakdownBar';
import { formatQuantity } from '../../utils/numberUtils';
import { AssetPnLTable, type PnlStatusFilter, type BalanceStatusFilter } from './AssetPnLTable';
import { AllocationTreemap } from './AllocationTreemap';
import { MarketValuePieChart } from './MarketValuePieChart';
import { InvestigationView } from './InvestigationView';
import { ViewModeToggle, type AssetsViewMode } from './ViewModeToggle';
import { useCategoryMaps } from '../../hooks/useCategoryMaps';
import {
    useVersionMetrics,
    useSettledMetrics,
    useMarketMetrics,
    useVersionPerformers,
    usePortfolioTimeline,
    useAssetPeriodDeltas,
} from '../../hooks/useChartData';
import type { ContextScope } from './pnlState';
import type { Range } from './TotalReturnScorecard';
import type { TransactionFilterState } from '../TransactionFilters';
import type { AssetPnLRow, AccountBalanceBreakdown } from './types';
import type { GroupBy, RangeKey, TimelinePoint } from '../../hooks/useChartData';

// ─── Tiny sparkline for collapsed overview ──────────────────────────────────

const MiniSparkline: React.FC<{ points: TimelinePoint[]; width?: number; height?: number }> = ({ points, width = 80, height = 20 }) => {
    if (points.length < 2) return null;
    const values = points.map(p => {
        const cb = p.cost_basis_in_base;
        if (cb <= 0) return 0;
        return ((p.unrealized_pnl + p.cumulative_realized_pnl) / cb) * 100;
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const coords = values.map((v, i) =>
        `${(i / (values.length - 1)) * width},${height - ((v - min) / range) * (height - 2) - 1}`
    ).join(' ');
    const isPositive = values[values.length - 1] >= values[0];
    return (
        <svg width={width} height={height} style={{ display: 'block', flexShrink: 0, border: '1px solid #E2E8F0', borderRadius: 3 }}>
            <polyline fill="none" stroke={isPositive ? '#38A169' : '#E53E3E'} strokeWidth={1.5} points={coords} />
        </svg>
    );
};

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ContextViewProps {
    scope: ContextScope;
    onAssetClick: (assetId: number) => void;
    onAccountClick?: (assetId: number, accountId: number) => void;
    onAssetNavigate: (assetId: number, assetSymbol: string) => void;
    onTransactionClick: (txId: number) => void;
    onUnitClick: (unitId: number) => void;
    onPerformerClick: (id: number, groupType: string, name: string) => void;
    onWarningsClick: () => void;
    onRefreshPrices: () => void;
    isRefreshingPrices: boolean;
    onLoadAccountBalances: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const ContextView: React.FC<ContextViewProps> = ({
    scope,
    onAssetClick,
    onAccountClick,
    onAssetNavigate,
    onTransactionClick,
    onUnitClick,
    onPerformerClick,
    onWarningsClick,
    onRefreshPrices,
    isRefreshingPrices,
    onLoadAccountBalances,
}) => {
    const {
        state,
        dispatch,
        assets,
        displayAssets,
        scorecardSummary,
        balanceHealth,
        heroTimeline,
        versionMetrics,
        settledMetrics,
        marketMetrics,
        performers,
        pricesReady,
        baseCurrency,
        liveBalanceMap,
        liveAccountBalanceMap,
        liveAccountErrors,
        liveFetchedAccountIds,
        liveBalanceLoading,
        unmappedLiveAssets,
        availableAccountIds,
        availableCategoryIds,
        versionsQuery,
    } = usePnL();

    const {
        dimensions, accounts, accountBalances, currentVersionId,
        prices, summary, pnlAssets, warningTypeCounts,
        performerGroupBy, performerDimensionId, deltaThreshold,
        showMismatchedOnly, timeframeRange, loadingPriceAssetIds,
    } = state;

    const assetPanelCtx = useContext(AssetDetailPanelContext);

    // ── Derived state ──
    const isPortfolio = scope.level === 'portfolio';
    const isAsset = scope.level === 'asset';
    const isMultiAsset = !isAsset;

    // ── Section open state ──
    const [overviewOpen, setOverviewOpen] = useState(true);
    const [assetsOpen, setAssetsOpen] = useState(true);
    const [auditOpen, setAuditOpen] = useState(false);

    // ── Section refs for scroll-to-section ──
    const overviewRef = useRef<HTMLDivElement>(null);
    const assetsRef = useRef<HTMLDivElement>(null);
    const auditRef = useRef<HTMLDivElement>(null);

    // Reset on scope change
    useEffect(() => {
        setOverviewOpen(true);
        setAssetsOpen(true);
        setAuditOpen(false);
    }, [scope.level, scope.entityId]);

    // Reset best/worst groupBy to 'asset' on scope change
    useEffect(() => {
        dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: 'asset' as GroupBy });
    }, [scope.level, scope.entityId, dispatch]);

    // When auditDefaultPanel is set, open audit section
    const auditDefaultPanel = state.auditDefaultPanel;
    useEffect(() => {
        if (auditDefaultPanel) setAuditOpen(true);
    }, [auditDefaultPanel]);

    // ── Scope-based API filters ──
    const hasScope = !isPortfolio;
    const scopeApiFilters = useMemo(() => ({
        assetIds: scope.assetIds,
        accountIds: scope.accountIds,
        categoryIds: scope.categoryIds,
    }), [scope.assetIds, scope.accountIds, scope.categoryIds]);

    // ── Scoped metrics (backend-filtered) ──
    const scopedVersionMetrics = useVersionMetrics(
        currentVersionId,
        {
            ...scopeApiFilters,
            groupBy: performerGroupBy,
            topN: 25,
            dimensionId: performerGroupBy === 'category' ? performerDimensionId : undefined,
        },
        !!currentVersionId && hasScope,
    );

    const scopedSettled = useSettledMetrics(
        currentVersionId,
        scopeApiFilters,
        !!currentVersionId && hasScope,
    );

    const scopedMarket = useMarketMetrics(
        currentVersionId,
        { ...scopeApiFilters, pricesReady },
        !!currentVersionId && hasScope,
    );

    const scopedPerformers = useVersionPerformers(
        currentVersionId,
        {
            period: timeframeRange,
            groupBy: performerGroupBy,
            topN: 500,
            dimensionId: performerGroupBy === 'category' ? performerDimensionId : undefined,
            ...scopeApiFilters,
            pricesReady,
        },
        !!currentVersionId && hasScope,
    );

    // ── Scoped timeline ──
    const timelineFilters = useMemo(() => ({
        granularity: 'daily' as const,
        ...scopeApiFilters,
    }), [scopeApiFilters]);
    const scopedTimeline = usePortfolioTimeline(currentVersionId, timelineFilters, !!currentVersionId && hasScope);

    // ── Asset period deltas for period-aware cards ──
    const assetPeriodDeltas = useAssetPeriodDeltas(
        currentVersionId,
        timeframeRange,
        !!currentVersionId && timeframeRange !== 'all',
    );

    // ── Effective data: scoped when not at portfolio, global otherwise ──
    const effectiveMetrics = hasScope ? scopedVersionMetrics : versionMetrics;
    const effectiveSettled = hasScope ? scopedSettled : settledMetrics;
    const effectiveMarket = hasScope ? scopedMarket : marketMetrics;
    const effectivePerformers = hasScope ? scopedPerformers : performers;
    const effectiveTimeline = hasScope ? scopedTimeline : heroTimeline;

    const effectiveSummary = useMemo(() => {
        const s = effectiveSettled.data?.summary;
        const m = effectiveMarket.data?.summary;
        if (s) {
            return {
                costBasis: s.cost_basis,
                realizedPnl: s.realized_pnl,
                taxableRealizedPnl: s.taxable_realized_pnl ?? 0,
                totalFees: s.total_fees,
                feeEntryCount: s.fee_entry_count,
                portfolioValue: m?.current_value ?? 0,
                unrealizedPnl: m?.unrealized_pnl ?? 0,
            };
        }
        return scorecardSummary;
    }, [effectiveSettled.data, effectiveMarket.data, scorecardSummary]);

    // ── Filter assets by scope ──
    const scopedAssets: AssetPnLRow[] = useMemo(() => {
        let filtered = assets;
        if (scope.categoryIds?.length) {
            filtered = filtered.filter(a => a.category_ids.some(id => scope.categoryIds!.includes(id)));
        }
        if (scope.accountIds?.length) {
            filtered = filtered.filter(a => a.account_ids.some(id => scope.accountIds!.includes(id)));
        }
        if (scope.assetIds?.length) {
            filtered = filtered.filter(a => scope.assetIds!.includes(a.asset.id!));
        }
        return filtered;
    }, [assets, scope.categoryIds, scope.accountIds, scope.assetIds]);

    const scopedDisplayAssets: AssetPnLRow[] = useMemo(() => {
        let filtered = displayAssets;
        if (scope.categoryIds?.length) {
            filtered = filtered.filter(a => a.category_ids.some(id => scope.categoryIds!.includes(id)));
        }
        if (scope.accountIds?.length) {
            filtered = filtered.filter(a => a.account_ids.some(id => scope.accountIds!.includes(id)));
        }
        return filtered;
    }, [displayAssets, scope.categoryIds, scope.accountIds]);

    // ── Asset category maps for treemap ──
    const assetCategoryMaps = useCategoryMaps(dimensions, scopedAssets);

    // ── Local asset table filters (do NOT affect metrics) ──
    const [search, setSearch] = useState('');
    const [minMarketValue, setMinMarketValue] = useState(5);
    const [pnlStatus, setPnlStatus] = useState<PnlStatusFilter>('with_pnl');
    const [balanceStatus, setBalanceStatus] = useState<BalanceStatusFilter>('all');
    const [assetsView, setAssetsView] = useState<AssetsViewMode>('list');

    // Context-derived filter values for AssetPnLTable (scope shown as active filters)
    const [localAccountIds, setLocalAccountIds] = useState<number[]>([]);
    const [localCategoryIds, setLocalCategoryIds] = useState<number[]>([]);

    // Sync scope filters to local table filters on scope change
    useEffect(() => {
        setLocalAccountIds(scope.accountIds ?? []);
        setLocalCategoryIds(scope.categoryIds ?? []);
        setSearch('');
        setAssetsView('list');
    }, [scope.level, scope.entityId, scope.accountIds, scope.categoryIds]);

    // ── Treemap asset filtering (uses scope-filtered assets, not local table filters) ──
    const filteredTreemapAssets = useMemo(() => {
        return scopedDisplayAssets.filter(a => {
            if (pnlStatus === 'with_pnl' && !a.has_lots) return false;
            if (pnlStatus === 'no_pnl' && a.has_lots) return false;
            const sym = a.asset.symbol?.toUpperCase() ?? '';
            const liveQty = liveBalanceMap?.get(sym);
            if (balanceStatus === 'mapped' && (liveQty == null || liveQty === 0)) return false;
            if (balanceStatus === 'unmapped' && liveQty != null && liveQty > 0) return false;
            if (minMarketValue > 0 && a.has_lots && a.unit_value != null) {
                const pnlValue = Math.abs(a.market_value);
                const liveValue = liveQty != null && a.unit_value != null ? Math.abs(liveQty * a.unit_value) : pnlValue;
                if (pnlValue < minMarketValue && liveValue < minMarketValue) return false;
            }
            return true;
        });
    }, [scopedDisplayAssets, pnlStatus, balanceStatus, minMarketValue, liveBalanceMap]);

    // ── InvestigationView filters (scope + period) ──
    const auditFilters = useMemo(() => {
        const f: Partial<TransactionFilterState> = {};
        if (scope.dateFrom && scope.dateTo && scope.period !== 'all') {
            f.dateFrom = scope.dateFrom;
            f.dateTo = scope.dateTo;
        }
        if (scope.assetIds?.length) f.relatedAssetIds = scope.assetIds.map(String);
        if (scope.accountIds?.length) f.relatedAccountIds = scope.accountIds.map(String);
        if (scope.categoryIds?.length) f.categoryIds = scope.categoryIds.map(String);
        return Object.keys(f).length > 0 ? f : undefined;
    }, [scope]);

    // ── Period card ROI (scoped) ──
    const allRangeRois = useMemo(() => {
        const result: Record<Range, number | null> = { all: null, '3y': null, '1y': null, '6m': null, '3m': null, '1m': null, '1w': null };
        const mktData = effectiveMarket.data;
        for (const r of RANGES) {
            const mkt = mktData?.ranges?.[r.key as RangeKey];
            if (mkt) result[r.key] = mkt.roi_pct;
        }
        return result;
    }, [effectiveMarket.data]);

    // ── Tax status (on-demand) ──
    // Tax tab is always visible when a version exists — no longer gated by jurisdiction

    // ── Account balance breakdowns (for asset-level balance cards) ──
    const accountBreakdowns: AccountBalanceBreakdown[] = useMemo(() => {
        if (!isAsset || !scope.assetIds?.length) return [];
        const assetId = scope.assetIds[0];
        const raw = accountBalances.get(assetId) ?? [];
        const unitValue = scopedAssets[0]?.unit_value;
        return raw.map((b: AccountBalanceBreakdown) => {
            if (unitValue == null || unitValue <= 0) return b;
            const mv = b.qty * unitValue;
            const urPnl = mv - b.cost_basis_in_base;
            const urPct = b.cost_basis_in_base > 0 ? (urPnl / b.cost_basis_in_base) * 100 : 0;
            return { ...b, market_value: mv, unrealized_pnl: urPnl, unrealized_pnl_pct: urPct };
        });
    }, [isAsset, scope.assetIds, accountBalances, scopedAssets]);

    // ── Breadcrumb data ──
    const { breadcrumbs } = state.drill;

    const firstCrumbLabel = breadcrumbs.length > 0 ? breadcrumbs[0].label : 'Portfolio';

    // ═══════════════════════════════════════════════════════════════════
    // Render
    // ═══════════════════════════════════════════════════════════════════

    return (
        <Box>
            {/* ─── 1. Breadcrumb + Period Cards row ─── */}
            <Flex
                align="center"
                gap={2}
                px={3}
                py={2}
                bg="gray.50"
                borderRadius="lg"
                border="1px solid"
                borderColor="gray.200"
                mb={0}
            >
                {/* Breadcrumb trail */}
                <Flex align="center" gap={1.5} flexShrink={0} flexWrap="wrap">
                    {breadcrumbs.map((crumb, idx) => {
                        const isLast = idx === breadcrumbs.length - 1;
                        const label = idx === 0 ? firstCrumbLabel : crumb.label;
                        return (
                            <React.Fragment key={idx}>
                                {idx > 0 && (
                                    <FiChevronRight
                                        size={14}
                                        style={{ color: 'var(--chakra-colors-gray-400)', flexShrink: 0 }}
                                    />
                                )}
                                {isLast ? (
                                    <Flex align="center" gap={1}>
                                        <Badge colorPalette="blue" variant="subtle" size="sm" px={2} py={0.5} fontWeight="600">
                                            {label}
                                        </Badge>
                                        {isAsset && scope.assetIds?.[0] != null && assetPanelCtx && (
                                            <Box
                                                as="button"
                                                cursor="pointer"
                                                color="gray.400"
                                                _hover={{ color: 'blue.500' }}
                                                onClick={() => assetPanelCtx.openAssetPanel(scope.assetIds![0], { pnlVersionId: currentVersionId ?? undefined })}
                                                title="Asset details"
                                            >
                                                <LuInfo size={14} />
                                            </Box>
                                        )}
                                    </Flex>
                                ) : (
                                    <Text
                                        fontSize="sm"
                                        fontWeight="500"
                                        color="blue.600"
                                        cursor="pointer"
                                        _hover={{ textDecoration: 'underline' }}
                                        onClick={() => dispatch({ type: 'DRILL_TO_BREADCRUMB', index: idx })}
                                        whiteSpace="nowrap"
                                    >
                                        {label}
                                    </Text>
                                )}
                            </React.Fragment>
                        );
                    })}
                </Flex>

                {/* Period cards (scoped ROI%) — right-aligned */}
                <Flex gap={1} ml="auto" overflowX="auto" flexShrink={0}>
                    {RANGES.map(r => {
                        const roi = allRangeRois[r.key];
                        const isActive = timeframeRange === r.key;
                        return (
                            <Card.Root
                                key={r.key}
                                cursor="pointer"
                                onClick={() => dispatch({ type: 'SET_TIMEFRAME_RANGE', range: r.key })}
                                minW="52px"
                                variant={isActive ? 'elevated' : 'outline'}
                                borderWidth="2px"
                                borderColor={isActive ? 'blue.500' : 'gray.200'}
                                bg={isActive ? 'blue.50' : 'white'}
                                _hover={{ borderColor: isActive ? 'blue.500' : 'gray.300', shadow: 'sm' }}
                                transition="all 0.15s"
                            >
                                <Card.Body py={1} px={1.5} textAlign="center">
                                    <Text fontSize="2xs" fontWeight="bold" color={isActive ? 'blue.700' : 'gray.500'}>
                                        {r.label}
                                    </Text>
                                    {roi !== null ? (
                                        <Text fontSize="2xs" fontWeight="bold" color={roi >= 0 ? 'green.600' : 'red.600'}>
                                            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
                                        </Text>
                                    ) : (
                                        <Text fontSize="2xs" color="gray.300">—</Text>
                                    )}
                                </Card.Body>
                            </Card.Root>
                        );
                    })}
                </Flex>

                {/* Separator + section nav pills */}
                <Box w="1px" h={5} bg="gray.300" mx={2} flexShrink={0} />
                <Flex gap={1} flexShrink={0}>
                    {([
                        { key: 'overview', label: 'Overview', open: overviewOpen, ref: overviewRef },
                        ...(isMultiAsset || currentVersionId ? [{ key: 'assets', label: 'Assets', open: assetsOpen, ref: assetsRef }] : []),
                        ...(currentVersionId ? [{ key: 'audit', label: 'Audit', open: auditOpen, ref: auditRef }] : []),
                    ] as { key: string; label: string; open: boolean; ref: React.RefObject<HTMLDivElement | null> }[]).map(s => (
                        <Card.Root
                            key={s.key}
                            cursor="pointer"
                            minW="52px"
                            variant={s.open ? 'elevated' : 'outline'}
                            borderWidth="2px"
                            borderColor={s.open ? 'blue.500' : 'gray.200'}
                            bg={s.open ? 'blue.50' : 'white'}
                            _hover={{ borderColor: s.open ? 'blue.500' : 'gray.300', shadow: 'sm' }}
                            transition="all 0.15s"
                            onClick={() => {
                                setOverviewOpen(s.key === 'overview');
                                setAssetsOpen(s.key === 'assets');
                                setAuditOpen(s.key === 'audit');
                                setTimeout(() => s.ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
                            }}
                        >
                            <Card.Body py={1} px={1.5} textAlign="center">
                                <Text fontSize="2xs" fontWeight="bold" color={s.open ? 'blue.700' : 'gray.500'}>
                                    {s.label}
                                </Text>
                            </Card.Body>
                        </Card.Root>
                    ))}
                </Flex>
            </Flex>

            {/* ─── 2. Tree-style sections ─── */}
            <Box
                ml={4}
                pl={3}
                borderLeft="2px solid"
                borderLeftColor="gray.200"
                mt={0}
            >
                {/* ── Overview Section ── */}
                <Box ref={overviewRef}>
                    <TreeSection
                        label="Overview"
                        open={overviewOpen}
                        onToggle={() => setOverviewOpen(v => !v)}
                        isLast={!isMultiAsset && !currentVersionId}
                        sectionBg="blue.50"
                        headerRight={isAsset && scope.assetIds?.[0] != null && assetPanelCtx ? (
                            <Box
                                as="button"
                                onClick={() => assetPanelCtx.openAssetPanel(scope.assetIds![0], { pnlVersionId: currentVersionId ?? undefined })}
                                p={0.5}
                                borderRadius="sm"
                                color="gray.400"
                                _hover={{ color: 'blue.500', bg: 'blue.50' }}
                                title="Asset details"
                            >
                                <LuInfo size={12} />
                            </Box>
                        ) : undefined}
                        summary={!overviewOpen && effectiveSummary ? (() => {
                            // Use period-specific metrics when a period is selected
                            const settled = effectiveSettled.data?.ranges?.[timeframeRange as RangeKey];
                            const market = effectiveMarket.data?.ranges?.[timeframeRange as RangeKey];
                            const isPeriod = timeframeRange !== 'all' && (settled || market);

                            const costVal = isPeriod ? (settled?.cost_basis_in_period ?? 0) : effectiveSummary.costBasis;
                            const realizedVal = isPeriod ? (settled?.realized_in_period ?? 0) : effectiveSummary.realizedPnl;
                            const unrealizedVal = isPeriod ? (market?.unrealized_in_period ?? 0) : effectiveSummary.unrealizedPnl;
                            const feesVal = isPeriod ? (settled?.fees_in_period ?? 0) : effectiveSummary.totalFees;
                            const valueVal = isPeriod ? (market?.current_value ?? effectiveSummary.portfolioValue) : effectiveSummary.portfolioValue;
                            const totalReturn = unrealizedVal + realizedVal;
                            const costBase = isPeriod ? costVal : effectiveSummary.costBasis;
                            const roi = costBase > 0 ? (totalReturn / costBase) * 100 : 0;
                            const clr = totalReturn >= 0 ? 'green.600' : 'red.600';
                            const suffix = isPeriod ? ' Δ' : '';
                            return (
                                <Box flex="1" minW={0}>
                                    <Flex gap={1} align="center">
                                        <MetricItem label="ROI" value={`${fmtCurrencySigned(totalReturn, baseCurrency)} (${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%)`} color={clr} icon={totalReturn >= 0 ? <FiTrendingUp size={10} /> : <FiTrendingDown size={10} />} bg={totalReturn >= 0 ? 'green.50' : 'red.50'} compact />
                                        {!isPeriod && <MetricItem label="Value" value={fmtCurrency(valueVal, baseCurrency)} color="gray.800" icon={<FiDollarSign size={10} />} bg="blue.50" compact />}
                                        <MetricItem label={`Cost${suffix}`} value={isPeriod ? fmtCurrencySigned(costVal, baseCurrency) : fmtCurrency(costVal, baseCurrency)} color="gray.700" icon={<LuReceipt size={10} />} bg="gray.100" compact />
                                        <MetricItem label={`Unreal.${suffix}`} value={fmtCurrencySigned(unrealizedVal, baseCurrency)} color={unrealizedVal >= 0 ? 'green.600' : 'red.600'} icon={null} bg={unrealizedVal >= 0 ? 'green.50' : 'red.50'} compact />
                                        <MetricItem label={`Real.${suffix}`} value={fmtCurrencySigned(realizedVal, baseCurrency)} color={realizedVal >= 0 ? 'green.600' : 'red.600'} icon={null} bg={realizedVal >= 0 ? 'green.50' : 'red.50'} compact />
                                        <MetricItem label={`Fees${suffix}`} value={isPeriod ? fmtCurrencySigned(feesVal, baseCurrency) : fmtCurrency(feesVal, baseCurrency)} color="orange.700" icon={null} bg="orange.50" compact />
                                        <MiniSparkline points={effectiveTimeline.data?.points || []} />
                                    </Flex>
                                    <Box mt={0.5}>
                                        <PnLBreakdownBar costBasis={costBase} unrealizedPnl={unrealizedVal} realizedPnl={realizedVal} fees={feesVal} baseCurrency={baseCurrency} height={4} />
                                    </Box>
                                </Box>
                            );
                        })() : undefined}
                    >
                        {/* TimeframeIndicators provides hero metrics, chart, PnL bar, best/worst — all scoped */}
                        <TimeframeIndicators
                            points={effectiveTimeline.data?.points || []}
                            baseCurrency={baseCurrency}
                            isLoading={effectiveTimeline.isLoading || effectiveSettled.isLoading}
                            summary={effectiveSummary}
                            periodSummaryData={effectiveMetrics.data ?? undefined}
                            settledData={effectiveSettled.data ?? undefined}
                            marketData={effectiveMarket.data ?? undefined}
                            isMarketLoading={effectiveMarket.isLoading}
                            performersData={effectivePerformers.data ?? undefined}
                            isPerformersLoading={effectivePerformers.isLoading}
                            range={timeframeRange}
                            onRangeChange={(r: Range) => dispatch({ type: 'SET_TIMEFRAME_RANGE', range: r })}
                            contextLabel={scope.assetSymbol || scope.entityLabel || undefined}
                            assetId={isAsset && scope.assetIds?.[0] != null ? scope.assetIds[0] : undefined}
                            assetSymbol={isAsset ? scope.assetSymbol : undefined}
                            groupBy={performerGroupBy}
                            onGroupByChange={(g: GroupBy) => dispatch({ type: 'SET_PERFORMER_GROUP_BY', groupBy: g })}
                            onPerformerClick={onPerformerClick}
                            onFeesClick={() => { }}
                            dimensions={dimensions}
                            selectedDimensionId={performerDimensionId}
                            onDimensionChange={(id: number | null) => dispatch({ type: 'SET_PERFORMER_DIMENSION_ID', id })}
                            versionId={currentVersionId}
                            assets={scopedAssets}
                            hidePeriodCards
                            hidePerformers={isAsset}
                            performerSlot={isAsset && accountBreakdowns.length > 0 ? (
                                <Box>
                                    <Text fontSize="xs" fontWeight="semibold" color="gray.600" mb={1.5}>Balance by Account</Text>
                                    <Flex gap={2} flexWrap="wrap" align="stretch">
                                        {accountBreakdowns.map(b => {
                                            const urPnl = b.unrealized_pnl ?? 0;
                                            const assetSymbol = scopedAssets[0]?.asset?.symbol;
                                            const liveQty = assetSymbol ? liveAccountBalanceMap?.get(assetSymbol)?.get(b.account_id) : undefined;
                                            return (
                                                <Box key={b.account_id} bg="gray.50" borderLeft="3px solid" borderLeftColor="blue.300" borderRadius="sm" px={2.5} py={1.5} minW="140px" flex="1">
                                                    <AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" />
                                                    <Flex align="center" gap={1} mt={1.5}>
                                                        <Text fontSize="xs" fontWeight="semibold" color="gray.700">{formatQuantity(b.qty)}</Text>
                                                        {liveQty != null && (
                                                            <Badge size="xs" variant="subtle" colorPalette={Math.abs(b.qty - liveQty) < 0.001 ? 'green' : 'orange'}>
                                                                Live: {formatQuantity(liveQty)}
                                                            </Badge>
                                                        )}
                                                    </Flex>
                                                    {b.market_value != null && (
                                                        <Text fontSize="xs" color="gray.600" mt={0.5}>{fmtCurrency(b.market_value, baseCurrency)}</Text>
                                                    )}
                                                    <Text fontSize="xs" color={urPnl >= 0 ? 'green.600' : 'red.600'} mt={0.5}>
                                                        {fmtCurrencySigned(urPnl, baseCurrency)}
                                                        {b.unrealized_pnl_pct != null && (
                                                            <Text as="span" color="gray.500" ml={1}>({b.unrealized_pnl_pct >= 0 ? '+' : ''}{b.unrealized_pnl_pct.toFixed(1)}%)</Text>
                                                        )}
                                                    </Text>
                                                </Box>
                                            );
                                        })}
                                    </Flex>
                                </Box>
                            ) : undefined}
                        />
                    </TreeSection>
                </Box>

                {/* ── Assets Section (multi-asset only) ── */}
                {isMultiAsset && (
                    <Box ref={assetsRef}>
                        <TreeSection
                            label="Assets"
                            open={assetsOpen}
                            onToggle={() => setAssetsOpen(v => !v)}
                            isLast={!currentVersionId}
                            badge={`${scopedDisplayAssets.length}`}
                            sectionBg="green.50"
                        >
                            {/* View mode tabs inside section content */}
                            <Flex gap={0} px={3} pt={2} pb={0} borderBottom="1px solid" borderColor="gray.200">
                                {(['list', 'treemap', 'pie'] as AssetsViewMode[]).map(mode => {
                                    const active = assetsView === mode;
                                    const labels: Record<AssetsViewMode, string> = { list: '📋 List', treemap: '🗺️ Treemap', pie: '🥧 Pie' };
                                    return (
                                        <Box
                                            key={mode}
                                            px={3}
                                            py={1.5}
                                            cursor="pointer"
                                            fontWeight={active ? '600' : '400'}
                                            fontSize="xs"
                                            color={active ? 'blue.700' : 'gray.500'}
                                            borderBottom="2px solid"
                                            borderColor={active ? 'blue.500' : 'transparent'}
                                            bg={active ? 'white' : 'transparent'}
                                            borderTopRadius="md"
                                            border={active ? '1px solid' : '1px solid transparent'}
                                            borderBottomColor={active ? 'white' : 'transparent'}
                                            borderLeftColor={active ? 'blue.200' : 'transparent'}
                                            borderRightColor={active ? 'blue.200' : 'transparent'}
                                            borderTopColor={active ? 'blue.400' : 'transparent'}
                                            mb="-1px"
                                            _hover={{ color: active ? 'blue.700' : 'gray.700', bg: active ? 'white' : 'gray.100' }}
                                            transition="all 0.15s"
                                            onClick={() => setAssetsView(mode)}
                                        >
                                            {labels[mode]}
                                        </Box>
                                    );
                                })}
                            </Flex>

                            {/* List view */}
                            {assetsView === 'list' && (
                                <Box p={2}>
                                    <AssetPnLTable
                                        assets={scopedDisplayAssets}
                                        baseCurrency={baseCurrency}
                                        onAssetClick={(id) => id != null && onAssetClick(id)}
                                        onAccountClick={onAccountClick}
                                        accountBalances={accountBalances}
                                        accounts={accounts}
                                        dimensions={dimensions}
                                        availableAccountIds={availableAccountIds}
                                        availableCategoryIds={availableCategoryIds}
                                        onLoadAccountBalances={onLoadAccountBalances}
                                        liveBalances={liveBalanceMap}
                                        liveAccountBalances={liveAccountBalanceMap}
                                        liveBalanceLoading={liveBalanceLoading}
                                        unmappedLiveAssets={unmappedLiveAssets}
                                        liveAccountErrors={liveAccountErrors}
                                        liveFetchedAccountIds={liveFetchedAccountIds}
                                        search={search}
                                        onSearchChange={setSearch}
                                        minMarketValue={minMarketValue}
                                        onMinMarketValueChange={setMinMarketValue}
                                        pnlStatus={pnlStatus}
                                        onPnlStatusChange={setPnlStatus}
                                        balanceStatus={balanceStatus}
                                        onBalanceStatusChange={setBalanceStatus}
                                        selectedAccountIds={localAccountIds}
                                        onSelectedAccountIdsChange={setLocalAccountIds}
                                        selectedCategoryIds={localCategoryIds}
                                        onSelectedCategoryIdsChange={setLocalCategoryIds}
                                        backendSummary={effectiveSummary ? {
                                            totalCost: effectiveSummary.costBasis,
                                            totalUnrealized: effectiveSummary.unrealizedPnl,
                                            totalRealized: effectiveSummary.realizedPnl,
                                            totalFees: effectiveSummary.totalFees,
                                            totalValue: effectiveSummary.portfolioValue,
                                        } : undefined}
                                        periodDeltaMap={timeframeRange !== 'all' ? assetPeriodDeltas.deltaMap : undefined}
                                        periodLabel={timeframeRange !== 'all' ? timeframeRange.toUpperCase() : undefined}
                                        pnlVersionId={currentVersionId ?? undefined}
                                    />
                                </Box>
                            )}

                            {/* Treemap view */}
                            {assetsView === 'treemap' && (
                                <Box p={2}>
                                    <AllocationTreemap
                                        points={effectiveTimeline.data?.points || []}
                                        assetCategoryMaps={assetCategoryMaps}
                                        dimensions={dimensions}
                                        accounts={accounts}
                                        assets={filteredTreemapAssets}
                                        baseCurrency={baseCurrency}
                                        isLoading={effectiveTimeline.isLoading}
                                        accountBalances={accountBalances}
                                        onAssetNavigate={onAssetNavigate}
                                    />
                                </Box>
                            )}

                            {/* Pie view */}
                            {assetsView === 'pie' && (
                                <Box p={2}>
                                    <MarketValuePieChart
                                        assets={filteredTreemapAssets}
                                        dimensions={dimensions}
                                        baseCurrency={baseCurrency}
                                    />
                                </Box>
                            )}
                        </TreeSection>
                    </Box>
                )}

                {/* ── PnL Audit Section ── */}
                {currentVersionId && (
                    <Box ref={auditRef}>
                        <TreeSection
                            label="PnL Audit"
                            open={auditOpen}
                            onToggle={() => setAuditOpen(v => !v)}
                            isLast
                            sectionBg="orange.50"
                        >
                            <Box p={3}>
                                <InvestigationView
                                    versionId={currentVersionId}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    onAssetClick={(id) => onAssetClick(id)}
                                    onUnitClick={onUnitClick}
                                    initialFilters={auditFilters}
                                    defaultPanel={auditDefaultPanel}
                                    onPanelChange={() => {
                                        if (auditDefaultPanel) dispatch({ type: 'SET_AUDIT_DEFAULT_PANEL', panel: null });
                                    }}
                                    assets={scopedAssets.map(a => ({
                                        id: a.asset.id ?? 0,
                                        symbol: a.asset.symbol ?? '',
                                        label: a.asset.label ?? undefined,
                                    }))}
                                />
                            </Box>
                        </TreeSection>
                    </Box>
                )}
            </Box>
        </Box>
    );
};

// ─── TreeSection — tree-style collapsible section toggle ────────────────────

interface TreeSectionProps {
    label: string;
    open: boolean;
    onToggle: () => void;
    isLast?: boolean;
    badge?: string;
    summary?: React.ReactNode;
    headerRight?: React.ReactNode;
    children: React.ReactNode;
    sectionBg?: string;
}

/**
 * A section toggle that looks like a tree branch with highlighted border:
 *   ├── [±] Label
 *   │   content...
 *   └── [±] Last Label
 */
const TreeSection: React.FC<TreeSectionProps> = ({
    label, open, onToggle, isLast = false, badge, summary, headerRight, children, sectionBg,
}) => {
    return (
        <Box
            position="relative"
            _before={!isLast ? {
                content: '""',
                position: 'absolute',
                left: '-15px',
                top: '0',
                bottom: '0',
                width: '2px',
                bg: 'gray.200',
            } : undefined}
        >
            {/* Branch connector */}
            <Box
                position="absolute"
                left="-15px"
                top="12px"
                w="14px"
                h="2px"
                bg="gray.200"
            />

            {/* Section wrapper with highlighted border */}
            <Box
                border="1px solid"
                borderColor={open ? 'blue.300' : 'gray.200'}
                borderRadius="md"
                bg={open ? (sectionBg ?? 'white') : 'transparent'}
                transition="all 0.15s"
                mb={1}
            >
                {/* Header */}
                <Flex
                    align="center"
                    gap={1.5}
                    py={1.5}
                    px={2}
                    cursor="pointer"
                    _hover={{ bg: 'gray.50' }}
                    borderRadius="md"
                    userSelect="none"
                    onClick={onToggle}
                >
                    {open ? <FiChevronDown size={14} color="var(--chakra-colors-blue-500)" /> : <FiChevronRight size={14} />}
                    <Text fontSize="sm" fontWeight="semibold" color={open ? 'blue.700' : 'gray.700'}>{label}</Text>
                    {badge && <Badge size="xs" variant="subtle" colorPalette="gray">{badge}</Badge>}
                    {summary && <Box ml={1} flex="1" minW={0}>{summary}</Box>}
                    {headerRight && (
                        <Box ml="auto" onClick={(e) => e.stopPropagation()}>
                            {headerRight}
                        </Box>
                    )}
                </Flex>

                {/* Content */}
                {open && (
                    <Box pt={1} pb={2} borderTop="1px solid" borderTopColor="gray.100">
                        {children}
                    </Box>
                )}
            </Box>
        </Box>
    );
};
