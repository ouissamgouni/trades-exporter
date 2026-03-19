/**
 * RealizedPnLSlidePanel — Slide panel for Realized P&L aggregate view.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { FiSearch } from 'react-icons/fi';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { TablePagination } from '../TablePagination';
import { ValueDisplay } from '../ValueDisplay';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';
import { AssetBadge } from '../AssetBadge';
import { formatQuantity } from '../../utils/numberUtils';

interface FilterOption { value: string; label?: string; count: number }
interface RealizedFilterOptions {
    assets: FilterOption[];
    taxable_options: FilterOption[];
    pnl_sign_options: FilterOption[];
    holding_period_options: FilterOption[];
}

interface RealizedPnLEntry {
    pnl_id: number;
    asset: { id: number; symbol: string; label?: string };
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
    taxable: boolean;
    transaction_id?: number;
    unit_id?: number;
    realized_at: string;
    holding_period_days?: number;
    // Proceeds tracking - how FMV was determined
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

export const RealizedPnLSlidePanel: React.FC<RealizedPnLSlidePanelProps> = ({
    isOpen,
    onClose,
    versionId,
    baseCurrency,
    txFilterParams,
    onAssetClick,
    onTransactionClick,
    onUnitClick,
}) => {
    const pagination = usePagination({ storageKey: 'pnl_realized_slide' });

    const [taxableFilter, setTaxableFilter] = useState<string>('all');
    const [signFilter, setSignFilter] = useState<string>('all');
    const [holdingFilter, setHoldingFilter] = useState<string>('all');
    const [assetFilter, setAssetFilter] = useState<string>('all');
    const [searchInput, setSearchInput] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');

    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchInput), 300);
        return () => clearTimeout(timer);
    }, [searchInput]);

    const serverParams = useMemo(() => {
        const params: Record<string, string | number | boolean | undefined> = { ...txFilterParams };
        if (taxableFilter !== 'all') params.is_taxable = taxableFilter === 'true';
        if (signFilter !== 'all') params.pnl_sign = signFilter;
        if (holdingFilter !== 'all') params.holding_period = holdingFilter;
        if (assetFilter !== 'all') params.asset_id = Number(assetFilter);
        if (debouncedSearch) params.search = debouncedSearch;
        return params;
    }, [txFilterParams, taxableFilter, signFilter, holdingFilter, assetFilter, debouncedSearch]);

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

    const hasAnyFilter = taxableFilter !== 'all' || signFilter !== 'all' || holdingFilter !== 'all' || assetFilter !== 'all' || !!debouncedSearch;

    const clearFilters = () => {
        setTaxableFilter('all'); setSignFilter('all'); setHoldingFilter('all');
        setAssetFilter('all'); setSearchInput('');
    };

    return (
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Realized P&L" width="850px">
            <Flex gap={2} mb={3} wrap="wrap" align="center">
                <Flex align="center" gap={1} bg="gray.50" borderRadius="md" px={2} py={0.5}>
                    <FiSearch size={12} color="gray" />
                    <input
                        type="text" placeholder="Search asset"
                        value={searchInput} onChange={e => setSearchInput(e.target.value)}
                        style={{ width: 100, fontSize: 11, background: 'transparent', border: 'none', outline: 'none' }}
                    />
                </Flex>
                {/* Taxable toggle */}
                {filterOpts?.taxable_options?.map(o => (
                    <Button key={o.value} size="2xs"
                        variant={taxableFilter === o.value ? 'solid' : 'outline'}
                        onClick={() => setTaxableFilter(taxableFilter === o.value ? 'all' : o.value)}
                    >
                        {o.label} ({o.count})
                    </Button>
                ))}
                {/* Gain/Loss */}
                {filterOpts?.pnl_sign_options?.map(o => (
                    <Button key={o.value} size="2xs"
                        variant={signFilter === o.value ? 'solid' : 'outline'}
                        colorPalette={o.value === 'gain' ? 'green' : 'red'}
                        onClick={() => setSignFilter(signFilter === o.value ? 'all' : o.value)}
                    >
                        {o.label} ({o.count})
                    </Button>
                ))}
                {/* Holding period */}
                {filterOpts?.holding_period_options?.map(o => (
                    <Button key={o.value} size="2xs"
                        variant={holdingFilter === o.value ? 'solid' : 'outline'}
                        onClick={() => setHoldingFilter(holdingFilter === o.value ? 'all' : o.value)}
                    >
                        {o.label} ({o.count})
                    </Button>
                ))}
                {hasAnyFilter && <Button size="2xs" variant="ghost" onClick={clearFilters}>Clear</Button>}
            </Flex>

            {/* Asset dropdown */}
            {filterOpts && filterOpts.assets.length > 1 && (
                <Flex mb={3}>
                    <select value={assetFilter} onChange={e => setAssetFilter(e.target.value)}
                        style={{ fontSize: 11, padding: '2px 4px', borderRadius: 4, border: '1px solid #e2e8f0' }}>
                        <option value="all">All Assets</option>
                        {filterOpts.assets.map(a => (
                            <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
                        ))}
                    </select>
                </Flex>
            )}

            {isLoading ? <TabLoadingState message="Loading realized P&L…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    entries.length === 0 ? <TabEmptyState title="No entries" description={hasAnyFilter ? 'Try adjusting filters.' : 'No realized P&L entries.'} /> : (
                        <Box>
                            <Text fontSize="2xs" color="gray.500" mb={2}>{total} entr{total !== 1 ? 'ies' : 'y'}</Text>
                            <Box overflowX="auto" fontSize="11px">
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>ID</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Date</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Asset</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Qty</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Proceeds</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>FMV</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Cost Basis</th>
                                            <th style={{ textAlign: 'center', padding: '4px 6px', fontSize: 10 }}>Chain</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>P&L</th>
                                            <th style={{ textAlign: 'center', padding: '4px 6px', fontSize: 10 }}>Tax</th>
                                            <th style={{ textAlign: 'right', padding: '4px 6px', fontSize: 10 }}>Days</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>TX</th>
                                            <th style={{ textAlign: 'left', padding: '4px 6px', fontSize: 10 }}>Unit</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {entries.map((e: RealizedPnLEntry, idx: number) => (
                                            <tr key={e.pnl_id ?? idx} style={{ borderBottom: '1px solid #f1f3f5' }}>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <Text fontSize="2xs" color="gray.600" fontFamily="mono">#{e.pnl_id}</Text>
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <Text fontSize="2xs" color="gray.500">
                                                        {e.realized_at ? new Date(e.realized_at).toLocaleDateString() : '-'}
                                                    </Text>
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    <AssetBadge asset={e.asset} size="xs" maxLength={20} />
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right', fontFamily: 'mono' }}>
                                                    {Number(e.qty).toFixed(4)}
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={e.proceeds_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    {e.proceeds_price != null ? (
                                                        <Flex gap={1} align="center" wrap="wrap">
                                                            <Text fontSize="2xs" fontFamily="mono" color="gray.600">
                                                                {formatQuantity(e.proceeds_price)}
                                                            </Text>
                                                            {e.proceeds_price_source && (
                                                                <Badge size="xs" colorPalette={e.proceeds_source === 'fmv' || e.proceeds_source === 'fmv_lookup' ? 'cyan' : e.proceeds_source === 'provisional' ? 'orange' : 'gray'} variant="subtle">
                                                                    {e.proceeds_price_source}
                                                                </Badge>
                                                            )}
                                                        </Flex>
                                                    ) : (
                                                        <Text fontSize="2xs" color="gray.400">-</Text>
                                                    )}
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <ValueDisplay value={e.cost_basis_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                    <CostBasisChainTooltip
                                                        pnlId={e.pnl_id}
                                                        versionId={versionId}
                                                        baseCurrency={baseCurrency}
                                                        onTransactionClick={onTransactionClick}
                                                    >
                                                        <Text fontSize="2xs" color="blue.400" cursor="help" _hover={{ textDecoration: 'underline' }}>🔗</Text>
                                                    </CostBasisChainTooltip>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <Text color={e.pnl_in_base >= 0 ? 'green.600' : 'red.600'} fontWeight="medium">
                                                        <ValueDisplay value={e.pnl_in_base} currency={baseCurrency} />
                                                    </Text>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'center' }}>
                                                    <Badge size="xs" colorPalette={e.taxable ? 'red' : 'gray'}>
                                                        {e.taxable ? 'Yes' : 'No'}
                                                    </Badge>
                                                </td>
                                                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                                                    <Text fontSize="2xs" color="gray.500">{e.holding_period_days ?? '-'}</Text>
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    {e.transaction_id ? (
                                                        <Text
                                                            fontSize="2xs"
                                                            color="blue.500"
                                                            fontFamily="mono"
                                                            cursor={onTransactionClick ? 'pointer' : undefined}
                                                            _hover={onTransactionClick ? { textDecoration: 'underline' } : undefined}
                                                            onClick={() => onTransactionClick?.(e.transaction_id!)}
                                                        >
                                                            #{e.transaction_id}
                                                        </Text>
                                                    ) : (
                                                        <Text fontSize="2xs" color="gray.400">-</Text>
                                                    )}
                                                </td>
                                                <td style={{ padding: '3px 6px' }}>
                                                    {e.unit_id ? (
                                                        <Text
                                                            fontSize="2xs"
                                                            color="blue.500"
                                                            fontFamily="mono"
                                                            cursor={onUnitClick ? 'pointer' : undefined}
                                                            _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                            onClick={() => onUnitClick?.(e.unit_id!)}
                                                        >
                                                            #{e.unit_id}
                                                        </Text>
                                                    ) : (
                                                        <Text fontSize="2xs" color="gray.400">-</Text>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
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
