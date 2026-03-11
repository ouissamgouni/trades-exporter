/**
 * AllocationTreemap
 *
 * Interactive portfolio treemap with drill-down, range filtering, and
 * performance-based coloring (green-red gradient).
 *
 * Controls:
 *  - Group by: Flat | Category (default) | Account
 *  - Size by: Weight (market value) | Return | Cost
 *  - Min/max range slider to filter visible items
 *  - Click a group node to drill down → breadcrumb to navigate back
 *
 * Uses the last point of the portfolio timeline breakdown + AssetPnLRow for fees.
 */
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { Badge, Box, Flex, Heading, IconButton, Slider, Text } from '@chakra-ui/react';
import { ResponsiveTreeMap } from '@nivo/treemap';
import { FiMaximize2, FiMinimize2 } from 'react-icons/fi';
import type { TimelinePoint, TimelineBreakdownItem } from '../../hooks/useChartData';
import { Account } from '../../types';
import { getContrastTextColor } from '../../constants/colors';
import type { AssetPnLRow } from './types';
import { currencySymbol } from './TotalReturnScorecard';

/** Drilldown state exported by the treemap for cross-component filtering */
export interface TreemapDrilldownState {
    groupBy: 'flat' | 'category' | 'account';
    /** The drilled-into group name (category label or account name), or null */
    drilldown: string | null;
}

interface AllocationTreemapProps {
    points: TimelinePoint[];
    assetCategoryMap: Record<number, string>;
    accounts: Account[];
    assets: AssetPnLRow[];
    baseCurrency: string;
    isLoading?: boolean;
    /** Called when drilldown state changes (for cross-component filtering) */
    onDrilldownChange?: (state: TreemapDrilldownState) => void;
}

type GroupBy = 'flat' | 'category' | 'account';
type SizeBy = 'market_value' | 'total_return' | 'cost_basis' | 'efficiency';

const SIZE_BY_LABELS: Record<SizeBy, string> = {
    market_value: 'Weight',
    total_return: 'Return',
    cost_basis: 'Cost',
    efficiency: 'Efficiency',
};

/** Performance color scale: green for gains, red for losses */
function performanceColor(pnlPct: number): string {
    const clamped = Math.max(-100, Math.min(100, pnlPct));
    if (clamped >= 0) {
        const intensity = Math.min(clamped / 50, 1);
        const g = Math.round(130 + intensity * 70);
        const r = Math.round(200 - intensity * 150);
        return `rgb(${r}, ${g}, 80)`;
    }
    const intensity = Math.min(Math.abs(clamped) / 50, 1);
    const r = Math.round(200 + intensity * 55);
    const g = Math.round(130 - intensity * 80);
    return `rgb(${r}, ${g}, 80)`;
}

function formatCompact(val: number, currency: string): string {
    const abs = Math.abs(val);
    const sign = val < 0 ? '-' : '';
    const sym = currencySymbol(currency);
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M ${sym}`;
    if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K ${sym}`;
    return `${sign}${abs.toFixed(0)} ${sym}`;
}

/** Truncate to maxLen chars with ellipsis */
function truncate(s: string, maxLen = 11): string {
    return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

interface TreeNode {
    id: string;
    value?: number;
    children?: TreeNode[];
    color?: string;
    pnlPct?: number;
    costBasis?: number;
    marketValue?: number;
    totalReturn?: number;
    totalReturnPct?: number;
    fees?: number;
    fullLabel?: string;
}

export const AllocationTreemap: React.FC<AllocationTreemapProps> = ({
    points,
    assetCategoryMap,
    accounts,
    assets,
    baseCurrency,
    isLoading,
    onDrilldownChange,
}) => {
    const [groupBy, setGroupBy] = useState<GroupBy>('category');
    const [sizeBy, setSizeBy] = useState<SizeBy>('market_value');
    // Drill-down: when set, show only children of this group
    const [drilldown, setDrilldown] = useState<string | null>(null);
    // Range slider: [min, max] as percentage of the data range (0-100)
    const [rangeFilter, setRangeFilter] = useState<[number, number]>([0, 100]);
    // Fullscreen toggle
    const [isFullscreen, setIsFullscreen] = useState(false);

    // Escape key closes fullscreen
    useEffect(() => {
        if (!isFullscreen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsFullscreen(false); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isFullscreen]);

    // asset_id → total_fees
    const assetFeeMap = useMemo(() => {
        const m: Record<number, number> = {};
        for (const a of assets) {
            if (a.asset.id != null) m[a.asset.id] = a.total_fees;
        }
        return m;
    }, [assets]);

    // asset_id → account_ids
    const assetAccountMap = useMemo(() => {
        const m: Record<number, number[]> = {};
        for (const a of assets) {
            if (a.asset.id != null) m[a.asset.id] = a.account_ids;
        }
        return m;
    }, [assets]);

    const accountMap = useMemo(() => {
        const m: Record<number, string> = {};
        for (const a of accounts) {
            if (a.id !== undefined && a.id !== null) m[a.id] = a.name;
        }
        return m;
    }, [accounts]);

    /** Get the sizing value for a breakdown item */
    const getSizeValue = (b: TimelineBreakdownItem): number => {
        switch (sizeBy) {
            case 'market_value': return b.value_in_base;
            case 'cost_basis': return b.cost_basis_in_base;
            case 'total_return': {
                const tr = (b.value_in_base - b.cost_basis_in_base) + b.realized_pnl_to_date;
                return Math.abs(tr);
            }
            case 'efficiency': {
                // ROI% as size — how much return per unit of cost invested
                const tr = (b.value_in_base - b.cost_basis_in_base) + b.realized_pnl_to_date;
                return b.cost_basis_in_base > 0 ? Math.abs(tr / b.cost_basis_in_base) * 100 : 0;
            }
            default: return b.value_in_base;
        }
    };

    // Compute the full tree (before drilldown / range filtering)
    const { fullTree, dataRange } = useMemo(() => {
        if (!points.length) return { fullTree: { id: 'root', children: [] } as TreeNode, dataRange: { min: 0, max: 0 } };

        const lastPt = points[points.length - 1];
        const breakdown = lastPt.breakdown.filter(b => getSizeValue(b) > 0);

        // Compute data range for slider
        const sizes = breakdown.map(b => getSizeValue(b));
        const min = sizes.length ? Math.min(...sizes) : 0;
        const max = sizes.length ? Math.max(...sizes) : 0;

        const mkLeaf = (b: TimelineBreakdownItem): TreeNode => {
            const unrealizedPnl = b.value_in_base - b.cost_basis_in_base;
            const totalReturn = unrealizedPnl + b.realized_pnl_to_date;
            const pnlPct = b.cost_basis_in_base > 0 ? (totalReturn / b.cost_basis_in_base) * 100 : 0;
            const sizeVal = getSizeValue(b);
            return {
                id: b.symbol,
                fullLabel: b.label || b.symbol,
                value: Math.max(sizeVal, 0.01),
                pnlPct,
                costBasis: b.cost_basis_in_base,
                marketValue: b.value_in_base,
                totalReturn,
                totalReturnPct: pnlPct,
                fees: assetFeeMap[b.asset_id] || 0,
                color: performanceColor(pnlPct),
            };
        };

        let tree: TreeNode;

        if (groupBy === 'flat') {
            tree = {
                id: 'Portfolio',
                children: breakdown.sort((a, b) => getSizeValue(b) - getSizeValue(a)).map(mkLeaf),
            };
        } else if (groupBy === 'category') {
            const groups: Record<string, TimelineBreakdownItem[]> = {};
            for (const b of breakdown) {
                const cat = assetCategoryMap[b.asset_id] || 'Uncategorized';
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(b);
            }
            tree = {
                id: 'Portfolio',
                children: Object.entries(groups)
                    .sort(([, a], [, b]) => {
                        const aSum = a.reduce((s, i) => s + getSizeValue(i), 0);
                        const bSum = b.reduce((s, i) => s + getSizeValue(i), 0);
                        return bSum - aSum;
                    })
                    .map(([cat, items]) => ({
                        id: cat,
                        children: items.sort((a, b) => getSizeValue(b) - getSizeValue(a)).map(mkLeaf),
                    })),
            };
        } else {
            // account grouping
            const accountGroups: Record<string, TreeNode[]> = {};
            for (const b of breakdown) {
                const acctIds = assetAccountMap[b.asset_id] || [];
                const leaf = mkLeaf(b);
                if (acctIds.length === 0) {
                    const key = 'Unknown';
                    if (!accountGroups[key]) accountGroups[key] = [];
                    accountGroups[key].push(leaf);
                } else {
                    const share = 1 / acctIds.length;
                    for (const acctId of acctIds) {
                        const key = accountMap[acctId] || `Account #${acctId}`;
                        if (!accountGroups[key]) accountGroups[key] = [];
                        accountGroups[key].push({
                            ...leaf,
                            id: `${leaf.id}`,
                            value: (leaf.value ?? 0) * share,
                            costBasis: (leaf.costBasis ?? 0) * share,
                            marketValue: (leaf.marketValue ?? 0) * share,
                            totalReturn: (leaf.totalReturn ?? 0) * share,
                            fees: (leaf.fees ?? 0) * share,
                        });
                    }
                }
            }
            tree = {
                id: 'Portfolio',
                children: Object.entries(accountGroups)
                    .sort(([, a], [, b]) => {
                        const aSum = a.reduce((s, n) => s + (n.value ?? 0), 0);
                        const bSum = b.reduce((s, n) => s + (n.value ?? 0), 0);
                        return bSum - aSum;
                    })
                    .map(([acct, items]) => ({
                        id: acct,
                        children: items.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
                    })),
            };
        }

        return { fullTree: tree, dataRange: { min, max } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points, groupBy, sizeBy, assetCategoryMap, assetFeeMap, assetAccountMap, accountMap]);

    // Apply drilldown + range filtering
    const treeData = useMemo((): TreeNode => {
        let tree = fullTree;

        // Drill-down: find the group node and promote its children to root
        if (drilldown && tree.children) {
            const group = tree.children.find(c => c.id === drilldown);
            if (group) {
                tree = { id: drilldown, children: group.children };
            }
        }

        // Range filter: filter leaf nodes by size value
        if (rangeFilter[0] > 0 || rangeFilter[1] < 100) {
            const range = dataRange.max - dataRange.min;
            const minVal = dataRange.min + (rangeFilter[0] / 100) * range;
            const maxVal = dataRange.min + (rangeFilter[1] / 100) * range;

            const filterChildren = (children: TreeNode[] | undefined): TreeNode[] => {
                if (!children) return [];
                return children
                    .map(node => {
                        if (node.children) {
                            const filteredKids = filterChildren(node.children);
                            if (filteredKids.length === 0) return null;
                            return { ...node, children: filteredKids };
                        }
                        // Leaf node: check if value is in range
                        const val = node.value ?? 0;
                        return val >= minVal && val <= maxVal ? node : null;
                    })
                    .filter(Boolean) as TreeNode[];
            };

            tree = { ...tree, children: filterChildren(tree.children) };
        }

        return tree;
    }, [fullTree, drilldown, rangeFilter, dataRange]);

    // Total value for manual percentage calculation
    const totalValue = useMemo(() => {
        const sumLeaves = (node: TreeNode): number => {
            if (node.children) return node.children.reduce((s, c) => s + sumLeaves(c), 0);
            return node.value ?? 0;
        };
        return sumLeaves(treeData);
    }, [treeData]);

    // Build leaf → parent group mapping for drill-down via leaf click
    const leafToParent = useMemo(() => {
        const map = new Map<string, string>();
        if (groupBy !== 'flat' && fullTree.children) {
            for (const group of fullTree.children) {
                if (group.children) {
                    for (const leaf of group.children) {
                        map.set(leaf.id, group.id);
                    }
                }
            }
        }
        return map;
    }, [fullTree, groupBy]);

    // Handle node click for drill-down
    const handleNodeClick = (node: any) => {
        if (groupBy === 'flat') return;
        // Group node click (rare — Nivo renders them behind leaves)
        if (node.data?.children && !drilldown) {
            setDrilldown(node.id);
            onDrilldownChange?.({ groupBy, drilldown: node.id });
            return;
        }
        // Leaf click in grouped mode without drilldown → drill into parent group
        if (!node.data?.children && !drilldown) {
            const parent = leafToParent.get(node.id);
            if (parent) {
                setDrilldown(parent);
                onDrilldownChange?.({ groupBy, drilldown: parent });
            }
        }
    };

    // Reset drilldown when groupBy changes
    const handleGroupByChange = (g: GroupBy) => {
        setGroupBy(g);
        setDrilldown(null);
        onDrilldownChange?.({ groupBy: g, drilldown: null });
    };

    if (!points.length && !isLoading) return null;

    return (
        <Box
            p={4}
            bg="white"
            borderRadius={isFullscreen ? 'none' : 'md'}
            border={isFullscreen ? 'none' : '1px solid'}
            borderColor="gray.200"
            {...(isFullscreen ? {
                position: 'fixed',
                inset: 0,
                zIndex: 1500,
                overflow: 'auto',
            } : {})}
        >
            {/* Controls row */}
            <Flex justify="space-between" align="center" mb={2} wrap="wrap" gap={2}>
                <Heading size="sm" color="gray.700">Portfolio Treemap</Heading>
                <Flex gap={3} align="center" wrap="wrap">
                    {/* Group by */}
                    <Flex gap={1} align="center">
                        <Text fontSize="xs" color="gray.500">Group:</Text>
                        {(['flat', 'category', 'account'] as const).map(g => (
                            <Badge
                                key={g}
                                cursor="pointer"
                                variant={groupBy === g ? 'solid' : 'outline'}
                                colorPalette={groupBy === g ? 'blue' : 'gray'}
                                onClick={() => handleGroupByChange(g)}
                                size="sm"
                                px={2}
                            >
                                {g === 'flat' ? 'Flat' : g === 'category' ? 'Category' : 'Account'}
                            </Badge>
                        ))}
                    </Flex>
                    {/* Size by */}
                    <Flex gap={1} align="center">
                        <Text fontSize="xs" color="gray.500">Size:</Text>
                        {(Object.keys(SIZE_BY_LABELS) as SizeBy[]).map(s => (
                            <Badge
                                key={s}
                                cursor="pointer"
                                variant={sizeBy === s ? 'solid' : 'outline'}
                                colorPalette={sizeBy === s ? 'purple' : 'gray'}
                                onClick={() => setSizeBy(s)}
                                size="sm"
                                px={2}
                            >
                                {SIZE_BY_LABELS[s]}
                            </Badge>
                        ))}
                    </Flex>
                    {/* Fullscreen toggle */}
                    <IconButton
                        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                        size="xs"
                        variant="ghost"
                        onClick={() => setIsFullscreen(f => !f)}
                    >
                        {isFullscreen ? <FiMinimize2 size={14} /> : <FiMaximize2 size={14} />}
                    </IconButton>
                </Flex>
            </Flex>

            {/* Breadcrumb for drill-down */}
            {drilldown && (
                <Flex align="center" gap={1} mb={2}>
                    <Text
                        fontSize="xs"
                        color="blue.500"
                        cursor="pointer"
                        fontWeight="semibold"
                        _hover={{ textDecoration: 'underline' }}
                        onClick={() => { setDrilldown(null); onDrilldownChange?.({ groupBy, drilldown: null }); }}
                    >
                        Portfolio
                    </Text>
                    <Text fontSize="xs" color="gray.400">/</Text>
                    <Text fontSize="xs" color="gray.700" fontWeight="semibold">{drilldown}</Text>
                </Flex>
            )}

            {/* Range filter slider */}
            {dataRange.max > dataRange.min && (
                <Flex align="center" gap={3} mb={2} px={1}>
                    <Text fontSize="2xs" color="gray.500" whiteSpace="nowrap">
                        Range: {formatCompact(dataRange.min + (rangeFilter[0] / 100) * (dataRange.max - dataRange.min), baseCurrency)}
                        {' — '}
                        {formatCompact(dataRange.min + (rangeFilter[1] / 100) * (dataRange.max - dataRange.min), baseCurrency)}
                    </Text>
                    <Box flex="1" maxW="300px">
                        <Slider.Root
                            size="sm"
                            min={0}
                            max={100}
                            step={1}
                            value={rangeFilter}
                            onValueChange={(details) => setRangeFilter(details.value as [number, number])}
                        >
                            <Slider.Control>
                                <Slider.Track>
                                    <Slider.Range />
                                </Slider.Track>
                                <Slider.Thumb index={0} />
                                <Slider.Thumb index={1} />
                            </Slider.Control>
                        </Slider.Root>
                    </Box>
                </Flex>
            )}

            {isLoading ? (
                <Box h={isFullscreen ? 'calc(100vh - 140px)' : '500px'} display="flex" alignItems="center" justifyContent="center">
                    <Text fontSize="sm" color="gray.400">Loading...</Text>
                </Box>
            ) : (
                <Box h={isFullscreen ? 'calc(100vh - 140px)' : '500px'}>
                    <ResponsiveTreeMap
                        data={treeData}
                        identity="id"
                        value="value"
                        leavesOnly={groupBy === 'flat' || !!drilldown}
                        innerPadding={2}
                        outerPadding={4}
                        colors={(node: any) => node.data?.color || '#CBD5E0'}
                        borderWidth={1}
                        borderColor={{ from: 'color', modifiers: [['darker', 0.3]] }}
                        label={(node: any) => {
                            const label = truncate(node.data?.fullLabel || node.id);
                            return label;
                        }}
                        labelSkipSize={40}
                        labelTextColor={(node: any) => {
                            const bg = node.color || '#CBD5E0';
                            return getContrastTextColor(bg);
                        }}
                        onClick={handleNodeClick}
                        tooltip={(node: any) => {
                            const data = node.node?.data;
                            const value = node.node?.value || 0;
                            const pct = totalValue > 0
                                ? ((value / totalValue) * 100).toFixed(1)
                                : '0.0';
                            const totalReturn = data?.totalReturn ?? 0;
                            const totalReturnPct = data?.totalReturnPct ?? 0;
                            const sym = currencySymbol(baseCurrency);
                            // Group node (has children) — show aggregate name
                            if (data?.children) {
                                return (
                                    <Box bg="white" p={2} borderRadius="md" boxShadow="md" border="1px solid" borderColor="gray.200" minW="160px">
                                        <Text fontSize="xs" fontWeight="bold" color="gray.700">{node.node?.id}</Text>
                                        <Text fontSize="xs" color="gray.600">
                                            {Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} {sym} ({pct}%)
                                        </Text>
                                        {groupBy !== 'flat' && !drilldown && (
                                            <Text fontSize="2xs" color="blue.500" mt={1}>Click to drill down</Text>
                                        )}
                                    </Box>
                                );
                            }
                            // Leaf node: stacked horizontal bar for cost vs return
                            const cost = Math.abs(data?.costBasis ?? 0);
                            const ret = data?.totalReturn ?? 0;
                            const barTotal = cost + Math.abs(ret);
                            const costPct = barTotal > 0 ? (cost / barTotal) * 100 : 50;
                            const retPct = barTotal > 0 ? (Math.abs(ret) / barTotal) * 100 : 50;
                            const parentGroup = !drilldown && groupBy !== 'flat' ? leafToParent.get(node.node?.id) : null;
                            return (
                                <Box bg="white" p={2} borderRadius="md" boxShadow="md" border="1px solid" borderColor="gray.200" minW="220px">
                                    <Text fontSize="xs" fontWeight="bold" color="gray.700">
                                        {data?.fullLabel || node.node?.id}
                                    </Text>
                                    {data?.fullLabel && data.fullLabel !== node.node?.id && (
                                        <Text fontSize="xs" color="gray.500">{node.node?.id}</Text>
                                    )}
                                    <Text fontSize="xs" color="gray.600" mt={1}>
                                        {Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} {sym} ({pct}%)
                                    </Text>
                                    {data?.marketValue != null && (
                                        <Box borderTop="1px solid" borderColor="gray.100" mt={1} pt={1}>
                                            {/* Cost & Return values */}
                                            <Flex justify="space-between" mb={0.5}>
                                                <Text fontSize="2xs" color="gray.500">Cost: {formatCompact(cost, baseCurrency)}</Text>
                                                <Text fontSize="2xs" color={ret >= 0 ? 'green.600' : 'red.600'}>
                                                    Return: {ret >= 0 ? '+' : ''}{formatCompact(ret, baseCurrency)}
                                                </Text>
                                            </Flex>
                                            {/* Stacked horizontal bar */}
                                            <Flex h="10px" borderRadius="sm" overflow="hidden" mb={1}>
                                                <Box bg="#A0AEC0" w={`${costPct}%`} h="100%" />
                                                <Box bg={ret >= 0 ? '#48BB78' : '#F56565'} w={`${retPct}%`} h="100%" />
                                            </Flex>
                                            <Flex justify="space-between">
                                                <Text fontSize="xs" color="gray.500">
                                                    MV: {formatCompact(data.marketValue, baseCurrency)}
                                                </Text>
                                                <Text fontSize="xs" fontWeight="bold" color={totalReturnPct >= 0 ? 'green.600' : 'red.600'}>
                                                    ROI: {totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}%
                                                </Text>
                                            </Flex>
                                            {(data.fees ?? 0) > 0 && (
                                                <Text fontSize="2xs" color="orange.500">
                                                    Fees: {formatCompact(data.fees, baseCurrency)}
                                                </Text>
                                            )}
                                        </Box>
                                    )}
                                    {parentGroup && (
                                        <Text fontSize="2xs" color="blue.500" mt={1}>Click to drill into {parentGroup}</Text>
                                    )}
                                </Box>
                            );
                        }}
                        theme={{
                            labels: { text: { fontSize: 11, fontWeight: 600 } },
                            tooltip: { container: { fontFamily: 'inherit', fontSize: 12 } },
                        }}
                    />
                </Box>
            )}

            {/* Performance color legend */}
            <Flex justify="center" mt={2} gap={4}>
                <Flex align="center" gap={1}>
                    <Box w="12px" h="12px" borderRadius="sm" bg={performanceColor(-50)} />
                    <Text fontSize="xs" color="gray.500">Loss</Text>
                </Flex>
                <Flex align="center" gap={1}>
                    <Box w="12px" h="12px" borderRadius="sm" bg={performanceColor(0)} />
                    <Text fontSize="xs" color="gray.500">Break-even</Text>
                </Flex>
                <Flex align="center" gap={1}>
                    <Box w="12px" h="12px" borderRadius="sm" bg={performanceColor(50)} />
                    <Text fontSize="xs" color="gray.500">Gain</Text>
                </Flex>
            </Flex>
        </Box>
    );
};
