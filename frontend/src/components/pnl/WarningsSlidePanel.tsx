/**
 * WarningsSlidePanel — Slide panel for Warnings aggregate view.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { FiSearch } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { TablePagination } from '../TablePagination';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';

interface FilterOption { value: string; label?: string; count: number }
interface WarningsFilterOptions {
    warning_types: FilterOption[];
    levels: FilterOption[];
    assets: FilterOption[];
}

interface WarningEntry {
    warning_type: string;
    message: string;
    timestamp: string;
    transaction_id?: number;
    unit_id?: number;
    unit_label?: string;
    asset_id?: number;
    details?: Record<string, unknown>;
}

const LEVEL_COLORS: Record<string, string> = {
    error: 'red',
    warning: 'orange',
    info: 'blue',
};

const TYPE_LEVEL: Record<string, string> = {
    insufficient_lots: 'error',
    negative_balance: 'error',
    missing_price: 'warning',
    stale_price: 'warning',
    fmv_fetch_failed: 'warning',
    fee_consumption_failed: 'warning',
    zero_cost_lot: 'warning',  // Upgraded — zero-cost causes phantom gains
    provisional_cost_lot: 'warning',  // FMV-based cost on negative lot
    unsettled_negative_lot: 'warning',  // Negative lot never settled
    residual_mismatch: 'info',
    unmatched_group: 'info',
    unmatched_internal_transfer: 'info',
};

export interface WarningSlidePanelProps {
    isOpen: boolean;
    onClose: () => void;
    versionId: number;
    baseCurrency: string;
    txFilterParams?: Record<string, string | number | boolean | undefined>;
    onPriceAdded?: (assetId: number, warningId: string) => void;
    onTransactionClick?: (txId: number) => void;
    onUnitClick?: (unitId: number) => void;
    onLotClick?: (lotId: number) => void;
}

export const WarningsSlidePanel: React.FC<WarningSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    txFilterParams,
    onPriceAdded,
    onTransactionClick,
    onUnitClick,
    onLotClick,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_warnings_slide' });

    const [typeFilter, setTypeFilter] = useState<string>('all');
    const [levelFilter, setLevelFilter] = useState<string>('all');
    const [assetFilter, setAssetFilter] = useState<string>('all');
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = { ...txFilterParams };
        if (typeFilter !== 'all') params.warning_type = typeFilter;
        if (levelFilter !== 'all') params.level = levelFilter;
        if (assetFilter !== 'all') params.asset_id = Number(assetFilter);
        if (debouncedSearch) params.search = debouncedSearch;
        return params;
    }, [txFilterParams, typeFilter, levelFilter, assetFilter, debouncedSearch]);

    const prevRef = React.useRef(serverParams);
    useEffect(() => {
        if (prevRef.current !== serverParams) { pagination.setPage(1); prevRef.current = serverParams; }
    }, [serverParams]);

    const { data: warnings, total, isLoading, error, refetch } = useLazyPaginatedQuery<WarningEntry>({
        endpoint: `/pnl/versions/${versionId}/warnings`,
        page: pagination.page,
        limit: pagination.pageSize,
        params: serverParams,
        lazy: true,
        enabled: isOpen,
    });

    useEffect(() => { pagination.setTotal(total); }, [total]);

    // Filter options
    const [filterOpts, setFilterOpts] = useState<WarningsFilterOptions | null>(null);
    useEffect(() => {
        if (!isOpen) return;
        const qs = new URLSearchParams();
        if (txFilterParams) {
            Object.entries(txFilterParams).forEach(([k, v]) => {
                if (v !== undefined && v !== '') qs.set(k, String(v));
            });
        }
        fetch(`${API_URL}/pnl/versions/${versionId}/warnings/filter-options?${qs}`)
            .then(r => r.json())
            .then(setFilterOpts)
            .catch(() => { });
    }, [versionId, txFilterParams, isOpen]);

    const hasAnyFilter = typeFilter !== 'all' || levelFilter !== 'all' || assetFilter !== 'all' || !!debouncedSearch;

    const clearFilters = () => {
        setTypeFilter('all'); setLevelFilter('all'); setAssetFilter('all'); setSearchInput('');
    };

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Warnings" width="900px">
            <Flex gap={2} mb={3} wrap="wrap" align="center">
                <Flex align="center" gap={1} bg="gray.50" borderRadius="md" px={2} py={0.5}>
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text" placeholder="Search message"
                        value={searchInput} onChange={e => setSearchInput(e.target.value)}
                        style={{ width: 120, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </Flex>
                {/* Level toggles */}
                {filterOpts?.levels?.map(o => (
                    <Button key={o.value} size="2xs"
                        variant={levelFilter === o.value ? 'solid' : 'outline'}
                        colorPalette={LEVEL_COLORS[o.value] || 'gray'}
                        onClick={() => setLevelFilter(levelFilter === o.value ? 'all' : o.value)}
                    >
                        {o.label} ({o.count})
                    </Button>
                ))}
                {hasAnyFilter && <Button size="2xs" variant="ghost" onClick={clearFilters}>Clear</Button>}
            </Flex>

            {/* Type + Asset dropdowns */}
            {filterOpts && (filterOpts.warning_types.length > 1 || filterOpts.assets.length > 1) && (
                <Flex gap={2} mb={3} wrap="wrap">
                    {filterOpts.warning_types.length > 1 && (
                        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
                            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                            <option value="all">All Types</option>
                            {filterOpts.warning_types.map(t => (
                                <option key={t.value} value={t.value}>
                                    {(t.label || t.value.replace(/_/g, ' '))} ({t.count})
                                </option>
                            ))}
                        </select>
                    )}
                    {filterOpts.assets.length > 1 && (
                        <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                            style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                            <option value="all">All Assets</option>
                            {filterOpts.assets.map(a => (
                                <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                            ))}
                        </select>
                    )}
                </Flex>
            )}

            {isLoading ? <TabLoadingState message="Loading warnings…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    warnings.length === 0 ? <TabEmptyState title="No warnings" description={hasAnyFilter ? 'Try adjusting filters.' : 'No warnings found.'} /> : (
                        <Box>
                            <Text fontSize="2xs" color="gray.500" mb={2}>{total} warning{total !== 1 ? 's' : ''}</Text>
                            <Box overflowX="auto" fontSize="11px">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Date</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Type</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Message</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>TX</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Unit</th>
                                            <th style={{ textAlign: 'center', padding: '4px 6px', fontSize: 10 }}>Chain</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {warnings.map((w: WarningEntry, idx: number) => {
                                            const level = TYPE_LEVEL[w.warning_type] || 'info';
                                            const lotId = w.details?.lot_id as number | undefined;
                                            const isProvisional = w.warning_type === 'provisional_cost_lot';
                                            const isUnsettled = w.warning_type === 'unsettled_negative_lot';
                                            const hasActions = isProvisional || isUnsettled;
                                            return (
                                                <React.Fragment key={idx}>
                                                    <tr style={{ borderBottom: hasActions ? 'none' : '1px solid #f1f3f5' }}>
                                                        <td style={{ padding: '3px 6px' }}>
                                                            <Text fontSize="2xs" color="gray.500">
                                                                {w.timestamp ? new Date(w.timestamp).toLocaleDateString() : '-'}
                                                            </Text>
                                                        </td>
                                                        <td style={{ padding: '3px 6px' }}>
                                                            <Badge size="xs" colorPalette={LEVEL_COLORS[level] || 'gray'}>
                                                                {w.warning_type.replace(/_/g, ' ')}
                                                            </Badge>
                                                        </td>
                                                        <td style={{ padding: '3px 6px', maxWidth: 250 }}>
                                                            <Text fontSize="2xs" color="gray.600" lineClamp={2}>
                                                                {w.message}
                                                            </Text>
                                                        </td>
                                                        <td style={{ padding: '3px 6px' }}>
                                                            {w.transaction_id ? (
                                                                <Text
                                                                    fontSize="2xs"
                                                                    color="blue.500"
                                                                    fontFamily="mono"
                                                                    cursor={onTransactionClick ? 'pointer' : undefined}
                                                                    _hover={onTransactionClick ? { textDecoration: 'underline' } : undefined}
                                                                    onClick={() => onTransactionClick?.(w.transaction_id!)}
                                                                >
                                                                    #{w.transaction_id}
                                                                </Text>
                                                            ) : (
                                                                <Text fontSize="2xs" color="gray.400">-</Text>
                                                            )}
                                                        </td>
                                                        <td style={{ padding: '3px 6px' }}>
                                                            {w.unit_id ? (
                                                                <Text
                                                                    fontSize="2xs"
                                                                    color="blue.500"
                                                                    fontFamily="mono"
                                                                    cursor={onUnitClick ? 'pointer' : undefined}
                                                                    _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                                    onClick={() => onUnitClick?.(w.unit_id!)}
                                                                >
                                                                    #{w.unit_id}
                                                                </Text>
                                                            ) : (
                                                                <Text fontSize="2xs" color="gray.400">-</Text>
                                                            )}
                                                        </td>
                                                        <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                            {lotId ? (
                                                                <CostBasisChainTooltip
                                                                    lotId={lotId}
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
                                                            <Flex gap={1} align="center">
                                                                {w.transaction_id && onTransactionClick && (
                                                                    <Button size="2xs" variant="ghost" colorPalette="blue"
                                                                        onClick={() => onTransactionClick(w.transaction_id!)}>
                                                                        View TX
                                                                    </Button>
                                                                )}
                                                                {lotId && onLotClick && (
                                                                    <Button size="2xs" variant="ghost" colorPalette="purple"
                                                                        onClick={() => onLotClick(lotId)}>
                                                                        View Lot
                                                                    </Button>
                                                                )}
                                                            </Flex>
                                                        </td>
                                                    </tr>
                                                    {/* Root cause info row for provisional/unsettled */}
                                                    {hasActions && (
                                                        <tr style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                            <td colSpan={7} style={{ padding: '2px 6px 6px 24px' }}>
                                                                <Text fontSize="2xs" color={isProvisional ? 'orange.600' : 'red.600'} fontStyle="italic">
                                                                    {isProvisional
                                                                        ? '💡 Cost basis is estimated via FMV. The acquisition transaction for this asset has not been imported yet. Import it to get the actual cost.'
                                                                        : '💡 This negative lot was never settled by an incoming acquisition. Check if the buy/deposit transaction is missing from your data.'}
                                                                </Text>
                                                            </td>
                                                        </tr>
                                                    )}
                                                </React.Fragment>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </Box>
                            <TablePagination
                                page={pagination.page} pageSize={pagination.pageSize}
                                total={total} onPageChange={pagination.setPage}
                                onPageSizeChange={pagination.setPageSize}
                            />
                        </Box>
                    )}
        </SlidePanel>
    );
};
