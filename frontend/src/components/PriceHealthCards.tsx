/**
 * PriceHealthCards — Compact card-grid price health view.
 *
 * - Filter pills + search + sort toolbar
 * - Responsive grid of compact cards (as many per row as fit)
 * - PnL-style pagination bar (top + bottom) with chevron icons
 * - Gap badge is clickable → expands card with bigger chart + CTAs
 * - Info icon next to asset name opens AssetDetailSlidePanel
 */

import React, { useMemo, useState } from 'react';
import {
    Badge, Box, Button, Flex, Input, NativeSelect, Spinner, Text,
} from '@chakra-ui/react';
import {
    FiInfo, FiSearch, FiRefreshCw, FiX,
    FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight,
    FiChevronDown, FiEdit3,
} from 'react-icons/fi';
import { usePriceHealth } from '../hooks/usePriceHealth';
import { usePriceGapsSummary, PRICE_GAPS_QUERY_KEY, PRICE_GAPS_SUMMARY_QUERY_KEY } from '../hooks/usePriceGaps';
import { PRICE_TIMESERIES_QUERY_KEY, PRICE_HEALTH_QUERY_KEY } from '../hooks/usePriceHealth';
import { useQueryClient } from '@tanstack/react-query';
import { useAssetDetailPanel } from '../contexts/AssetDetailPanelContext';
import { GapFixPanel } from './GapFixPanel';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { Tooltip } from './ui/tooltip';
import { formatRelativeTime } from '../utils/dateUtils';
import type { PriceHealthRow } from '../types';

// ---------------------------------------------------------------------------
// Lightweight sparkline — pure SVG, no deps, no HTTP fetch
// ---------------------------------------------------------------------------

const Sparkline: React.FC<{ prices: number[]; width?: number; height?: number; color?: string }> = ({
    prices, width = 180, height = 28, color = '#6366f1',
}) => {
    if (prices.length < 2) return null;
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;
    const pad = 1;
    const points = prices
        .map((p, i) => {
            const x = (i / (prices.length - 1)) * (width - pad * 2) + pad;
            const y = height - pad - ((p - min) / range) * (height - pad * 2);
            return `${x},${y}`;
        })
        .join(' ');
    return (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
            <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
};

// ---------------------------------------------------------------------------
// Status config
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<string, { color: string; label: string; emoji: string }> = {
    healthy: { color: 'green', label: 'Healthy', emoji: '✅' },
    warning: { color: 'yellow', label: 'Warning', emoji: '⚠️' },
    stale: { color: 'red', label: 'Stale', emoji: '🔴' },
    no_transactions: { color: 'gray', label: 'No txns', emoji: 'ℹ️' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPrice(price: number): string {
    if (price >= 1) return price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 0.01) return price.toFixed(4);
    if (price >= 0.0001) return price.toFixed(6);
    return price.toFixed(8);
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortKey = 'status' | 'gaps' | 'days_stale' | 'symbol';
const STATUS_ORDER: Record<string, number> = { stale: 0, warning: 1, healthy: 2, no_transactions: 3 };

function sortRows(rows: PriceHealthRow[], key: SortKey, gapMap: Map<number, number>): PriceHealthRow[] {
    return [...rows].sort((a, b) => {
        switch (key) {
            case 'status': {
                const c = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
                return c !== 0 ? c : b.days_stale - a.days_stale;
            }
            case 'gaps': return (gapMap.get(b.asset_id) ?? 0) - (gapMap.get(a.asset_id) ?? 0);
            case 'days_stale': return b.days_stale - a.days_stale;
            case 'symbol': return a.symbol.localeCompare(b.symbol);
            default: return 0;
        }
    });
}

type StatusFilter = 'all' | 'healthy' | 'warning' | 'stale' | 'gaps';

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PriceHealthCards: React.FC = () => {
    const { data, isLoading, error, refetch } = usePriceHealth();
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<StatusFilter>('all');
    const [sortKey, setSortKey] = useState<SortKey>('status');
    const [page, setPage] = useState(0);         // 0-indexed like PnL
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    const [expandedId, setExpandedId] = useState<number | null>(null);

    const { openAssetPanel } = useAssetDetailPanel();
    const qc = useQueryClient();

    const handleCardRefresh = () => {
        qc.invalidateQueries({ queryKey: PRICE_HEALTH_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_GAPS_SUMMARY_QUERY_KEY });
        qc.invalidateQueries({ queryKey: PRICE_TIMESERIES_QUERY_KEY });
    };

    // Gap summary
    const allAssetIds = useMemo(() => (data?.items ?? []).map(r => r.asset_id), [data?.items]);
    const { data: gapSummary } = usePriceGapsSummary(allAssetIds);
    const gapMap = useMemo(() => {
        const m = new Map<number, number>();
        if (gapSummary?.items) {
            for (const item of gapSummary.items) {
                if (item.total_missing_days > 0) m.set(item.asset_id, item.total_missing_days);
            }
        }
        return m;
    }, [gapSummary]);

    // Filter + search + sort
    const processed = useMemo(() => {
        if (!data?.items) return [];
        let items = data.items;
        if (search) {
            const q = search.toLowerCase();
            items = items.filter(r =>
                r.symbol.toLowerCase().includes(q) || (r.label && r.label.toLowerCase().includes(q))
            );
        }
        if (filter !== 'all') {
            items = filter === 'gaps'
                ? items.filter(r => gapMap.has(r.asset_id))
                : items.filter(r => r.status === filter);
        }
        return sortRows(items, sortKey, gapMap);
    }, [data?.items, search, filter, sortKey, gapMap]);

    // Pagination
    const totalRows = processed.length;
    const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
    const safePage = Math.min(page, pageCount - 1);
    const pageItems = useMemo(() => {
        const start = safePage * pageSize;
        return processed.slice(start, start + pageSize);
    }, [processed, safePage, pageSize]);

    React.useEffect(() => { setPage(0); }, [search, filter, sortKey]);

    // Counts
    const counts = useMemo(() => {
        if (!data?.items) return { all: 0, healthy: 0, warning: 0, stale: 0, gaps: 0 };
        return {
            all: data.items.length,
            healthy: data.summary.healthy,
            warning: data.summary.warning,
            stale: data.summary.stale,
            gaps: gapMap.size,
        };
    }, [data, gapMap]);

    // ── Loading / Error / Empty ──────────────────────────────────────────
    if (isLoading) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Spinner size="xl" color="blue.500" />
                <Text mt={4}>Loading price health data...</Text>
            </Box>
        );
    }
    if (error) {
        return (
            <Box textAlign="center" py={10} bg="red.50" borderRadius="md" borderWidth={1} borderColor="red.200">
                <Text color="red.600">Error: {error}</Text>
                <Button size="sm" mt={3} onClick={() => refetch()}>Retry</Button>
            </Box>
        );
    }
    if (!data || data.items.length === 0) {
        return (
            <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                <Text color="gray.500">No price snapshot data found. Import prices first.</Text>
            </Box>
        );
    }

    // ── Pagination bar (PnL style) ──────────────────────────────────────
    const paginationBar = totalRows > PAGE_SIZE_OPTIONS[0] ? (
        <Flex justify="space-between" align="center" width="100%" py={2} px={3}>
            <Flex align="center" gap={2}>
                <Text fontSize="2xs" color="gray.500">Rows:</Text>
                <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                    {PAGE_SIZE_OPTIONS.map(size => (
                        <Button
                            key={size}
                            size="2xs"
                            variant={pageSize === size ? 'subtle' : 'ghost'}
                            colorPalette={pageSize === size ? 'blue' : 'gray'}
                            borderRadius="0"
                            onClick={() => { setPageSize(size); setPage(0); }}
                            px={2}
                            fontSize="xs"
                        >
                            {size}
                        </Button>
                    ))}
                </Flex>
            </Flex>
            <Text fontSize="2xs" color="gray.500">
                {safePage * pageSize + 1}–{Math.min((safePage + 1) * pageSize, totalRows)} of {totalRows}
            </Text>
            <Flex align="center" gap={1}>
                <Button size="2xs" variant="ghost" onClick={() => setPage(0)} disabled={safePage === 0} px={1}>
                    <FiChevronsLeft size={12} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} px={1}>
                    <FiChevronLeft size={14} />
                </Button>
                <Text fontSize="xs" color="gray.600" mx={1}>
                    {safePage + 1} / {pageCount}
                </Text>
                <Button size="2xs" variant="ghost" onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={safePage >= pageCount - 1} px={1}>
                    <FiChevronRight size={14} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} px={1}>
                    <FiChevronsRight size={12} />
                </Button>
            </Flex>
        </Flex>
    ) : null;

    // ── Filter pills ────────────────────────────────────────────────────
    const pills: Array<{ key: StatusFilter; label: string; count: number; color: string }> = [
        { key: 'all', label: 'All', count: counts.all, color: 'gray' },
        { key: 'healthy', label: 'Healthy', count: counts.healthy, color: 'green' },
        { key: 'warning', label: 'Warning', count: counts.warning, color: 'yellow' },
        { key: 'stale', label: 'Stale', count: counts.stale, color: 'red' },
        { key: 'gaps', label: 'Gaps', count: counts.gaps, color: 'orange' },
    ];

    return (
        <Box>
            {/* ── Toolbar: pills + search + sort + refresh ── */}
            <Flex gap={2} mb={2} flexWrap="wrap" align="center">
                {pills.map(p => (
                    <Badge
                        key={p.key}
                        cursor="pointer"
                        colorPalette={p.color}
                        variant={filter === p.key ? 'solid' : 'outline'}
                        size="sm"
                        px={2}
                        py={0.5}
                        borderRadius="full"
                        onClick={() => setFilter(filter === p.key ? 'all' : p.key)}
                    >
                        {p.label} ({p.count})
                    </Badge>
                ))}
                <Box flex={1} />
                <Box position="relative" w="160px">
                    <Input placeholder="Search..." size="xs" value={search} onChange={e => setSearch(e.target.value)} pl={7} borderRadius="md" />
                    <Box position="absolute" left={2} top="50%" transform="translateY(-50%)" color="gray.400"><FiSearch size={12} /></Box>
                </Box>
                <NativeSelect.Root size="xs" w="120px">
                    <NativeSelect.Field value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)}>
                        <option value="status">Sort: Status</option>
                        <option value="gaps">Sort: Gaps</option>
                        <option value="days_stale">Sort: Stale</option>
                        <option value="symbol">Sort: A-Z</option>
                    </NativeSelect.Field>
                </NativeSelect.Root>
                <Button size="xs" variant="outline" onClick={() => refetch()}><FiRefreshCw size={12} /></Button>
            </Flex>

            {/* ── Top pagination ── */}
            {paginationBar && (
                <Box borderBottom="1px solid" borderColor="gray.100" mb={2}>
                    {paginationBar}
                </Box>
            )}

            {/* ── Card grid ── */}
            {pageItems.length === 0 ? (
                <Box textAlign="center" py={10} bg="gray.50" borderRadius="md">
                    <Text color="gray.400">No assets match your criteria.</Text>
                </Box>
            ) : (
                <Flex flexWrap="wrap" gap={2}>
                    {pageItems.map(row => (
                        <HealthCard
                            key={row.asset_id}
                            row={row}
                            gapDays={gapMap.get(row.asset_id)}
                            expanded={expandedId === row.asset_id}
                            onToggleExpand={() => setExpandedId(prev => prev === row.asset_id ? null : row.asset_id)}
                            onOpenPanel={() => openAssetPanel(row.asset_id)}
                            onRefresh={handleCardRefresh}
                        />
                    ))}
                </Flex>
            )}

            {/* ── Bottom pagination ── */}
            {paginationBar && (
                <Box borderTop="1px solid" borderColor="gray.100" mt={2}>
                    {paginationBar}
                </Box>
            )}
        </Box>
    );
};

// ---------------------------------------------------------------------------
// Single health card — compact, fits many per row
// ---------------------------------------------------------------------------

interface HealthCardProps {
    row: PriceHealthRow;
    gapDays?: number;
    expanded: boolean;
    onToggleExpand: () => void;
    onOpenPanel: () => void;
    onRefresh: () => void;
}

const HealthCard: React.FC<HealthCardProps> = ({ row, gapDays, expanded, onToggleExpand, onOpenPanel, onRefresh }) => {
    const cfg = STATUS_CONFIG[row.status] ?? STATUS_CONFIG.healthy;
    const hasGaps = gapDays != null && gapDays > 0;
    const noTx = row.status === 'no_transactions';
    const [showPriceSetter, setShowPriceSetter] = useState(false);

    return (
        <Box
            bg="white"
            border="1px solid"
            borderColor={expanded ? 'orange.300' : noTx ? 'gray.100' : 'gray.200'}
            borderRadius="md"
            px={2.5}
            py={1.5}
            minW="185px"
            maxW={expanded ? '660px' : '220px'}
            flex={expanded ? '1 0 570px' : '1 0 185px'}
            _hover={{ borderColor: expanded ? 'orange.400' : 'blue.300', boxShadow: 'xs' }}
            transition="all 0.15s"
            opacity={noTx ? 0.6 : 1}
            position="relative"
        >
            {/* Row 1: name + icons + tiny chart */}
            <Flex align="center" gap={1.5} mb={1}>
                <Text fontSize="xs" fontWeight="bold" truncate flex={1}>
                    {row.symbol}
                </Text>
                <Tooltip content="Open details">
                    <Box
                        as="button"
                        color="gray.400"
                        _hover={{ color: 'blue.500' }}
                        cursor="pointer"
                        onClick={e => { e.stopPropagation(); onOpenPanel(); }}
                        flexShrink={0}
                    >
                        <FiInfo size={12} />
                    </Box>
                </Tooltip>
                <Tooltip content="Set prices">
                    <Box
                        as="button"
                        color="gray.400"
                        _hover={{ color: 'blue.500' }}
                        cursor="pointer"
                        onClick={e => { e.stopPropagation(); setShowPriceSetter(true); }}
                        flexShrink={0}
                    >
                        <FiEdit3 size={11} />
                    </Box>
                </Tooltip>
                <Tooltip content="Refresh">
                    <Box
                        as="button"
                        color="gray.300"
                        _hover={{ color: 'blue.500' }}
                        cursor="pointer"
                        onClick={e => { e.stopPropagation(); onRefresh(); }}
                        flexShrink={0}
                    >
                        <FiRefreshCw size={10} />
                    </Box>
                </Tooltip>
                {expanded ? (
                    <Tooltip content="Collapse">
                        <Box
                            as="button"
                            color="gray.400"
                            _hover={{ color: 'red.500' }}
                            cursor="pointer"
                            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
                            flexShrink={0}
                        >
                            <FiX size={14} />
                        </Box>
                    </Tooltip>
                ) : (
                    <Tooltip content="Expand">
                        <Box
                            as="button"
                            color="gray.300"
                            _hover={{ color: 'blue.500' }}
                            cursor="pointer"
                            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
                            flexShrink={0}
                        >
                            <FiChevronDown size={14} />
                        </Box>
                    </Tooltip>
                )}
            </Flex>

            {/* Sparkline row */}
            {!expanded && row.sparkline && row.sparkline.length >= 2 && (
                <Box h="28px" mt={0.5} mb={0.5}>
                    <Sparkline prices={row.sparkline} width={180} height={28} />
                </Box>
            )}

            {/* Row 2: badges */}
            <Flex gap={1} flexWrap="wrap" mb={0.5}>
                <Badge size="xs" colorPalette={cfg.color} fontSize="9px">
                    {cfg.label}
                </Badge>
                {row.is_flatline && (
                    <Tooltip content="Last 5+ prices identical — possible broken feed">
                        <Badge size="xs" colorPalette="orange" fontSize="9px">Flat</Badge>
                    </Tooltip>
                )}
                {hasGaps && (
                    <Badge
                        size="xs"
                        colorPalette="orange"
                        variant={expanded ? 'solid' : 'subtle'}
                        fontSize="9px"
                        cursor="pointer"
                        onClick={onToggleExpand}
                        _hover={{ opacity: 0.8 }}
                    >
                        {gapDays}d gaps
                    </Badge>
                )}
            </Flex>

            {/* Row 3: price, age, source */}
            <Flex gap={2} align="center">
                <Text fontSize="xs" fontWeight="bold" fontFamily="mono">
                    {formatPrice(row.last_price)}
                </Text>
                <Tooltip content={row.last_updated ? new Date(row.last_updated).toLocaleString() : ''}>
                    <Text fontSize="2xs" color={row.status === 'stale' ? 'red.600' : 'gray.500'}>
                        {formatRelativeTime(row.last_updated)}
                    </Text>
                </Tooltip>
                <Text fontSize="2xs" color="gray.400" truncate>
                    {row.last_source || '—'}
                </Text>
            </Flex>

            {/* Expanded section: chart + gap CTAs */}
            {expanded && (
                <ExpandedSection assetId={row.asset_id} symbol={row.symbol} onOpenPriceSetter={() => setShowPriceSetter(true)} />
            )}

            {/* Price Setter Dialog */}
            {showPriceSetter && (
                <PriceSetterDialog
                    isOpen={true}
                    onClose={() => setShowPriceSetter(false)}
                    onSave={() => { setShowPriceSetter(false); onRefresh(); }}
                    assetId={row.asset_id}
                    assetName={row.symbol}
                    defaultDate={new Date().toISOString()}
                />
            )}
        </Box>
    );
};

// ---------------------------------------------------------------------------
// Expanded gap section — loaded only when card is expanded
// ---------------------------------------------------------------------------

const ExpandedSection: React.FC<{ assetId: number; symbol: string; onOpenPriceSetter: () => void }> = ({ assetId, symbol, onOpenPriceSetter }) => (
    <Box mt={2} pt={2} borderTop="1px solid" borderColor="orange.100">
        <GapFixPanel assetId={assetId} symbol={symbol} onOpenPriceSetter={onOpenPriceSetter} />
    </Box>
);

export default PriceHealthCards;
