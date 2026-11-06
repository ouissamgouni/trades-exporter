import React, { useMemo, useState } from 'react';
import { LuChevronDown, LuChevronLeft, LuChevronRight, LuChevronUp, LuActivity } from 'react-icons/lu';
import { CalendarHeatmap, DailyStats } from '../../CalendarHeatmap';
import { cn } from '../../../lib/cn';
import { formatMonthLabel, localFilterToUtcNaive, toLocalDateKey } from '../../../utils/dateUtils';
import { useTransactionGroups } from './useTransactionGroups';

interface ActivityHeaderProps {
    groupsUrl: string;
    params: URLSearchParams;
    dateFrom: string;
    dateTo: string;
    onSelectRange: (from: string, to: string) => void;
}

const STORAGE_KEY = 'txActivity:expanded';
const STRIP_MONTHS = 36;

function withoutDates(params: URLSearchParams): URLSearchParams {
    const next = new URLSearchParams(params);
    next.delete('date_from');
    next.delete('date_to');
    return next;
}

function monthRange(periodStart: string): { from: string; to: string } {
    const [y, m] = periodStart.split('-').map(Number);
    return { from: periodStart, to: toLocalDateKey(new Date(y, m, 0)) };
}

/** Activity overview above the grouped table: month strip (collapsed) or year heatmap (expanded). Ignores the date filter so it can be used to navigate. */
export const ActivityHeader: React.FC<ActivityHeaderProps> = ({ groupsUrl, params, dateFrom, dateTo, onSelectRange }) => {
    const [expanded, setExpanded] = useState(() => localStorage.getItem(STORAGE_KEY) === '1');
    const [year, setYear] = useState(() => new Date().getFullYear());
    const baseParams = useMemo(() => withoutDates(params), [params]);

    const toggle = () => {
        setExpanded(prev => {
            try { localStorage.setItem(STORAGE_KEY, prev ? '0' : '1'); } catch { }
            return !prev;
        });
    };

    const months = useTransactionGroups({
        groupsUrl,
        params: baseParams,
        granularity: 'month',
        sortDir: 'desc',
        pageSize: STRIP_MONTHS,
        enabled: !expanded,
    });
    const monthGroups = useMemo(
        () => [...(months.data?.pages[0]?.groups ?? [])].reverse(),
        [months.data],
    );
    const maxCount = Math.max(1, ...monthGroups.map(g => g.total_count + g.invalid_count));

    const yearBounds = useMemo(() => ({
        from: localFilterToUtcNaive(`${year}-01-01`, 'start'),
        to: localFilterToUtcNaive(`${year}-12-31`, 'end'),
    }), [year]);
    const days = useTransactionGroups({
        groupsUrl,
        params: baseParams,
        granularity: 'day',
        sortDir: 'asc',
        bounds: yearBounds,
        pageSize: 366,
        enabled: expanded,
    });
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

    return (
        <div className="mb-2 border border-slate-200 bg-white px-2 py-1.5">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    aria-expanded={expanded}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 hover:text-blue-600"
                    onClick={toggle}
                >
                    <LuActivity size={12} /> Activity
                    {expanded ? <LuChevronUp size={12} /> : <LuChevronDown size={12} />}
                </button>
                {expanded && (
                    <span className="inline-flex items-center gap-1">
                        <button type="button" aria-label="Previous year" className="p-0.5 text-slate-500 hover:text-blue-600" onClick={() => setYear(y => y - 1)}>
                            <LuChevronLeft size={12} />
                        </button>
                        <span className="text-[11px] tabular-nums text-slate-700">{year}</span>
                        <button type="button" aria-label="Next year" className="p-0.5 text-slate-500 hover:text-blue-600" onClick={() => setYear(y => y + 1)}>
                            <LuChevronRight size={12} />
                        </button>
                    </span>
                )}
                <span className="text-[10px] text-slate-400">Click a {expanded ? 'day' : 'month'} to focus on it</span>
            </div>

            {!expanded && (
                <div className="mt-1 flex h-10 items-end gap-px" role="list" aria-label="Transactions per month">
                    {monthGroups.map(g => {
                        const range = monthRange(g.period_start);
                        const isSelected = selectedFrom === range.from && selectedTo === range.to;
                        const totalH = ((g.total_count + g.invalid_count) / maxCount) * 100;
                        const pendingShare = g.total_count ? g.pending_count / g.total_count : 0;
                        const label = `${formatMonthLabel(g.period_start)}: ${g.total_count} (${g.pending_count} pending)`;
                        return (
                            <button
                                key={g.period_start}
                                type="button"
                                role="listitem"
                                aria-label={label}
                                title={label}
                                className={cn('flex h-full min-w-[4px] flex-1 flex-col justify-end', isSelected && 'outline outline-1 outline-blue-500')}
                                onClick={() => onSelectRange(range.from, range.to)}
                            >
                                <span className="flex w-full flex-col" style={{ height: `${Math.max(totalH, 4)}%` }}>
                                    <span className="w-full bg-yellow-400" style={{ height: `${pendingShare * 100}%` }} />
                                    <span className="w-full flex-1 bg-green-500" />
                                </span>
                            </button>
                        );
                    })}
                    {!months.isLoading && monthGroups.length === 0 && (
                        <span className="text-[10px] text-slate-400">No activity</span>
                    )}
                </div>
            )}

            {expanded && (
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
