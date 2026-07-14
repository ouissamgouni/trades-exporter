/**
 * ActivityFeed – Compact chronological stream of calculation units.
 *
 * Primary tab view for the PnL audit — replaces the "Calculation Units" tab.
 * Each row is a condensed unit showing:
 *   Type icon | Date | Operation + TX IDs (inline) | Balance After (global + delta, tooltip per-account) | P&L | Fees | Warnings (tooltip)
 *
 * Features:
 *   - Expandable rows (UnitDetailRow) on click
 *   - Client-side filters: type, has warnings, has realized P&L
 *   - Rounded quantities in Operation and Balance columns
 *   - Tooltips on warnings and balance columns
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button } from '../ui/primitives';
import { FiAlertTriangle, FiRepeat, FiArrowRightCircle, FiScissors, FiTrendingUp, FiLink, FiEdit, FiHelpCircle, FiSearch } from 'react-icons/fi';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { TablePagination } from '../TablePagination';
import { AssetBadge } from '../AssetBadge';
import { ValueDisplay } from '../ValueDisplay';
import { Tooltip } from '../ui/tooltip';
import {
    TabLoadingState,
    TabErrorState,
    TabEmptyState,
} from './AuditTabWrappers';
import {
    CalculationUnit,
    ProcessedUnitResponse,
    mapProcessedUnitToCalculationUnit,
} from './types';
import { UnitDetailRow } from './DataExplorerPanel';
import { formatDateLocale } from '../../utils/dateUtils';
import { formatQuantityCompact } from '../../utils/numberUtils';
import { UnitPattern, getUnitPatternLabel } from '../../enums';
import { API_URL } from '../../types';

const fmtQty = formatQuantityCompact;

// ─── Props ──────────────────────────────────────────────────────────────────

export interface ActivityFeedProps {
    versionId: number;
    baseCurrency: string;
    /** Transaction-level filter params forwarded to the units endpoint. */
    txFilterParams?: Record<string, string | number | boolean | undefined>;
    /** Called when user clicks a transaction ID badge. */
    onTransactionClick?: (txId: number) => void;
    /** Called when user clicks an asset badge (e.g. to set assetId filter). */
    onAssetClick?: (assetId: number) => void;
    /** Current P&L balance per asset: symbol (uppercase) → total quantity */
    assetBalanceMap?: Map<string, number>;
    /** Called when user clicks a unit row to navigate / inspect. */
    onUnitClick?: (unitId: number) => void;
}

// ─── Pattern icon mapping (matches UnitPattern enum values) ─────────────────

const PATTERN_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
    [UnitPattern.SWAP]: { icon: <FiRepeat size={14} />, color: 'text-orange-500' },
    [UnitPattern.INTERNAL_TRANSFER]: { icon: <FiArrowRightCircle size={14} />, color: 'text-blue-500' },
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: { icon: <FiLink size={14} />, color: 'text-cyan-500' },
    [UnitPattern.SPLIT]: { icon: <FiScissors size={14} />, color: 'text-purple-500' },
    [UnitPattern.FLOW]: { icon: <FiTrendingUp size={14} />, color: 'text-green-500' },
    [UnitPattern.CUSTOM]: { icon: <FiEdit size={14} />, color: 'text-teal-500' },
    [UnitPattern.UNKNOWN]: { icon: <FiHelpCircle size={14} />, color: 'text-gray-400' },
};

const getPatternIcon = (pattern: string | null | undefined) =>
    PATTERN_ICONS[pattern || 'unknown'] || PATTERN_ICONS[UnitPattern.UNKNOWN];

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Render compact operation label from unit legs (rounded quantities).
 */
const OperationLabel: React.FC<{ unit: CalculationUnit }> = ({ unit }) => {
    const inflowLegs = unit.legs.filter(l => l.leg_type === 'inflow');
    const outflowLegs = unit.legs.filter(l => l.leg_type === 'outflow');
    const feeLegs = unit.legs.filter(l => l.leg_type === 'fee');

    const LEG_COLORS: Record<string, { icon: string; text: string }> = {
        green: { icon: 'text-green-500', text: 'text-green-600' },
        red: { icon: 'text-red-500', text: 'text-red-600' },
        orange: { icon: 'text-orange-500', text: 'text-orange-600' },
    };

    const renderLeg = (leg: typeof unit.legs[0], color: 'green' | 'red' | 'orange', icon: string, key: string) => (
        <span key={key} className="inline-flex items-center gap-0.5">
            <span className={`text-xs font-bold ${LEG_COLORS[color].icon}`}>{icon}</span>
            <span className={`text-xs ${LEG_COLORS[color].text}`}>{fmtQty(leg.qty)}</span>
            {leg.asset?.id ? (
                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
            ) : (
                <span className={`text-xs ${LEG_COLORS[color].text}`}>{leg.asset?.symbol || '?'}</span>
            )}
        </span>
    );

    return (
        <div className="flex flex-wrap items-center gap-0.5">
            {inflowLegs.map((leg, i) => renderLeg(leg, 'green', '↓', `in-${i}`))}
            {inflowLegs.length > 0 && outflowLegs.length > 0 && (
                <span className="px-0.5 text-xs text-gray-400">|</span>
            )}
            {outflowLegs.map((leg, i) => renderLeg(leg, 'red', '↑', `out-${i}`))}
            {(inflowLegs.length > 0 || outflowLegs.length > 0) && feeLegs.length > 0 && (
                <span className="px-0.5 text-xs text-gray-400">|</span>
            )}
            {feeLegs.map((leg, i) => renderLeg(leg, 'orange', '💸', `fee-${i}`))}
        </div>
    );
};

/**
 * Compute net delta per asset from unit legs.
 * Returns array of { assetId, symbol, delta } entries.
 */
function computeDeltas(unit: CalculationUnit): Array<{ assetId: number; symbol: string; delta: number }> {
    const map = new Map<number, { symbol: string; delta: number }>();
    for (const leg of unit.legs) {
        const id = leg.asset?.id;
        if (id == null) continue;
        const current = map.get(id) || { symbol: leg.asset?.symbol ?? '', delta: 0 };
        if (leg.leg_type === 'inflow') {
            map.set(id, { symbol: current.symbol, delta: current.delta + leg.qty });
        } else {
            map.set(id, { symbol: current.symbol, delta: current.delta - Math.abs(leg.qty) });
        }
    }
    return Array.from(map.entries()).map(([assetId, v]) => ({ assetId, symbol: v.symbol, delta: v.delta }));
}

/**
 * Net Δ column — per-asset net change from this unit's legs, plus current balance.
 */
const NetDeltaColumn: React.FC<{ unit: CalculationUnit; assetBalanceMap?: Map<string, number> }> = ({ unit, assetBalanceMap }) => {
    const deltas = computeDeltas(unit);
    if (deltas.length === 0) {
        return <span className="text-[10px] text-gray-400">—</span>;
    }
    const visible = deltas.slice(0, 3);
    const overflow = deltas.length - 3;

    return (
        <div className="flex flex-col gap-0.5">
            {visible.map(d => {
                const currentBal = assetBalanceMap?.get(d.symbol.toUpperCase());
                return (
                    <div key={d.assetId} className="flex items-center gap-1">
                        <AssetBadge asset={{ id: d.assetId, symbol: d.symbol }} size="xs" />
                        {currentBal != null && (
                            <span className="font-mono text-[10px] text-gray-600">
                                {fmtQty(currentBal)}
                            </span>
                        )}
                        <span
                            className={`font-mono text-[10px] font-semibold ${d.delta >= 0 ? 'text-green-600' : 'text-red-600'}`}
                        >
                            ({d.delta >= 0 ? '+' : ''}{fmtQty(d.delta)})
                        </span>
                    </div>
                );
            })}
            {overflow > 0 && (
                <span className="text-[10px] text-gray-400">+{overflow} more</span>
            )}
        </div>
    );
};

/**
 * Warning badge with tooltip showing warning details on hover.
 */
const WarningBadge: React.FC<{ unit: CalculationUnit }> = ({ unit }) => {
    const warningCount = unit.warnings?.length || 0;
    if (warningCount === 0) {
        return <span className="text-[10px] text-gray-400">-</span>;
    }

    const tooltipContent = (
        <div className="flex max-w-[300px] flex-col gap-1 p-1">
            {unit.warnings!.slice(0, 5).map((w, i) => (
                <div key={i}>
                    <div className="text-[10px] font-bold text-orange-200">{w.warning_type}</div>
                    <div className="text-[10px] text-gray-200">{w.message}</div>
                </div>
            ))}
            {warningCount > 5 && (
                <span className="text-[10px] text-gray-300">+{warningCount - 5} more…</span>
            )}
        </div>
    );

    return (
        <Tooltip content={tooltipContent} showArrow>
            <Badge colorScheme="orange" className="cursor-default">
                <FiAlertTriangle style={{ marginRight: 2 }} />
                {warningCount}
            </Badge>
        </Tooltip>
    );
};

// ─── Component ──────────────────────────────────────────────────────────────

export const ActivityFeed: React.FC<ActivityFeedProps> = ({
    versionId,
    baseCurrency,
    txFilterParams,
    onTransactionClick,
    onAssetClick,
    assetBalanceMap,
    onUnitClick,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_activity_feed' });

    // ── Server-side filter state ────────────────────────────────────────────
    const [typeFilter, setTypeFilter] = useState<string>('all');
    const [warningTypes, setWarningTypes] = useState<string[]>([]);
    const [hasRealizedPnl, setHasRealizedPnl] = useState(false);
    const [hasFees, setHasFees] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    // Debounce search input
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // Build server params from filter state
    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = {
            ...txFilterParams,
        };
        if (typeFilter !== 'all') params.unit_pattern = typeFilter;
        if (warningTypes.length > 0) {
            params.warning_type = warningTypes.join(',');
            params.has_warnings = true;
        }
        if (hasRealizedPnl) params.has_realized_pnl = true;
        if (hasFees) params.has_fees = true;
        if (debouncedSearch) params.search = debouncedSearch;
        return params;
    }, [txFilterParams, typeFilter, warningTypes, hasRealizedPnl, hasFees, debouncedSearch]);

    // Reset to page 1 when filters change
    const prevParamsRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevParamsRef.current !== serverParams) {
            pagination.setPage(1);
            prevParamsRef.current = serverParams;
        }
    }, [serverParams]);

    const { data: rawUnits, total, isLoading, error, refetch } = useLazyPaginatedQuery<ProcessedUnitResponse>({
        endpoint: `/pnl/versions/${versionId}/units`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: serverParams,
    });

    // Map raw API response to frontend CalculationUnit
    const units = useMemo(
        () => rawUnits.map(mapProcessedUnitToCalculationUnit),
        [rawUnits],
    );

    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    // ── Filter options from backend ─────────────────────────────────────────
    interface FilterOption { value: string; label?: string; count: number }
    interface UnitsFilterOptions {
        patterns: FilterOption[];
        total_units: number;
        has_warnings_count: number;
        has_realized_pnl_count: number;
        has_fees_count: number;
        warning_types: FilterOption[];
    }
    const [filterOptions, setFilterOptions] = useState<UnitsFilterOptions | null>(null);

    useEffect(() => {
        const qs = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== '') qs.set(k, String(v));
            });
        }
        fetch(`${API_URL}/pnl/versions/${versionId}/units/filter-options?${qs}`)
            .then(r => r.json())
            .then(setFilterOptions)
            .catch(() => { });
    }, [versionId, txFilterParams]);

    // Available pattern types for filter buttons
    const availableTypes = useMemo(() => {
        if (filterOptions?.patterns) {
            return filterOptions.patterns
                .filter(p => p.count > 0)
                .map(p => ({ value: p.value, count: p.count }));
        }
        // Fallback: derive from current page
        const set = new Set(units.map(u => u.pattern || 'unknown'));
        return Array.from(set).sort().map(v => ({ value: v, count: 0 }));
    }, [filterOptions, units]);

    // ── Expandable row state ────────────────────────────────────────────────
    const [expandedUnits, setExpandedUnits] = useState<Set<number>>(new Set());

    const toggleExpand = (unitId: number) => {
        setExpandedUnits(prev => {
            const next = new Set(prev);
            if (next.has(unitId)) {
                next.delete(unitId);
            } else {
                next.add(unitId);
            }
            return next;
        });
    };

    // ── Transaction ID list per unit (for compact badge display) ────────────
    const txIdsByUnit = useMemo(() => {
        const map = new Map<number, number[]>();
        for (const u of units) {
            map.set(u.unit_id, u.transactions.map((t: any) => t.id));
        }
        return map;
    }, [units]);

    // Total columns (used for expanded row colSpan)
    const COL_COUNT = 8;

    const hasAnyFilter = typeFilter !== 'all' || warningTypes.length > 0 || hasRealizedPnl || hasFees || !!debouncedSearch;

    if (isLoading) return <TabLoadingState message="Loading activity feed..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (units.length === 0 && !hasAnyFilter) {
        return (
            <TabEmptyState
                title="No Activity"
                description="Calculation units will appear here after P&L calculation."
            />
        );
    }

    const clearFilters = () => {
        setTypeFilter('all');
        setWarningTypes([]);
        setHasRealizedPnl(false);
        setHasFees(false);
        setSearchInput('');
    };

    return (
        <div>
            {/* ── Filter bar ────────────────────────────────────────────── */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
                {/* Search */}
                <div className="flex items-center gap-1 bg-gray-50 px-2 py-0.5">
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text"
                        placeholder="Search ID / label"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        style={{ width: 100, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </div>
                {/* Type filter buttons */}
                <div className="flex items-center gap-1">
                    <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        variant={typeFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTypeFilter('all')}
                    >
                        All
                    </Button>
                    {availableTypes.map(({ value: type, count }) => {
                        const pi = getPatternIcon(type);
                        return (
                            <Tooltip key={type} content={`${getUnitPatternLabel(type)} (${count})`} showArrow>
                                <Button
                                    size="sm"
                                    className="h-6 px-2 text-[10px]"
                                    variant={typeFilter === type ? 'solid' : 'outline'}
                                    onClick={() => setTypeFilter(typeFilter === type ? 'all' : type)}
                                >
                                    <span className={typeFilter === type ? undefined : pi.color}>{pi.icon}</span>
                                </Button>
                            </Tooltip>
                        );
                    })}
                </div>
                {/* Toggle filters */}
                <div className="ml-2 flex items-center gap-1">
                    {/* Warning type toggle buttons */}
                    {(filterOptions?.warning_types ?? []).map(wt => {
                        const active = warningTypes.includes(wt.value);
                        return (
                            <Button
                                key={wt.value}
                                size="sm"
                                className={`h-6 px-2 text-[10px] ${active ? 'bg-orange-500 text-white hover:bg-orange-600 border-orange-500' : ''}`}
                                variant={active ? 'solid' : 'outline'}
                                colorScheme="gray"
                                onClick={() => {
                                    setWarningTypes(prev =>
                                        prev.includes(wt.value)
                                            ? prev.filter(t => t !== wt.value)
                                            : [...prev, wt.value]
                                    );
                                }}
                            >
                                <FiAlertTriangle size={10} />
                                <span className="ml-1">
                                    {(wt.label || wt.value).replace(/_/g, ' ')} ({wt.count})
                                </span>
                            </Button>
                        );
                    })}
                    {/* Fallback: show generic warnings button while filter options load */}
                    {!filterOptions && (
                        <Button size="sm" className="h-6 px-2 text-[10px]" variant="outline" colorScheme="gray" disabled>
                            <FiAlertTriangle size={10} />
                            <span className="ml-1">Warnings</span>
                        </Button>
                    )}
                    <Button
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        variant={hasRealizedPnl ? 'solid' : 'outline'}
                        colorScheme={hasRealizedPnl ? 'green' : 'gray'}
                        onClick={() => setHasRealizedPnl(v => !v)}
                    >
                        💰
                        <span className="ml-1">Has P&L{filterOptions ? ` (${filterOptions.has_realized_pnl_count})` : ''}</span>
                    </Button>
                    <Button
                        size="sm"
                        className={`h-6 px-2 text-[10px] ${hasFees ? 'bg-yellow-400 text-yellow-900 hover:bg-yellow-500 border-yellow-400' : ''}`}
                        variant={hasFees ? 'solid' : 'outline'}
                        colorScheme="gray"
                        onClick={() => setHasFees(v => !v)}
                    >
                        💸
                        <span className="ml-1">Has Fees{filterOptions ? ` (${filterOptions.has_fees_count})` : ''}</span>
                    </Button>
                </div>
                {/* Active filter indicator */}
                {hasAnyFilter && (
                    <div className="ml-2 flex items-center gap-1">
                        <span className="text-[10px] text-gray-500">
                            {total} result{total !== 1 ? 's' : ''}
                        </span>
                        <Button size="sm" className="h-6 px-2 text-[10px]" variant="ghost" onClick={clearFilters}>
                            Clear
                        </Button>
                    </div>
                )}
            </div>

            {/* ── Table ─────────────────────────────────────────────────── */}
            <div className="overflow-x-auto" style={{ fontSize: '8px' }}>
                <table className="w-full text-sm">
                    <thead>
                        <tr>
                            <th className="w-8 text-center" />
                            <th className="w-[60px] text-right">ID</th>
                            <th className="w-20 text-left">Date</th>
                            <th className="text-left">Operation</th>
                            <th className="w-40 text-left">Balance</th>
                            <th className="w-[90px] text-right">P&L</th>
                            <th className="w-20 text-right">Fees</th>
                            <th className="w-10 text-center">⚠</th>
                        </tr>
                    </thead>
                    <tbody>
                        {units.map((unit: CalculationUnit) => {
                            const txIds = txIdsByUnit.get(unit.unit_id) || [];
                            const isExpanded = expandedUnits.has(unit.unit_id);
                            const pi = getPatternIcon(unit.pattern);

                            return (
                                <React.Fragment key={unit.unit_id}>
                                    <tr
                                        onClick={() => toggleExpand(unit.unit_id)}
                                        className={`cursor-pointer hover:bg-gray-50 ${isExpanded ? 'bg-blue-50' : ''}`}
                                    >
                                        {/* Type icon */}
                                        <td className="text-center">
                                            <Tooltip content={`${getUnitPatternLabel(unit.pattern || 'unknown')}${unit.pattern && unit.pattern !== 'unknown' ? ` (${unit.pattern})` : ''}`} showArrow>
                                                <span className={pi.color}>{pi.icon}</span>
                                            </Tooltip>
                                        </td>

                                        {/* Unit ID */}
                                        <td className="text-right">
                                            <span className="font-mono text-[10px] text-gray-500">{unit.unit_id}</span>
                                        </td>

                                        {/* Date */}
                                        <td className="text-[10px]">
                                            {formatDateLocale(unit.date)}
                                        </td>

                                        {/* Operation + compact tx IDs — single line, flex-wrap */}
                                        <td>
                                            <div className="flex flex-wrap items-center gap-1">
                                                <OperationLabel unit={unit} />
                                                {txIds.length > 0 && (
                                                    <>
                                                        <span className="text-[10px] text-gray-300">·</span>
                                                        {txIds.slice(0, 3).map(id => (
                                                            <Badge
                                                                key={id}
                                                                colorScheme="gray"
                                                                className="cursor-pointer"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onTransactionClick?.(id);
                                                                }}
                                                            >
                                                                #{id}
                                                            </Badge>
                                                        ))}
                                                        {txIds.length > 3 && (
                                                            <span className="text-[10px] text-gray-400">
                                                                +{txIds.length - 3}
                                                            </span>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        </td>

                                        {/* Net Δ — per-asset net change */}
                                        <td>
                                            <NetDeltaColumn unit={unit} assetBalanceMap={assetBalanceMap} />
                                        </td>

                                        {/* P&L */}
                                        <td className="text-right">
                                            <span
                                                className={`text-xs font-medium ${(unit.realized_pnl_in_base || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                            >
                                                <ValueDisplay value={unit.realized_pnl_in_base || 0} currency={baseCurrency} />
                                            </span>
                                        </td>

                                        {/* Fees */}
                                        <td className="text-right">
                                            {unit.has_fees && unit.total_fees_in_base ? (
                                                <span className="text-xs text-orange-600">
                                                    <ValueDisplay value={unit.total_fees_in_base} currency={baseCurrency} />
                                                </span>
                                            ) : (
                                                <span className="text-[10px] text-gray-400">-</span>
                                            )}
                                        </td>

                                        {/* Warnings — tooltip on hover */}
                                        <td className="text-center">
                                            <WarningBadge unit={unit} />
                                        </td>
                                    </tr>

                                    {/* Expanded detail row */}
                                    {isExpanded && (
                                        <tr>
                                            <td colSpan={COL_COUNT} style={{ background: '#f9fafb', padding: 0 }}>
                                                <UnitDetailRow
                                                    unit={unit}
                                                    baseCurrency={baseCurrency}
                                                    costLots={[]}
                                                    versionId={versionId}
                                                    onTransactionClick={onTransactionClick}
                                                />
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </div>
    );
};
