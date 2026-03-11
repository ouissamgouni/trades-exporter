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

import React, { useEffect, useMemo, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Table,
    Text,
} from '@chakra-ui/react';
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
}

// ─── Pattern icon mapping (matches UnitPattern enum values) ─────────────────

const PATTERN_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
    [UnitPattern.SWAP]: { icon: <FiRepeat size={14} />, color: 'orange.500' },
    [UnitPattern.INTERNAL_TRANSFER]: { icon: <FiArrowRightCircle size={14} />, color: 'blue.500' },
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: { icon: <FiLink size={14} />, color: 'cyan.500' },
    [UnitPattern.SPLIT]: { icon: <FiScissors size={14} />, color: 'purple.500' },
    [UnitPattern.FLOW]: { icon: <FiTrendingUp size={14} />, color: 'green.500' },
    [UnitPattern.CUSTOM]: { icon: <FiEdit size={14} />, color: 'teal.500' },
    [UnitPattern.UNKNOWN]: { icon: <FiHelpCircle size={14} />, color: 'gray.400' },
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

    const renderLeg = (leg: typeof unit.legs[0], color: string, icon: string, key: string) => (
        <Flex key={key} align="center" gap={0.5} as="span">
            <Text fontSize="xs" color={`${color}.500`} fontWeight="bold">{icon}</Text>
            <Text fontSize="xs" color={`${color}.600`}>{fmtQty(leg.qty)}</Text>
            {leg.asset?.id ? (
                <AssetBadge asset={{ id: leg.asset.id, symbol: leg.asset.symbol }} size="xs" />
            ) : (
                <Text fontSize="xs" color={`${color}.600`}>{leg.asset?.symbol || '?'}</Text>
            )}
        </Flex>
    );

    return (
        <Flex align="center" gap={0.5} flexWrap="wrap">
            {inflowLegs.map((leg, i) => renderLeg(leg, 'green', '↓', `in-${i}`))}
            {inflowLegs.length > 0 && outflowLegs.length > 0 && (
                <Text fontSize="xs" color="gray.400" px={0.5}>|</Text>
            )}
            {outflowLegs.map((leg, i) => renderLeg(leg, 'red', '↑', `out-${i}`))}
            {(inflowLegs.length > 0 || outflowLegs.length > 0) && feeLegs.length > 0 && (
                <Text fontSize="xs" color="gray.400" px={0.5}>|</Text>
            )}
            {feeLegs.map((leg, i) => renderLeg(leg, 'orange', '💸', `fee-${i}`))}
        </Flex>
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
        return <Text fontSize="2xs" color="gray.400">—</Text>;
    }
    const visible = deltas.slice(0, 3);
    const overflow = deltas.length - 3;

    return (
        <Flex direction="column" gap={0.5}>
            {visible.map(d => {
                const currentBal = assetBalanceMap?.get(d.symbol.toUpperCase());
                return (
                    <Flex key={d.assetId} align="center" gap={1}>
                        <AssetBadge asset={{ id: d.assetId, symbol: d.symbol }} size="xs" />
                        {currentBal != null && (
                            <Text fontSize="2xs" color="gray.600" fontFamily="mono">
                                {fmtQty(currentBal)}
                            </Text>
                        )}
                        <Text
                            fontSize="2xs"
                            color={d.delta >= 0 ? 'green.600' : 'red.600'}
                            fontFamily="mono"
                            fontWeight="semibold"
                        >
                            ({d.delta >= 0 ? '+' : ''}{fmtQty(d.delta)})
                        </Text>
                    </Flex>
                );
            })}
            {overflow > 0 && (
                <Text fontSize="2xs" color="gray.400">+{overflow} more</Text>
            )}
        </Flex>
    );
};

/**
 * Warning badge with tooltip showing warning details on hover.
 */
const WarningBadge: React.FC<{ unit: CalculationUnit }> = ({ unit }) => {
    const warningCount = unit.warnings?.length || 0;
    if (warningCount === 0) {
        return <Text fontSize="2xs" color="gray.400">-</Text>;
    }

    const tooltipContent = (
        <Flex direction="column" gap={1} p={1} maxW="300px">
            {unit.warnings!.slice(0, 5).map((w, i) => (
                <Box key={i}>
                    <Text fontSize="2xs" fontWeight="bold" color="orange.200">{w.warning_type}</Text>
                    <Text fontSize="2xs" color="gray.200">{w.message}</Text>
                </Box>
            ))}
            {warningCount > 5 && (
                <Text fontSize="2xs" color="gray.300">+{warningCount - 5} more…</Text>
            )}
        </Flex>
    );

    return (
        <Tooltip content={tooltipContent} showArrow>
            <Badge size="xs" colorPalette="orange" cursor="default">
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
}) => {
    const pagination = usePagination({ storageKey: 'pnl_activity_feed' });

    const { data: rawUnits, total, isLoading, error, refetch } = useLazyPaginatedQuery<ProcessedUnitResponse>({
        endpoint: `/pnl/versions/${versionId}/units`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: { ...txFilterParams },
    });

    // Map raw API response to frontend CalculationUnit (timestamp → date, etc.)
    const units = useMemo(
        () => rawUnits.map(mapProcessedUnitToCalculationUnit),
        [rawUnits],
    );

    useEffect(() => {
        pagination.setTotal(total);
    }, [total]);

    // ── Client-side filters ─────────────────────────────────────────────────
    const [typeFilter, setTypeFilter] = useState<string>('all');
    const [hasWarnings, setHasWarnings] = useState(false);
    const [hasRealizedPnl, setHasRealizedPnl] = useState(false);
    const [unitIdSearch, setUnitIdSearch] = useState('');

    // Distinct types in current page
    const availableTypes = useMemo(() => {
        const set = new Set(units.map(u => u.pattern || 'unknown'));
        return Array.from(set).sort();
    }, [units]);

    // Apply client-side filters
    const filteredUnits = useMemo(() => {
        return units.filter(u => {
            if (typeFilter !== 'all' && (u.pattern || 'unknown') !== typeFilter) return false;
            if (hasWarnings && (!u.warnings || u.warnings.length === 0)) return false;
            if (hasRealizedPnl && !(u.realized_pnl_in_base && u.realized_pnl_in_base !== 0)) return false;
            if (unitIdSearch && !u.unit_id.toString().includes(unitIdSearch.trim())) return false;
            return true;
        });
    }, [units, typeFilter, hasWarnings, hasRealizedPnl, unitIdSearch]);

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

    if (isLoading) return <TabLoadingState message="Loading activity feed..." />;
    if (error) return <TabErrorState error={error} onRetry={refetch} />;
    if (units.length === 0) {
        return (
            <TabEmptyState
                title="No Activity"
                description="Calculation units will appear here after P&L calculation."
            />
        );
    }

    const hasAnyFilter = typeFilter !== 'all' || hasWarnings || hasRealizedPnl || !!unitIdSearch;

    return (
        <Box>
            {/* ── Filter bar ────────────────────────────────────────────── */}
            <Flex gap={2} mb={3} wrap="wrap" align="center">
                {/* Unit ID search */}
                <Flex align="center" gap={1} bg="gray.50" borderRadius="md" px={2} py={0.5}>
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text"
                        placeholder="Unit ID"
                        value={unitIdSearch}
                        onChange={(e) => setUnitIdSearch(e.target.value)}
                        style={{ width: 70, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </Flex>
                {/* Type filter buttons */}
                <Flex gap={1} align="center">
                    <Button
                        size="2xs"
                        variant={typeFilter === 'all' ? 'solid' : 'outline'}
                        onClick={() => setTypeFilter('all')}
                    >
                        All
                    </Button>
                    {availableTypes.map(type => {
                        const pi = getPatternIcon(type);
                        return (
                            <Tooltip key={type} content={getUnitPatternLabel(type)} showArrow>
                                <Button
                                    size="2xs"
                                    variant={typeFilter === type ? 'solid' : 'outline'}
                                    onClick={() => setTypeFilter(type)}
                                >
                                    <Box color={typeFilter === type ? undefined : pi.color}>{pi.icon}</Box>
                                </Button>
                            </Tooltip>
                        );
                    })}
                </Flex>
                {/* Toggle filters */}
                <Flex gap={1} align="center" ml={2}>
                    <Button
                        size="2xs"
                        variant={hasWarnings ? 'solid' : 'outline'}
                        colorPalette={hasWarnings ? 'orange' : 'gray'}
                        onClick={() => setHasWarnings(v => !v)}
                    >
                        <FiAlertTriangle size={12} />
                        <Text ml={1}>Warnings</Text>
                    </Button>
                    <Button
                        size="2xs"
                        variant={hasRealizedPnl ? 'solid' : 'outline'}
                        colorPalette={hasRealizedPnl ? 'green' : 'gray'}
                        onClick={() => setHasRealizedPnl(v => !v)}
                    >
                        💰
                        <Text ml={1}>Has P&L</Text>
                    </Button>
                </Flex>
                {/* Filter count */}
                {hasAnyFilter && (
                    <Text fontSize="2xs" color="gray.500" ml={2}>
                        {filteredUnits.length} of {units.length}
                    </Text>
                )}
            </Flex>

            {/* ── Table ─────────────────────────────────────────────────── */}
            <Box overflowX="auto" style={{ fontSize: '8px' }}>
                <Table.Root size="sm">
                    <Table.Header>
                        <Table.Row>
                            <Table.ColumnHeader width="32px" textAlign="center" />
                            <Table.ColumnHeader width="60px" textAlign="right">ID</Table.ColumnHeader>
                            <Table.ColumnHeader width="80px">Date</Table.ColumnHeader>
                            <Table.ColumnHeader>Operation</Table.ColumnHeader>
                            <Table.ColumnHeader width="160px">Balance</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="90px">P&L</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="right" width="80px">Fees</Table.ColumnHeader>
                            <Table.ColumnHeader textAlign="center" width="40px">⚠</Table.ColumnHeader>
                        </Table.Row>
                    </Table.Header>
                    <Table.Body>
                        {filteredUnits.map((unit: CalculationUnit) => {
                            const txIds = txIdsByUnit.get(unit.unit_id) || [];
                            const isExpanded = expandedUnits.has(unit.unit_id);
                            const pi = getPatternIcon(unit.pattern);

                            return (
                                <React.Fragment key={unit.unit_id}>
                                    <Table.Row
                                        onClick={() => toggleExpand(unit.unit_id)}
                                        style={{ cursor: 'pointer' }}
                                        _hover={{ bg: 'gray.50' }}
                                        bg={isExpanded ? 'blue.50' : undefined}
                                    >
                                        {/* Type icon */}
                                        <Table.Cell textAlign="center">
                                            <Tooltip content={`${getUnitPatternLabel(unit.pattern || 'unknown')}${unit.pattern && unit.pattern !== 'unknown' ? ` (${unit.pattern})` : ''}`} showArrow>
                                                <Box as="span" color={pi.color}>{pi.icon}</Box>
                                            </Tooltip>
                                        </Table.Cell>

                                        {/* Unit ID */}
                                        <Table.Cell textAlign="right">
                                            <Text fontSize="2xs" fontFamily="mono" color="gray.500">{unit.unit_id}</Text>
                                        </Table.Cell>

                                        {/* Date */}
                                        <Table.Cell fontSize="2xs">
                                            {formatDateLocale(unit.date)}
                                        </Table.Cell>

                                        {/* Operation + compact tx IDs — single line, flex-wrap */}
                                        <Table.Cell>
                                            <Flex align="center" gap={1} flexWrap="wrap">
                                                <OperationLabel unit={unit} />
                                                {txIds.length > 0 && (
                                                    <>
                                                        <Text fontSize="2xs" color="gray.300">·</Text>
                                                        {txIds.slice(0, 3).map(id => (
                                                            <Badge
                                                                key={id}
                                                                size="xs"
                                                                variant="subtle"
                                                                colorPalette="gray"
                                                                cursor="pointer"
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    onTransactionClick?.(id);
                                                                }}
                                                            >
                                                                #{id}
                                                            </Badge>
                                                        ))}
                                                        {txIds.length > 3 && (
                                                            <Text fontSize="2xs" color="gray.400">
                                                                +{txIds.length - 3}
                                                            </Text>
                                                        )}
                                                    </>
                                                )}
                                            </Flex>
                                        </Table.Cell>

                                        {/* Net Δ — per-asset net change */}
                                        <Table.Cell>
                                            <NetDeltaColumn unit={unit} assetBalanceMap={assetBalanceMap} />
                                        </Table.Cell>

                                        {/* P&L */}
                                        <Table.Cell textAlign="right">
                                            <Text
                                                fontSize="xs"
                                                color={(unit.realized_pnl_in_base || 0) >= 0 ? 'green.600' : 'red.600'}
                                                fontWeight="medium"
                                            >
                                                <ValueDisplay value={unit.realized_pnl_in_base || 0} currency={baseCurrency} />
                                            </Text>
                                        </Table.Cell>

                                        {/* Fees */}
                                        <Table.Cell textAlign="right">
                                            {unit.has_fees && unit.total_fees_in_base ? (
                                                <Text fontSize="xs" color="orange.600">
                                                    <ValueDisplay value={unit.total_fees_in_base} currency={baseCurrency} />
                                                </Text>
                                            ) : (
                                                <Text fontSize="2xs" color="gray.400">-</Text>
                                            )}
                                        </Table.Cell>

                                        {/* Warnings — tooltip on hover */}
                                        <Table.Cell textAlign="center">
                                            <WarningBadge unit={unit} />
                                        </Table.Cell>
                                    </Table.Row>

                                    {/* Expanded detail row */}
                                    {isExpanded && (
                                        <Table.Row>
                                            <Table.Cell colSpan={COL_COUNT} style={{ background: '#f9fafb', padding: 0 }}>
                                                <UnitDetailRow
                                                    unit={unit}
                                                    baseCurrency={baseCurrency}
                                                    costLots={[]}
                                                    versionId={versionId}
                                                    onTransactionClick={onTransactionClick}
                                                />
                                            </Table.Cell>
                                        </Table.Row>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </Table.Body>
                </Table.Root>
            </Box>

            <TablePagination
                page={pagination.page}
                pageSize={pagination.pageSize}
                total={total}
                onPageChange={pagination.setPage}
                onPageSizeChange={pagination.setPageSize}
            />
        </Box>
    );
};
