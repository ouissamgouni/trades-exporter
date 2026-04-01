/**
 * LotsSlidePanel — Slide panel for Cost Lots aggregate view.
 *
 * Uses server-side filters (status, asset, account, search) and pagination.
 * Reuses existing CostLotsTab for the table rendering.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Flex, SimpleGrid, Text } from '@chakra-ui/react';
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

/* ─── Constants ─── */
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
const TH: React.CSSProperties = { padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600 };
const TD: React.CSSProperties = { padding: '3px 6px', fontSize: 11 };

/* ─── FilterChip ─── */
const FilterChip: React.FC<{ label: string; color: string; onClear: () => void }> = ({ label, color, onClear }) => (
    <Badge size="xs" colorPalette={color} variant="subtle" gap={1} cursor="default" display="inline-flex" alignItems="center">
        {label}
        <Box as="span" cursor="pointer" onClick={(e: React.MouseEvent) => { e.stopPropagation(); onClear(); }} _hover={{ opacity: 0.7 }}>
            <LuX size={10} />
        </Box>
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
        const chips: { id: string; label: string; color: string; onClear: () => void }[] = [];
        if (statusFilter !== 'all')
            chips.push({ id: 'status', label: `Status: ${statusFilter}`, color: statusFilter === 'open' ? 'green' : statusFilter === 'exhausted' ? 'gray' : 'red', onClear: () => setStatusFilter('all') });
        if (assetFilter !== 'all') {
            const opt = filterOpts?.assets?.find(o => o.value === assetFilter);
            chips.push({ id: 'asset', label: `Asset: ${opt?.label || assetFilter}`, color: 'purple', onClear: () => setAssetFilter('all') });
        }
        if (accountFilter !== 'all') {
            const opt = filterOpts?.accounts?.find(o => o.value === accountFilter);
            chips.push({ id: 'account', label: `Acct: ${opt?.label || accountFilter}`, color: 'teal', onClear: () => setAccountFilter('all') });
        }
        if (debouncedSearch)
            chips.push({ id: 'search', label: `"${debouncedSearch}"`, color: 'blue', onClear: () => setSearchInput('') });
        return chips;
    }, [statusFilter, assetFilter, accountFilter, debouncedSearch, filterOpts]);

    const pageCount = Math.max(1, Math.ceil(total / pagination.pageSize));
    const safePage = pagination.page;

    const paginationBar = total > PAGE_SIZE_OPTIONS[0] ? (
        <Flex justify="space-between" align="center" width="100%" py={2} px={3}>
            <Flex align="center" gap={2}>
                <Text fontSize="2xs" color="gray.500">Rows:</Text>
                <Flex borderRadius="md" border="1px solid" borderColor="gray.200" overflow="hidden" display="inline-flex">
                    {PAGE_SIZE_OPTIONS.map(size => (
                        <Button key={size} size="2xs"
                            variant={pagination.pageSize === size ? 'subtle' : 'ghost'}
                            colorPalette={pagination.pageSize === size ? 'blue' : 'gray'}
                            borderRadius="0"
                            onClick={() => { pagination.setPageSize(size); pagination.setPage(1); }}
                            px={2} fontSize="xs">
                            {size}
                        </Button>
                    ))}
                </Flex>
            </Flex>
            <Text fontSize="2xs" color="gray.500">
                {(safePage - 1) * pagination.pageSize + 1}–{Math.min(safePage * pagination.pageSize, total)} of {total}
            </Text>
            <Flex align="center" gap={1}>
                <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(1)} disabled={safePage <= 1} px={1}>
                    <FiChevronsLeft size={12} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(safePage - 1)} disabled={safePage <= 1} px={1}>
                    <FiChevronLeft size={14} />
                </Button>
                <Text fontSize="xs" color="gray.600" mx={1}>{safePage} / {pageCount}</Text>
                <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(safePage + 1)} disabled={safePage >= pageCount} px={1}>
                    <FiChevronRight size={14} />
                </Button>
                <Button size="2xs" variant="ghost" onClick={() => pagination.setPage(pageCount)} disabled={safePage >= pageCount} px={1}>
                    <FiChevronsRight size={12} />
                </Button>
            </Flex>
        </Flex>
    ) : null;

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Cost Lots" width="950px">
            {/* ─── Collapsible Filter Section ─── */}
            <Box mb={3}>
                <Box bg="gray.50" borderRadius="md" border="1px solid" borderColor={hasAnyFilter ? 'blue.300' : 'gray.200'} overflow="visible">
                    {/* Clickable header */}
                    <Flex align="center" justify="space-between" p={3} pb={hasAnyFilter ? 2 : 3}
                        cursor="pointer" transition="background 0.15s" _hover={{ bg: 'gray.100' }}
                        onClick={() => setFiltersExpanded(p => !p)} borderRadius="md">
                        <Flex align="center" gap={1.5}>
                            <Box transition="transform 0.2s" transform={filtersExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'}>
                                <LuChevronDown size={14} />
                            </Box>
                            <LuFilter size={12} />
                            <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                            {activeChips.length > 0 && (
                                <Badge size="xs" colorPalette="blue">{activeChips.length} active</Badge>
                            )}
                        </Flex>
                        <Flex gap={1.5} onClick={e => e.stopPropagation()}>
                            {hasAnyFilter && (
                                <Button size="xs" variant="ghost" onClick={clearFilters} color="gray.500" _hover={{ color: 'gray.700' }}>
                                    <LuRotateCcw size={10} />
                                    <Text ml={0.5} fontSize="2xs">Clear All</Text>
                                </Button>
                            )}
                        </Flex>
                    </Flex>

                    {/* Active filter chips row */}
                    {hasAnyFilter && (
                        <Box px={3} pb={filtersExpanded ? 2 : 3} pt={0}>
                            <Flex flexWrap="wrap" gap={1.5} align="center">
                                {activeChips.map(chip => <FilterChip key={chip.id} label={chip.label} color={chip.color} onClear={chip.onClear} />)}
                            </Flex>
                        </Box>
                    )}

                    {!hasAnyFilter && !filtersExpanded && (
                        <Box px={3} pb={3} pt={0}>
                            <Text fontSize="xs" color="gray.500" fontStyle="italic">No filters applied</Text>
                        </Box>
                    )}

                    {/* Expanded filter controls */}
                    {filtersExpanded && (
                        <Box p={3} pt={hasAnyFilter ? 1 : 2}>
                            <SimpleGrid columns={{ base: 1, md: 2, lg: 4 }} gap={3}>
                                {/* Search */}
                                <Box>
                                    <Text fontSize="2xs" fontWeight="medium" color="gray.600" mb={1}>Search</Text>
                                    <Flex align="center" gap={1} bg="white" borderRadius="md" px={2} py={1} border="1px solid" borderColor="gray.200">
                                        <FiSearch size={12} color="gray" />
                                        <input
                                            type="text"
                                            placeholder="Asset / account…"
                                            value={searchInput}
                                            onChange={(e) => setSearchInput(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                                        />
                                    </Flex>
                                </Box>
                                {/* Status */}
                                <Box>
                                    <Text fontSize="2xs" fontWeight="medium" color="gray.600" mb={1}>Status</Text>
                                    <Flex gap={1} flexWrap="wrap">
                                        {['all', 'open', 'exhausted', 'negative'].map(s => {
                                            const opt = filterOpts?.statuses?.find(o => o.value === s);
                                            return (
                                                <Button key={s} size="2xs"
                                                    variant={statusFilter === s ? 'solid' : 'outline'}
                                                    onClick={() => setStatusFilter(statusFilter === s && s !== 'all' ? 'all' : s)}>
                                                    {s === 'all' ? 'All' : `${s.charAt(0).toUpperCase() + s.slice(1)}${opt ? ` (${opt.count})` : ''}`}
                                                </Button>
                                            );
                                        })}
                                    </Flex>
                                </Box>
                                {/* Asset */}
                                {filterOpts && filterOpts.assets.length > 1 && (
                                    <Box>
                                        <Text fontSize="2xs" fontWeight="medium" color="gray.600" mb={1}>Asset</Text>
                                        <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white' }}>
                                            <option value="all">All Assets</option>
                                            {filterOpts.assets.map(a => (
                                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                                            ))}
                                        </select>
                                    </Box>
                                )}
                                {/* Account */}
                                {filterOpts && filterOpts.accounts.length > 1 && (
                                    <Box>
                                        <Text fontSize="2xs" fontWeight="medium" color="gray.600" mb={1}>Account</Text>
                                        <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}
                                            style={{ width: '100%', fontSize: 11, padding: '4px 6px', borderRadius: 6, border: '1px solid #e2e8f0', background: 'white' }}>
                                            <option value="all">All Accounts</option>
                                            {filterOpts.accounts.map(a => (
                                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                                            ))}
                                        </select>
                                    </Box>
                                )}
                            </SimpleGrid>
                        </Box>
                    )}
                </Box>
            </Box>

            {/* Content */}
            {isLoading ? <TabLoadingState message="Loading lots…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    lots.length === 0 ? <TabEmptyState title="No lots" description={hasAnyFilter ? 'Try adjusting filters.' : 'No cost lots found.'} /> : (
                        <Box>
                            <Flex justify="space-between" align="center" mb={1}>
                                <Text fontSize="2xs" color="gray.500">{total} lot{total !== 1 ? 's' : ''}</Text>
                            </Flex>
                            {paginationBar}
                            <Box overflowX="auto" fontSize="11px">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ ...TH, textAlign: 'left' }}>ID</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Asset</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Account</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Status</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Initial Qty</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Remaining</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Unit Cost</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Initial Cost</th>
                                            <th style={{ ...TH, textAlign: 'right' }}>Remaining Cost</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Source</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Chain</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Date</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Unit</th>
                                            <th style={{ ...TH, textAlign: 'left' }}>Origin TX</th>
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
                                                    <td style={TD}>
                                                        <AssetBadge asset={lot.asset} size="xs" />
                                                    </td>
                                                    <td style={TD}>
                                                        <Text fontSize="2xs" color="gray.500">{lot.account_name || '-'}</Text>
                                                    </td>
                                                    <td style={{ ...TD, textAlign: 'center' }}>
                                                        <Badge size="xs" colorPalette={statusColor}>{status}</Badge>
                                                    </td>
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.qty_original} />
                                                    </td>
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.qty_remaining} />
                                                    </td>
                                                    <td style={{ ...TD, textAlign: 'right' }}>
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
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.total_cost_in_base} currency={baseCurrency} />
                                                    </td>
                                                    <td style={{ ...TD, textAlign: 'right' }}>
                                                        <ValueDisplay value={lot.remaining_cost_in_base} currency={baseCurrency} />
                                                    </td>
                                                    <td style={TD}>
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
                                                    <td style={{ ...TD, textAlign: 'center' }}>
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
                                                    <td style={TD}>
                                                        <Text fontSize="2xs" color="gray.500">
                                                            {lot.acquired_at ? new Date(lot.acquired_at).toLocaleDateString() : '-'}
                                                        </Text>
                                                    </td>
                                                    <td style={TD}>
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
                                                    <td style={TD}>
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
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </Box>
                            {paginationBar}
                        </Box>
                    )}
        </SlidePanel>
    );
};
