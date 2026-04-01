/**
 * PnLAuditTransactionsView — Transaction-level view for P&L audit.
 *
 * Shows individual transactions as rows (via TransactionsTable) enriched
 * with P&L data (unit info, realized P&L, fees, cost lot events).
 *
 * Uses the TransactionsTable plugin architecture:
 *   - customApiUrl: points to /pnl/versions/{id}/enriched-transactions
 *   - additionalColumns: Unit, P&L, Fees, Events
 *   - PnL filter bar above the table (pattern, has_pnl, has_fees, warnings)
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    Flex,
    Text,
} from '@chakra-ui/react';
import {
    FiRepeat,
    FiArrowRightCircle,
    FiScissors,
    FiTrendingUp,
    FiLink,
    FiEdit,
    FiHelpCircle,
    FiSearch,
} from 'react-icons/fi';
import { TransactionsTable } from '../TransactionsTable';
import { UnitDetailSlidePanel } from './UnitDetailSlidePanel';
import { SlidePanel } from './SlidePanel';
import { CostLotEventsTable, EVENT_TABLE_PRESETS } from './CostLotEventsTable';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL, Transaction } from '../../types';
import { UnitPattern, getUnitPatternLabel } from '../../enums';
import type { ColumnPlugin } from '../tables/types';
import type { EnrichedTransaction, EnrichedTransactionsFilterOptions } from './types';

// ─── Pattern icon mapping (shared with ActivityFeed) ─────────────────────────

const PATTERN_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
    [UnitPattern.SWAP]: { icon: <FiRepeat size={13} />, color: 'orange.500' },
    [UnitPattern.INTERNAL_TRANSFER]: { icon: <FiArrowRightCircle size={13} />, color: 'blue.500' },
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: { icon: <FiLink size={13} />, color: 'cyan.500' },
    [UnitPattern.SPLIT]: { icon: <FiScissors size={13} />, color: 'purple.500' },
    [UnitPattern.FLOW]: { icon: <FiTrendingUp size={13} />, color: 'green.500' },
    [UnitPattern.CUSTOM]: { icon: <FiEdit size={13} />, color: 'teal.500' },
    [UnitPattern.UNKNOWN]: { icon: <FiHelpCircle size={13} />, color: 'gray.400' },
};

const PATTERN_BORDER_COLORS: Record<string, string> = {
    [UnitPattern.SWAP]: 'orange.400',
    [UnitPattern.INTERNAL_TRANSFER]: 'blue.400',
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: 'cyan.400',
    [UnitPattern.SPLIT]: 'purple.400',
    [UnitPattern.FLOW]: 'green.400',
    [UnitPattern.CUSTOM]: 'teal.400',
    [UnitPattern.UNKNOWN]: 'gray.300',
};

const getPatternIcon = (pattern: string | null | undefined) =>
    PATTERN_ICONS[pattern || 'unknown'] || PATTERN_ICONS[UnitPattern.UNKNOWN];

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PnLAuditTransactionsViewProps {
    versionId: number;
    baseCurrency: string;
    txFilterParams?: Record<string, string | number | boolean | undefined>;
    onTransactionClick?: (txId: number) => void;
}

export const PnLAuditTransactionsView: React.FC<PnLAuditTransactionsViewProps> = ({
    versionId,
    baseCurrency,
    txFilterParams,
    onTransactionClick,
}) => {
    // ── PnL-specific filter state ───────────────────────────────────────────
    const [typeFilter, setTypeFilter] = useState<string | null>(null);
    const [hasRealizedPnl, setHasRealizedPnl] = useState<boolean | null>(null);
    const [hasFees, setHasFees] = useState<boolean | null>(null);
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    // Filter options from backend
    const [filterOptions, setFilterOptions] = useState<EnrichedTransactionsFilterOptions | null>(null);

    // Unit detail slide panel
    const [slidePanelUnitId, setSlidePanelUnitId] = useState<number | null>(null);

    // Events slide panel
    const [eventsPanelUnitId, setEventsPanelUnitId] = useState<number | null>(null);

    // ── Debounce search ─────────────────────────────────────────────────────
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // ── Fetch filter options ────────────────────────────────────────────────
    useEffect(() => {
        const params = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
            });
        }
        const qs = params.toString();
        const url = `${API_URL}/pnl/versions/${versionId}/enriched-transactions/filter-options${qs ? `?${qs}` : ''}`;

        fetch(url)
            .then(res => res.ok ? res.json() : null)
            .then(data => { if (data) setFilterOptions(data); })
            .catch(() => { /* ignore */ });
    }, [versionId, txFilterParams]);

    // ── Build customApiUrl with PnL filters baked in ────────────────────────
    const customApiUrl = useMemo(() => {
        const params = new URLSearchParams();

        // PnL-specific filters
        if (typeFilter) params.set('unit_pattern', typeFilter);
        if (hasRealizedPnl !== null) params.set('has_realized_pnl', String(hasRealizedPnl));
        if (hasFees !== null) params.set('has_fees', String(hasFees));
        if (debouncedSearch) params.set('search', debouncedSearch);

        // Context filters from parent
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
            });
        }

        const qs = params.toString();
        return `${API_URL}/pnl/versions/${versionId}/enriched-transactions${qs ? `?${qs}` : ''}`;
    }, [versionId, typeFilter, hasRealizedPnl, hasFees, debouncedSearch, txFilterParams]);

    // ── Additional columns (plugin architecture) ────────────────────────────
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => [
        {
            id: 'pnl-unit',
            header: 'Unit',
            width: '80px',
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                if (!etx.unit_id) return <Text fontSize="xs" color="gray.400">-</Text>;
                const { icon, color } = getPatternIcon(etx.unit_pattern);
                return (
                    <Tooltip content={etx.unit_label || getUnitPatternLabel(etx.unit_pattern || 'unknown')}>
                        <Flex
                            align="center"
                            gap={1}
                            cursor="pointer"
                            onClick={(e) => { e.stopPropagation(); setSlidePanelUnitId(etx.unit_id!); }}
                        >
                            <Box color={color}>{icon}</Box>
                            <Text fontSize="xs" color="gray.600">#{etx.unit_id}</Text>
                        </Flex>
                    </Tooltip>
                );
            },
        },
        {
            id: 'pnl-realized',
            header: 'P&L (R)',
            width: '100px',
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                if (etx.realized_pnl_in_base == null) return <Text fontSize="xs" color="gray.400">-</Text>;
                const isPositive = etx.realized_pnl_in_base >= 0;
                const entries = etx.realized_entries || [];
                const tooltipLines: string[] = [];
                entries.forEach(e => {
                    tooltipLines.push(`── ${e.asset?.symbol || '?'} (${e.is_fee ? 'Fee' : e.disposal_taxable ? 'Taxable Disposal' : 'Non-Taxable'}) ──`);
                    tooltipLines.push(`Proceeds: ${e.proceeds_in_base >= 0 ? '+' : ''}${e.proceeds_in_base.toFixed(2)} ${baseCurrency}`);
                    if (e.proceeds_price != null) {
                        const fmvParts = [`FMV: ${e.proceeds_price.toFixed(6)}`];
                        if (e.proceeds_price_source) fmvParts.push(`(${e.proceeds_price_source})`);
                        if (e.proceeds_price_timestamp) {
                            const dt = new Date(e.proceeds_price_timestamp);
                            fmvParts.push(dt.toLocaleString());
                        }
                        tooltipLines.push(fmvParts.join(' '));
                    }
                    tooltipLines.push(`Cost: ${e.cost_basis_in_base.toFixed(2)} ${baseCurrency}`);
                    tooltipLines.push(`P&L: ${e.pnl_in_base >= 0 ? '+' : ''}${e.pnl_in_base.toFixed(2)} ${baseCurrency}`);
                });
                const tooltipContent = tooltipLines.length > 0
                    ? tooltipLines.join('\n')
                    : `${etx.realized_pnl_in_base >= 0 ? '+' : ''}${etx.realized_pnl_in_base.toFixed(2)} ${baseCurrency}`;
                return (
                    <Tooltip content={tooltipContent}>
                        <Box textAlign="right">
                            <Text fontSize="xs" fontWeight="semibold" color={isPositive ? 'green.600' : 'red.600'}>
                                {isPositive ? '+' : ''}<ValueDisplay value={etx.realized_pnl_in_base} currency={baseCurrency} />
                            </Text>
                        </Box>
                    </Tooltip>
                );
            },
        },
        {
            id: 'pnl-fees',
            header: 'Fees',
            width: '80px',
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                if (etx.total_fees_in_base == null) return <Text fontSize="xs" color="gray.400">-</Text>;
                return (
                    <Box textAlign="right">
                        <Text fontSize="xs" color="orange.600">
                            <ValueDisplay value={etx.total_fees_in_base} currency={baseCurrency} />
                        </Text>
                    </Box>
                );
            },
        },
        {
            id: 'pnl-events',
            header: 'Events',
            width: '60px',
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                const events = etx.cost_lot_event_summary || [];
                if (events.length === 0) return <Text fontSize="xs" color="gray.400">-</Text>;
                const tooltipContent = events.slice(0, 5).map(
                    e => `${e.event_type}: Δ${e.quantity_delta >= 0 ? '+' : ''}${e.quantity_delta.toFixed(4)} (lot #${e.lot_id || '?'})`
                ).join('\n') + (events.length > 5 ? `\n...+${events.length - 5} more` : '');
                return (
                    <Tooltip content={tooltipContent}>
                        <Flex justify="center">
                            <Badge
                                size="sm"
                                colorPalette="gray"
                                variant="subtle"
                                cursor={etx.unit_id ? 'pointer' : undefined}
                                _hover={etx.unit_id ? { colorPalette: 'blue' } : undefined}
                                onClick={etx.unit_id ? (e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setEventsPanelUnitId(etx.unit_id!);
                                } : undefined}
                            >
                                {events.length}
                            </Badge>
                        </Flex>
                    </Tooltip>
                );
            },
        },
    ], [baseCurrency]);


    // ── Clear PnL filters ───────────────────────────────────────────────────
    const hasAnyFilter = typeFilter || hasRealizedPnl !== null || hasFees !== null || debouncedSearch;
    const clearFilters = useCallback(() => {
        setTypeFilter(null);
        setHasRealizedPnl(null);
        setHasFees(null);
        setSearchInput('');
        setDebouncedSearch('');
    }, []);

    return (
        <Box>
            {/* PnL Filter Bar */}
            <Flex wrap="wrap" gap={2} mb={3} align="center">
                {/* Search */}
                <Flex align="center" gap={1} bg="gray.50" borderRadius="md" px={2} py={1} maxW="200px">
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text"
                        placeholder="Search unit..."
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        style={{
                            border: 'none',
                            background: 'transparent',
                            fontSize: '12px',
                            outline: 'none',
                            width: '100%',
                        }}
                    />
                </Flex>

                {/* Pattern filter chips */}
                {filterOptions?.patterns.map(p => (
                    <Button
                        key={p.value}
                        size="xs"
                        variant={typeFilter === p.value ? 'solid' : 'outline'}
                        colorPalette={typeFilter === p.value ? 'blue' : 'gray'}
                        onClick={() => setTypeFilter(typeFilter === p.value ? null : p.value)}
                    >
                        {getUnitPatternLabel(p.value)} ({p.count})
                    </Button>
                ))}

                {/* Boolean filter chips */}
                {filterOptions && filterOptions.has_realized_pnl_count > 0 && (
                    <Button
                        size="xs"
                        variant={hasRealizedPnl ? 'solid' : 'outline'}
                        colorPalette={hasRealizedPnl ? 'green' : 'gray'}
                        onClick={() => setHasRealizedPnl(hasRealizedPnl ? null : true)}
                    >
                        Has P&L ({filterOptions.has_realized_pnl_count})
                    </Button>
                )}
                {filterOptions && filterOptions.has_fees_count > 0 && (
                    <Button
                        size="xs"
                        variant={hasFees ? 'solid' : 'outline'}
                        colorPalette={hasFees ? 'orange' : 'gray'}
                        onClick={() => setHasFees(hasFees ? null : true)}
                    >
                        Has Fees ({filterOptions.has_fees_count})
                    </Button>
                )}

                {/* Clear filters */}
                {hasAnyFilter && (
                    <Button size="xs" variant="ghost" onClick={clearFilters}>
                        Clear
                    </Button>
                )}
            </Flex>

            {/* TransactionsTable with enriched data */}
            <TransactionsTable
                title=""
                subtitle=""
                compact
                showFilters={false}
                defaultFiltersCollapsed={true}
                showBundles={false}
                hideLegend
                customApiUrl={customApiUrl}
                tableId="pnl-enriched-transactions"
                config={{
                    columnPreset: 'compact',
                    hiddenColumns: ['bundle', 'tags', 'feeInBase', 'status', 'sourceTransactionId'],
                    features: { selection: false, inlineEdit: false },
                }}
                additionalColumns={additionalColumns}
            />

            {/* Unit Detail Slide Panel */}
            <UnitDetailSlidePanel
                isOpen={slidePanelUnitId !== null}
                onClose={() => setSlidePanelUnitId(null)}
                versionId={versionId}
                unitId={slidePanelUnitId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
            />

            {/* Cost Lot Events Slide Panel */}
            <SlidePanel
                isOpen={eventsPanelUnitId !== null}
                onClose={() => setEventsPanelUnitId(null)}
                title={`Cost Lot Events — Unit #${eventsPanelUnitId}`}
                width="800px"
            >
                {eventsPanelUnitId !== null && (
                    <Box maxH="calc(100vh - 140px)" overflow="auto">
                        <CostLotEventsTable
                            {...EVENT_TABLE_PRESETS.UNIT_DETAIL}
                            versionId={versionId}
                            baseCurrency={baseCurrency}
                            unitId={eventsPanelUnitId}
                            onTransactionClick={onTransactionClick}
                            onUnitClick={(uid) => {
                                setEventsPanelUnitId(null);
                                setSlidePanelUnitId(uid);
                            }}
                        />
                    </Box>
                )}
            </SlidePanel>
        </Box>
    );
};
