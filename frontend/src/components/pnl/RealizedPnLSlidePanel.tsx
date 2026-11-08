/**
 * RealizedPnLSlidePanel — Slide panel for Realized P&L aggregate view.
 *
 * Features:
 * - Backend pagination with AssetPnLTable-style inline pagination bar
 * - Card-based filters matching TransactionFilters pattern
 * - Account column, short date formats
 * - Taxability + Origin (fee/disposal) columns
 * - Server-side sorting by P&L value and holding period
 */

import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Badge, Button, Input } from '../ui/primitives';
import { FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight } from 'react-icons/fi';
import { LuChevronDown, LuCircleAlert, LuCircleCheck, LuFilter, LuInfo, LuPencil, LuRotateCcw, LuX } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { ValueDisplay } from '../ValueDisplay';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';
import { RealizedEntrySlidePanel } from './RealizedEntrySlidePanel';
import {
    InfoTip, TaxabilityPill, TaxableGainValue, DeferredInValue, TERM_HELP, realizedOf, realizedCostOf,
} from './pnlTerms';
import { Tooltip } from '../ui/tooltip';
import { PriceGetterTester } from '../PriceGetterTester';
import {
    RFilterCard, RDropdownCard, RDateCard, SortHeader, FilterChip,
    TH, TD,
    type FilterOption, type RealizedFilterOptions, type FilterChipData,
} from './RealizedPnLFilters';

/* ─── Types ─── */

interface RealizedPnLEntry {
    pnl_id: number;
    asset: { id: number; symbol: string; label?: string };
    account_id?: number;
    account_name?: string;
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    economic_cost_basis_in_base?: number;
    economic_pnl_in_base?: number;
    taxable: boolean;
    is_fee: boolean;
    transaction_id?: number;
    unit_id?: number;
    realized_at: string;
    holding_period_days?: number;
    proceeds_source?: string;
    proceeds_price?: number;
    proceeds_price_source?: string;
    proceeds_price_timestamp?: string;
}

export interface RealizedPnLSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    txFilterParams?: Record<string, string | number | boolean | undefined>;
    onAssetClick?: (assetId: number) => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}

/* ─── Constants ─── */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;

const DATE_PRESETS = [
    { label: '1M', months: 1 },
    { label: '3M', months: 3 },
    { label: '6M', months: 6 },
    { label: '1Y', months: 12 },
];

/* ═══════════════════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   Main Component
   ═══════════════════════════════════════════════════════════════════════════ */

export const RealizedPnLSlidePanel: React.FC<RealizedPnLSlidePanelProps> = ({
    isOpen, onClose, versionId, baseCurrency, txFilterParams,
    onAssetClick, onTransactionClick, onUnitClick,
}) => {
    const assetPanelCtx = useContext(AssetDetailPanelContext);
    const pagination = usePagination({ storageKey: 'pnl_realized_slide' });

    // Multi-select filters (array-based, matching TransactionFilters)
    const [taxableFilter, setTaxableFilter] = useState<string[]>([]);
    const [signFilter, setSignFilter] = useState<string[]>([]);
    const [holdingFilter, setHoldingFilter] = useState<string[]>([]);
    const [originFilter, setOriginFilter] = useState<string[]>([]);
    const [assetFilter, setAssetFilter] = useState<string[]>([]);
    const [accountFilter, setAccountFilter] = useState<string[]>([]);
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    // Filter accordion
    const [filtersExpanded, setFiltersExpanded] = useState(false);

    const [entryPanelId, setEntryPanelId] = useState<number | null>(null);

    // Absolute P&L threshold (default: hide dust entries < 1€)
    const [minAbsPnl, setMinAbsPnl] = useState(1);

    // Dropdown open states
    const [assetDropdownOpen, setAssetDropdownOpen] = useState(false);
    const [accountDropdownOpen, setAccountDropdownOpen] = useState(false);

    // Sorting
    const [sortBy, setSortBy] = useState<string | null>(null);
    const [sortOrder, setSortOrder] = useState<string>('asc');

    const handleSort = (field: string) => {
        if (sortBy === field) {
            setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
        } else {
            setSortBy(field);
            setSortOrder(field === 'pnl' ? 'desc' : 'asc');
        }
    };

    // Build server params — first selected value wins for single-value backend params
    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = { ...txFilterParams };
        if (taxableFilter.length === 1) params.is_taxable = taxableFilter[0] === 'true';
        if (signFilter.length === 1) params.pnl_sign = signFilter[0];
        if (holdingFilter.length === 1) params.holding_period = holdingFilter[0];
        if (originFilter.length === 1) params.is_fee = originFilter[0] === 'fee';
        if (assetFilter.length === 1) params.asset_id = Number(assetFilter[0]);
        if (accountFilter.length === 1) params.account_id = Number(accountFilter[0]);
        if (dateFrom) params.date_from = dateFrom;
        if (dateTo) params.date_to = dateTo;
        if (minAbsPnl > 0) params.min_abs_pnl = minAbsPnl;
        if (sortBy) { params.sort_by = sortBy; params.order = sortOrder; }
        return params;
    }, [txFilterParams, taxableFilter, signFilter, holdingFilter, originFilter, assetFilter, accountFilter, dateFrom, dateTo, minAbsPnl, sortBy, sortOrder]);

    const prevRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevRef.current !== serverParams) { pagination.setPage(1); prevRef.current = serverParams; }
    }, [serverParams]);

    const { data: entries, total, isLoading, error, refetch } = useLazyPaginatedQuery<RealizedPnLEntry>({
        endpoint: `/pnl/versions/${versionId}/realized-pnl`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: serverParams,
        lazy: true,
        enabled: isOpen,
    });

    useEffect(() => { pagination.setTotal(total); }, [total]);

    // Filter options
    const [filterOpts, setFilterOpts] = useState<RealizedFilterOptions | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        const qs = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== '') qs.set(k, String(v));
            });
        }
        fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/filter-options?${qs}`)
            .then(r => r.json())
            .then(setFilterOpts)
            .catch(() => { });
    }, [versionId, txFilterParams, isOpen]);

    const hasAnyFilter = taxableFilter.length > 0 || signFilter.length > 0 || holdingFilter.length > 0
        || originFilter.length > 0 || assetFilter.length > 0 || accountFilter.length > 0
        || !!dateFrom || !!dateTo || minAbsPnl > 0;

    // FMV override dialog state
    const [overrideEntry, setOverrideEntry] = useState<RealizedPnLEntry | null>(null);
    const [overridePrice, setOverridePrice] = useState('');
    const [overrideLoading, setOverrideLoading] = useState(false);
    const [overrideError, setOverrideError] = useState<string | null>(null);

    const handleOverrideFmv = async () => {
        if (!overrideEntry || !overridePrice) return;
        const price = parseFloat(overridePrice);
        if (isNaN(price) || price <= 0) { setOverrideError('Price must be a positive number'); return; }
        setOverrideLoading(true);
        setOverrideError(null);
        try {
            const res = await fetch(`${API_URL}/pnl/versions/${versionId}/realized-pnl/${overrideEntry.pnl_id}/override-fmv`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ price }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ detail: 'Request failed' }));
                throw new Error(err.detail || `Error ${res.status}`);
            }
            const result = await res.json();
            setOverrideEntry(null);
            setOverridePrice('');
            if (result.recalculation_started) {
                // Recalculation was triggered — data will refresh on next poll
                console.log('FMV override saved, recalculation started');
            }
            refetch();
        } catch (err: any) {
            setOverrideError(err.message || 'Failed to override FMV');
        } finally {
            setOverrideLoading(false);
        }
    };

    const clearFilters = () => {
        setTaxableFilter([]); setSignFilter([]); setHoldingFilter([]);
        setOriginFilter([]); setAssetFilter([]); setAccountFilter([]);
        setDateFrom(''); setDateTo(''); setMinAbsPnl(0);
    };

    // Build active filter chips
    const activeChips = useMemo<FilterChipData[]>(() => {
        const chips: FilterChipData[] = [];
        taxableFilter.forEach(v => {
            const opt = filterOpts?.taxable_options?.find(o => o.value === v);
            chips.push({ id: `taxable-${v}`, label: opt?.label || v, color: 'red', onClear: () => setTaxableFilter(p => p.filter(x => x !== v)) });
        });
        signFilter.forEach(v => {
            const opt = filterOpts?.pnl_sign_options?.find(o => o.value === v);
            chips.push({ id: `sign-${v}`, label: opt?.label || v, color: v === 'gain' ? 'green' : 'red', onClear: () => setSignFilter(p => p.filter(x => x !== v)) });
        });
        holdingFilter.forEach(v => {
            const opt = filterOpts?.holding_period_options?.find(o => o.value === v);
            chips.push({ id: `holding-${v}`, label: opt?.label || v, color: 'gray', onClear: () => setHoldingFilter(p => p.filter(x => x !== v)) });
        });
        originFilter.forEach(v => {
            const opt = filterOpts?.origin_type_options?.find(o => o.value === v);
            chips.push({ id: `origin-${v}`, label: opt?.label || v, color: v === 'fee' ? 'orange' : 'blue', onClear: () => setOriginFilter(p => p.filter(x => x !== v)) });
        });
        assetFilter.forEach(v => {
            const opt = filterOpts?.assets?.find(o => o.value === v);
            chips.push({ id: `asset-${v}`, label: `Asset: ${opt?.label || v}`, color: 'purple', onClear: () => setAssetFilter(p => p.filter(x => x !== v)) });
        });
        accountFilter.forEach(v => {
            const opt = filterOpts?.accounts?.find(o => o.value === v);
            chips.push({ id: `account-${v}`, label: `Acct: ${opt?.label || v}`, color: 'teal', onClear: () => setAccountFilter(p => p.filter(x => x !== v)) });
        });
        if (dateFrom || dateTo) {
            const parts = [];
            if (dateFrom) parts.push(`from ${dateFrom.split('T')[0]}`);
            if (dateTo) parts.push(`to ${dateTo.split('T')[0]}`);
            chips.push({ id: 'date', label: parts.join(' '), color: 'purple', onClear: () => { setDateFrom(''); setDateTo(''); } });
        }
        if (minAbsPnl > 0) {
            chips.push({ id: 'abs-pnl', label: `|P&L| ≥ €${minAbsPnl}`, color: 'blue', onClear: () => setMinAbsPnl(0) });
        }
        return chips;
    }, [taxableFilter, signFilter, holdingFilter, originFilter, assetFilter, accountFilter, dateFrom, dateTo, filterOpts]);

    // Short date formatters
    const fmtDate = (iso: string) => {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
    };
    const fmtTime = (iso?: string) => {
        if (!iso) return '-';
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    };

    // Pagination helpers (server-side is 1-indexed but we render as if 0-indexed)
    const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));
    const safePage = pagination.page; // 1-indexed from usePagination

    const paginationBar = total > PAGE_SIZE_OPTIONS[0] ? (
        <div className="flex w-full items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500">Rows:</span>
                <div className="inline-flex overflow-hidden border border-gray-200">
                    {PAGE_SIZE_OPTIONS.map(size => (
                        <Button key={size}
                            size="sm"
                            variant={pagination.pageSize === size ? 'subtle' : 'ghost'}
                            colorScheme={pagination.pageSize === size ? 'blue' : 'gray'}
                            onClick={() => { pagination.setPageSize(size); pagination.setPage(1); }}
                            className="h-6 px-2 text-xs">
                            {size}
                        </Button>
                    ))}
                </div>
            </div>
            <span className="text-[10px] text-gray-500">
                {(safePage - 1) * pagination.pageSize + 1}–{Math.min(safePage * pagination.pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(1)} disabled={safePage <= 1} className="h-6 px-1">
                    <FiChevronsLeft size={12} />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(safePage - 1)} disabled={safePage <= 1} className="h-6 px-1">
                    <FiChevronLeft size={14} />
                </Button>
                <span className="mx-1 text-xs text-gray-600">{safePage} / {pageCount}</span>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(safePage + 1)} disabled={safePage >= pageCount} className="h-6 px-1">
                    <FiChevronRight size={14} />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(pageCount)} disabled={safePage >= pageCount} className="h-6 px-1">
                    <FiChevronsRight size={12} />
                </Button>
            </div>
        </div>
    ) : null;

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Realized P&L" width="1100px">
            {/* ─── Collapsible Filter Section ─── */}
            <div className="mb-3">
                <div className={`overflow-visible border bg-gray-50 ${hasAnyFilter ? 'border-blue-300' : 'border-gray-200'}`}>
                    {/* Clickable header */}
                    <div className="flex cursor-pointer items-center justify-between p-3 transition-colors hover:bg-gray-100"
                        onClick={() => setFiltersExpanded(p => !p)}>
                        <div className="flex flex-wrap items-center gap-1.5">
                            <div className={`transition-transform duration-200 ${filtersExpanded ? 'rotate-0' : '-rotate-90'}`}>
                                <LuChevronDown size={14} />
                            </div>
                            <LuFilter size={12} />
                            <span className="text-xs font-semibold">Filters</span>
                            {activeChips.length > 0 && (
                                <Badge colorScheme="blue">{activeChips.length} active</Badge>
                            )}
                            {activeChips.map(chip => <FilterChip key={chip.id} chip={chip} />)}
                        </div>
                        <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                            {hasAnyFilter && (
                                <Button size="sm" variant="ghost" onClick={clearFilters} className="h-6 px-2 text-gray-500 hover:text-gray-700">
                                    <LuRotateCcw size={10} />
                                    <span className="ml-0.5 text-[10px]">Clear All</span>
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Expanded filter cards */}
                    {filtersExpanded && (
                        <div className="overflow-visible p-3 pt-1">
                            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
                                {/* Taxability card */}
                                {filterOpts?.taxable_options && filterOpts.taxable_options.length > 0 && (
                                    <RFilterCard label="Taxability" icon="🏷️" options={filterOpts.taxable_options}
                                        selected={taxableFilter} onChange={setTaxableFilter} color="red" />
                                )}
                                {/* Origin card */}
                                {filterOpts?.origin_type_options && filterOpts.origin_type_options.length > 0 && (
                                    <RFilterCard label="Origin" icon="📋" options={filterOpts.origin_type_options}
                                        selected={originFilter} onChange={setOriginFilter} color="blue" />
                                )}
                                {/* Gain/Loss card */}
                                {filterOpts?.pnl_sign_options && filterOpts.pnl_sign_options.length > 0 && (
                                    <RFilterCard label="Gain / Loss" icon="📊" options={filterOpts.pnl_sign_options}
                                        selected={signFilter} onChange={setSignFilter} color="green" />
                                )}
                                {/* Holding Period card */}
                                {filterOpts?.holding_period_options && filterOpts.holding_period_options.length > 0 && (
                                    <RFilterCard label="Holding" icon="⏱️" options={filterOpts.holding_period_options}
                                        selected={holdingFilter} onChange={setHoldingFilter} color="gray" />
                                )}
                                {/* Asset dropdown */}
                                {filterOpts && filterOpts.assets.length > 1 && (
                                    <RDropdownCard label="Asset" icon="🪙" options={filterOpts.assets}
                                        selected={assetFilter} onChange={setAssetFilter} color="purple"
                                        isOpen={assetDropdownOpen}
                                        onToggle={() => { setAssetDropdownOpen(p => !p); setAccountDropdownOpen(false); }}
                                        onClose={() => setAssetDropdownOpen(false)} />
                                )}
                                {/* Account dropdown */}
                                {filterOpts && filterOpts.accounts.length > 1 && (
                                    <RDropdownCard label="Account" icon="👤" options={filterOpts.accounts}
                                        selected={accountFilter} onChange={setAccountFilter} color="teal"
                                        isOpen={accountDropdownOpen}
                                        onToggle={() => { setAccountDropdownOpen(p => !p); setAssetDropdownOpen(false); }}
                                        onClose={() => setAccountDropdownOpen(false)} />
                                )}
                                {/* Date card */}
                                <RDateCard dateFrom={dateFrom} dateTo={dateTo}
                                    onChangeFrom={setDateFrom} onChangeTo={setDateTo}
                                    onClear={() => { setDateFrom(''); setDateTo(''); }} />
                            </div>

                            {/* Absolute P&L threshold slider */}
                            <div className="mt-2 px-1">
                                <div className="flex items-center gap-2">
                                    <span className="whitespace-nowrap text-[10px] font-medium text-gray-600">|P&L| ≥</span>
                                    <input type="range" min={0} max={100} step={1} value={minAbsPnl}
                                        onChange={e => setMinAbsPnl(Number(e.target.value))}
                                        className="h-1 flex-1 accent-blue-500" />
                                    <div className="flex items-center gap-0.5">
                                        <span className="text-[10px] text-gray-500">€</span>
                                        <input type="number" min={0} step={1} value={minAbsPnl}
                                            onChange={e => setMinAbsPnl(Math.max(0, Number(e.target.value)))}
                                            className="h-[22px] w-12 border border-gray-200 px-1 text-right text-[10px]" />
                                    </div>
                                </div>
                                <div className="mt-0.5 text-[10px] text-gray-400">Hides entries where absolute P&L is below this threshold</div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {isLoading ? <TabLoadingState message="Loading realized P&L…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    entries.length === 0 ? <TabEmptyState title="No entries" description={hasAnyFilter ? 'Try adjusting filters.' : 'No realized P&L entries.'} /> : (
                        <div>
                            <div className="mb-1 flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">{total} entr{total !== 1 ? 'ies' : 'y'}</span>
                            </div>

                            {/* Top pagination bar */}
                            {paginationBar}

                            <div className="overflow-x-auto">
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ ...TH, textAlign: 'left', fontSize: 9 }}>ID</th>
                                            <SortHeader label="Date" field="date" current={sortBy} order={sortOrder} onSort={handleSort} />
                                            <th style={{ ...TH, textAlign: 'left' }}>Asset</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Account</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Qty</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Proceeds</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>FMV Price</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Source</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>FMV Time</th>
                                            <th style={{ ...TH, textAlign: 'right' }}><span className="inline-flex items-center gap-0.5">Cost <InfoTip text={TERM_HELP.cost} /></span></th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Chain</th>
                                            <SortHeader label="Realized" field="pnl" current={sortBy} order={sortOrder} align="right" onSort={handleSort} />
                                            <th style={{ ...TH, textAlign: 'right' }}><span className="inline-flex items-center gap-0.5">Taxable gain <InfoTip text={TERM_HELP.taxable} /></span></th>
                                            <th style={{ ...TH, textAlign: 'right' }}><span className="inline-flex items-center gap-0.5">Deferred in <InfoTip text={TERM_HELP.deferredIn} /></span></th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Taxability</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Origin</th>
                                            <SortHeader label="Days" field="holding_period" current={sortBy} order={sortOrder} align="right" onSort={handleSort} />
                                            <th style={{ ...TH, textAlign: 'left' }}>TX</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Unit</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {entries.map((e: RealizedPnLEntry, idx: number) => (
                                            <tr key={e.pnl_id ?? idx} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                <td style={{ ...TD }}>
                                                    <button type="button" className="font-mono text-[9px] text-blue-500 hover:underline"
                                                        title="Explain this entry" onClick={() => setEntryPanelId(e.pnl_id)}>
                                                        #{e.pnl_id}
                                                    </button>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <span className="whitespace-nowrap text-[10px] text-gray-600">
                                                        {e.realized_at ? fmtDate(e.realized_at) : '-'}
                                                    </span>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <div className="flex items-center gap-1">
                                                        <Tooltip content={
                                                            <div className="p-1 text-xs">
                                                                <div className="font-bold">{e.asset.label || e.asset.symbol}</div>
                                                                <div className="font-mono text-gray-300">{e.asset.symbol}</div>
                                                                {e.asset.id && <div className="text-[10px] text-gray-400">ID: {e.asset.id}</div>}
                                                            </div>
                                                        }>
                                                            <span
                                                                className={`max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-medium text-purple-600 ${onAssetClick ? 'cursor-pointer hover:underline' : 'cursor-default'}`}
                                                                onClick={() => e.asset.id && onAssetClick?.(e.asset.id)}>
                                                                {e.asset.label || e.asset.symbol}
                                                            </span>
                                                        </Tooltip>
                                                        {e.asset.id != null && assetPanelCtx && (
                                                            <button
                                                                type="button"
                                                                onClick={(ev: React.MouseEvent) => { ev.stopPropagation(); assetPanelCtx.openAssetPanel(e.asset.id!, { pnlVersionId: versionId }); }}
                                                                className="p-0.5 text-gray-400 hover:bg-purple-50 hover:text-purple-500"
                                                                title="Asset details"
                                                            >
                                                                <LuInfo size={10} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <span className="max-w-[80px] overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-gray-500">
                                                        {e.account_name || '-'}
                                                    </span>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={e.qty} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={e.proceeds_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <div className="flex items-center justify-end gap-1">
                                                        {e.proceeds_price != null
                                                            ? <ValueDisplay value={e.proceeds_price} currency={baseCurrency} />
                                                            : <span className="text-[10px] text-gray-400">-</span>}
                                                        {e.proceeds_source !== 'transfer' && (
                                                            <button type="button" className="inline-flex cursor-pointer items-center text-gray-400 hover:text-blue-500"
                                                                title="Override FMV"
                                                                onClick={() => {
                                                                    setOverrideEntry(e);
                                                                    setOverridePrice(e.proceeds_price != null ? String(e.proceeds_price) : '');
                                                                    setOverrideError(null);
                                                                }}>
                                                                <LuPencil size={10} />
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    {e.proceeds_price_source ? (
                                                        <Badge
                                                            colorScheme={
                                                                e.proceeds_source === 'fmv' || e.proceeds_source === 'fmv_lookup' ? 'blue'
                                                                    : e.proceeds_source === 'provisional' ? 'orange'
                                                                        : 'gray'
                                                            }>
                                                            {e.proceeds_price_source}
                                                        </Badge>
                                                    ) : <span className="text-[10px] text-gray-400">-</span>}
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <span className="whitespace-nowrap text-[10px] text-gray-500">
                                                        {e.proceeds_price_timestamp ? fmtDate(e.proceeds_price_timestamp) : '-'}
                                                    </span>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={realizedCostOf(e)} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <CostBasisChainTooltip
                                                        pnlId={e.pnl_id} versionId={versionId}
                                                        baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                        <span className="cursor-help text-[10px] text-blue-400 hover:underline">🔗</span>
                                                    </CostBasisChainTooltip>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <span className={`text-[10px] font-medium ${realizedOf(e) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                        <ValueDisplay value={realizedOf(e)} currency={baseCurrency} />
                                                    </span>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <TaxableGainValue entry={e} taxable={e.taxable} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <DeferredInValue entry={e} taxable={e.taxable} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <TaxabilityPill taxable={e.taxable} isFee={e.is_fee} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <Badge colorScheme={e.is_fee ? 'orange' : 'blue'}>
                                                        {e.is_fee ? 'Fee' : 'Disposal'}
                                                    </Badge>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <span className="text-[10px] text-gray-500">{e.holding_period_days ?? '-'}</span>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    {e.transaction_id ? (
                                                        <span className={`font-mono text-[10px] text-blue-500 ${onTransactionClick ? 'cursor-pointer hover:underline' : ''}`}
                                                            onClick={() => onTransactionClick?.(e.transaction_id!)}>
                                                            #{e.transaction_id}
                                                        </span>
                                                    ) : <span className="text-[10px] text-gray-400">-</span>}
                                                </td>
                                                <td style={{ ...TD }}>
                                                    {e.unit_id ? (
                                                        <span className={`font-mono text-[10px] text-blue-500 ${onUnitClick ? 'cursor-pointer hover:underline' : ''}`}
                                                            onClick={() => onUnitClick?.(e.unit_id!)}>
                                                            #{e.unit_id}
                                                        </span>
                                                    ) : <span className="text-[10px] text-gray-400">-</span>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* Bottom pagination bar */}
                            {paginationBar}
                        </div>
                    )}

            <RealizedEntrySlidePanel
                isOpen={entryPanelId !== null}
                onClose={() => setEntryPanelId(null)}
                versionId={versionId}
                pnlId={entryPanelId}
                baseCurrency={baseCurrency}
                onTransactionClick={onTransactionClick}
                onUnitClick={onUnitClick}
            />

            {/* FMV Override Dialog */}
            <RadixDialog.Root
                open={!!overrideEntry}
                onOpenChange={(open) => { if (!open) { setOverrideEntry(null); setOverridePrice(''); setOverrideError(null); } }}
            >
                <RadixDialog.Portal>
                    <RadixDialog.Overlay className="fixed inset-0 z-[2000] bg-black/40" />
                    <RadixDialog.Content className="fixed left-1/2 top-1/2 z-[2000] w-full max-w-[420px] -translate-x-1/2 -translate-y-1/2 border border-slate-200 bg-white shadow-xl">
                        <div className="border-b border-gray-200 px-5 py-3">
                            <RadixDialog.Title className="text-sm font-semibold">Override FMV Price</RadixDialog.Title>
                        </div>
                        <div className="px-5 py-4">
                            {overrideEntry && (
                                <div>
                                    <div className="mb-3 flex items-center gap-2">
                                        <Badge colorScheme="purple">{overrideEntry.asset.symbol}</Badge>
                                        <span className="text-sm text-gray-500">
                                            {overrideEntry.realized_at ? fmtDate(overrideEntry.realized_at) : ''}
                                        </span>
                                    </div>
                                    {overrideEntry.proceeds_price != null && (
                                        <div className="mb-2 text-sm text-gray-500">
                                            Current FMV: <strong>{overrideEntry.proceeds_price}</strong>
                                            {overrideEntry.proceeds_price_source && ` (${overrideEntry.proceeds_price_source})`}
                                        </div>
                                    )}
                                    <div className="mb-1 text-sm">New FMV price per unit ({baseCurrency}):</div>
                                    <Input
                                        type="number"
                                        step="any"
                                        min="0"
                                        value={overridePrice}
                                        onChange={(e) => setOverridePrice(e.target.value)}
                                        placeholder="e.g. 16.35"
                                        autoFocus
                                    />
                                    {/* Price Getter Tester */}
                                    {overrideEntry && (
                                        <PriceGetterTester
                                            assetId={overrideEntry.asset.id}
                                            defaultDate={overrideEntry.realized_at}
                                            onUsePrice={(price) => setOverridePrice(String(price))}
                                        />
                                    )}
                                    {overrideError && (
                                        <div className="mt-2 text-sm text-red-500">{overrideError}</div>
                                    )}
                                    <div className="mt-2 text-xs text-gray-400">
                                        This creates a manual price snapshot and triggers a full P&L recalculation.
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
                            <Button variant="outline" onClick={() => { setOverrideEntry(null); setOverridePrice(''); setOverrideError(null); }}>
                                Cancel
                            </Button>
                            <Button
                                colorScheme="blue"
                                onClick={handleOverrideFmv}
                                loading={overrideLoading}
                                disabled={!overridePrice || overrideLoading}
                            >
                                Save & Recalculate
                            </Button>
                        </div>
                    </RadixDialog.Content>
                </RadixDialog.Portal>
            </RadixDialog.Root>
        </SlidePanel>
    );
};
