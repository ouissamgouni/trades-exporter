import React, { useEffect, useMemo, useState } from 'react';
import { LuChevronDown, LuChevronRight, LuFilter, LuCheck, LuUndo2 } from 'react-icons/lu';
import type { Transaction } from '../../../types';
import { Spinner } from '../../ui/primitives';
import { cn } from '../../../lib/cn';
import { formatDayLabel, formatMonthLabel, parseApiDate } from '../../../utils/dateUtils';
import { toaster } from '../../ui/toaster';
import { GroupAccountsInline, GroupAccountsRecap, GroupStatusSummary } from './GroupRecap';
import { GroupFacetBar } from './GroupFacetBar';
import {
    applyFacetSelection,
    groupRowCount,
    hasFacetSelection,
    shouldAutoExpandDays,
    shouldAutoShowFacetBar,
} from './groupUtils';
import { fetchGroupIds, PeriodBounds, useGroupRows, useTransactionGroups } from './useTransactionGroups';
import type { GroupFacetSelection, TransactionGroup } from './types';

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
}

type SharedProps = Omit<GroupedTransactionsBodyProps, 'groupsUrl' | 'params' | 'sortDir' | 'colSpan' | 'emptyMessage'> & {
    groupsUrl: string;
    sortDir: 'asc' | 'desc';
    colSpan: number;
};

const boundsOf = (g: TransactionGroup): PeriodBounds => ({ from: g.date_from, to: g.date_to });

function inBounds(tx: Transaction, bounds: PeriodBounds): boolean {
    const d = parseApiDate(tx.date_time);
    if (!d) return false;
    const key = d.toISOString().replace('Z', '');
    return key >= bounds.from && key <= bounds.to;
}

export const GroupedTransactionsBody: React.FC<GroupedTransactionsBodyProps> = ({ params, emptyMessage, ...shared }) => {
    const months = useTransactionGroups({
        groupsUrl: shared.groupsUrl,
        params,
        granularity: 'month',
        sortDir: shared.sortDir,
    });

    const groups = useMemo(() => months.data?.pages.flatMap(p => p.groups) ?? [], [months.data]);
    const total = months.data?.pages[0]?.total_groups ?? 0;

    if (months.isLoading) {
        return <StatusRow colSpan={shared.colSpan}><Spinner size="sm" className="text-blue-500" /> Loading months…</StatusRow>;
    }
    if (months.error) {
        return <StatusRow colSpan={shared.colSpan}><span className="text-red-600">Failed to load groups.</span></StatusRow>;
    }
    if (groups.length === 0) {
        return <StatusRow colSpan={shared.colSpan}>{emptyMessage || 'No transactions found'}</StatusRow>;
    }

    return (
        <>
            {groups.map((month, i) => (
                <MonthSection key={month.period_start} month={month} defaultExpanded={i === 0} params={params} {...shared} />
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

/** Header checkbox + inbox "mark reviewed" for a period. */
const GroupActions: React.FC<SharedProps & { group: TransactionGroup; params: URLSearchParams; scopeLabel: string }> = ({
    group, params, scopeLabel, idsUrl, selectable, selectedIds, setSelectedIds, onMarkGroupReviewed,
}) => {
    const [groupIds, setGroupIds] = useState<number[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState(false);

    const loadIds = async () => {
        if (!idsUrl) return [];
        const result = await fetchGroupIds(idsUrl, params, boundsOf(group));
        if (result.truncated) {
            toaster.info({ title: 'Selection capped', description: `Only the first ${result.ids.length} of ${result.total} transactions were selected.` });
        }
        setGroupIds(result.ids);
        return result.ids;
    };

    const allSelected = !!groupIds && groupIds.length > 0 && groupIds.every(id => selectedIds.has(id));

    const toggleSelectGroup = async () => {
        setBusy(true);
        try {
            const ids = allSelected ? groupIds! : await loadIds();
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

    const markReviewed = async () => {
        if (!onMarkGroupReviewed) return;
        setBusy(true);
        try {
            await onMarkGroupReviewed(await loadIds());
        } finally {
            setBusy(false);
            setConfirming(false);
        }
    };

    return (
        <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
            {selectable && idsUrl && (
                <input
                    type="checkbox"
                    aria-label={`Select all ${groupRowCount(group)} in ${scopeLabel}`}
                    title={`Select all ${groupRowCount(group)} in ${scopeLabel}`}
                    className="h-3.5 w-3.5 cursor-pointer accent-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                    checked={allSelected}
                    disabled={busy}
                    onChange={toggleSelectGroup}
                />
            )}
            {onMarkGroupReviewed && idsUrl && group.pending_count > 0 && (
                confirming ? (
                    <span className="inline-flex items-center gap-1 text-[10px]">
                        <button
                            type="button"
                            className="bg-blue-500 px-1.5 py-0.5 text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
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
                        className="inline-flex items-center gap-0.5 border border-slate-200 bg-white px-1 py-0.5 text-[10px] text-slate-700 hover:bg-slate-50"
                        title={`Mark all pending in ${scopeLabel} as valid`}
                        onClick={() => setConfirming(true)}
                    >
                        <LuCheck size={10} /> Mark reviewed
                    </button>
                )
            )}
        </span>
    );
};

const FacetToggle: React.FC<{ active: boolean; open: boolean; onClick: () => void }> = ({ active, open, onClick }) => (
    <button
        type="button"
        aria-label="Filter this group"
        aria-pressed={open}
        title="Filter this group"
        className={cn('inline-flex items-center p-0.5', active ? 'text-blue-600' : 'text-slate-400 hover:text-blue-600')}
        onClick={e => { e.stopPropagation(); onClick(); }}
    >
        <LuFilter size={11} />
    </button>
);

const MonthSection: React.FC<SharedProps & { month: TransactionGroup; defaultExpanded: boolean; params: URLSearchParams }> = (props) => {
    const { month, defaultExpanded, params, colSpan, onApplyFacetsGlobally } = props;
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [facets, setFacets] = useState<GroupFacetSelection>({});
    const [showFacets, setShowFacets] = useState(() => shouldAutoShowFacetBar(month));
    const [expandAllDays, setExpandAllDays] = useState(() => shouldAutoExpandDays(month));
    const [expandVersion, setExpandVersion] = useState(0);
    const label = formatMonthLabel(month.period_start);
    const scopedParams = useMemo(() => applyFacetSelection(params, facets), [params, facets]);

    const days = useTransactionGroups({
        groupsUrl: props.groupsUrl,
        params: scopedParams,
        granularity: 'day',
        sortDir: props.sortDir,
        bounds: boundsOf(month),
        enabled: expanded,
        pageSize: 31,
    });
    const dayGroups = useMemo(() => days.data?.pages.flatMap(p => p.groups) ?? [], [days.data]);

    return (
        <>
            <tr className="border-t-2 border-slate-300 bg-slate-100">
                <td colSpan={colSpan} className="px-2 py-1.5">
                    <div
                        className="flex cursor-pointer flex-wrap items-start gap-x-3 gap-y-1"
                        role="button"
                        aria-expanded={expanded}
                        tabIndex={0}
                        onClick={() => setExpanded(e => !e)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(x => !x); } }}
                    >
                        <span className="inline-flex items-center gap-1">
                            {expanded ? <LuChevronDown size={14} /> : <LuChevronRight size={14} />}
                            <span className="text-sm font-semibold text-slate-800">{label}</span>
                        </span>
                        <GroupStatusSummary group={month} baseCurrency={props.baseCurrency} />
                        <GroupActions {...props} group={month} params={scopedParams} scopeLabel={label} />
                        <FacetToggle active={hasFacetSelection(facets)} open={showFacets} onClick={() => setShowFacets(s => !s)} />
                        {expanded && (
                            <button
                                type="button"
                                className="text-[10px] text-slate-500 hover:text-blue-600"
                                onClick={e => {
                                    e.stopPropagation();
                                    setExpandAllDays(v => !v);
                                    setExpandVersion(v => v + 1);
                                }}
                            >
                                {expandAllDays ? 'Collapse all days' : 'Expand all days'}
                            </button>
                        )}
                    </div>
                    <div className="mt-1 pl-5">
                        <GroupAccountsRecap group={month} />
                        {showFacets && (
                            <GroupFacetBar
                                group={month}
                                scopeLabel="month"
                                selection={facets}
                                onChange={setFacets}
                                onApplyToAll={sel => { onApplyFacetsGlobally(sel); setFacets({}); }}
                            />
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
                    defaultExpanded={expandAllDays}
                />
            ))}
            {expanded && !days.isLoading && dayGroups.length === 0 && (
                <StatusRow colSpan={colSpan}>No transactions match the month filters</StatusRow>
            )}
        </>
    );
};

const DaySection: React.FC<SharedProps & { day: TransactionGroup; params: URLSearchParams; defaultExpanded: boolean }> = (props) => {
    const {
        day, params, defaultExpanded, colSpan, listUrl, sortDir, renderRow, onRowsLoaded,
        reviewedOverlay, onUndoReviewed, onApplyFacetsGlobally,
    } = props;
    const [expanded, setExpanded] = useState(defaultExpanded);
    const [facets, setFacets] = useState<GroupFacetSelection>({});
    const [showFacets, setShowFacets] = useState(() => shouldAutoShowFacetBar(day));
    const label = formatDayLabel(day.period_start);
    const bounds = boundsOf(day);
    const scopedParams = useMemo(() => applyFacetSelection(params, facets), [params, facets]);

    const rowsQuery = useGroupRows({ listUrl, params: scopedParams, bounds, sortDir, enabled: expanded });
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
            <tr className="bg-slate-50">
                <td colSpan={colSpan} className="sticky top-0 z-[6] border-b border-slate-200 bg-slate-50 px-2 py-1 pl-6">
                    <div
                        className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5"
                        role="button"
                        aria-expanded={expanded}
                        tabIndex={0}
                        onClick={() => setExpanded(e => !e)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(x => !x); } }}
                    >
                        <span className="inline-flex items-center gap-1">
                            {expanded ? <LuChevronDown size={12} /> : <LuChevronRight size={12} />}
                            <span className="text-xs font-semibold text-slate-700">{label}</span>
                        </span>
                        <GroupStatusSummary group={day} baseCurrency={props.baseCurrency} />
                        <GroupAccountsInline group={day} />
                        <GroupActions {...props} group={day} params={scopedParams} scopeLabel={label} />
                        <FacetToggle active={hasFacetSelection(facets)} open={showFacets} onClick={() => setShowFacets(s => !s)} />
                    </div>
                    {showFacets && (
                        <div className="pl-4">
                            <GroupFacetBar
                                group={day}
                                scopeLabel="day"
                                selection={facets}
                                onChange={setFacets}
                                onApplyToAll={sel => { onApplyFacetsGlobally(sel); setFacets({}); }}
                            />
                        </div>
                    )}
                </td>
            </tr>
            {expanded && rowsQuery.isLoading && (
                <StatusRow colSpan={colSpan}><Spinner size="sm" className="text-blue-500" /> Loading…</StatusRow>
            )}
            {expanded && merged.map(({ tx, overlay }) => overlay ? (
                <tr key={`overlay-${tx.id}`} className="bg-slate-100 text-slate-400">
                    <td colSpan={colSpan} className="px-3 py-1 text-[10px]">
                        <span className="inline-flex items-center gap-2">
                            <LuCheck size={10} className="text-green-600" />
                            <span className="line-through">#{tx.id} · {tx.linked_asset?.symbol || tx.source_asset_symbol || '—'} · {tx.quantity}</span>
                            <span>marked {overlay.newStatus}</span>
                            <button
                                type="button"
                                className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
                                onClick={() => onUndoReviewed(tx.id)}
                            >
                                <LuUndo2 size={10} /> Undo
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
                            className="text-[10px] text-blue-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
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
