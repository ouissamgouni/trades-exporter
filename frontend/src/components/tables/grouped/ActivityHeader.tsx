import React, { useMemo, useState } from 'react';
import { LuChevronDown, LuChevronLeft, LuChevronRight, LuChevronUp, LuActivity } from 'react-icons/lu';
import { CalendarHeatmap, DailyStats } from '../../CalendarHeatmap';
import { cn } from '../../../lib/cn';
import { localFilterToUtcNaive, toLocalDateKey } from '../../../utils/dateUtils';
import { useTransactionGroups } from './useTransactionGroups';
import type { TransactionGroup } from './types';

interface ActivityHeaderProps {
    groupsUrl: string;
    params: URLSearchParams;
    dateFrom: string;
    dateTo: string;
    onSelectRange: (from: string, to: string) => void;
}

type ActivityView = 'months' | 'year' | 'hidden';

const STORAGE_KEY = 'txActivity:view';
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Same scale as the year heatmap (CalendarHeatmap) so both views read the same way.
const HEAT_COLORS = ['#d1fae5', '#6ee7b7', '#34d399', '#10b981', '#059669'];
const EMPTY_COLOR = '#f1f5f9';

function withoutDates(params: URLSearchParams): URLSearchParams {
    const next = new URLSearchParams(params);
    next.delete('date_from');
    next.delete('date_to');
    return next;
}

function readView(): ActivityView {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'year' || stored === 'hidden' ? stored : 'months';
}

function heatLevel(count: number, max: number): number {
    if (count <= 0) return -1;
    return Math.min(HEAT_COLORS.length - 1, Math.ceil((count / max) * HEAT_COLORS.length) - 1);
}

/** Activity overview above the grouped table: one-line month heatmap or full-year day heatmap. Ignores the date filter so it can be used to navigate. */
export const ActivityHeader: React.FC<ActivityHeaderProps> = ({ groupsUrl, params, dateFrom, dateTo, onSelectRange }) => {
    const [view, setViewState] = useState<ActivityView>(readView);
    const [lastVisible, setLastVisible] = useState<Exclude<ActivityView, 'hidden'>>(() => (readView() === 'year' ? 'year' : 'months'));
    const [year, setYear] = useState(() => new Date().getFullYear());
    const baseParams = useMemo(() => withoutDates(params), [params]);

    const setView = (next: ActivityView) => {
        if (next !== 'hidden') setLastVisible(next);
        setViewState(next);
        try { localStorage.setItem(STORAGE_KEY, next); } catch { }
    };

    const yearBounds = useMemo(() => ({
        from: localFilterToUtcNaive(`${year}-01-01`, 'start'),
        to: localFilterToUtcNaive(`${year}-12-31`, 'end'),
    }), [year]);

    const months = useTransactionGroups({
        groupsUrl,
        params: baseParams,
        granularity: 'month',
        sortDir: 'asc',
        bounds: yearBounds,
        pageSize: 12,
        enabled: view === 'months',
    });
    const days = useTransactionGroups({
        groupsUrl,
        params: baseParams,
        granularity: 'day',
        sortDir: 'asc',
        bounds: yearBounds,
        pageSize: 366,
        enabled: view === 'year',
    });

    const monthCells = useMemo(() => {
        const byStart = new Map<string, TransactionGroup>((months.data?.pages[0]?.groups ?? []).map(g => [g.period_start, g]));
        return MONTH_NAMES.map((name, i) => {
            const from = toLocalDateKey(new Date(year, i, 1));
            return { name, from, to: toLocalDateKey(new Date(year, i + 1, 0)), group: byStart.get(from) };
        });
    }, [months.data, year]);
    const maxCount = Math.max(1, ...monthCells.map(c => c.group?.total_count ?? 0));

    const dailyStats: DailyStats[] = useMemo(() => (days.data?.pages[0]?.groups ?? []).map(g => ({
        date: g.period_start,
        count: g.total_count,
        volume: 0,
        inflow_count: g.accounts.reduce((s, a) => s + a.inflow_count, 0),
        outflow_count: g.accounts.reduce((s, a) => s + a.outflow_count, 0),
    })), [days.data]);

    const selectedFrom = dateFrom.split('T')[0];
    const selectedTo = dateTo.split('T')[0];
    const selectedDay = selectedFrom && selectedFrom === selectedTo ? selectedFrom : null;
    const visible = view !== 'hidden';

    return (
        <div className="mb-2 border border-slate-200 bg-white px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    aria-expanded={visible}
                    className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700 hover:text-blue-600"
                    onClick={() => setView(visible ? 'hidden' : lastVisible)}
                >
                    <LuActivity size={14} /> Activity
                    {visible ? <LuChevronUp size={14} /> : <LuChevronDown size={14} />}
                </button>
                {visible && (
                    <>
                        <span className="inline-flex text-xs" role="group" aria-label="Activity view">
                            {(['months', 'year'] as const).map(v => (
                                <button
                                    key={v}
                                    type="button"
                                    aria-pressed={view === v}
                                    onClick={() => setView(v)}
                                    className={cn(
                                        'border px-2 py-0.5 first:border-r-0',
                                        view === v ? 'border-slate-700 bg-slate-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
                                    )}
                                >
                                    {v === 'months' ? 'Months' : 'Year'}
                                </button>
                            ))}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <button type="button" aria-label="Previous year" className="p-0.5 text-slate-500 hover:text-blue-600" onClick={() => setYear(y => y - 1)}>
                                <LuChevronLeft size={14} />
                            </button>
                            <span className="text-sm font-medium tabular-nums text-slate-700">{year}</span>
                            <button type="button" aria-label="Next year" className="p-0.5 text-slate-500 hover:text-blue-600" onClick={() => setYear(y => y + 1)}>
                                <LuChevronRight size={14} />
                            </button>
                        </span>
                        <span className="text-xs text-slate-400">Click a {view === 'year' ? 'day' : 'month'} to focus on it</span>
                    </>
                )}
            </div>

            {view === 'months' && (
                <div className="mt-2 grid grid-cols-12 gap-1" role="list" aria-label={`Transactions per month in ${year}`}>
                    {monthCells.map(cell => {
                        const count = cell.group?.total_count ?? 0;
                        const pending = cell.group?.pending_count ?? 0;
                        const level = heatLevel(count, maxCount);
                        const isSelected = selectedFrom === cell.from && selectedTo === cell.to;
                        const label = `${cell.name} ${year}: ${count} transactions${pending ? `, ${pending} pending` : ''}`;
                        return (
                            <button
                                key={cell.from}
                                type="button"
                                role="listitem"
                                aria-label={label}
                                title={label}
                                disabled={count === 0 && !cell.group?.invalid_count}
                                className={cn(
                                    'flex flex-col items-stretch gap-0.5 text-left disabled:cursor-default',
                                    isSelected && 'outline outline-2 outline-offset-1 outline-blue-500',
                                )}
                                onClick={() => onSelectRange(cell.from, cell.to)}
                            >
                                <span
                                    className={cn('relative flex h-7 items-center justify-center text-xs font-medium tabular-nums', level >= 3 ? 'text-white' : 'text-slate-700')}
                                    style={{ backgroundColor: level < 0 ? EMPTY_COLOR : HEAT_COLORS[level] }}
                                >
                                    {count > 0 ? count : ''}
                                    {pending > 0 && (
                                        <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" aria-hidden />
                                    )}
                                </span>
                                <span className="text-center text-[11px] text-slate-500">{cell.name}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {view === 'year' && (
                <CalendarHeatmap
                    year={year}
                    data={dailyStats}
                    selectedDate={selectedDay}
                    onDateClick={(date) => onSelectRange(date, date)}
                    isLoading={days.isLoading}
                />
            )}
        </div>
    );
};
