/**
 * LotsSlidePanel — Slide panel for Cost Lots aggregate view.
 *
 * Uses server-side filters (status, asset, account, search) and pagination.
 * Reuses existing CostLotsTab for the table rendering.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { FiSearch } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { TablePagination } from '../TablePagination';
import { ValueDisplay } from '../ValueDisplay';
import { Tooltip } from '../ui/tooltip';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostLot } from './types';
import { CostLotLineageTooltip } from './LineageTooltips';
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

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Cost Lots" width="950px">
            {/* Filter bar */}
            <Flex gap={2} mb={3} wrap="wrap" align="center">
                <Flex align="center" gap={1} bg="gray.50" borderRadius="md" px={2} py={0.5}>
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text"
                        placeholder="Search asset / account"
                        value={searchInput}
                        onChange={(e) => setSearchInput(e.target.value)}
                        style={{ width: 130, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </Flex>
                {/* Status toggles */}
                <Flex gap={1}>
                    {['all', 'open', 'exhausted', 'negative'].map(s => {
                        const opt = filterOpts?.statuses?.find(o => o.value === s);
                        return (
                            <Button
                                key={s}
                                size="2xs"
                                variant={statusFilter === s ? 'solid' : 'outline'}
                                onClick={() => setStatusFilter(statusFilter === s && s !== 'all' ? 'all' : s)}
                            >
                                {s === 'all' ? 'All' : `${s.charAt(0).toUpperCase() + s.slice(1)}${opt ? ` (${opt.count})` : ''}`}
                            </Button>
                        );
                    })}
                </Flex>
                {hasAnyFilter && (
                    <Button size="2xs" variant="ghost" onClick={() => {
                        setStatusFilter('all'); setAssetFilter('all'); setAccountFilter('all'); setSearchInput('');
                    }}>
                        Clear
                    </Button>
                )}
            </Flex>

            {/* Asset / Account quick filters (if options available) */}
            {filterOpts && (filterOpts.assets.length > 1 || filterOpts.accounts.length > 1) && (
                <Flex gap={2} mb={3} wrap="wrap" align="center">
                    {filterOpts.assets.length > 1 && (
                        <select
                            value={assetFilter}
                            onChange={e => setAssetFilter(e.target.value)}
                            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}
                        >
                            <option value="all">All Assets</option>
                            {filterOpts.assets.map(a => (
                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                            ))}
                        </select>
                    )}
                    {filterOpts.accounts.length > 1 && (
                        <select
                            value={accountFilter}
                            onChange={e => setAccountFilter(e.target.value)}
                            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}
                        >
                            <option value="all">All Accounts</option>
                            {filterOpts.accounts.map(a => (
                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                            ))}
                        </select>
                    )}
                </Flex>
            )}

            {/* Content */}
            {isLoading ? <TabLoadingState message="Loading lots…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    lots.length === 0 ? <TabEmptyState title="No lots" description={hasAnyFilter ? 'Try adjusting filters.' : 'No cost lots found.'} /> : (
                        <Box>
                            <Text fontSize="2xs" color="gray.500" mb={2}>{total} lot{total !== 1 ? 's' : ''}</Text>
                            {/* Simple lot rows */}
                            <Box overflowX="auto" fontSize="11px">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>ID</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Origin TX</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Asset</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Account</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Qty</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Remaining</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Unit Cost</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Total Cost</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Source</th>
                                            <th style={{ textAlign: 'center', padding: '4px 6px', fontSize: 10 }}>Chain</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Date</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Unit</th>
                                            <th style={{ textAlign: 'center', padding: '4px 6px', fontSize: 10 }}>Status</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {lots.map((lot: any) => {
                                            const status = lot.is_negative ? 'negative' : lot.qty_remaining === 0 ? 'exhausted' : 'open';
                                            const statusColor = status === 'open' ? 'green' : status === 'exhausted' ? 'gray' : 'red';
                                            return (
                                                <tr key={lot.cost_lot_id} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        <CostLotLineageTooltip
                                                            lotId={lot.cost_lot_id}
                                                            versionId={versionId}
                                                            baseCurrency={baseCurrency}
                                                            onTransactionClick={onTransactionClick}
                                                        >
                                                            <Text fontSize="2xs" color="blue.500" fontFamily="mono" cursor="help" _hover={{ textDecoration: 'underline' }}>#{lot.cost_lot_id}</Text>
                                                        </CostLotLineageTooltip>
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        {lot.origin_transaction_id ? (
                                                            <Text
                                                                fontSize="2xs"
                                                                color="blue.500"
                                                                fontFamily="mono"
                                                                cursor={onTransactionClick ? 'pointer' : undefined}
                                                                _hover={onTransactionClick ? { textDecoration: 'underline' } : undefined}
                                                                onClick={() => onTransactionClick?.(lot.origin_transaction_id!)}
                                                            >
                                                                #{lot.origin_transaction_id}
                                                            </Text>
                                                        ) : (
                                                            <Text fontSize="2xs" color="gray.400">-</Text>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        <Text fontSize="xs" fontWeight="medium">{lot.asset?.symbol || '?'}</Text>
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        <Text fontSize="2xs" color="gray.500">{lot.account_name || '-'}</Text>
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'mono' }}>
                                                        {Number(lot.qty_original).toFixed(4)}
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'mono' }}>
                                                        {Number(lot.qty_remaining).toFixed(4)}
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                        {lot.is_zero_cost ? (
                                                            <Badge size="xs" colorPalette="red">Zero</Badge>
                                                        ) : lot.cost_source === 'provisional' ? (
                                                            <Tooltip
                                                                content={
                                                                    <Box fontSize="xs">
                                                                        <Text fontWeight="semibold">Provisional Cost</Text>
                                                                        <Text>FMV estimate for negative lot</Text>
                                                                        {lot.cost_fmv_price != null && <Text>FMV: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</Text>}
                                                                        {lot.cost_fmv_source && <Text>Source: {lot.cost_fmv_source}</Text>}
                                                                    </Box>
                                                                }
                                                                openDelay={200}
                                                            >
                                                                <Badge size="xs" colorPalette="orange" cursor="help">
                                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                                </Badge>
                                                            </Tooltip>
                                                        ) : lot.cost_source === 'fmv' && lot.cost_fmv_stale ? (
                                                            <Tooltip
                                                                content={
                                                                    <Box fontSize="xs">
                                                                        <Text fontWeight="semibold">Stale FMV</Text>
                                                                        {lot.cost_fmv_price != null && <Text>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</Text>}
                                                                        {lot.cost_fmv_source && <Text>Source: {lot.cost_fmv_source}</Text>}
                                                                        {lot.cost_fmv_timestamp && <Text>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</Text>}
                                                                    </Box>
                                                                }
                                                                openDelay={200}
                                                            >
                                                                <Badge size="xs" colorPalette="yellow" cursor="help">
                                                                    <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                                </Badge>
                                                            </Tooltip>
                                                        ) : (
                                                            <ValueDisplay value={lot.unit_cost_in_base} currency={baseCurrency} />
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.total_cost_in_base} currency={baseCurrency} />
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        {lot.cost_source ? (
                                                            (lot.cost_fmv_price || lot.cost_fmv_source || lot.cost_fmv_timestamp) ? (
                                                                <Tooltip
                                                                    content={
                                                                        <Box fontSize="xs" lineHeight="tall">
                                                                            <Text fontWeight="semibold">FMV Details</Text>
                                                                            {lot.cost_fmv_price != null && <Text>Price: {Number(lot.cost_fmv_price).toFixed(6)} {baseCurrency}</Text>}
                                                                            {lot.cost_fmv_source && <Text>Source: {lot.cost_fmv_source}</Text>}
                                                                            {lot.cost_fmv_timestamp && <Text>Snapped: {new Date(lot.cost_fmv_timestamp).toLocaleString()}</Text>}
                                                                            {lot.cost_fmv_stale && <Text color="orange.300">⚠ Stale price</Text>}
                                                                        </Box>
                                                                    }
                                                                    openDelay={200}
                                                                >
                                                                    <Badge size="xs" cursor="help" colorPalette={
                                                                        lot.cost_source === 'base_currency' ? 'gray' :
                                                                            lot.cost_source === 'proceeds' ? 'green' :
                                                                                lot.cost_source === 'inherited' ? 'blue' :
                                                                                    lot.cost_source === 'fmv' ? 'cyan' :
                                                                                        lot.cost_source === 'provisional' ? 'orange' : 'gray'
                                                                    }>
                                                                        {lot.cost_source}
                                                                    </Badge>
                                                                </Tooltip>
                                                            ) : (
                                                                <Badge size="xs" colorPalette={
                                                                    lot.cost_source === 'base_currency' ? 'gray' :
                                                                        lot.cost_source === 'proceeds' ? 'green' :
                                                                            lot.cost_source === 'inherited' ? 'blue' :
                                                                                lot.cost_source === 'fmv' ? 'cyan' :
                                                                                    lot.cost_source === 'provisional' ? 'orange' : 'gray'
                                                                }>
                                                                    {lot.cost_source}
                                                                </Badge>
                                                            )
                                                        ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                        {(lot.cost_source === 'inherited' || lot.cost_source === 'proceeds' || lot.source_lot_id) ? (
                                                            <CostBasisChainTooltip
                                                                lotId={lot.cost_lot_id}
                                                                versionId={versionId}
                                                                baseCurrency={baseCurrency}
                                                                onTransactionClick={onTransactionClick}
                                                            >
                                                                <Text fontSize="2xs" color="blue.400" cursor="help" _hover={{ textDecoration: 'underline' }}>🔗</Text>
                                                            </CostBasisChainTooltip>
                                                        ) : (
                                                            <Text fontSize="2xs" color="gray.300">—</Text>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        <Text fontSize="2xs" color="gray.500">
                                                            {lot.acquired_at ? new Date(lot.acquired_at).toLocaleDateString() : '-'}
                                                        </Text>
                                                    </td>
                                                    <td style={{ padding: '3px 6px' }}>
                                                        {lot.origin_unit_id ? (
                                                            <Text
                                                                fontSize="2xs"
                                                                color="blue.500"
                                                                fontFamily="mono"
                                                                cursor={onUnitClick ? 'pointer' : undefined}
                                                                _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                                onClick={() => onUnitClick?.(lot.origin_unit_id!)}
                                                            >
                                                                #{lot.origin_unit_id}
                                                            </Text>
                                                        ) : (
                                                            <Text fontSize="2xs" color="gray.400">-</Text>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                        <Badge size="xs" colorPalette={statusColor}>{status}</Badge>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </Box>
                            <TablePagination
                                page={pagination.page}
                                pageSize={pagination.pageSize}
                                total={total}
                                onPageChange={pagination.setPage}
                                onPageSizeChange={pagination.setPageSize}
                            />
                        </Box>
                    )}
        </SlidePanel>
    );
};
