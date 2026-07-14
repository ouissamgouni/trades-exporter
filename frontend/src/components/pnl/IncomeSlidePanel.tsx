/**
 * IncomeSlidePanel — Slide panel for Income Events (dividends, interest, etc.)
 *
 * Features:
 * - Backend pagination with inline pagination bar
 * - Filters by asset, income type, account, jurisdiction, date range
 * - Server-side sorting by date and amount
 */

import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Badge } from '../ui/primitives';
import { FiChevronLeft, FiChevronRight } from 'react-icons/fi';
import { LuBanknote, LuFilter, LuX } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { ValueDisplay } from '../ValueDisplay';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import type { IncomeEventItem, IncomeFilterOptionsResponse } from '../../hooks/useChartData';

/* ─── Props ─── */

export interface IncomeSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    onAssetClick?: (assetId: number) => void;
}

/* ─── Constants ─── */

const PAGE_SIZE = 50;

const fmtDate = (iso: string | null) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

/* ═══════════════════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════════════════ */

export const IncomeSlidePanel: React.FC<IncomeSlidePanelProps> = ({
    isOpen, onClose, versionId, baseCurrency, onAssetClick,
}) => {
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const pagination = usePagination({ storageKey: 'pnl_income_slide' });

    // Filters
    const [assetFilter, setAssetFilter] = useState<string>('');
    const [typeFilter, setTypeFilter] = useState<string>('');
    const [accountFilter, setAccountFilter] = useState<string>('');
    const [jurisdictionFilter, setJurisdictionFilter] = useState<string>('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [sortBy, setSortBy] = useState<string>('date');
    const [sortOrder, setSortOrder] = useState<string>('desc');

    const handleSort = (field: string) => {
        if (sortBy === field) {
            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(field);
            setSortOrder('desc');
        }
    };

    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = {};
        if (assetFilter) params.asset_id = Number(assetFilter);
        if (typeFilter) params.income_type = typeFilter;
        if (accountFilter) params.account_id = Number(accountFilter);
        if (jurisdictionFilter) params.jurisdiction = jurisdictionFilter;
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;
        if (sortBy) { params.sort_by = sortBy; params.order = sortOrder; }
        return params;
    }, [assetFilter, typeFilter, accountFilter, jurisdictionFilter, dateFrom, dateTo, sortBy, sortOrder]);

    // Reset page on filter change
    const prevRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevRef.current !== serverParams) { pagination.setPage(1); prevRef.current = serverParams; }
    }, [serverParams]);

    const { data: entries, total, isLoading, error } = useLazyPaginatedQuery<IncomeEventItem>({
        endpoint: `/pnl/versions/${versionId}/income-events`,
        page: pagination.page,
        limit: pagination.pageSize || PAGE_SIZE,
        params: serverParams,
        lazy: true,
        enabled: isOpen,
    });

    useEffect(() => { pagination.setTotal(total); }, [total]);

    // Filter options
    const [filterOpts, setFilterOpts] = useState<IncomeFilterOptionsResponse | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        fetch(`${API_URL}/pnl/versions/${versionId}/income-events/filter-options`)
            .then(r => r.json())
            .then(setFilterOpts)
            .catch(() => { });
    }, [versionId, isOpen]);

    const hasAnyFilter = !!assetFilter || !!typeFilter || !!accountFilter || !!jurisdictionFilter || !!dateFrom || !!dateTo;

    const clearFilters = () => {
        setAssetFilter('');
        setTypeFilter('');
        setAccountFilter('');
        setJurisdictionFilter('');
        setDateFrom('');
        setDateTo('');
    };

    // Totals from visible rows
    const visibleTotals = useMemo(() => {
        let gross = 0, wht = 0, net = 0;
        for (const e of entries) {
            gross += e.gross_amount_in_base;
            wht += e.withholding_amount_in_base;
            net += e.net_amount_in_base;
        }
        return { gross, wht, net };
    }, [entries]);

    const pageCount = Math.ceil(total / (pagination.pageSize || PAGE_SIZE));

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Income Events" titleIcon={<LuBanknote size={18} />} width="800px">
            <div className="p-4">
                {/* Summary bar */}
                <div className="mb-4 flex flex-wrap items-center gap-4 bg-teal-50 p-3">
                    <div>
                        <span className="block text-xs text-slate-500">Total Events</span>
                        <span className="block font-bold text-teal-700">{total}</span>
                    </div>
                    <div>
                        <span className="block text-xs text-slate-500">Gross Income</span>
                        <span className="block font-bold text-teal-700">
                            <ValueDisplay value={visibleTotals.gross} currency={baseCurrency} />
                        </span>
                    </div>
                    <div>
                        <span className="block text-xs text-slate-500">Withholding</span>
                        <span className="block font-bold text-red-500">
                            <ValueDisplay value={-visibleTotals.wht} currency={baseCurrency} />
                        </span>
                    </div>
                    <div>
                        <span className="block text-xs text-slate-500">Net Income</span>
                        <span className="block font-bold text-teal-700">
                            <ValueDisplay value={visibleTotals.net} currency={baseCurrency} />
                        </span>
                    </div>
                </div>

                {/* Filter row */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <LuFilter size={14} />
                    {filterOpts?.assets && filterOpts.assets.length > 0 && (
                        <select
                            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                            value={assetFilter} onChange={(e) => setAssetFilter(e.target.value)}>
                            <option value="">All Assets</option>
                            {filterOpts.assets.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </select>
                    )}
                    {filterOpts?.income_types && filterOpts.income_types.length > 1 && (
                        <select
                            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                            value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                            <option value="">All Types</option>
                            {filterOpts.income_types.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </select>
                    )}
                    {filterOpts?.accounts && filterOpts.accounts.length > 1 && (
                        <select
                            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                            value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
                            <option value="">All Accounts</option>
                            {filterOpts.accounts.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </select>
                    )}
                    {filterOpts?.jurisdictions && filterOpts.jurisdictions.length > 0 && (
                        <select
                            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                            value={jurisdictionFilter} onChange={(e) => setJurisdictionFilter(e.target.value)}>
                            <option value="">All Countries</option>
                            {filterOpts.jurisdictions.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </select>
                    )}
                    {hasAnyFilter && (
                        <button type="button" onClick={clearFilters} className="flex cursor-pointer items-center gap-1 text-xs text-red-500">
                            <LuX size={12} /> Clear
                        </button>
                    )}
                </div>

                {/* Table */}
                {isLoading ? (
                    <TabLoadingState message="Loading income events..." />
                ) : error ? (
                    <TabErrorState error={error} />
                ) : entries.length === 0 ? (
                    <TabEmptyState title="No income events found" description="No income events match the current filters." />
                ) : (
                    <>
                        <div className="mb-3 overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="bg-slate-50">
                                        <th className="cursor-pointer whitespace-nowrap px-2 py-1 text-left" onClick={() => handleSort('date')}>
                                            Date {sortBy === 'date' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                                        </th>
                                        <th className="px-2 py-1 text-left">Asset</th>
                                        <th className="px-2 py-1 text-left">Type</th>
                                        <th className="px-2 py-1 text-left">Account</th>
                                        <th className="cursor-pointer whitespace-nowrap px-2 py-1 text-right" onClick={() => handleSort('amount')}>
                                            Gross {sortBy === 'amount' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                                        </th>
                                        <th className="px-2 py-1 text-right">WHT</th>
                                        <th className="px-2 py-1 text-right">Net</th>
                                        <th className="px-2 py-1 text-left">Country</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {entries.map(e => {
                                        const asset = e.attributed_asset ?? e.asset;
                                        const assetId = asset?.id;
                                        return (
                                            <tr key={e.id} className="border-b border-slate-100 hover:bg-slate-50">
                                                <td className="whitespace-nowrap px-2 py-1.5">{fmtDate(e.income_at)}</td>
                                                <td className="px-2 py-1.5">
                                                    <span
                                                        className={`text-xs font-semibold text-blue-600 ${assetId ? 'cursor-pointer hover:underline' : ''}`}
                                                        onClick={() => {
                                                            if (assetId && assetPanelCtx) {
                                                                assetPanelCtx.openAssetPanel(assetId, { pnlVersionId: versionId });
                                                            } else if (assetId && onAssetClick) {
                                                                onAssetClick(assetId);
                                                            }
                                                        }}
                                                    >
                                                        {asset?.symbol || '—'}
                                                    </span>
                                                </td>
                                                <td className="px-2 py-1.5">
                                                    <Badge colorScheme="green">
                                                        {e.income_type}
                                                    </Badge>
                                                </td>
                                                <td className="px-2 py-1.5 text-slate-600">{e.account_name || '—'}</td>
                                                <td className="px-2 py-1.5 text-right font-medium text-teal-700">
                                                    <ValueDisplay value={e.gross_amount_in_base} currency={baseCurrency} />
                                                </td>
                                                <td className="px-2 py-1.5 text-right text-red-500">
                                                    {e.withholding_amount_in_base > 0 ? (
                                                        <>
                                                            -<ValueDisplay value={e.withholding_amount_in_base} currency={baseCurrency} />
                                                            {e.withholding_rate != null && (
                                                                <span className="ml-1 text-[10px] text-slate-400">
                                                                    ({(e.withholding_rate * 100).toFixed(0)}%)
                                                                </span>
                                                            )}
                                                        </>
                                                    ) : '—'}
                                                </td>
                                                <td className="px-2 py-1.5 text-right font-semibold text-teal-600">
                                                    <ValueDisplay value={e.net_amount_in_base} currency={baseCurrency} />
                                                </td>
                                                <td className="px-2 py-1.5 text-[10px] text-slate-500">
                                                    {e.withholding_jurisdiction || '—'}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        {pageCount > 1 && (
                            <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500">
                                <span>
                                    {((pagination.page - 1) * (pagination.pageSize || PAGE_SIZE)) + 1}–
                                    {Math.min(pagination.page * (pagination.pageSize || PAGE_SIZE), total)} of {total}
                                </span>
                                <div className="flex gap-1">
                                    <button type="button" aria-disabled={pagination.page <= 1} onClick={() => pagination.page > 1 && pagination.setPage(pagination.page - 1)}
                                        className={pagination.page <= 1 ? 'cursor-not-allowed opacity-30' : 'cursor-pointer opacity-100'}>
                                        <FiChevronLeft size={14} />
                                    </button>
                                    <span>Page {pagination.page} / {pageCount}</span>
                                    <button type="button" aria-disabled={pagination.page >= pageCount} onClick={() => pagination.page < pageCount && pagination.setPage(pagination.page + 1)}
                                        className={pagination.page >= pageCount ? 'cursor-not-allowed opacity-30' : 'cursor-pointer opacity-100'}>
                                        <FiChevronRight size={14} />
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </SlidePanel>
    );
};
