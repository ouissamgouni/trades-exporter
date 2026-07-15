/**
 * LotsSlidePanel — Slide panel for Cost Lots aggregate view.
 *
 * Uses server-side filters (status, asset, account, search) and pagination.
 * Reuses existing CostLotsTab for the table rendering.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, BadgeColorScheme, Button } from '../ui/primitives';
import { FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight, FiSearch } from 'react-icons/fi';
import { LuChevronDown, LuFilter, LuRotateCcw, LuX } from 'react-icons/lu';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { ValueDisplay } from '../ValueDisplay';
import { AssetBadge } from '../AssetBadge';
import { Tooltip } from '../ui/tooltip';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostLot } from './types';
import { CostLotLineageTooltip, costSourceColor } from './LineageTooltips';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';

interface FilterOption { value: string; label?: string; count: number }
interface LotsFilterOptions {
    assets: FilterOption[];
    accounts: FilterOption[];
    statuses: FilterOption[];
}

export interface LotsSlidePanelProps {
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
const TH: React.CSSProperties = { padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600 };
const TD: React.CSSProperties = { padding: '3px 6px', fontSize: 11 };
const HL_BG = 'rgba(66, 153, 225, 0.06)';  // Subtle blue tint for highlighted columns
const TH_HL: React.CSSProperties = { ...TH, backgroundColor: HL_BG };
const TD_HL: React.CSSProperties = { ...TD, backgroundColor: HL_BG };

/* ─── FilterChip ─── */
const FilterChip: React.FC<{ label: string; color: BadgeColorScheme; onClear: () => void }> = ({ label, color, onClear }) => (
    <Badge colorScheme={color} className="inline-flex cursor-default items-center gap-1">
        {label}
        <span className="cursor-pointer hover:opacity-70" onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClear(); }}>
            <LuX size={10} />
        </span>
    </Badge>
);

export const LotsSlidePanel: React.FC<LotsSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    txFilterParams,
    onAssetClick,
    onTransactionClick,
    onUnitClick,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_lots_slide' });

    // ── Server-side filter state ────────────────────────────────────────────
    const [statusFilter, setStatusFilter] = useState<string>('all');
    const [assetFilter, setAssetFilter] = useState<string>('all');
    const [accountFilter, setAccountFilter] = useState<string>('all');
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = {
            ...txFilterParams,
        };
        if (statusFilter !== 'all') params.lot_status = statusFilter;
        if (assetFilter !== 'all') params.asset_id = Number(assetFilter);
        if (accountFilter !== 'all') params.account_id = Number(accountFilter);
        if (debouncedSearch) params.search = debouncedSearch;
        return params;
    }, [txFilterParams, statusFilter, assetFilter, accountFilter, debouncedSearch]);

    // Reset page on filter change
    const prevRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevRef.current !== serverParams) {
            pagination.setPage(1);
            prevRef.current = serverParams;
        }
    }, [serverParams]);

    const { data: lots, total, isLoading, error, refetch } = useLazyPaginatedQuery<CostLot>({
        endpoint: `/pnl/versions/${versionId}/lots`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: serverParams,
        lazy: true,
        enabled: isOpen,
    });

    useEffect(() => { pagination.setTotal(total); }, [total]);

    // ── Filter options ──────────────────────────────────────────────────────
    const [filterOpts, setFilterOpts] = useState<LotsFilterOptions | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        const qs = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== '') qs.set(k, String(v));
            });
        }
        fetch(`${API_URL}/pnl/versions/${versionId}/lots/filter-options?${qs}`)
            .then(r => r.json())
            .then(setFilterOpts)
            .catch(() => { });
    }, [versionId, txFilterParams, isOpen]);

    const hasAnyFilter = statusFilter !== 'all' || assetFilter !== 'all' || accountFilter !== 'all' || !!debouncedSearch;

    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const clearFilters = () => {
        setStatusFilter('all'); setAssetFilter('all'); setAccountFilter('all'); setSearchInput('');
    };

    const activeChips = useMemo(() => {
        const chips: { id: string; label: string; color: BadgeColorScheme; onClear: () => void }[] = [];
        if (statusFilter !== 'all')
            chips.push({ id: 'status', label: `Status: ${statusFilter}`, color: statusFilter === 'open' ? 'green' : statusFilter === 'exhausted' ? 'gray' : 'red', onClear: () => setStatusFilter('all') });
        if (assetFilter !== 'all') {
            const opt = filterOpts?.assets?.find(o => o.value === assetFilter);
            chips.push({ id: 'asset', label: `Asset: ${opt?.label || assetFilter}`, color: 'purple', onClear: () => setAssetFilter('all') });
        }
        if (accountFilter !== 'all') {
            const opt = filterOpts?.accounts?.find(o => o.value === accountFilter);
            chips.push({ id: 'account', label: `Acct: ${opt?.label || accountFilter}`, color: 'orange', onClear: () => setAccountFilter('all') });
        }
        if (debouncedSearch)
            chips.push({ id: 'search', label: `"${debouncedSearch}"`, color: 'blue', onClear: () => setSearchInput('') });
        return chips;
    }, [statusFilter, assetFilter, accountFilter, debouncedSearch, filterOpts]);

    const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));
    const safePage = pagination.page;

    const paginationBar = total > PAGE_SIZE_OPTIONS[0] ? (
        <div className="flex w-full items-center justify-between px-3 py-2">
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-gray-500">Rows:</span>
                <div className="inline-flex overflow-hidden rounded-md border border-gray-200">
                    {PAGE_SIZE_OPTIONS.map(size => (
                        <Button key={size}
                            size="sm"
                            variant={pagination.pageSize === size ? 'subtle' : 'ghost'}
                            colorScheme={pagination.pageSize === size ? 'blue' : 'gray'}
                            className="rounded-none px-2 text-xs"
                            onClick={() => { pagination.setPageSize(size); pagination.setPage(1); }}>
                            {size}
                        </Button>
                    ))}
                </div>
            </div>
            <span className="text-[10px] text-gray-500">
                {(safePage - 1) * pagination.pageSize + 1}–{Math.min(safePage * pagination.pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(1)} disabled={safePage <= 1} className="px-1">
                    <FiChevronsLeft size={12} />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(safePage - 1)} disabled={safePage <= 1} className="px-1">
                    <FiChevronLeft size={14} />
                </Button>
                <span className="mx-1 text-xs text-gray-600">{safePage} / {pageCount}</span>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(safePage + 1)} disabled={safePage >= pageCount} className="px-1">
                    <FiChevronRight size={14} />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => pagination.setPage(pageCount)} disabled={safePage >= pageCount} className="px-1">
                    <FiChevronsRight size={12} />
                </Button>
            </div>
        </div>
    ) : null;

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Cost Lots" width="950px">
            {/* ─── Collapsible Filter Section ─── */}
            <div className="mb-3">
                <div className={`overflow-visible rounded-md border bg-gray-50 ${hasAnyFilter ? 'border-blue-300' : 'border-gray-200'}`}>
                    {/* Clickable header */}
                    <div
                        className="flex cursor-pointer items-center justify-between rounded-md p-3 transition-colors hover:bg-gray-100"
                        onClick={() => setFiltersExpanded(p => !p)}
                    >
                        <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className={`shrink-0 transition-transform duration-200 ${filtersExpanded ? 'rotate-0' : '-rotate-90'}`}>
                                <LuChevronDown size={14} />
                            </span>
                            <LuFilter size={12} />
                            <span className="shrink-0 text-xs font-semibold">Filters</span>
                            {activeChips.length > 0 && (
                                <div className="ml-1 flex flex-wrap items-center gap-1" onClick={e => e.stopPropagation()}>
                                    {activeChips.map(chip => <FilterChip key={chip.id} label={chip.label} color={chip.color} onClear={chip.onClear} />)}
                                </div>
                            )}
                        </div>
                        <div className="flex shrink-0 gap-1.5" onClick={e => e.stopPropagation()}>
                            {hasAnyFilter && (
                                <Button size="sm" variant="ghost" onClick={clearFilters} className="text-gray-500 hover:text-gray-700">
                                    <LuRotateCcw size={10} />
                                    <span className="ml-0.5 text-[10px]">Clear All</span>
                                </Button>
                            )}
                        </div>
                    </div>

                    {/* Expanded filter controls */}
                    {filtersExpanded && (
                        <div className="p-3 pt-1">
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                                {/* Search */}
                                <div>
                                    <div className="mb-1 text-[10px] font-medium text-gray-600">Search</div>
                                    <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1">
                                        <FiSearch size={12} color="gray" />
                                        <input
                                            type="text"
                                            placeholder="Asset / account…"
                                            value={searchInput}
                                            onChange={(e) => setSearchInput(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                                        />
                                    </div>
                                </div>
                                {/* Status */}
                                <div>
                                    <div className="mb-1 text-[10px] font-medium text-gray-600">Status</div>
                                    <div className="flex flex-wrap gap-1">
                                        {['all', 'open', 'exhausted', 'negative'].map(s => {
                                            const opt = filterOpts?.statuses?.find(o => o.value === s);
                                            return (
                                                <Button key={s} size="sm"
                                                    variant={statusFilter === s ? 'solid' : 'outline'}
                                                    onClick={() => setStatusFilter(statusFilter === s && s !== 'all' ? 'all' : s)}>
                                                    {s === 'all' ? 'All' : `${s.charAt(0).toUpperCase() + s.slice(1)}${opt ? ` (${opt.count})` : ''}`}
                                                </Button>
                                            );
                                        })}
                                    </div>
                                </div>
                                {/* Asset */}
                                {filterOpts && filterOpts.assets.length > 1 && (
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium text-gray-600">Asset</div>
                                        <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white' }}>
                                            <option value="all">All Assets</option>
                                            {filterOpts.assets.map(a => (
                                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                {/* Account */}
                                {filterOpts && filterOpts.accounts.length > 1 && (
                                    <div>
                                        <div className="mb-1 text-[10px] font-medium text-gray-600">Account</div>
                                        <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white' }}>
                                            <option value="all">All Accounts</option>
                                            {filterOpts.accounts.map(a => (
                                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Content */}
            {isLoading ? <TabLoadingState message="Loading lots…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    lots.length === 0 ? <TabEmptyState title="No lots" description={hasAnyFilter ? 'Try adjusting filters.' : 'No cost lots found.'} /> : (
                        <div>
                            <div className="mb-1 flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">{total} lot{total !== 1 ? 's' : ''}</span>
                            </div>
                            {paginationBar}
                            <div className="overflow-x-auto text-[11px]">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ ...TH, textAlign: 'left' }}>ID</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Created</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Acquired</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Asset</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Account</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Status</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Initial Qty</th>
                                            <th style={{ ...TH_HL, textAlign: 'right' }}>Rem Qty</th>
                                            <th style={{ ...TH_HL, textAlign: 'right' }}>Unit Cost</th>
                                            <th style={{ ...TH_HL, textAlign: 'right' }}>Rem Cost</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Initial Cost</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Created By</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Updated By</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Source</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lots.map((lot: any) => {
                                            const status = lot.is_negative ? 'negative' : lot.qty_remaining === 0 ? 'exhausted' : 'open';
                                            const statusColor: BadgeColorScheme = status === 'open' ? 'green' : status === 'exhausted' ? 'gray' : 'red';
                                            return (
                                                <tr key={lot.cost_lot_id} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                    {/* ID */}
                                                    <td style={{ padding: '3px 6px' }}>
                                                        <CostLotLineageTooltip
                                                            lotId={lot.cost_lot_id}
                                                            versionId={versionId}
                                                            baseCurrency={baseCurrency}
                                                            onTransactionClick={onTransactionClick}
                                                        >
                                                            <span className="cursor-help font-mono text-[10px] text-blue-500 hover:underline">#{lot.cost_lot_id}</span>
                                                        </CostLotLineageTooltip>
                                                    </td>
                                                    {/* Created */}
                                                    <td style={TD}>
                                                        <span className="text-[10px] text-gray-500">
                                                            {lot.created_at ? new Date(lot.created_at).toLocaleDateString() : '-'}
                                                        </span>
                                                    </td>
                                                    {/* Acquired */}
                                                    <td style={TD}>
                                                        <span className="text-[10px] text-gray-500">
                                                            {lot.acquired_at ? new Date(lot.acquired_at).toLocaleDateString() : '-'}
                                                        </span>
                                                    </td>
                                                    {/* Asset */}
                                                    <td style={TD}>
                                                        <AssetBadge asset={lot.asset} size="xs" />
                                                    </td>
                                                    {/* Account */}
                                                    <td style={TD}>
                                                        <span className="text-[10px] text-gray-500">{lot.account_name || '-'}</span>
                                                    </td>
                                                    {/* Status */}
                                                    <td style={{ ...TD, textAlign: 'center' }}>
                                                        <Badge colorScheme={statusColor}>{status}</Badge>
                                                    </td>
                                                    {/* Initial Qty */}
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.qty_original} />
                                                    </td>
                                                    {/* Rem Qty (highlighted) */}
                                                    <td style={{ ...TD_HL, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.qty_remaining} />
                                                    </td>
                                                    {/* Unit Cost (highlighted) */}
                                                    <td style={{ ...TD_HL, textAlign: 'right' }}>
                                                        {lot.is_zero_cost ? (
                                                            <Badge colorScheme="red">Zero</Badge>
                                                        ) : lot.cost_source === 'provisional' ? (
                                                            <Tooltip
                                                                content={
                                                                    <div className="text-xs">
                                                                        <div className="font-semibold">Provisional Cost</div>
                                                                        <div>FMV estimate for negative lot</div>
                                                                        {lot.cost_fmv_price != null && <div>FMV: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>}
                                                                        {lot.cost_fmv_source && <div>Source: {lot.cost_fmv_source}</div>}
                                                                    </div>
                                                                }
                                                                openDelay={200}
                                                            >
                                                                <Badge colorScheme="orange" className="cursor-help">
                                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                                </Badge>
                                                            </Tooltip>
                                                        ) : lot.cost_source === 'fmv' && lot.cost_fmv_stale ? (
                                                            <Tooltip
                                                                content={
                                                                    <div className="text-xs">
                                                                        <div className="font-semibold">Stale FMV</div>
                                                                        {lot.cost_fmv_price != null && <div>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>}
                                                                        {lot.cost_fmv_source && <div>Source: {lot.cost_fmv_source}</div>}
                                                                        {lot.cost_fmv_timestamp && <div>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</div>}
                                                                    </div>
                                                                }
                                                                openDelay={200}
                                                            >
                                                                <Badge colorScheme="yellow" className="cursor-help">
                                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                                </Badge>
                                                            </Tooltip>
                                                        ) : (
                                                            <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                        )}
                                                    </td>
                                                    {/* Rem Cost (highlighted) */}
                                                    <td style={{ ...TD_HL, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.remaining_cost_in_base} currency={baseCurrency} />
                                                    </td>
                                                    {/* Initial Cost */}
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.total_cost_in_base} currency={baseCurrency} />
                                                    </td>
                                                    {/* Created By (origin TX) */}
                                                    <td style={TD}>
                                                        {lot.origin_transaction_id ? (
                                                            <span
                                                                className={`font-mono text-[10px] text-blue-500 ${onTransactionClick ? 'cursor-pointer hover:underline' : ''}`}
                                                                onClick={() => onTransactionClick?.(lot.origin_transaction_id!)}
                                                            >
                                                                TX#{lot.origin_transaction_id}
                                                            </span>
                                                        ) : (
                                                            <span className="text-[10px] text-gray-400">—</span>
                                                        )}
                                                    </td>
                                                    {/* Updated By (last non-CREATED event TX) */}
                                                    <td style={TD}>
                                                        {lot.last_updated_by_tx_id ? (
                                                            <span
                                                                className={`font-mono text-[10px] text-blue-500 ${onTransactionClick ? 'cursor-pointer hover:underline' : ''}`}
                                                                onClick={() => onTransactionClick?.(lot.last_updated_by_tx_id!)}
                                                            >
                                                                TX#{lot.last_updated_by_tx_id}
                                                            </span>
                                                        ) : (
                                                            <span className="text-[10px] text-gray-400">—</span>
                                                        )}
                                                    </td>
                                                    {/* Source / Chain (merged) */}
                                                    <td style={TD}>
                                                        <div className="flex items-center gap-1">
                                                            {lot.cost_source ? (
                                                                (lot.cost_fmv_price || lot.cost_fmv_source || lot.cost_fmv_timestamp) ? (
                                                                    <Tooltip
                                                                        content={
                                                                            <div className="text-xs leading-relaxed">
                                                                                <div className="font-semibold">FMV Details</div>
                                                                                {lot.cost_fmv_price != null && <div>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</div>}
                                                                                {lot.cost_fmv_source && <div>Source: {lot.cost_fmv_source}</div>}
                                                                                {lot.cost_fmv_timestamp && <div>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</div>}
                                                                                {lot.cost_fmv_stale && <div className="text-orange-300">⚠ Stale price</div>}
                                                                            </div>
                                                                        }
                                                                        openDelay={200}
                                                                    >
                                                                        <Badge className="cursor-help" colorScheme={costSourceColor(lot.cost_source)}>
                                                                            {lot.cost_source}
                                                                        </Badge>
                                                                    </Tooltip>
                                                                ) : (
                                                                    <Badge colorScheme={costSourceColor(lot.cost_source)}>
                                                                        {lot.cost_source}
                                                                    </Badge>
                                                                )
                                                            ) : <span className="text-[10px] text-gray-400">—</span>}
                                                            {(lot.cost_source === 'inherited' || lot.cost_source === 'proceeds' || lot.source_lot_id) && (
                                                                <CostBasisChainTooltip
                                                                    lotId={lot.cost_lot_id}
                                                                    versionId={versionId}
                                                                    baseCurrency={baseCurrency}
                                                                    onTransactionClick={onTransactionClick}
                                                                >
                                                                    <span className="cursor-help text-[10px] text-blue-400 hover:underline">🔗</span>
                                                                </CostBasisChainTooltip>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            {paginationBar}
                        </div>
                    )}
        </SlidePanel>
    );
};
