/**
 * FeesSlidePanel — Slide panel for Fees aggregate view.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FiSearch } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { usePagination } from '../../hooks/usePagination';
import { TablePagination } from '../TablePagination';
import { ValueDisplay } from '../ValueDisplay';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { Button } from '../ui/primitives';

interface FilterOption { value: string; label?: string; count: number }
interface FeesFilterOptions {
    assets: FilterOption[];
    related_assets: FilterOption[];
}

interface FeeEntryItem {
    id: number;
    date: string;
    asset: { id: number; symbol: string; label?: string };
    fee_amount: number;
    fee_in_base: number;
    transaction_id?: number;
    unit_id?: number;
    source?: string;
    transaction_type?: string;
    cost_basis_consumed?: number;
    realized_pnl?: number;
    related_asset?: { id: number; symbol: string; label?: string };
}

interface FeesApiResponse {
    fees: FeeEntryItem[];
    summary: {
        total_fees_in_base: number;
        fees_by_asset: Record<string, number>;
        fees_by_source: Record<string, number>;
        disposal_taxable_fee_count: number;
    };
    total: number;
    page: number;
    limit: number;
}

export interface FeesSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    txFilterParams?: Record<string, string | number | boolean | undefined>;
    onAssetClick?: (assetId: number) => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
}

export const FeesSlidePanel: React.FC<FeesSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    txFilterParams,
    onAssetClick,
    onTransactionClick,
    onUnitClick,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_fees_slide' });

    const [assetFilter, setAssetFilter] = useState<string>('all');
    const [relatedAssetFilter, setRelatedAssetFilter] = useState<string>('all');
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // ── Custom fetch (fees endpoint returns { fees, summary, total }) ────────
    const [data, setData] = useState<FeesApiResponse | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = { ...txFilterParams };
        if (assetFilter !== 'all') params.asset_id = Number(assetFilter);
        if (relatedAssetFilter !== 'all') params.related_asset_id = Number(relatedAssetFilter);
        if (debouncedSearch) params.search = debouncedSearch;
        params.page = pagination.page;
        params.limit = pagination.pageSize;
        return params;
    }, [txFilterParams, assetFilter, relatedAssetFilter, debouncedSearch, pagination.page, pagination.pageSize]);

    const prevRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevRef.current !== serverParams) {
            // Only reset page if non-page params changed
            const { page: _p1, limit: _l1, ...rest1 } = prevRef.current;
            const { page: _p2, limit: _l2, ...rest2 } = serverParams;
            if (JSON.stringify(rest1) !== JSON.stringify(rest2)) {
                pagination.setPage(1);
            }
            prevRef.current = serverParams;
        }
    }, [serverParams]);

    useEffect(() => {
        if (!isOpen) return;
        setIsLoading(true);
        setError(null);
        const qs = new URLSearchParams();
        Object.entries(serverParams).forEach(([k, v]) => {
            if (v !== undefined && v !== '') qs.set(k, String(v));
        });
        fetch(`${API_URL}/pnl/versions/${versionId}/fees?${qs}`)
            .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
            .then(d => { setData(d); setIsLoading(false); })
            .catch(e => { setError(e.message); setIsLoading(false); });
    }, [versionId, serverParams, isOpen]);

    useEffect(() => {
        if (data) pagination.setTotal(data.total);
    }, [data]);

    const fees = data?.fees || [];
    const total = data?.total || 0;

    // Filter options
    const [filterOpts, setFilterOpts] = useState<FeesFilterOptions | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        const qs = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== '') qs.set(k, String(v));
            });
        }
        fetch(`${API_URL}/pnl/versions/${versionId}/fees/filter-options?${qs}`)
            .then(r => r.json())
            .then(setFilterOpts)
            .catch(() => { });
    }, [versionId, txFilterParams, isOpen]);

    const hasAnyFilter = assetFilter !== 'all' || relatedAssetFilter !== 'all' || !!debouncedSearch;

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Fees" width="700px">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 bg-slate-50 px-2 py-0.5">
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text" placeholder="Search asset"
                        value={searchInput} onChange={e => setSearchInput(e.target.value)}
                        style={{ width: 100, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </div>
                {filterOpts && filterOpts.assets.length > 1 && (
                    <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                        style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <option value="all">All Fee Assets</option>
                        {filterOpts.assets.map(a => (
                            <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                        ))}
                    </select>
                )}
                {filterOpts && filterOpts.related_assets.length > 1 && (
                    <select value={relatedAssetFilter} onChange={e => setRelatedAssetFilter(e.target.value)}
                        style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <option value="all">All Related Assets</option>
                        {filterOpts.related_assets.map(a => (
                            <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                        ))}
                    </select>
                )}
                {hasAnyFilter && (
                    <Button size="sm" variant="ghost" onClick={() => {
                        setAssetFilter('all'); setRelatedAssetFilter('all'); setSearchInput('');
                    }}>Clear</Button>
                )}
            </div>

            {/* Summary */}
            {data?.summary && (
                <div className="mb-3 flex flex-wrap gap-3">
                    <div className="flex flex-col bg-orange-50 px-3 py-1.5">
                        <span className="text-[10px] text-slate-500">Total Fees</span>
                        <span className="text-sm font-bold text-orange-700">
                            <ValueDisplay value={data.summary.total_fees_in_base} currency={baseCurrency} />
                        </span>
                    </div>
                    <div className="flex flex-col bg-slate-50 px-3 py-1.5">
                        <span className="text-[10px] text-slate-500">Entries</span>
                        <span className="text-sm font-bold">{total}</span>
                    </div>
                </div>
            )}

            {isLoading ? <TabLoadingState message="Loading fees…" /> :
                error ? <TabErrorState error={error} onRetry={() => { }} /> :
                    fees.length === 0 ? <TabEmptyState title="No fees" description={hasAnyFilter ? 'Try adjusting filters.' : 'No fee entries.'} /> : (
                        <div>
                            <div className="overflow-x-auto text-[11px]">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>TX</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Unit</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Date</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Asset</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Amount</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Fee Value</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Source</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Related</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {fees.map((f: FeeEntryItem) => (
                                            <tr key={f.id} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                <td style={{ padding: '3px 6px' }}>
                                                    {f.transaction_id ? (
                                                        <span
                                                            className="cursor-pointer font-mono text-[10px] text-blue-500"
                                                            onClick={() => onTransactionClick?.(f.transaction_id!)}
                                                        >
                                                            #{f.transaction_id}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[10px] text-slate-400">-</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    {f.unit_id ? (
                                                        <span
                                                            className="cursor-pointer font-mono text-[10px] text-blue-500"
                                                            onClick={() => onUnitClick?.(f.unit_id!)}
                                                        >
                                                            {f.unit_id}
                                                        </span>
                                                    ) : (
                                                        <span className="text-[10px] text-slate-400">-</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <span className="text-[10px] text-slate-500">
                                                        {f.date ? new Date(f.date).toLocaleDateString() : '-'}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <span className="text-xs font-medium">{f.asset?.symbol || '?'}</span>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'mono' }}>
                                                    {Number(f.fee_amount).toFixed(4)}
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={f.fee_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <span className="text-[10px] text-slate-500">{f.source || '-'}</span>
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <span className="text-[10px] text-slate-500">{f.related_asset?.symbol || '-'}</span>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <TablePagination
                                page={pagination.page} pageSize={pagination.pageSize}
                                total={total} onPageChange={pagination.setPage}
                                onPageSizeChange={pagination.setPageSize}
                            />
                        </div>
                    )}
        </SlidePanel>
    );
};
