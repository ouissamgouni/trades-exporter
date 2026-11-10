import React, { useEffect, useMemo, useState } from 'react';
import { LuChevronDown, LuChevronRight, LuChevronsDownUp, LuChevronsUpDown, LuCheck, LuUndo2 } from 'react-icons/lu';
import type { Transaction } from '../../../types';
import { Spinner } from '../../ui/primitives';
import { cn } from '../../../lib/cn';
import { formatDayLabel, formatMonthLabel, parseApiDate } from '../../../utils/dateUtils';
import { toaster } from '../../ui/toaster';
import {
    GROUP_GRID,
    GROUP_GRID_PNL,
    GroupAccountsInline,
    GroupAccountsStrip,
    GroupStatusCells,
} from './GroupRecap';
import { AppliedFacetsBar } from './GroupFacetBar';
import { applyFacetSelection, groupRowCount, hasFacetSelection, shouldAutoExpandDays, withoutInvalid } from './groupUtils';
import { fetchGroupIds, PeriodBounds, useGroupRows, useTransactionGroups } from './useTransactionGroups';
import type { FacetKey, GroupFacetSelection, TransactionGroup } from './types';

export interface ReviewedOverlayEntry {
    tx: Transaction;
    previousStatus: string;
    newStatus: string;
}

export interface GroupedTransactionsBodyProps {
    groupsUrl: string;
    listUrl: string;
    idsUrl: string | null;
    params: URLSearchParams;
    sortDir: 'asc' | 'desc';
    colSpan: number;
    selectable: boolean;
    renderRow: (tx: Transaction) => React.ReactNode;
    onRowsLoaded: (key: string, rows: Transaction[] | null) => void;
    selectedIds: Set<number>;
    setSelectedIds: React.Dispatch<React.SetStateAction<Set<number>>>;
    onApplyFacetsGlobally: (selection: GroupFacetSelection) => void;
    /** Inbox triage: mark every transaction of a group as valid. */
    onMarkGroupReviewed?: (ids: number[]) => Promise<void>;
    reviewedOverlay: Map<number, ReviewedOverlayEntry>;
    onUndoReviewed: (id: number) => void;
    emptyMessage?: string;
    baseCurrency?: string;
    /** Hide invalid rows and periods that only contain invalid transactions. */
    hideInvalid?: boolean;
    onExcludedInvalidCount?: (count: number | null) => void;
    /** Datetime of the focused transaction: its month and day open by default. */
    focusDate?: string;
    /** Open every loaded month and day on mount (review tables). */
    defaultExpandAll?: boolean;
}

type ExpandMode = 'default' | 'expanded' | 'collapsed';

type SharedProps = Omit<GroupedTransactionsBodyProps, 'groupsUrl' | 'params' | 'sortDir' | 'colSpan' | 'emptyMessage' | 'hideInvalid' | 'onExcludedInvalidCount' | 'defaultExpandAll'> & {
    groupsUrl: string;
    sortDir: 'asc' | 'desc';
    colSpan: number;
    showPnl: boolean;
    hideInvalid: boolean;
};

// Month header height is fixed (h-14) so day headers can stick right below it.
const MONTH_STICKY_TD = 'sticky top-[var(--thead-h,0px)] z-[8] p-0';
const DAY_STICKY_TD = 'sticky top-[calc(var(--thead-h,0px)+3.5rem)] z-[7] p-0';
// Month header grows by the h-7 applied-filters bar.
const DAY_STICKY_TD_FILTERED = 'sticky top-[calc(var(--thead-h,0px)+5.25rem)] z-[7] p-0';
// Keeps header content within the visible scroll width when the table is wider than the viewport.
const VIEWPORT_BOX = 'sticky left-0 w-[var(--scroll-w,100%)]';

const boundsOf = (g: TransactionGroup): PeriodBounds => ({ from: g.date_from, to: g.date_to });

function inBounds(tx: Transaction, bounds: PeriodBounds): boolean {
    const d = parseApiDate(tx.date_time);
    if (!d) return false;
    const key = d.toISOString().replace('Z', '');
    return key >= bounds.from && key <= bounds.to;
}

function containsFocus(focusDate: string | undefined, group: TransactionGroup): boolean {
    if (!focusDate) return false;
    const d = parseApiDate(focusDate);
    if (!d) return false;
    const key = d.toISOString().replace('Z', '');
    return key >= group.date_from && key <= group.date_to;
}

export const GroupedTransactionsBody: React.FC<GroupedTransactionsBodyProps> = ({
    params, emptyMessage, hideInvalid: hideInvalidRequested = false, onExcludedInvalidCount, defaultExpandAll = false, ...shared
}) => {
    const [expandMode, setExpandMode] = useState<ExpandMode>(defaultExpandAll ? 'expanded' : 'default');
    const [expandVersion, setExpandVersion] = useState(0);
    // Nothing to hide when the status filter keeps only invalid transactions.
    const hideInvalid = hideInvalidRequested && withoutInvalid(params) !== null;
    const months = useTransactionGroups({
        groupsUrl: shared.groupsUrl,
        params,
        granularity: 'month',
        sortDir: shared.sortDir,
        hideInvalid,
    });

    const groups = useMemo(() => months.data?.pages.flatMap(p => p.groups) ?? [], [months.data]);
    const total = months.data?.pages[0]?.total_groups ?? 0;
    const showPnl = shared.groupsUrl.includes('/enriched-transactions/groups');
    const excludedInvalid = hideInvalid ? months.data?.pages[0]?.excluded_invalid_count ?? null : null;
    useEffect(() => {
        onExcludedInvalidCount?.(excludedInvalid);
    }, [excludedInvalid, onExcludedInvalidCount]);

    if (months.isLoading) {
        return <StatusRow colSpan={shared.colSpan}><Spinner size="sm" className="text-blue-500" /> Loading months…</StatusRow>;
    }
    if (months.error) {
        return <StatusRow colSpan={shared.colSpan}><span className="text-red-600">Failed to load groups.</span></StatusRow>;
    }
    if (groups.length === 0) {
        return <StatusRow colSpan={shared.colSpan}>{emptyMessage || 'No transactions found'}</StatusRow>;
    }

    const allExpanded = expandMode === 'expanded';
    const toggleExpandAll = () => {
        setExpandMode(allExpanded ? 'collapsed' : 'expanded');
        setExpandVersion(v => v + 1);
    };

    return (
        <>
            <tr>
                <td colSpan={shared.colSpan} className="p-0">
                    <div className={cn(VIEWPORT_BOX, 'flex items-center px-2 py-1')}>
                        <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-blue-600"
                            onClick={toggleExpandAll}
                        >
                            {allExpanded ? <LuChevronsDownUp size={14} /> : <LuChevronsUpDown size={14} />}
                            {allExpanded ? 'Collapse all' : 'Expand all days'}
                        </button>
                    </div>
                </td>
            </tr>
            {groups.map((month, i) => (
                <MonthSection
                    key={`${month.period_start}:${expandVersion}`}
                    month={month}
                    defaultExpanded={expandMode === 'expanded' || (expandMode === 'default' && i === 0) || containsFocus(shared.focusDate, month)}
                    defaultExpandDays={expandMode === 'expanded' ? true : expandMode === 'collapsed' ? false : undefined}
                    params={params}
                    showPnl={showPnl}
                    hideInvalid={hideInvalid}
                    {...shared}
                />
            ))}
            {months.hasNextPage && (
                <tr>
                    <td colSpan={shared.colSpan} className="py-2 text-center">
                        <button
                            type="button"
                            className="border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={months.isFetchingNextPage}
                            onClick={() => months.fetchNextPage()}
                        >
                            {months.isFetchingNextPage ? 'Loading…' : `Load more months (${total - groups.length} left)`}
                        </button>
                    </td>
                </tr>
            )}
        </>
    );
};

const StatusRow: React.FC<{ colSpan: number; children: React.ReactNode }> = ({ colSpan, children }) => (
    <tr>
        <td colSpan={colSpan}>
            <span className="flex items-center justify-center gap-2 py-6 text-xs text-slate-500">{children}</span>
        </td>
    </tr>
);

type GroupScopeProps = SharedProps & { group: TransactionGroup; params: URLSearchParams; scopeLabel: string };

async function loadGroupIds(idsUrl: string, params: URLSearchParams, group: TransactionGroup): Promise<number[]> {
    const result = await fetchGroupIds(idsUrl, params, boundsOf(group));
    if (result.truncated) {
        toaster.info({ title: 'Selection capped', description: `Only the first ${result.ids.length} of ${result.total} transactions were selected.` });
    }
    return result.ids;
}

/** First grid cell: select every transaction of the period. */
const GroupSelect: React.FC<GroupScopeProps> = ({ group, params, scopeLabel, idsUrl, selectable, selectedIds, setSelectedIds, hideInvalid }) => {
    const [groupIds, setGroupIds] = useState<number[] | null>(null);
    const [busy, setBusy] = useState(false);
    const allSelected = !!groupIds && groupIds.length > 0 && groupIds.every(id => selectedIds.has(id));

    if (!selectable || !idsUrl) return <span />;

    const toggle = async () => {
        setBusy(true);
        try {
            const ids = allSelected ? groupIds! : await loadGroupIds(idsUrl, params, group);
            setGroupIds(ids);
            setSelectedIds(prev => {
                const next = new Set(prev);
                ids.forEach(id => (allSelected ? next.delete(id) : next.add(id)));
                return next;
            });
        } catch {
            toaster.error({ title: 'Error', description: 'Failed to select transactions' });
        } finally {
            setBusy(false);
        }
    };

    const title = `Select all ${hideInvalid ? group.total_count : groupRowCount(group)} in ${scopeLabel}`;
    return (
        <span className="inline-flex items-center" onClick={e => e.stopPropagation()}>
            <input
                type="checkbox"
                aria-label={title}
                title={title}
                className="h-3.5 w-3.5 cursor-pointer accent-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                checked={allSelected}
                disabled={busy}
                onChange={toggle}
            />
        </span>
    );
};

/** Inbox triage: mark all pending in the period as valid. */
const MarkReviewedAction: React.FC<GroupScopeProps> = ({ group, params, scopeLabel, idsUrl, onMarkGroupReviewed }) => {
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(false);
    if (!onMarkGroupReviewed || !idsUrl || group.pending_count === 0) return null;

    const markReviewed = async () => {
        setBusy(true);
        try {
            await onMarkGroupReviewed(await loadGroupIds(idsUrl, params, group));
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    };

    return confirming ? (
        <span className="inline-flex items-center gap-1.5 text-xs" onClick={e => e.stopPropagation()}>
            <button
                type="button"
                className="bg-blue-500 px-2 py-0.5 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={markReviewed}
            >
                {busy ? 'Saving…' : `Mark ${group.pending_count} valid`}
            </button>
            <button type="button" className="text-slate-500 hover:text-slate-800" onClick={() => setConfirming(false)}>
                Cancel
            </button>
        </span>
    ) : (
        <button
            type="button"
            className="inline-flex items-center gap-1 border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50"
            title={`Mark all pending in ${scopeLabel} as valid`}
            onClick={e => { e.stopPropagation(); setConfirming(true); }}
        >
            <LuCheck size={12} /> Mark as valid
        </button>
    );
};

const toggleFacetValue = (selection: GroupFacetSelection, dim: FacetKey, value: string): GroupFacetSelection => {
    const current = selection[dim] ?? [];
    return { ...selection, [dim]: current.includes(value) ? current.filter(v => v !== value) : [...current, value] };
};

const FilterBarRow: React.FC<{ grid: string; children: React.ReactNode }> = ({ grid, children }) => (
    <div className={cn(grid, 'h-7 border-t border-slate-300 bg-blue-50 px-2')}>
        <div className="col-[2/-1] min-w-0">{children}</div>
    </div>
);

const toggleKeys = (toggle: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
};

const MonthSection: React.FC<SharedProps & { month: TransactionGroup; defaultExpanded: boolean; defaultExpandDays?: boolean; params: URLSearchParams }> = (props) => {
    const { month, defaultExpanded, defaultExpandDays, params, colSpan, onApplyFacetsGlobally, showPnl, hideInvalid } = props;
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [facets, setFacets] = useState<GroupFacetSelection>({});
    const [expandAllDays, setExpandAllDays] = useState(() => defaultExpandDays ?? shouldAutoExpandDays(month));
    const [expandVersion, setExpandVersion] = useState(0);
    const label = formatMonthLabel(month.period_start);
    const scopedParams = useMemo(() => applyFacetSelection(params, facets), [params, facets]);
    const rowParams = useMemo(() => (hideInvalid ? withoutInvalid(scopedParams) : null) ?? scopedParams, [scopedParams, hideInvalid]);
    const filtered = hasFacetSelection(facets);
    const grid = showPnl ? GROUP_GRID_PNL : GROUP_GRID;
    const toggle = () => setExpanded(e => !e);
    const toggleFacet = (dim: FacetKey, value: string) => {
        setFacets(f => toggleFacetValue(f, dim, value));
        setExpanded(true);
    };

    const days = useTransactionGroups({
        groupsUrl: props.groupsUrl,
        params: scopedParams,
        granularity: 'day',
        sortDir: props.sortDir,
        bounds: boundsOf(month),
        enabled: expanded,
        pageSize: 31,
        hideInvalid,
    });
    const dayGroups = useMemo(() => days.data?.pages.flatMap(p => p.groups) ?? [], [days.data]);

    return (
        <>
            <tr>
                <td colSpan={colSpan} className={MONTH_STICKY_TD}>
                    <div className={cn(VIEWPORT_BOX, 'border-l-4 border-t border-slate-700 border-t-slate-300 bg-slate-200')}>
                        <div
                            className={cn(grid, 'h-14 cursor-pointer px-2 hover:bg-slate-300/70')}
                            role="button"
                            aria-expanded={expanded}
                            tabIndex={0}
                            onClick={toggle}
                            onKeyDown={toggleKeys(toggle)}
                        >
                            <GroupSelect {...props} group={month} params={rowParams} scopeLabel={label} />
                            <span className="flex min-w-0 flex-col justify-center text-slate-900">
                                <span className="inline-flex min-w-0 items-center gap-1">
                                    {expanded ? <LuChevronDown size={16} /> : <LuChevronRight size={16} />}
                                    <span className="truncate text-base font-semibold">{label}</span>
                                </span>
                                {expanded && (
                                    <button
                                        type="button"
                                        className="self-start pl-5 text-[11px] leading-tight text-slate-500 hover:text-blue-600"
                                        onClick={e => {
                                            e.stopPropagation();
                                            setExpandAllDays(v => !v);
                                            setExpandVersion(v => v + 1);
                                        }}
                                    >
                                        {expandAllDays ? 'Collapse days' : 'Expand days'}
                                    </button>
                                )}
                            </span>
                            <GroupStatusCells group={month} showPnl={showPnl} baseCurrency={props.baseCurrency} showInvalid={!hideInvalid} />
                            <GroupAccountsStrip group={month} selection={facets} onToggleFacet={toggleFacet} />
                            <MarkReviewedAction {...props} group={month} params={rowParams} scopeLabel={label} />
                        </div>
                        {filtered && (
                            <FilterBarRow grid={grid}>
                                <AppliedFacetsBar
                                    group={month}
                                    selection={facets}
                                    onChange={setFacets}
                                    onApplyToAll={sel => { onApplyFacetsGlobally(sel); setFacets({}); }}
                                />
                            </FilterBarRow>
                        )}
                    </div>
                </td>
            </tr>
            {expanded && days.isLoading && (
                <StatusRow colSpan={colSpan}><Spinner size="sm" className="text-blue-500" /> Loading days…</StatusRow>
            )}
            {expanded && dayGroups.map(day => (
                <DaySection
                    key={`${day.period_start}:${expandVersion}`}
                    {...props}
                    day={day}
                    params={scopedParams}
                    defaultExpanded={expandAllDays || containsFocus(props.focusDate, day)}
                    monthFiltered={filtered}
                />
            ))}
            {expanded && !days.isLoading && dayGroups.length === 0 && (
                <StatusRow colSpan={colSpan}>No transactions match the month filters</StatusRow>
            )}
        </>
    );
};

const DaySection: React.FC<SharedProps & { day: TransactionGroup; params: URLSearchParams; defaultExpanded: boolean; monthFiltered: boolean }> = (props) => {
    const {
        day, params, defaultExpanded, monthFiltered, colSpan, listUrl, sortDir, renderRow, onRowsLoaded,
        reviewedOverlay, onUndoReviewed, onApplyFacetsGlobally, showPnl, hideInvalid,
    } = props;
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [facets, setFacets] = useState<GroupFacetSelection>({});
    const label = formatDayLabel(day.period_start);
    const bounds = boundsOf(day);
    const scopedParams = useMemo(() => applyFacetSelection(params, facets), [params, facets]);
    const rowParams = useMemo(() => (hideInvalid ? withoutInvalid(scopedParams) : null) ?? scopedParams, [scopedParams, hideInvalid]);
    const filtered = hasFacetSelection(facets);
    const grid = showPnl ? GROUP_GRID_PNL : GROUP_GRID;
    const toggle = () => setExpanded(e => !e);
    const toggleFacet = (dim: FacetKey, value: string) => {
        setFacets(f => toggleFacetValue(f, dim, value));
        setExpanded(true);
    };

    const rowsQuery = useGroupRows({ listUrl, params: rowParams, bounds, sortDir, enabled: expanded });
    const rows = useMemo(() => rowsQuery.data?.pages.flatMap(p => p.results) ?? [], [rowsQuery.data]);
    const remaining = (rowsQuery.data?.pages[0]?.metadata.filtered_count ?? 0) - rows.length;

    const rowKey = `${day.period_start}:${day.date_from}`;
    useEffect(() => {
        onRowsLoaded(rowKey, expanded ? rows : null);
    }, [rowKey, rows, expanded, onRowsLoaded]);
    useEffect(() => () => onRowsLoaded(rowKey, null), [rowKey, onRowsLoaded]);

    const merged = useMemo(() => {
        const items: { tx: Transaction; overlay?: ReviewedOverlayEntry }[] = rows
            .filter(tx => !reviewedOverlay.has(tx.id))
            .map(tx => ({ tx }));
        reviewedOverlay.forEach(entry => {
            if (inBounds(entry.tx, bounds)) items.push({ tx: entry.tx, overlay: entry });
        });
        const dir = sortDir === 'asc' ? 1 : -1;
        return items.sort((a, b) =>
            dir * ((parseApiDate(a.tx.date_time)?.getTime() ?? 0) - (parseApiDate(b.tx.date_time)?.getTime() ?? 0)));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- bounds derived from day
    }, [rows, reviewedOverlay, sortDir, day.date_from, day.date_to]);

    return (
        <>
            <tr>
                <td colSpan={colSpan} className={monthFiltered ? DAY_STICKY_TD_FILTERED : DAY_STICKY_TD}>
                    <div className={cn(VIEWPORT_BOX, 'border-b border-l-4 border-slate-200 border-l-slate-300 bg-slate-100')}>
                        <div
                            className={cn(grid, 'h-9 cursor-pointer px-2 hover:bg-slate-200/70')}
                            role="button"
                            aria-expanded={expanded}
                            tabIndex={0}
                            onClick={toggle}
                            onKeyDown={toggleKeys(toggle)}
                        >
                            <GroupSelect {...props} group={day} params={rowParams} scopeLabel={label} />
                            <span className="inline-flex min-w-0 items-center gap-1 pl-4 text-slate-700">
                                {expanded ? <LuChevronDown size={14} /> : <LuChevronRight size={14} />}
                                <span className="truncate text-sm font-semibold">{label}</span>
                            </span>
                            <GroupStatusCells group={day} showPnl={showPnl} baseCurrency={props.baseCurrency} showInvalid={!hideInvalid} />
                            <GroupAccountsInline group={day} selection={facets} onToggleFacet={toggleFacet} />
                            <MarkReviewedAction {...props} group={day} params={rowParams} scopeLabel={label} />
                        </div>
                        {filtered && (
                            <FilterBarRow grid={grid}>
                                <AppliedFacetsBar
                                    group={day}
                                    selection={facets}
                                    onChange={setFacets}
                                    onApplyToAll={sel => { onApplyFacetsGlobally(sel); setFacets({}); }}
                                />
                            </FilterBarRow>
                        )}
                    </div>
                </td>
            </tr>
            {expanded && rowsQuery.isLoading && (
                <StatusRow colSpan={colSpan}><Spinner size="sm" className="text-blue-500" /> Loading…</StatusRow>
            )}
            {expanded && merged.map(({ tx, overlay }) => overlay ? (
                <tr key={`overlay-${tx.id}`} className="bg-slate-100 text-slate-400">
                    <td colSpan={colSpan} className="px-3 py-1 text-xs">
                        <span className="inline-flex items-center gap-2">
                            <LuCheck size={12} className="text-green-600" />
                            <span className="line-through">#{tx.id} · {tx.linked_asset?.symbol || tx.source_asset_symbol || '—'} · {tx.quantity}</span>
                            <span>marked {overlay.newStatus}</span>
                            <button
                                type="button"
                                className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                                onClick={() => onUndoReviewed(tx.id)}
                            >
                                <LuUndo2 size={12} /> Undo
                            </button>
                        </span>
                    </td>
                </tr>
            ) : (
                <React.Fragment key={tx.id}>{renderRow(tx)}</React.Fragment>
            ))}
            {expanded && rowsQuery.hasNextPage && (
                <tr>
                    <td colSpan={colSpan} className="py-1 pl-8">
                        <button
                            type="button"
                            className="text-xs text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                            disabled={rowsQuery.isFetchingNextPage}
                            onClick={() => rowsQuery.fetchNextPage()}
                        >
                            {rowsQuery.isFetchingNextPage ? 'Loading…' : `Load more (${remaining} left)`}
                        </button>
                    </td>
                </tr>
            )}
        </>
    );
};
