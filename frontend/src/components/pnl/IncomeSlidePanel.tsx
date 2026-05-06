/**
 * IncomeSlidePanel — Slide panel for Income Events (dividends, interest, etc.)
 *
 * Features:
 * - Backend pagination with inline pagination bar
 * - Filters by asset, income type, account, jurisdiction, date range
 * - Server-side sorting by date and amount
 */

import React, { useContext, useEffect, useMemo, useState } from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
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
            .catch(() => {});
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
            <Box p={4}>
                {/* Summary bar */}
                <Flex gap={4} mb={4} p={3} bg="teal.50" borderRadius="md" align="center" wrap="wrap">
                    <Box>
                        <Text fontSize="xs" color="gray.500">Total Events</Text>
                        <Text fontWeight="bold" color="teal.700">{total}</Text>
                    </Box>
                    <Box>
                        <Text fontSize="xs" color="gray.500">Gross Income</Text>
                        <Text fontWeight="bold" color="teal.700">
                            <ValueDisplay value={visibleTotals.gross} currency={baseCurrency} />
                        </Text>
                    </Box>
                    <Box>
                        <Text fontSize="xs" color="gray.500">Withholding</Text>
                        <Text fontWeight="bold" color="red.500">
                            <ValueDisplay value={-visibleTotals.wht} currency={baseCurrency} />
                        </Text>
                    </Box>
                    <Box>
                        <Text fontSize="xs" color="gray.500">Net Income</Text>
                        <Text fontWeight="bold" color="teal.700">
                            <ValueDisplay value={visibleTotals.net} currency={baseCurrency} />
                        </Text>
                    </Box>
                </Flex>

                {/* Filter row */}
                <Flex gap={2} mb={3} wrap="wrap" align="center">
                    <LuFilter size={14} />
                    {filterOpts?.assets && filterOpts.assets.length > 0 && (
                        <Box as="select" fontSize="xs" px={2} py={1} borderRadius="md" border="1px solid" borderColor="gray.200"
                            value={assetFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAssetFilter(e.target.value)}>
                            <option value="">All Assets</option>
                            {filterOpts.assets.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </Box>
                    )}
                    {filterOpts?.income_types && filterOpts.income_types.length > 1 && (
                        <Box as="select" fontSize="xs" px={2} py={1} borderRadius="md" border="1px solid" borderColor="gray.200"
                            value={typeFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTypeFilter(e.target.value)}>
                            <option value="">All Types</option>
                            {filterOpts.income_types.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </Box>
                    )}
                    {filterOpts?.accounts && filterOpts.accounts.length > 1 && (
                        <Box as="select" fontSize="xs" px={2} py={1} borderRadius="md" border="1px solid" borderColor="gray.200"
                            value={accountFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAccountFilter(e.target.value)}>
                            <option value="">All Accounts</option>
                            {filterOpts.accounts.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </Box>
                    )}
                    {filterOpts?.jurisdictions && filterOpts.jurisdictions.length > 0 && (
                        <Box as="select" fontSize="xs" px={2} py={1} borderRadius="md" border="1px solid" borderColor="gray.200"
                            value={jurisdictionFilter} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setJurisdictionFilter(e.target.value)}>
                            <option value="">All Countries</option>
                            {filterOpts.jurisdictions.map(o => (
                                <option key={o.value} value={o.value}>{o.label} ({o.count})</option>
                            ))}
                        </Box>
                    )}
                    {hasAnyFilter && (
                        <Box as="button" fontSize="xs" color="red.500" onClick={clearFilters} cursor="pointer" display="flex" alignItems="center" gap={1}>
                            <LuX size={12} /> Clear
                        </Box>
                    )}
                </Flex>

                {/* Table */}
                {isLoading ? (
                    <TabLoadingState message="Loading income events..." />
                ) : error ? (
                    <TabErrorState message={error} />
                ) : entries.length === 0 ? (
                    <TabEmptyState message="No income events found." icon={<LuBanknote size={24} />} />
                ) : (
                    <>
                        <Box overflowX="auto" mb={3}>
                            <Box as="table" width="100%" fontSize="xs">
                                <Box as="thead">
                                    <Box as="tr" bg="gray.50">
                                        <Box as="th" px={2} py={1} textAlign="left" cursor="pointer" onClick={() => handleSort('date')} whiteSpace="nowrap">
                                            Date {sortBy === 'date' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                                        </Box>
                                        <Box as="th" px={2} py={1} textAlign="left">Asset</Box>
                                        <Box as="th" px={2} py={1} textAlign="left">Type</Box>
                                        <Box as="th" px={2} py={1} textAlign="left">Account</Box>
                                        <Box as="th" px={2} py={1} textAlign="right" cursor="pointer" onClick={() => handleSort('amount')} whiteSpace="nowrap">
                                            Gross {sortBy === 'amount' ? (sortOrder === 'asc' ? '↑' : '↓') : ''}
                                        </Box>
                                        <Box as="th" px={2} py={1} textAlign="right">WHT</Box>
                                        <Box as="th" px={2} py={1} textAlign="right">Net</Box>
                                        <Box as="th" px={2} py={1} textAlign="left">Country</Box>
                                    </Box>
                                </Box>
                                <Box as="tbody">
                                    {entries.map(e => {
                                        const asset = e.attributed_asset ?? e.asset;
                                        const assetId = asset?.id;
                                        return (
                                            <Box as="tr" key={e.id} _hover={{ bg: 'gray.50' }} borderBottom="1px solid" borderColor="gray.100">
                                                <Box as="td" px={2} py={1.5} whiteSpace="nowrap">{fmtDate(e.income_at)}</Box>
                                                <Box as="td" px={2} py={1.5}>
                                                    <Text
                                                        fontSize="xs"
                                                        fontWeight="semibold"
                                                        color="blue.600"
                                                        cursor={assetId ? 'pointer' : undefined}
                                                        _hover={assetId ? { textDecoration: 'underline' } : undefined}
                                                        onClick={() => {
                                                            if (assetId && assetPanelCtx) {
                                                                assetPanelCtx.openAssetPanel(assetId, { pnlVersionId: versionId });
                                                            } else if (assetId && onAssetClick) {
                                                                onAssetClick(assetId);
                                                            }
                                                        }}
                                                    >
                                                        {asset?.symbol || '—'}
                                                    </Text>
                                                </Box>
                                                <Box as="td" px={2} py={1.5}>
                                                    <Badge size="xs" colorPalette="teal" variant="subtle">
                                                        {e.income_type}
                                                    </Badge>
                                                </Box>
                                                <Box as="td" px={2} py={1.5} color="gray.600">{e.account_name || '—'}</Box>
                                                <Box as="td" px={2} py={1.5} textAlign="right" fontWeight="medium" color="teal.700">
                                                    <ValueDisplay value={e.gross_amount_in_base} currency={baseCurrency} />
                                                </Box>
                                                <Box as="td" px={2} py={1.5} textAlign="right" color="red.500">
                                                    {e.withholding_amount_in_base > 0 ? (
                                                        <>
                                                            -<ValueDisplay value={e.withholding_amount_in_base} currency={baseCurrency} />
                                                            {e.withholding_rate != null && (
                                                                <Text as="span" fontSize="2xs" color="gray.400" ml={1}>
                                                                    ({(e.withholding_rate * 100).toFixed(0)}%)
                                                                </Text>
                                                            )}
                                                        </>
                                                    ) : '—'}
                                                </Box>
                                                <Box as="td" px={2} py={1.5} textAlign="right" fontWeight="semibold" color="teal.600">
                                                    <ValueDisplay value={e.net_amount_in_base} currency={baseCurrency} />
                                                </Box>
                                                <Box as="td" px={2} py={1.5} color="gray.500" fontSize="2xs">
                                                    {e.withholding_jurisdiction || '—'}
                                                </Box>
                                            </Box>
                                        );
                                    })}
                                </Box>
                            </Box>
                        </Box>

                        {/* Pagination */}
                        {pageCount > 1 && (
                            <Flex align="center" justify="space-between" fontSize="xs" color="gray.500" pt={2} borderTop="1px solid" borderColor="gray.100">
                                <Text>
                                    {((pagination.page - 1) * (pagination.pageSize || PAGE_SIZE)) + 1}–
                                    {Math.min(pagination.page * (pagination.pageSize || PAGE_SIZE), total)} of {total}
                                </Text>
                                <Flex gap={1}>
                                    <Box as="button" disabled={pagination.page <= 1} onClick={() => pagination.setPage(pagination.page - 1)}
                                        opacity={pagination.page <= 1 ? 0.3 : 1} cursor={pagination.page <= 1 ? 'not-allowed' : 'pointer'}>
                                        <FiChevronLeft size={14} />
                                    </Box>
                                    <Text>Page {pagination.page} / {pageCount}</Text>
                                    <Box as="button" disabled={pagination.page >= pageCount} onClick={() => pagination.setPage(pagination.page + 1)}
                                        opacity={pagination.page >= pageCount ? 0.3 : 1} cursor={pagination.page >= pageCount ? 'not-allowed' : 'pointer'}>
                                        <FiChevronRight size={14} />
                                    </Box>
                                </Flex>
                            </Flex>
                        )}
                    </>
                )}
            </Box>
        </SlidePanel>
    );
};
