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
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Badge, Button } from '../ui/primitives';
import { ResponsiveTreeMap } from '@nivo/treemap';
import { FiMaximize2, FiMinimize2 } from 'react-icons/fi';
import type { TimelinePoint, TimelineBreakdownItem } from '../../hooks/useChartData';
import { Account, DimensionWithCategories } from '../../types';
import { getContrastTextColor } from '../../constants/colors';
import type { AssetPnLRow } from './types';
import type { AccountBalanceBreakdown } from './types';
import { currencySymbol } from './TotalReturnScorecard';

/** Drilldown state exported by the treemap for cross-component filtering */
export interface TreemapDrilldownState {
    groupBy: 'flat' | 'category' | 'account' | 'currency';
    /** The drilled-into group name (category label or account name), or null */
    drilldown: string | null;
}

interface AllocationTreemapProps {
    points: TimelinePoint[];
    /** Per-dimension asset category maps: dimensionId → (assetId → categoryLabel) */
    assetCategoryMaps: Record<number, Record<number, string>>;
    /** Available dimensions for category grouping selector */
    dimensions: DimensionWithCategories[];
    accounts: Account[];
    assets: AssetPnLRow[];
    baseCurrency: string;
    isLoading?: boolean;
    /** Called when drilldown state changes (for cross-component filtering) */
    onDrilldownChange?: (state: TreemapDrilldownState) => void;
    /** Per-account balance data keyed by asset ID (for accurate account grouping) */
    accountBalances?: Map<number, AccountBalanceBreakdown[]>;
    /** Called when user double-clicks a leaf asset to navigate to asset detail */
    onAssetNavigate?: (assetId: number, assetSymbol: string) => void;
    /** Per-asset denomination currency map: assetId → currency symbol (e.g., "USD") */
    assetCurrencyMap?: Record<number, string>;
}

type GroupBy = 'flat' | 'category' | 'account' | 'currency';
type SizeBy = 'market_value' | 'total_return' | 'cost_basis' | 'efficiency';

/** Minimum cost basis to compute meaningful ROI / efficiency (avoids division-by-near-zero) */
const MIN_COST_BASIS = 1.0;
/** Cap efficiency value to prevent a single asset from dominating the treemap */
const EFFICIENCY_CAP = 1000;

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

/** Dual-thumb range slider (no Chakra Slider primitive available) — two overlapping
 * native range inputs; each input's track has pointer-events disabled, but its thumb
 * (a genuinely circular control, allowed rounded-full exception) keeps pointer-events so
 * only the thumbs are draggable. */
const THUMB_CLASSES =
    'pointer-events-none absolute inset-x-0 top-1/2 h-1 w-full -translate-y-1/2 appearance-none bg-transparent ' +
    '[&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 ' +
    '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 ' +
    '[&::-webkit-slider-thumb]:border [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow ' +
    '[&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 ' +
    '[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border [&::-moz-range-thumb]:border-white [&::-moz-range-thumb]:bg-blue-500 ' +
    '[&::-moz-range-thumb]:shadow';

const DualRangeSlider: React.FC<{
    value: [number, number];
    onChange: (value: [number, number]) => void;
}> = ({ value, onChange }) => {
    const [lo, hi] = value;
    return (
        <div className="relative h-4 w-full">
            <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-gray-200" />
            <div
                className="absolute top-1/2 h-1 -translate-y-1/2 bg-blue-500"
                style={{ left: `${lo}%`, right: `${100 - hi}%` }}
            />
            <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={lo}
                onChange={(e) => onChange([Math.min(Number(e.target.value), hi), hi])}
                className={THUMB_CLASSES}
                aria-label="Range minimum"
            />
            <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={hi}
                onChange={(e) => onChange([lo, Math.max(Number(e.target.value), lo)])}
                className={THUMB_CLASSES}
                aria-label="Range maximum"
            />
        </div>
    );
};

export const AllocationTreemap: React.FC<AllocationTreemapProps> = ({
    points,
    assetCategoryMaps,
    dimensions,
    accounts,
    assets,
    baseCurrency,
    isLoading,
    onDrilldownChange,
    accountBalances,
    onAssetNavigate,
    assetCurrencyMap = {},
}) => {
    const [groupBy, setGroupBy] = useState<GroupBy>('category');
    const [sizeBy, setSizeBy] = useState<SizeBy>('market_value');
    // Selected dimension for category grouping (default: first dimension)
    const [selectedDimensionId, setSelectedDimensionId] = useState<number | null>(null);
    // Drill-down: when set, show only children of this group
    const [drilldown, setDrilldown] = useState<string | null>(null);
    // Range slider: [min, max] as percentage of the data range (0-100)
    const [rangeFilter, setRangeFilter] = useState<[number, number]>([0, 100]);
    // Fullscreen toggle
    const [isFullscreen, setIsFullscreen] = useState(false);
    // Mouse position for portal tooltip (viewport coords)
    const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

    // Default to first dimension when dimensions load
    useEffect(() => {
        if (selectedDimensionId === null && dimensions.length > 0) {
            setSelectedDimensionId(dimensions[0].id);
        }
    }, [dimensions, selectedDimensionId]);

    // Resolved category map for the selected dimension
    const assetCategoryMap = useMemo(() => {
        if (selectedDimensionId != null && assetCategoryMaps[selectedDimensionId]) {
            return assetCategoryMaps[selectedDimensionId];
        }
        // Fallback: merge all dimensions (first match wins)
        const result: Record<number, string> = {};
        for (const dimId of Object.keys(assetCategoryMaps)) {
            const map = assetCategoryMaps[Number(dimId)];
            for (const [assetId, label] of Object.entries(map)) {
                if (!(Number(assetId) in result)) {
                    result[Number(assetId)] = label;
                }
            }
        }
        return result;
    }, [assetCategoryMaps, selectedDimensionId]);

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
                if (b.cost_basis_in_base < MIN_COST_BASIS) return 0;
                return Math.min(Math.abs(tr / b.cost_basis_in_base) * 100, EFFICIENCY_CAP);
            }
            default: return b.value_in_base;
        }
    };

    /** Compute total return for a breakdown item (signed) */
    const itemTotalReturn = (b: TimelineBreakdownItem): number =>
        (b.value_in_base - b.cost_basis_in_base) + b.realized_pnl_to_date;

    /** Whether the current sizeBy mode needs a Gains / Losses partition */
    const hasSplit = sizeBy === 'total_return' || sizeBy === 'efficiency';

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
            const rawPct = b.cost_basis_in_base >= MIN_COST_BASIS ? (totalReturn / b.cost_basis_in_base) * 100 : 0;
            const pnlPct = Math.max(-EFFICIENCY_CAP, Math.min(EFFICIENCY_CAP, rawPct));
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

        /** Build grouped children for a subset of breakdown items */
        const buildGroupedChildren = (items: TimelineBreakdownItem[]): TreeNode[] => {
            if (groupBy === 'flat') {
                return items.sort((a, b) => getSizeValue(b) - getSizeValue(a)).map(mkLeaf);
            } else if (groupBy === 'category') {
                const groups: Record<string, TimelineBreakdownItem[]> = {};
                for (const b of items) {
                    const cat = assetCategoryMap[b.asset_id] || 'Uncategorized';
                    if (!groups[cat]) groups[cat] = [];
                    groups[cat].push(b);
                }
                return Object.entries(groups)
                    .sort(([, a], [, b]) => {
                        const aSum = a.reduce((s, i) => s + getSizeValue(i), 0);
                        const bSum = b.reduce((s, i) => s + getSizeValue(i), 0);
                        return bSum - aSum;
                    })
                    .map(([cat, catItems]) => ({
                        id: cat,
                        children: catItems.sort((a, b) => getSizeValue(b) - getSizeValue(a)).map(mkLeaf),
                    }));
            } else if (groupBy === 'currency') {
                const groups: Record<string, TimelineBreakdownItem[]> = {};
                for (const b of items) {
                    const ccy = assetCurrencyMap[b.asset_id] || 'Unknown';
                    if (!groups[ccy]) groups[ccy] = [];
                    groups[ccy].push(b);
                }
                return Object.entries(groups)
                    .sort(([, a], [, b]) => {
                        const aSum = a.reduce((s, i) => s + getSizeValue(i), 0);
                        const bSum = b.reduce((s, i) => s + getSizeValue(i), 0);
                        return bSum - aSum;
                    })
                    .map(([ccy, ccyItems]) => ({
                        id: ccy,
                        children: ccyItems.sort((a, b) => getSizeValue(b) - getSizeValue(a)).map(mkLeaf),
                    }));
            } else {
                // account grouping
                const accountGroups: Record<string, TreeNode[]> = {};
                for (const b of items) {
                    const acctIds = assetAccountMap[b.asset_id] || [];
                    const leaf = mkLeaf(b);
                    const balances = accountBalances?.get(b.asset_id);

                    if (acctIds.length === 0) {
                        const key = 'Unknown';
                        if (!accountGroups[key]) accountGroups[key] = [];
                        accountGroups[key].push(leaf);
                    } else if (balances && balances.length > 0) {
                        const totalCost = balances.reduce((s, ab) => s + ab.cost_basis_in_base, 0);
                        for (const ab of balances) {
                            const key = ab.account_name || accountMap[ab.account_id] || `Account #${ab.account_id}`;
                            if (!accountGroups[key]) accountGroups[key] = [];
                            const share = totalCost > 0 ? ab.cost_basis_in_base / totalCost : 1 / balances.length;
                            const acctMarketValue = ab.market_value != null ? ab.market_value : (leaf.marketValue ?? 0) * share;
                            const acctCostBasis = ab.cost_basis_in_base;
                            const acctUnrealizedPnl = acctMarketValue - acctCostBasis;
                            const acctRealizedPnl = (leaf.totalReturn ?? 0) - ((leaf.marketValue ?? 0) - (leaf.costBasis ?? 0));
                            const acctTotalReturn = acctUnrealizedPnl + acctRealizedPnl * share;
                            const rawPct = acctCostBasis >= MIN_COST_BASIS ? (acctTotalReturn / acctCostBasis) * 100 : 0;
                            const pnlPct = Math.max(-EFFICIENCY_CAP, Math.min(EFFICIENCY_CAP, rawPct));
                            const sizeVal = (() => {
                                switch (sizeBy) {
                                    case 'market_value': return acctMarketValue;
                                    case 'cost_basis': return acctCostBasis;
                                    case 'total_return': return Math.abs(acctTotalReturn);
                                    case 'efficiency':
                                        return acctCostBasis < MIN_COST_BASIS ? 0 : Math.min(Math.abs(acctTotalReturn / acctCostBasis) * 100, EFFICIENCY_CAP);
                                    default: return acctMarketValue;
                                }
                            })();
                            accountGroups[key].push({
                                ...leaf,
                                id: `${leaf.id}@${key}`,
                                value: Math.max(sizeVal, 0.01),
                                pnlPct,
                                costBasis: acctCostBasis,
                                marketValue: acctMarketValue,
                                totalReturn: acctTotalReturn,
                                totalReturnPct: pnlPct,
                                fees: (leaf.fees ?? 0) * share,
                                color: performanceColor(pnlPct),
                            });
                        }
                    } else {
                        const share = 1 / acctIds.length;
                        for (const acctId of acctIds) {
                            const key = accountMap[acctId] || `Account #${acctId}`;
                            if (!accountGroups[key]) accountGroups[key] = [];
                            accountGroups[key].push({
                                ...leaf,
                                id: `${leaf.id}@${key}`,
                                value: (leaf.value ?? 0) * share,
                                costBasis: (leaf.costBasis ?? 0) * share,
                                marketValue: (leaf.marketValue ?? 0) * share,
                                totalReturn: (leaf.totalReturn ?? 0) * share,
                                fees: (leaf.fees ?? 0) * share,
                            });
                        }
                    }
                }
                return Object.entries(accountGroups)
                    .sort(([, a], [, b]) => {
                        const aSum = a.reduce((s, n) => s + (n.value ?? 0), 0);
                        const bSum = b.reduce((s, n) => s + (n.value ?? 0), 0);
                        return bSum - aSum;
                    })
                    .map(([acct, acctItems]) => ({
                        id: acct,
                        children: acctItems.sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
                    }));
            }
        };

        let tree: TreeNode;

        if (hasSplit) {
            // Partition into gains (return >= 0) and losses (return < 0)
            const gains = breakdown.filter(b => itemTotalReturn(b) >= 0);
            const losses = breakdown.filter(b => itemTotalReturn(b) < 0);
            const children: TreeNode[] = [];
            if (gains.length > 0) {
                children.push({
                    id: 'Gains',
                    children: buildGroupedChildren(gains),
                    color: performanceColor(30),
                });
            }
            if (losses.length > 0) {
                children.push({
                    id: 'Losses',
                    children: buildGroupedChildren(losses),
                    color: performanceColor(-30),
                });
            }
            tree = { id: 'Portfolio', children };
        } else {
            tree = {
                id: 'Portfolio',
                children: buildGroupedChildren(breakdown),
            };
        }

        return { fullTree: tree, dataRange: { min, max } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points, groupBy, sizeBy, assetCategoryMap, assetFeeMap, assetAccountMap, accountMap, accountBalances]);

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

    // Build leaf → top-level group mapping for drill-down via leaf click
    const leafToParent = useMemo(() => {
        const map = new Map<string, string>();
        if ((hasSplit || groupBy !== 'flat') && fullTree.children) {
            const mapLeaves = (node: TreeNode, topGroup: string) => {
                if (node.children) {
                    for (const child of node.children) mapLeaves(child, topGroup);
                } else {
                    map.set(node.id, topGroup);
                }
            };
            for (const group of fullTree.children) {
                mapLeaves(group, group.id);
            }
        }
        return map;
    }, [fullTree, groupBy, hasSplit]);

    // Handle node click for drill-down
    const handleNodeClick = (node: any) => {
        if (groupBy === 'flat' && !hasSplit) return;
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

    // symbol → asset_id mapping for asset navigation
    const symbolToAssetId = useMemo(() => {
        const m = new Map<string, number>();
        for (const a of assets) {
            if (a.asset.id != null && a.asset.symbol) {
                m.set(a.asset.symbol, a.asset.id);
            }
        }
        return m;
    }, [assets]);

    // Double-click leaf → navigate to asset detail (escape hatch from treemap to L2)
    const lastClickRef = useRef<{ id: string; time: number } | null>(null);
    const handleNodeClickWithDoubleClick = useCallback((node: any) => {
        const now = Date.now();
        const last = lastClickRef.current;
        if (last && last.id === node.id && now - last.time < 400) {
            // Double-click detected
            lastClickRef.current = null;
            if (onAssetNavigate && !node.data?.children) {
                const assetId = symbolToAssetId.get(node.id);
                if (assetId != null) {
                    onAssetNavigate(assetId, node.id);
                    return;
                }
            }
        }
        lastClickRef.current = { id: node.id, time: now };
        handleNodeClick(node);
    }, [handleNodeClick, onAssetNavigate, symbolToAssetId]);

    // Reset drilldown when groupBy changes
    const handleGroupByChange = (g: GroupBy) => {
        setGroupBy(g);
        setDrilldown(null);
        onDrilldownChange?.({ groupBy: g, drilldown: null });
    };

    // Track mouse position for portal-based tooltip (avoids overflow clipping)
    const handleChartMouseMove = useCallback((e: React.MouseEvent) => {
        mousePosRef.current = { x: e.clientX, y: e.clientY };
    }, []);

    if (!points.length && !isLoading) return null;

    return (
        <div
            className={`bg-white p-4 ${isFullscreen ? 'fixed inset-0 z-[2500] overflow-auto' : 'border border-gray-200'}`}
        >
            {/* Controls row */}
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-gray-700">Portfolio Treemap</h2>
                <div className="flex flex-wrap items-center gap-3">
                    {/* Group by */}
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">Group:</span>
                        {(['flat', 'category', 'account', 'currency'] as const).map(g => (
                            <Badge
                                key={g}
                                colorScheme={groupBy === g ? 'blue' : 'gray'}
                                onClick={() => handleGroupByChange(g)}
                                className={`cursor-pointer px-2 ${groupBy === g ? 'ring-2 ring-blue-400' : ''}`}
                            >
                                {g === 'flat' ? 'Flat' : g === 'category' ? 'Category' : g === 'account' ? 'Account' : 'Currency'}
                            </Badge>
                        ))}
                    </div>
                    {/* Dimension selector — shown when groupBy is 'category' */}
                    {groupBy === 'category' && dimensions.length > 1 && (
                        <div className="flex items-center gap-1">
                            <span className="text-xs text-gray-500">Dim:</span>
                            {dimensions.map(dim => (
                                <Badge
                                    key={dim.id}
                                    colorScheme={selectedDimensionId === dim.id ? 'green' : 'gray'}
                                    onClick={() => { setSelectedDimensionId(dim.id); setDrilldown(null); }}
                                    className={`cursor-pointer px-2 ${selectedDimensionId === dim.id ? 'ring-2 ring-green-400' : ''}`}
                                >
                                    {dim.label}
                                </Badge>
                            ))}
                        </div>
                    )}
                    {/* Size by */}
                    <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">Size:</span>
                        {(Object.keys(SIZE_BY_LABELS) as SizeBy[]).map(s => (
                            <Badge
                                key={s}
                                colorScheme={sizeBy === s ? 'purple' : 'gray'}
                                onClick={() => { setSizeBy(s); setDrilldown(null); }}
                                className={`cursor-pointer px-2 ${sizeBy === s ? 'ring-2 ring-purple-400' : ''}`}
                            >
                                {SIZE_BY_LABELS[s]}
                            </Badge>
                        ))}
                    </div>
                    {/* Fullscreen toggle */}
                    <Button
                        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                        variant="ghost"
                        colorScheme="gray"
                        onClick={() => setIsFullscreen(f => !f)}
                        className="h-7 w-7 p-0"
                    >
                        {isFullscreen ? <FiMinimize2 size={14} /> : <FiMaximize2 size={14} />}
                    </Button>
                </div>
            </div>

            {/* Breadcrumb for drill-down */}
            {drilldown && (
                <div className="mb-2 flex items-center gap-1">
                    <span
                        className="cursor-pointer text-xs font-semibold text-blue-500 hover:underline"
                        onClick={() => { setDrilldown(null); onDrilldownChange?.({ groupBy, drilldown: null }); }}
                    >
                        Portfolio
                    </span>
                    <span className="text-xs text-gray-400">/</span>
                    <span className="text-xs font-semibold text-gray-700">{drilldown}</span>
                </div>
            )}

            {/* Range filter slider */}
            {dataRange.max > dataRange.min && (
                <div className="mb-2 flex items-center gap-3 px-1">
                    <span className="whitespace-nowrap text-[10px] text-gray-500">
                        Range: {formatCompact(dataRange.min + (rangeFilter[0] / 100) * (dataRange.max - dataRange.min), baseCurrency)}
                        {' — '}
                        {formatCompact(dataRange.min + (rangeFilter[1] / 100) * (dataRange.max - dataRange.min), baseCurrency)}
                    </span>
                    <div className="max-w-[300px] flex-1">
                        <DualRangeSlider value={rangeFilter} onChange={setRangeFilter} />
                    </div>
                </div>
            )}

            {isLoading ? (
                <div className={`flex items-center justify-center ${isFullscreen ? 'h-[calc(100vh-140px)]' : 'h-[500px]'}`}>
                    <span className="text-sm text-gray-400">Loading...</span>
                </div>
            ) : (
                <div className={isFullscreen ? 'h-[calc(100vh-140px)]' : 'h-[500px]'} onMouseMove={handleChartMouseMove}>
                    <ResponsiveTreeMap
                        data={treeData}
                        identity="id"
                        value="value"
                        leavesOnly={hasSplit ? !!drilldown : (groupBy === 'flat' || !!drilldown)}
                        innerPadding={2}
                        outerPadding={4}
                        colors={(node: any) => node.data?.color || '#CBD5E0'}
                        borderWidth={1}
                        borderColor={{ from: 'color', modifiers: [['darker', 0.3]] }}
                        label={(node: any) => {
                            const rawId = (node.id as string)?.replace(/@.+$/, '') ?? node.id;
                            const label = truncate(node.data?.fullLabel || rawId);
                            return label;
                        }}
                        labelSkipSize={40}
                        labelTextColor={(node: any) => {
                            const bg = node.color || '#CBD5E0';
                            return getContrastTextColor(bg);
                        }}
                        onClick={handleNodeClickWithDoubleClick}
                        tooltip={(node: any) => {
                            const data = node.node?.data;
                            const value = node.node?.value || 0;
                            const pct = totalValue > 0
                                ? ((value / totalValue) * 100).toFixed(1)
                                : '0.0';
                            const totalReturn = data?.totalReturn ?? 0;
                            const totalReturnPct = data?.totalReturnPct ?? 0;
                            const sym = currencySymbol(baseCurrency);
                            const { x: mx, y: my } = mousePosRef.current;

                            // Build tooltip content
                            let content: React.ReactNode;
                            if (data?.children) {
                                // Group node (has children) — show aggregate name
                                content = (
                                    <div className="min-w-[160px] border border-gray-200 bg-white p-2 shadow-md">
                                        <div className="text-xs font-bold text-gray-700">{node.node?.id}</div>
                                        <div className="text-xs text-gray-600">
                                            {sizeBy === 'efficiency'
                                                ? `ROI: ${Number(value).toFixed(1)}% (${pct}% of total)`
                                                : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${sym} (${pct}%)`
                                            }
                                        </div>
                                        {groupBy !== 'flat' && !drilldown && (
                                            <div className="mt-1 text-[10px] text-blue-500">Click to drill down</div>
                                        )}
                                    </div>
                                );
                            } else {
                                // Leaf node: stacked horizontal bar for cost vs return
                                const cost = Math.abs(data?.costBasis ?? 0);
                                const ret = data?.totalReturn ?? 0;
                                const barTotal = cost + Math.abs(ret);
                                const costPct = barTotal > 0 ? (cost / barTotal) * 100 : 50;
                                const retPct = barTotal > 0 ? (Math.abs(ret) / barTotal) * 100 : 50;
                                const parentGroup = !drilldown && groupBy !== 'flat' ? leafToParent.get(node.node?.id) : null;
                                // Strip @accountName suffix from display ID
                                const displayId = (node.node?.id as string)?.replace(/@.+$/, '') ?? node.node?.id;
                                content = (
                                    <div className="min-w-[220px] border border-gray-200 bg-white p-2 shadow-md">
                                        <div className="text-xs font-bold text-gray-700">
                                            {data?.fullLabel || displayId}
                                        </div>
                                        {data?.fullLabel && data.fullLabel !== displayId && (
                                            <div className="text-xs text-gray-500">{displayId}</div>
                                        )}
                                        <div className="mt-1 text-xs text-gray-600">
                                            {sizeBy === 'efficiency'
                                                ? `ROI: ${Number(value).toFixed(1)}% (${pct}% of total)`
                                                : `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${sym} (${pct}%)`
                                            }
                                        </div>
                                        {data?.marketValue != null && (
                                            <div className="mt-1 border-t border-gray-100 pt-1">
                                                {/* Cost & Return values */}
                                                <div className="mb-0.5 flex justify-between">
                                                    <span className="text-[10px] text-gray-500">Cost: {formatCompact(cost, baseCurrency)}</span>
                                                    <span className={`text-[10px] ${ret >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        Return: {ret >= 0 ? '+' : ''}{formatCompact(ret, baseCurrency)}
                                                    </span>
                                                </div>
                                                {/* Stacked horizontal bar */}
                                                <div className="mb-1 flex h-[10px] overflow-hidden">
                                                    <div className="h-full bg-[#A0AEC0]" style={{ width: `${costPct}%` }} />
                                                    <div className={`h-full ${ret >= 0 ? 'bg-[#48BB78]' : 'bg-[#F56565]'}`} style={{ width: `${retPct}%` }} />
                                                </div>
                                                <div className="flex justify-between">
                                                    <span className="text-xs text-gray-500">
                                                        MV: {formatCompact(data.marketValue, baseCurrency)}
                                                    </span>
                                                    <span className={`text-xs font-bold ${totalReturnPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        ROI: {totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}%
                                                    </span>
                                                </div>
                                                {(data.fees ?? 0) > 0 && (
                                                    <div className="text-[10px] text-orange-500">
                                                        Fees: {formatCompact(data.fees, baseCurrency)}
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                        {parentGroup && (
                                            <div className="mt-1 text-[10px] text-blue-500">Click to drill into {parentGroup}</div>
                                        )}
                                    </div>
                                );
                            }

                            // Render via portal so tooltip is never clipped by parent overflow
                            return createPortal(
                                <div style={{
                                    position: 'fixed',
                                    left: mx + 12,
                                    top: my + 12,
                                    zIndex: 10000,
                                    pointerEvents: 'none',
                                }}>
                                    {content}
                                </div>,
                                document.body,
                            );
                        }}
                        theme={{
                            labels: { text: { fontSize: 11, fontWeight: 600 } },
                        }}
                    />
                </div>
            )}

            {/* Performance color legend */}
            <div className="mt-2 flex justify-center gap-4">
                <div className="flex items-center gap-1">
                    <div className="h-3 w-3" style={{ backgroundColor: performanceColor(-50) }} />
                    <span className="text-xs text-gray-500">Loss</span>
                </div>
                <div className="flex items-center gap-1">
                    <div className="h-3 w-3" style={{ backgroundColor: performanceColor(0) }} />
                    <span className="text-xs text-gray-500">Break-even</span>
                </div>
                <div className="flex items-center gap-1">
                    <div className="h-3 w-3" style={{ backgroundColor: performanceColor(50) }} />
                    <span className="text-xs text-gray-500">Gain</span>
                </div>
            </div>
        </div>
    );
};
