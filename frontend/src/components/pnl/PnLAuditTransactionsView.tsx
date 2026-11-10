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
import { Badge, Button } from '../ui/primitives';
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
import { RealizedEntrySlidePanel } from './RealizedEntrySlidePanel';
import { SlidePanel } from './SlidePanel';
import { CostLotEventsTable, EVENT_TABLE_PRESETS } from './CostLotEventsTable';
import { Tooltip } from '../ui/tooltip';
import { ValueDisplay } from '../ValueDisplay';
import { API_URL, Transaction } from '../../types';
import { UnitPattern, getUnitPatternLabel } from '../../enums';
import type { ColumnPlugin, RowAction } from '../tables/types';
import { LuLocateFixed } from 'react-icons/lu';
import { contextDateWindow } from '../../hooks/useShowInAllTransactions';
import { consumePendingLocate } from '../../utils/pnlLocate';
import type { EnrichedTransaction, EnrichedTransactionsFilterOptions } from './types';
import { realizedOf, realizedCostOf, deferredInOf, TERM_HELP } from './pnlTerms';

// Non-sticky columns first; the pinned Unit / Realized pair sits against the right edge.
const COLUMN_ORDER = ['pnl-fees', 'pnl-events', 'pnl-unit', 'pnl-realized'];
const byColumnOrder = (a: { id: string }, b: { id: string }) => COLUMN_ORDER.indexOf(a.id) - COLUMN_ORDER.indexOf(b.id);

// ─── Pattern icon mapping (shared with ActivityFeed) ─────────────────────────

const PATTERN_ICONS: Record<string, { icon: React.ReactNode; color: string }> = {
    [UnitPattern.SWAP]: { icon: <FiRepeat size={13} />, color: 'text-orange-500' },
    [UnitPattern.INTERNAL_TRANSFER]: { icon: <FiArrowRightCircle size={13} />, color: 'text-blue-500' },
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: { icon: <FiLink size={13} />, color: 'text-cyan-500' },
    [UnitPattern.SPLIT]: { icon: <FiScissors size={13} />, color: 'text-purple-500' },
    [UnitPattern.FLOW]: { icon: <FiTrendingUp size={13} />, color: 'text-green-500' },
    [UnitPattern.CUSTOM]: { icon: <FiEdit size={13} />, color: 'text-teal-500' },
    [UnitPattern.UNKNOWN]: { icon: <FiHelpCircle size={13} />, color: 'text-gray-400' },
};

const PATTERN_BORDER_COLORS: Record<string, string> = {
    [UnitPattern.SWAP]: 'border-orange-400',
    [UnitPattern.INTERNAL_TRANSFER]: 'border-blue-400',
    [UnitPattern.UNMATCHED_INTERNAL_TRANSFER]: 'border-cyan-400',
    [UnitPattern.SPLIT]: 'border-purple-400',
    [UnitPattern.FLOW]: 'border-green-400',
    [UnitPattern.CUSTOM]: 'border-teal-400',
    [UnitPattern.UNKNOWN]: 'border-slate-300',
};

const getPatternIcon = (pattern: string | null | undefined) =>
    PATTERN_ICONS[pattern || 'unknown'] || PATTERN_ICONS[UnitPattern.UNKNOWN];

interface PnlFilterSnapshot {
    typeFilter: string | null;
    hasRealizedPnl: boolean | null;
    hasFees: boolean | null;
    search: string;
}

const EMPTY_PNL_FILTERS: PnlFilterSnapshot = { typeFilter: null, hasRealizedPnl: null, hasFees: null, search: '' };

interface LocateState {
    txId: number;
    dateTime?: string;
    dateFrom: string;
    dateTo: string;
    /** P&L chips to restore on "Back" */
    previous: PnlFilterSnapshot;
}

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

    const [entryPanelId, setEntryPanelId] = useState<number | null>(null);

    // Locate: every transaction ±3 days around one, ignoring all filters (table only).
    const [locate, setLocate] = useState<LocateState | null>(() => {
        const pending = consumePendingLocate();
        const dateWindow = pending ? contextDateWindow(pending.dateTime) : null;
        return pending && dateWindow
            ? { txId: pending.txId, dateTime: pending.dateTime ?? undefined, ...dateWindow, previous: EMPTY_PNL_FILTERS }
            : null;
    });

    const startLocate = useCallback((tx: Transaction) => {
        const dateWindow = contextDateWindow(tx.date_time);
        if (!dateWindow) return;
        setSlidePanelUnitId(null);
        setEventsPanelUnitId(null);
        setEntryPanelId(null);
        setLocate(prev => ({
            txId: tx.id,
            dateTime: String(tx.date_time),
            ...dateWindow,
            previous: prev?.previous ?? { typeFilter, hasRealizedPnl, hasFees, search: searchInput },
        }));
        setTypeFilter(null);
        setHasRealizedPnl(null);
        setHasFees(null);
        setSearchInput('');
        setDebouncedSearch('');
    }, [typeFilter, hasRealizedPnl, hasFees, searchInput]);

    const backFromLocate = useCallback(() => {
        if (!locate) return;
        const p = locate.previous;
        setTypeFilter(p.typeFilter);
        setHasRealizedPnl(p.hasRealizedPnl);
        setHasFees(p.hasFees);
        setSearchInput(p.search);
        setDebouncedSearch(p.search);
        setLocate(null);
    }, [locate]);

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

        if (locate) {
            params.set('date_from', locate.dateFrom);
            params.set('date_to', locate.dateTo);
            return `${API_URL}/pnl/versions/${versionId}/enriched-transactions?${params.toString()}`;
        }

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
    }, [versionId, typeFilter, hasRealizedPnl, hasFees, debouncedSearch, txFilterParams, locate]);

    // ── Additional columns (plugin architecture) ────────────────────────────
    const additionalColumns: ColumnPlugin<Transaction>[] = useMemo(() => ([
        {
            id: 'pnl-unit',
            header: 'Unit',
            width: '80px',
            sticky: 'right',
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                if (!etx.unit_id) return <span className="text-xs text-gray-400">-</span>;
                const { icon, color } = getPatternIcon(etx.unit_pattern);
                return (
                    <Tooltip content={etx.unit_label || getUnitPatternLabel(etx.unit_pattern || 'unknown')}>
                        <div
                            className="flex cursor-pointer items-center gap-1"
                            onClick={(e) => { e.stopPropagation(); setSlidePanelUnitId(etx.unit_id!); }}
                        >
                            <span className={color}>{icon}</span>
                            <span className="text-xs text-gray-600">#{etx.unit_id}</span>
                        </div>
                    </Tooltip>
                );
            },
        },
        {
            id: 'pnl-realized',
            header: 'Realized',
            width: '110px',
            sticky: 'right',
            info: `${TERM_HELP.realized} Per transaction; the day/month header shows the period total (Realized Σ). Click a value to explain it.`,
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                if (etx.realized_pnl_in_base == null) return <span className="text-xs text-gray-400">-</span>;
                const isPositive = etx.realized_pnl_in_base >= 0;
                const entries = etx.realized_entries || [];
                const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} ${baseCurrency}`;
                const taxableGain = entries.filter(e => e.disposal_taxable).reduce((sum, e) => sum + e.pnl_in_base, 0);
                const hasTaxable = entries.some(e => e.disposal_taxable);
                const tooltipLines: string[] = [];
                entries.forEach(e => {
                    tooltipLines.push(`── ${e.asset?.symbol || '?'} (${e.is_fee ? 'Fee' : e.disposal_taxable ? 'Taxable' : 'Deferred'}) ──`);
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
                    tooltipLines.push(`Cost: ${realizedCostOf(e).toFixed(2)} ${baseCurrency}`);
                    tooltipLines.push(`Realized: ${fmt(realizedOf(e))}`);
                    if (e.disposal_taxable) tooltipLines.push(`Taxable gain: ${fmt(e.pnl_in_base)} (tax cost ${e.cost_basis_in_base.toFixed(2)})`);
                    const deferredIn = deferredInOf(e);
                    if (deferredIn !== 0) tooltipLines.push(`Deferred in: ${fmt(deferredIn)} (${e.disposal_taxable ? 'released' : 'rolled over'})`);
                });
                const tooltipContent = tooltipLines.length > 0
                    ? tooltipLines.join('\n')
                    : `${etx.realized_pnl_in_base >= 0 ? '+' : ''}${etx.realized_pnl_in_base.toFixed(2)} ${baseCurrency}`;
                const firstPnlId = entries.find(e => e.pnl_id != null)?.pnl_id;
                return (
                    <Tooltip content={tooltipContent}>
                        <div
                            className={firstPnlId != null ? 'cursor-pointer text-right hover:underline' : 'text-right'}
                            onClick={firstPnlId != null ? (ev) => { ev.stopPropagation(); setEntryPanelId(firstPnlId); } : undefined}
                        >
                            <span className={`text-xs font-semibold ${isPositive ? 'text-green-600' : 'text-red-600'}`}>
                                {isPositive ? '+' : ''}<ValueDisplay value={etx.realized_pnl_in_base} currency={baseCurrency} />
                            </span>
                            {hasTaxable && Math.abs(taxableGain - etx.realized_pnl_in_base) >= 0.005 && (
                                <div className="text-[9px] text-gray-500">
                                    Taxable: <ValueDisplay value={taxableGain} currency={baseCurrency} />
                                </div>
                            )}
                        </div>
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
                if (etx.total_fees_in_base == null) return <span className="text-xs text-gray-400">-</span>;
                return (
                    <div className="text-right">
                        <span className="text-xs text-orange-600">
                            <ValueDisplay value={etx.total_fees_in_base} currency={baseCurrency} />
                        </span>
                    </div>
                );
            },
        },
        {
            id: 'pnl-events',
            header: 'Events',
            width: '60px',
            defaultHidden: true,
            headerBg: 'white',
            cellBg: 'white',
            render: (tx: Transaction) => {
                const etx = tx as unknown as EnrichedTransaction;
                const events = etx.cost_lot_event_summary || [];
                if (events.length === 0) return <span className="text-xs text-gray-400">-</span>;
                const tooltipContent = events.slice(0, 5).map(
                    e => `${e.event_type}: Δ${e.quantity_delta >= 0 ? '+' : ''}${e.quantity_delta.toFixed(4)} (lot #${e.lot_id || '?'})`
                ).join('\n') + (events.length > 5 ? `\n...+${events.length - 5} more` : '');
                return (
                    <Tooltip content={tooltipContent}>
                        <div className="flex justify-center">
                            <Badge
                                colorScheme="gray"
                                className={etx.unit_id ? 'cursor-pointer hover:bg-blue-100 hover:text-blue-700' : undefined}
                                onClick={etx.unit_id ? (e: React.MouseEvent) => {
                                    e.stopPropagation();
                                    setEventsPanelUnitId(etx.unit_id!);
                                } : undefined}
                            >
                                {events.length}
                            </Badge>
                        </div>
                    </Tooltip>
                );
            },
        },
    ] as ColumnPlugin<Transaction>[]).sort(byColumnOrder), [baseCurrency]);


    const hasScope = !!txFilterParams && Object.values(txFilterParams).some(v => v !== undefined && v !== null && v !== '');

    const rowActions: RowAction<Transaction>[] = useMemo(() => [{
        id: 'pnl-locate',
        icon: <LuLocateFixed size={11} />,
        label: 'Locate: show all transactions ±3 days around this one (no filters)',
        colorPalette: 'blue',
        isVisible: () => !locate && (hasScope || !!typeFilter || hasRealizedPnl !== null || hasFees !== null || !!debouncedSearch),
        onClick: startLocate,
    }], [locate, hasScope, typeFilter, hasRealizedPnl, hasFees, debouncedSearch, startLocate]);

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
        <div>
            {locate && (
                <div className="mb-2 flex flex-wrap items-center gap-2 border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs text-blue-900">
                    <LuLocateFixed size={12} />
                    <span>
                        Around <strong>TX #{locate.txId}</strong> ({locate.dateFrom} → {locate.dateTo}) · all accounts and assets, no filters
                    </span>
                    {hasScope && <span className="text-blue-700">· cards above keep their scope</span>}
                    <Button size="xs" variant="outline" className="ml-auto" onClick={backFromLocate}>
                        ← Back to previous view
                    </Button>
                </div>
            )}

            {/* PnL Filter Bar */}
            <div className={`mb-3 flex flex-wrap items-center gap-2 ${locate ? 'pointer-events-none opacity-40' : ''}`}>
                {/* Search */}
                <div className="flex max-w-[200px] items-center gap-1 border border-slate-200 bg-slate-50 px-2 py-1">
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
                </div>

                {/* Pattern filter chips */}
                {filterOptions?.patterns.map(p => (
                    <Button
                        key={p.value}
                        size="sm"
                        variant={typeFilter === p.value ? 'solid' : 'outline'}
                        colorScheme={typeFilter === p.value ? 'blue' : 'gray'}
                        onClick={() => setTypeFilter(typeFilter === p.value ? null : p.value)}
                    >
                        {getUnitPatternLabel(p.value)} ({p.count})
                    </Button>
                ))}

                {/* Boolean filter chips */}
                {filterOptions && filterOptions.has_realized_pnl_count > 0 && (
                    <Button
                        size="sm"
                        variant={hasRealizedPnl ? 'solid' : 'outline'}
                        colorScheme={hasRealizedPnl ? 'green' : 'gray'}
                        onClick={() => setHasRealizedPnl(hasRealizedPnl ? null : true)}
                    >
                        Has P&L ({filterOptions.has_realized_pnl_count})
                    </Button>
                )}
                {filterOptions && filterOptions.has_fees_count > 0 && (
                    <Button
                        size="sm"
                        variant={hasFees ? 'solid' : 'outline'}
                        colorScheme="gray"
                        className={hasFees ? 'bg-orange-600 text-white hover:bg-orange-700' : 'border-orange-300 text-orange-700 hover:bg-orange-50'}
                        onClick={() => setHasFees(hasFees ? null : true)}
                    >
                        Has Fees ({filterOptions.has_fees_count})
                    </Button>
                )}

                {/* Clear filters */}
                {hasAnyFilter && (
                    <Button size="sm" variant="ghost" onClick={clearFilters}>
                        Clear
                    </Button>
                )}
            </div>

            {/* TransactionsTable with enriched data */}
            <TransactionsTable
                defaultExpandAllDays
                title=""
                subtitle=""
                compact
                showFilters={false}
                defaultFiltersCollapsed={true}
                showBundles={false}
                hideLegend
                showColumnPicker
                pinDateColumn
                focusTransactionId={locate?.txId}
                focusDateTime={locate?.dateTime}
                additionalRowActions={rowActions}
                customApiUrl={customApiUrl}
                baseCurrency={baseCurrency}
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

            <RealizedEntrySlidePanel
                isOpen={entryPanelId !== null}
                onClose={() => setEntryPanelId(null)}
                versionId={versionId}
                pnlId={entryPanelId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
                onUnitClick={(uid) => { setEntryPanelId(null); setSlidePanelUnitId(uid); }}
            />

            {/* Cost Lot Events Slide Panel */}
            <SlidePanel
                isOpen={eventsPanelUnitId !== null}
                onClose={() => setEventsPanelUnitId(null)}
                title={`Cost Lot Events — Unit #${eventsPanelUnitId}`}
                width="800px"
            >
                {eventsPanelUnitId !== null && (
                    <div className="max-h-[calc(100vh-140px)] overflow-auto">
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
                    </div>
                )}
            </SlidePanel>
        </div>
    );
};
