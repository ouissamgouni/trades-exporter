import React, { useEffect, useMemo, useState } from 'react';
import { LuChevronLeft, LuChevronRight, LuPlus, LuRefreshCw, LuSearch, LuSparkles, LuX } from 'react-icons/lu';
import { Button, Input, Spinner } from '../ui/primitives';
import { TABLE_HEAD } from '../../lib/ui';
import { MappingFilters, MappingOverview, MappingStatus } from '../../utils/mappingApi';
import { STATUS_META } from './mappingUi';

export interface WorkbenchColumn<T> {
    key: string;
    header: React.ReactNode;
    className?: string;
    render: (row: T) => React.ReactNode;
}

const TABS: (MappingStatus | '')[] = ['suggested', 'unmapped', 'mapped', 'ignored', ''];
const PAGE_SIZE = 50;

const EMPTY: Record<MappingStatus | '', string> = {
    suggested: 'No pending suggestions.',
    unmapped: 'Nothing left to map by hand.',
    mapped: 'No mappings yet.',
    ignored: 'Nothing ignored.',
    '': 'No rows match.',
};

interface MappingWorkbenchProps<T> {
    title: string;
    description: React.ReactNode;
    overview?: MappingOverview<T>;
    isLoading: boolean;
    isFetching: boolean;
    error?: Error | null;
    filters: MappingFilters;
    onFiltersChange: (f: MappingFilters) => void;
    onRefresh: () => void;
    columns: WorkbenchColumn<T>[];
    rowKey: (row: T) => string;
    selectedKey?: string | null;
    onRowClick: (row: T) => void;
    rowClassName?: (row: T) => string;
    searchPlaceholder: string;
    verifiedCount: number;
    onAcceptVerified: () => void;
    accepting: boolean;
    onAdd: () => void;
}

export function MappingWorkbench<T>({
    title,
    description,
    overview,
    isLoading,
    isFetching,
    error,
    filters,
    onFiltersChange,
    onRefresh,
    columns,
    rowKey,
    selectedKey,
    onRowClick,
    rowClassName,
    searchPlaceholder,
    verifiedCount,
    onAcceptVerified,
    accepting,
    onAdd,
}: MappingWorkbenchProps<T>) {
    const [search, setSearch] = useState(filters.q ?? '');
    const [page, setPage] = useState(0);

    // Debounce search into the server-side filter
    useEffect(() => {
        const t = setTimeout(() => {
            if ((filters.q ?? '') !== search) onFiltersChange({ ...filters, q: search });
        }, 250);
        return () => clearTimeout(t);
    }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { setPage(0); }, [filters.status, filters.q, filters.source, filters.network]);

    const items = overview?.items ?? [];
    const counts = overview?.counts;
    const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
    const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const rows = useMemo(() => items.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE), [items, safePage]);
    const hasScopeFilter = !!(filters.q || filters.source || filters.network);

    const selectCls = 'h-8 border border-slate-200 bg-white px-2 text-xs text-slate-700';

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold text-slate-800">{title}</h2>
                    <p className="text-xs text-slate-500">{description}</p>
                </div>
                <div className="flex items-center gap-2">
                    {verifiedCount > 0 && (
                        <Button
                            size="sm"
                            colorScheme="green"
                            leftIcon={<LuSparkles size={14} />}
                            loading={accepting}
                            disabled={accepting}
                            onClick={onAcceptVerified}
                        >
                            Accept {verifiedCount} verified
                        </Button>
                    )}
                    <Button size="sm" colorScheme="blue" leftIcon={<LuPlus size={14} />} onClick={onAdd}>
                        Add mapping
                    </Button>
                    <Button size="sm" variant="outline" aria-label="Refresh" onClick={onRefresh} disabled={isFetching}>
                        <LuRefreshCw size={14} className={isFetching ? 'animate-spin' : undefined} />
                    </Button>
                </div>
            </div>

            <div role="tablist" aria-label="Mapping status" className="flex flex-wrap border-b border-slate-200">
                {TABS.map((tab) => {
                    const active = (filters.status ?? '') === tab;
                    const count = tab ? counts?.[tab] : total;
                    return (
                        <button
                            key={tab || 'all'}
                            role="tab"
                            aria-selected={active}
                            type="button"
                            onClick={() => onFiltersChange({ ...filters, status: tab })}
                            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium ${active
                                ? 'border-blue-500 text-blue-700'
                                : 'border-transparent text-slate-500 hover:text-slate-800'
                                }`}
                        >
                            {tab ? STATUS_META[tab].label : 'All'}
                            <span className={`px-1.5 text-[10px] tabular-nums ${active ? 'bg-blue-500 text-white' : 'bg-slate-100 text-slate-600'}`}>
                                {count ?? '…'}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                    <LuSearch size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                    <Input
                        aria-label="Search mappings"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={searchPlaceholder}
                        className="h-8 pl-7 text-xs"
                    />
                </div>
                <select
                    aria-label="Source"
                    className={selectCls}
                    value={filters.source ?? ''}
                    onChange={(e) => onFiltersChange({ ...filters, source: e.target.value })}
                >
                    <option value="">All sources</option>
                    {overview?.sources.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <select
                    aria-label="Network"
                    className={selectCls}
                    value={filters.network ?? ''}
                    onChange={(e) => onFiltersChange({ ...filters, network: e.target.value })}
                >
                    <option value="">All networks</option>
                    {overview?.networks.map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
                {hasScopeFilter && (
                    <Button
                        size="xs"
                        variant="ghost"
                        leftIcon={<LuX size={12} />}
                        onClick={() => { setSearch(''); onFiltersChange({ status: filters.status }); }}
                    >
                        Clear
                    </Button>
                )}
                {isFetching && !isLoading && <Spinner size="sm" className="text-slate-400" />}
            </div>

            <div className="overflow-x-auto border border-slate-200 bg-white">
                {isLoading ? (
                    <div className="flex justify-center py-12"><Spinner size="lg" className="text-blue-500" /></div>
                ) : error ? (
                    <div className="bg-red-50 py-10 text-center text-xs text-red-600">{error.message}</div>
                ) : (
                    <table className="w-full text-xs">
                        <thead className={TABLE_HEAD}>
                            <tr>
                                {columns.map((c) => (
                                    <th key={c.key} className={`px-3 py-2 text-left ${c.className ?? ''}`}>{c.header}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr>
                                    <td colSpan={columns.length} className="py-10 text-center text-slate-500">
                                        {hasScopeFilter ? 'No rows match these filters.' : EMPTY[filters.status ?? '']}
                                    </td>
                                </tr>
                            ) : rows.map((row) => {
                                const key = rowKey(row);
                                const selected = key === selectedKey;
                                return (
                                    <tr
                                        key={key}
                                        tabIndex={0}
                                        aria-selected={selected}
                                        onClick={() => onRowClick(row)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') onRowClick(row); }}
                                        className={`cursor-pointer border-t border-slate-100 focus:outline-none focus-visible:bg-blue-50 ${selected ? 'bg-blue-50' : 'hover:bg-slate-50'} ${rowClassName?.(row) ?? ''}`}
                                    >
                                        {columns.map((c) => (
                                            <td key={c.key} className={`px-3 py-2 align-middle ${c.className ?? ''}`}>{c.render(row)}</td>
                                        ))}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
                {items.length > PAGE_SIZE && (
                    <div className="flex items-center justify-between border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
                        <span>
                            {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, items.length)} of {items.length}
                        </span>
                        <div className="flex items-center gap-1">
                            <Button size="xs" variant="ghost" aria-label="Previous page" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                                <LuChevronLeft size={14} />
                            </Button>
                            <span>{safePage + 1} / {pageCount}</span>
                            <Button size="xs" variant="ghost" aria-label="Next page" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
                                <LuChevronRight size={14} />
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
