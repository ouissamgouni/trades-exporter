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
import { Badge, Box, Button, Dialog, Flex, Input, SimpleGrid, Text } from '@chakra-ui/react';
import { FiChevronLeft, FiChevronRight, FiChevronsLeft, FiChevronsRight } from 'react-icons/fi';
import { LuArrowDown, LuArrowUp, LuArrowUpDown, LuCheck, LuChevronDown, LuCircleAlert, LuCircleCheck, LuFilter, LuInfo, LuPencil, LuRotateCcw, LuSearch, LuX } from 'react-icons/lu';
import { AssetDetailPanelContext } from '../../contexts/AssetDetailPanelContext';
import { SlidePanel } from './SlidePanel';
import { useLazyPaginatedQuery } from '../../hooks/useLazyPaginatedQuery';
import { usePagination } from '../../hooks/usePagination';
import { ValueDisplay } from '../ValueDisplay';
import { TabLoadingState, TabErrorState, TabEmptyState } from './AuditTabWrappers';
import { API_URL } from '../../types';
import { CostBasisChainTooltip } from './CostBasisChainTooltip';
import { Tooltip } from '../ui/tooltip';
import { PriceGetterTester } from '../PriceGetterTester';

/* ─── Types ─── */

interface FilterOption { value: string; label?: string; count: number }
interface RealizedFilterOptions {
    assets: FilterOption[];
    taxable_options: FilterOption[];
    pnl_sign_options: FilterOption[];
    holding_period_options: FilterOption[];
    origin_type_options: FilterOption[];
    accounts: FilterOption[];
    date_range?: { min: string; max: string } | null;
}

interface RealizedPnLEntry {
    pnl_id: number;
    asset: { id: number; symbol: string; label?: string };
    account_id?: number;
    account_name?: string;
    qty: number;
    proceeds_in_base: number;
    cost_basis_in_base: number;
    pnl_in_base: number;
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
const TH: React.CSSProperties = { padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600 };
const TD: React.CSSProperties = { padding: '3px 6px', fontSize: 11 };

const DATE_PRESETS = [
    { label: '1M', months: 1 },
    { label: '3M', months: 3 },
    { label: '6M', months: 6 },
    { label: '1Y', months: 12 },
];

/* ─── Sort Header ─── */

const SortHeader: React.FC<{
    label: string; field: string; current: string | null; order: string; align?: string;
    onSort: (f: string) => void;
}> = ({ label, field, current, order, align = 'left', onSort }) => (
    <th style={{ ...TH, textAlign: align as any, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => onSort(field)}>
        <Flex gap={0.5} align="center" justify={align === 'right' ? 'flex-end' : 'flex-start'}>
            {label}
            {current === field
                ? (order === 'desc' ? <LuArrowDown size={10} /> : <LuArrowUp size={10} />)
                : <LuArrowUpDown size={9} color="var(--chakra-colors-gray-400)" />}
        </Flex>
    </th>
);

/* ─── FilterCard (toggleable chips) ─── */

const RFilterCard: React.FC<{
    label: string; icon: string; options: FilterOption[];
    selected: string[]; onChange: (s: string[]) => void; color: string;
    searchable?: boolean;
}> = ({ label, icon, options, selected, onChange, color, searchable }) => {
    const [search, setSearch] = useState('');
    const handleToggle = (value: string) => {
        onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
    };
    const displayOptions = searchable && search
        ? options.filter(o => (o.label || o.value).toLowerCase().includes(search.toLowerCase()))
        : options;
    const needsScroll = displayOptions.length > 6;

    return (
        <Box bg="white" border="1px solid" borderColor={selected.length > 0 ? `${color}.200` : 'gray.200'}
            borderRadius="md" p={2} minH="70px">
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">{icon}</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">{label}</Text>
                </Flex>
                {selected.length > 0 && <Badge size="xs" colorPalette={color} borderRadius="full">{selected.length}</Badge>}
            </Flex>
            {searchable && (
                <Flex align="center" gap={1} mb={1.5} px={1} py={1} bg="gray.50" borderRadius="sm">
                    <LuSearch size={10} color="#A0AEC0" />
                    <input type="text" placeholder="Search..." value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: '10px', width: '100%', color: '#4A5568' }} />
                </Flex>
            )}
            <Box maxH={needsScroll ? '110px' : 'auto'} overflowY={needsScroll ? 'auto' : 'visible'}
                css={{ '&::-webkit-scrollbar': { width: '4px' }, '&::-webkit-scrollbar-thumb': { background: '#CBD5E0', borderRadius: '2px' } }}>
                <Flex flexWrap="wrap" gap={1}>
                    {displayOptions.map(option => {
                        const isSelected = selected.includes(option.value);
                        return (
                            <Box key={option.value} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs"
                                fontWeight="medium" cursor="pointer" transition="all 0.15s"
                                bg={isSelected ? `${color}.100` : 'gray.50'} color={isSelected ? `${color}.700` : 'gray.600'}
                                border="1px solid" borderColor={isSelected ? `${color}.300` : 'gray.200'}
                                _hover={{ bg: isSelected ? `${color}.200` : 'gray.100', borderColor: isSelected ? `${color}.400` : 'gray.300' }}
                                onClick={() => handleToggle(option.value)} display="inline-flex" alignItems="center" gap={0.5}>
                                {isSelected && <LuCheck size={8} />}
                                {option.label || option.value}
                                {option.count !== undefined && (
                                    <Text as="span" fontSize="2xs" color={isSelected ? `${color}.500` : 'gray.400'}>({option.count})</Text>
                                )}
                            </Box>
                        );
                    })}
                </Flex>
            </Box>
        </Box>
    );
};

/* ─── DropdownCard (searchable popover) ─── */

const RDropdownCard: React.FC<{
    label: string; icon: string; options: FilterOption[];
    selected: string[]; onChange: (s: string[]) => void; color: string;
    isOpen: boolean; onToggle: () => void; onClose: () => void;
}> = ({ label, icon, options, selected, onChange, color, isOpen, onToggle, onClose }) => {
    const [search, setSearch] = useState('');
    const cardRef = useRef<HTMLDivElement>(null);
    const popoverRef = useRef<HTMLDivElement>(null);
    const filteredOptions = options.filter(o => (o.label || o.value).toLowerCase().includes(search.toLowerCase()));
    const handleToggle = (value: string) => {
        onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
    };

    useEffect(() => {
        if (!isOpen) return;
        const handleClickOutside = (event: MouseEvent) => {
            if (popoverRef.current && !popoverRef.current.contains(event.target as Node)
                && cardRef.current && !cardRef.current.contains(event.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isOpen, onClose]);

    const getSelectedDisplay = () => {
        if (selected.length === 0) return 'Select...';
        if (selected.length === 1) {
            const opt = options.find(o => o.value === selected[0]);
            return opt?.label || selected[0];
        }
        return `${selected.length} selected`;
    };

    return (
        <Box ref={cardRef} bg="white" border="1px solid"
            borderColor={selected.length > 0 ? `${color}.200` : 'gray.200'}
            borderRadius="md" p={2} minH="70px" position="relative">
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">{icon}</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">{label}</Text>
                </Flex>
                {selected.length > 0 && <Badge size="xs" colorPalette={color} borderRadius="full">{selected.length}</Badge>}
            </Flex>
            <Button size="xs" variant="outline" width="100%" justifyContent="space-between"
                onClick={onToggle} borderColor={isOpen ? `${color}.300` : 'gray.200'}
                bg={selected.length > 0 ? `${color}.50` : 'white'} _hover={{ borderColor: `${color}.300` }}>
                <Text fontSize="2xs" color={selected.length > 0 ? `${color}.700` : 'gray.600'} truncate>
                    {getSelectedDisplay()}
                </Text>
                <LuChevronDown size={10} style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }} />
            </Button>
            {isOpen && (
                <Box ref={popoverRef} position="absolute" top="100%" left={0} right={0} mt={1}
                    bg="white" border="1px solid" borderColor="gray.200" borderRadius="md" boxShadow="lg" zIndex={1000} overflow="hidden">
                    <Box p={1.5} borderBottom="1px solid" borderColor="gray.100">
                        <Flex align="center" bg="gray.50" borderRadius="sm" px={1.5} gap={1}>
                            <LuSearch size={10} color="#A0AEC0" />
                            <input type="text" placeholder="Search..." value={search}
                                onChange={e => setSearch(e.target.value)}
                                style={{ flex: 1, border: 'none', background: 'transparent', padding: '6px 0', fontSize: '10px', outline: 'none' }} />
                        </Flex>
                    </Box>
                    <Flex p={1.5} gap={1} borderBottom="1px solid" borderColor="gray.100">
                        <Button size="xs" variant="ghost" onClick={() => onChange(filteredOptions.map(o => o.value))}>
                            <Text fontSize="2xs">All</Text>
                        </Button>
                        <Button size="xs" variant="ghost" onClick={() => onChange([])}>
                            <Text fontSize="2xs">None</Text>
                        </Button>
                    </Flex>
                    <Box maxH="160px" overflowY="auto" p={1}>
                        {filteredOptions.map(option => {
                            const isSelected = selected.includes(option.value);
                            return (
                                <Box key={option.value} px={1.5} py={1} cursor="pointer" borderRadius="sm"
                                    bg={isSelected ? `${color}.50` : undefined}
                                    _hover={{ bg: isSelected ? `${color}.100` : 'gray.50' }}
                                    onClick={() => handleToggle(option.value)} display="flex" alignItems="center" gap={1.5}>
                                    <Box w="12px" h="12px" borderRadius="sm" border="1px solid"
                                        borderColor={isSelected ? `${color}.500` : 'gray.300'}
                                        bg={isSelected ? `${color}.500` : 'white'}
                                        display="flex" alignItems="center" justifyContent="center" flexShrink={0}>
                                        {isSelected && <LuCheck size={8} color="white" />}
                                    </Box>
                                    <Text fontSize="2xs" flex={1}>{option.label || option.value}</Text>
                                    {option.count !== undefined && <Text fontSize="2xs" color="gray.400">({option.count})</Text>}
                                </Box>
                            );
                        })}
                        {filteredOptions.length === 0 && (
                            <Text fontSize="2xs" color="gray.400" p={1.5} textAlign="center">No results</Text>
                        )}
                    </Box>
                </Box>
            )}
        </Box>
    );
};

/* ─── DateCard ─── */

const RDateCard: React.FC<{
    dateFrom: string; dateTo: string;
    onChangeFrom: (v: string) => void; onChangeTo: (v: string) => void; onClear: () => void;
}> = ({ dateFrom, dateTo, onChangeFrom, onChangeTo, onClear }) => {
    const hasValue = dateFrom || dateTo;
    const getActivePreset = (): string | null => {
        if (!dateFrom || !dateTo) return null;
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        if (dateTo.split('T')[0] !== todayStr) return null;
        for (const preset of DATE_PRESETS) {
            const fromDate = new Date(today);
            fromDate.setMonth(fromDate.getMonth() - preset.months);
            if (dateFrom.split('T')[0] === fromDate.toISOString().split('T')[0]) return preset.label;
        }
        return null;
    };
    const applyPreset = (months: number) => {
        const today = new Date();
        const from = new Date(today);
        from.setMonth(from.getMonth() - months);
        onChangeFrom(from.toISOString().split('T')[0]);
        onChangeTo(today.toISOString().split('T')[0]);
    };
    const activePreset = getActivePreset();

    return (
        <Box bg="white" border="1px solid" borderColor={hasValue ? 'purple.200' : 'gray.200'}
            borderRadius="md" p={2} minH="70px" overflow="hidden">
            <Flex align="center" justify="space-between" mb={1.5}>
                <Flex align="center" gap={1}>
                    <Text fontSize="xs">📅</Text>
                    <Text fontSize="2xs" fontWeight="semibold" color="gray.600" textTransform="uppercase">Date Range</Text>
                </Flex>
                {hasValue && (
                    <Box as="button" onClick={onClear} color="gray.400" _hover={{ color: 'gray.600' }} cursor="pointer" p={0.5}>
                        <LuX size={10} />
                    </Box>
                )}
            </Flex>
            <Flex gap={1} mb={1.5} flexWrap="wrap">
                {DATE_PRESETS.map(preset => {
                    const isActive = activePreset === preset.label;
                    return (
                        <Box key={preset.label} as="button" px={1.5} py={0.5} borderRadius="sm" fontSize="2xs"
                            fontWeight="medium" cursor="pointer" transition="all 0.15s"
                            bg={isActive ? 'purple.100' : 'gray.50'} color={isActive ? 'purple.700' : 'gray.600'}
                            border="1px solid" borderColor={isActive ? 'purple.300' : 'gray.200'}
                            _hover={{ bg: isActive ? 'purple.200' : 'gray.100', borderColor: isActive ? 'purple.400' : 'gray.300' }}
                            onClick={() => applyPreset(preset.months)}>
                            {preset.label}
                        </Box>
                    );
                })}
            </Flex>
            <Flex direction="column" gap={1}>
                <Box>
                    <Text fontSize="2xs" color="gray.500" mb={0.5}>From</Text>
                    <input type="date" value={dateFrom ? dateFrom.split('T')[0] : ''}
                        onChange={e => onChangeFrom(e.target.value ? `${e.target.value}T00:00` : '')}
                        style={{ width: '100%', height: '22px', padding: '0 4px', fontSize: '10px', border: '1px solid #E2E8F0', borderRadius: '4px', backgroundColor: 'white' }} />
                </Box>
                <Box>
                    <Text fontSize="2xs" color="gray.500" mb={0.5}>To</Text>
                    <input type="date" value={dateTo ? dateTo.split('T')[0] : ''}
                        onChange={e => onChangeTo(e.target.value ? `${e.target.value}T23:59` : '')}
                        style={{ width: '100%', height: '22px', padding: '0 4px', fontSize: '10px', border: '1px solid #E2E8F0', borderRadius: '4px', backgroundColor: 'white' }} />
                </Box>
            </Flex>
        </Box>
    );
};

/* ─── FilterChip (removable badge) ─── */

interface FilterChipData { id: string; label: string; color: string; onClear: () => void }

const FilterChip: React.FC<{ chip: FilterChipData }> = ({ chip }) => (
    <Badge size="sm" colorPalette={chip.color} display="inline-flex" alignItems="center" gap={1}
        px={2} py={0.5} borderRadius="md" cursor="pointer" transition="all 0.15s"
        _hover={{ transform: 'scale(0.95)', opacity: 0.8 }} onClick={e => { e.stopPropagation(); chip.onClear(); }}>
        <Text fontSize="xs">{chip.label}</Text>
        <LuX size={12} />
    </Badge>
);

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
        <SlidePanel isOpen={isOpen} onClose={onClose} title="Realized P&L" width="1100px">
            {/* ─── Collapsible Filter Section ─── */}
            <Box mb={3}>
                <Box bg="gray.50" borderRadius="md" border="1px solid" borderColor={hasAnyFilter ? 'blue.300' : 'gray.200'} overflow="visible">
                    {/* Clickable header */}
                    <Flex align="center" justify="space-between" p={3}
                        cursor="pointer" transition="background 0.15s" _hover={{ bg: 'gray.100' }}
                        onClick={() => setFiltersExpanded(p => !p)} borderRadius="md">
                        <Flex align="center" gap={1.5} flexWrap="wrap">
                            <Box transition="transform 0.2s" transform={filtersExpanded ? 'rotate(0deg)' : 'rotate(-90deg)'}>
                                <LuChevronDown size={14} />
                            </Box>
                            <LuFilter size={12} />
                            <Text fontWeight="semibold" fontSize="xs">Filters</Text>
                            {activeChips.length > 0 && (
                                <Badge size="xs" colorPalette="blue">{activeChips.length} active</Badge>
                            )}
                            {activeChips.map(chip => <FilterChip key={chip.id} chip={chip} />)}
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

                    {/* Expanded filter cards */}
                    {filtersExpanded && (
                        <Box p={3} pt={1} overflow="visible">
                            <SimpleGrid columns={{ base: 2, md: 4, lg: 6 }} gap={2}>
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
                            </SimpleGrid>

                            {/* Absolute P&L threshold slider */}
                            <Box mt={2} px={1}>
                                <Flex align="center" gap={2}>
                                    <Text fontSize="2xs" fontWeight="medium" color="gray.600" whiteSpace="nowrap">|P&L| ≥</Text>
                                    <input type="range" min={0} max={100} step={1} value={minAbsPnl}
                                        onChange={e => setMinAbsPnl(Number(e.target.value))}
                                        style={{ flex: 1, height: 4, accentColor: '#3182CE' }} />
                                    <Flex align="center" gap={0.5}>
                                        <Text fontSize="2xs" color="gray.500">€</Text>
                                        <input type="number" min={0} step={1} value={minAbsPnl}
                                            onChange={e => setMinAbsPnl(Math.max(0, Number(e.target.value)))}
                                            style={{ width: 48, height: 22, padding: '0 4px', fontSize: 10, border: '1px solid #E2E8F0', borderRadius: 4, textAlign: 'right' }} />
                                    </Flex>
                                </Flex>
                                <Text fontSize="2xs" color="gray.400" mt={0.5}>Hides entries where absolute P&L is below this threshold</Text>
                            </Box>
                        </Box>
                    )}
                </Box>
            </Box>

            {isLoading ? <TabLoadingState message="Loading realized P&L…" /> :
                error ? <TabErrorState error={error} onRetry={refetch} /> :
                    entries.length === 0 ? <TabEmptyState title="No entries" description={hasAnyFilter ? 'Try adjusting filters.' : 'No realized P&L entries.'} /> : (
                        <Box>
                            <Flex justify="space-between" align="center" mb={1}>
                                <Text fontSize="2xs" color="gray.500">{total} entr{total !== 1 ? 'ies' : 'y'}</Text>
                            </Flex>

                            {/* Top pagination bar */}
                            {paginationBar}

                            <Box overflowX="auto">
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
                                            <th style={{ ...TH, textAlign: 'right' }}>Cost Basis</th>
                                            <th style={{ ...TH, textAlign: 'center' }}>Chain</th>
                                            <SortHeader label="P&L" field="pnl" current={sortBy} order={sortOrder} align="right" onSort={handleSort} />
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
                                                    <Text fontSize="3xs" color="gray.400" fontFamily="mono">#{e.pnl_id}</Text>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <Text fontSize="2xs" color="gray.600" whiteSpace="nowrap">
                                                        {e.realized_at ? fmtDate(e.realized_at) : '-'}
                                                    </Text>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <Flex align="center" gap={1}>
                                                        <Tooltip content={
                                                            <Box p={1} fontSize="xs">
                                                                <Text fontWeight="bold">{e.asset.label || e.asset.symbol}</Text>
                                                                <Text fontFamily="mono" color="gray.300">{e.asset.symbol}</Text>
                                                                {e.asset.id && <Text color="gray.400" fontSize="2xs">ID: {e.asset.id}</Text>}
                                                            </Box>
                                                        }>
                                                            <Text fontSize="2xs" fontWeight="medium" color="purple.600"
                                                                cursor={onAssetClick ? 'pointer' : 'default'}
                                                                _hover={onAssetClick ? { textDecoration: 'underline' } : undefined}
                                                                onClick={() => e.asset.id && onAssetClick?.(e.asset.id)}
                                                                maxW="80px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                                                {e.asset.label || e.asset.symbol}
                                                            </Text>
                                                        </Tooltip>
                                                        {e.asset.id != null && assetPanelCtx && (
                                                            <Box
                                                                as="button"
                                                                onClick={(ev: React.MouseEvent) => { ev.stopPropagation(); assetPanelCtx.openAssetPanel(e.asset.id!, { pnlVersionId: versionId }); }}
                                                                p={0.5}
                                                                borderRadius="sm"
                                                                color="gray.400"
                                                                _hover={{ color: 'purple.500', bg: 'purple.50' }}
                                                                title="Asset details"
                                                            >
                                                                <LuInfo size={10} />
                                                            </Box>
                                                        )}
                                                    </Flex>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <Text fontSize="2xs" color="gray.500" maxW="80px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                                                        {e.account_name || '-'}
                                                    </Text>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={e.qty} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={e.proceeds_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <Flex align="center" justify="flex-end" gap={1}>
                                                        {e.proceeds_price != null
                                                            ? <ValueDisplay value={e.proceeds_price} currency={baseCurrency} />
                                                            : <Text fontSize="2xs" color="gray.400">-</Text>}
                                                        {e.proceeds_source !== 'transfer' && (
                                                            <Box as="button" display="inline-flex" alignItems="center"
                                                                color="gray.400" _hover={{ color: 'blue.500' }}
                                                                cursor="pointer" title="Override FMV"
                                                                onClick={() => {
                                                                    setOverrideEntry(e);
                                                                    setOverridePrice(e.proceeds_price != null ? String(e.proceeds_price) : '');
                                                                    setOverrideError(null);
                                                                }}>
                                                                <LuPencil size={10} />
                                                            </Box>
                                                        )}
                                                    </Flex>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    {e.proceeds_price_source ? (
                                                        <Badge size="xs" variant="subtle"
                                                            colorPalette={
                                                                e.proceeds_source === 'fmv' || e.proceeds_source === 'fmv_lookup' ? 'cyan'
                                                                    : e.proceeds_source === 'provisional' ? 'orange'
                                                                        : 'gray'
                                                            }>
                                                            {e.proceeds_price_source}
                                                        </Badge>
                                                    ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                                </td>
                                                <td style={{ ...TD }}>
                                                    <Text fontSize="2xs" color="gray.500" whiteSpace="nowrap">
                                                        {e.proceeds_price_timestamp ? fmtDate(e.proceeds_price_timestamp) : '-'}
                                                    </Text>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <ValueDisplay value={e.cost_basis_in_base} currency={baseCurrency} />
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <CostBasisChainTooltip
                                                        pnlId={e.pnl_id} versionId={versionId}
                                                        baseCurrency={baseCurrency} onTransactionClick={onTransactionClick}>
                                                        <Text fontSize="2xs" color="blue.400" cursor="help" _hover={{ textDecoration: 'underline' }}>🔗</Text>
                                                    </CostBasisChainTooltip>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <Text color={e.pnl_in_base >= 0 ? 'green.600' : 'red.600'} fontWeight="medium" fontSize="2xs">
                                                        <ValueDisplay value={e.pnl_in_base} currency={baseCurrency} />
                                                    </Text>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <Tooltip content={e.taxable ? 'Taxable' : 'Non-Taxable'}>
                                                        <Flex align="center" justify="center">
                                                            <Box display="inline-flex" alignItems="center" justifyContent="center"
                                                                w="18px" h="18px" borderRadius="full"
                                                                bg={e.taxable ? 'red.100' : 'green.100'}
                                                                color={e.taxable ? 'red.600' : 'green.600'}>
                                                                {e.taxable ? <LuCircleAlert size={11} /> : <LuCircleCheck size={11} />}
                                                            </Box>
                                                        </Flex>
                                                    </Tooltip>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'center' }}>
                                                    <Badge size="xs" colorPalette={e.is_fee ? 'orange' : 'blue'} variant="subtle">
                                                        {e.is_fee ? 'Fee' : 'Disposal'}
                                                    </Badge>
                                                </td>
                                                <td style={{ ...TD, textAlign: 'right' }}>
                                                    <Text fontSize="2xs" color="gray.500">{e.holding_period_days ?? '-'}</Text>
                                                </td>
                                                <td style={{ ...TD }}>
                                                    {e.transaction_id ? (
                                                        <Text fontSize="2xs" color="blue.500" fontFamily="mono"
                                                            cursor={onTransactionClick ? 'pointer' : undefined}
                                                            _hover={onTransactionClick ? { textDecoration: 'underline' } : undefined}
                                                            onClick={() => onTransactionClick?.(e.transaction_id!)}>
                                                            #{e.transaction_id}
                                                        </Text>
                                                    ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                                </td>
                                                <td style={{ ...TD }}>
                                                    {e.unit_id ? (
                                                        <Text fontSize="2xs" color="blue.500" fontFamily="mono"
                                                            cursor={onUnitClick ? 'pointer' : undefined}
                                                            _hover={onUnitClick ? { textDecoration: 'underline' } : undefined}
                                                            onClick={() => onUnitClick?.(e.unit_id!)}>
                                                            #{e.unit_id}
                                                        </Text>
                                                    ) : <Text fontSize="2xs" color="gray.400">-</Text>}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </Box>

                            {/* Bottom pagination bar */}
                            {paginationBar}
                        </Box>
                    )}

            {/* FMV Override Dialog */}
            <Dialog.Root
                open={!!overrideEntry}
                onOpenChange={(e) => { if (!e.open) { setOverrideEntry(null); setOverridePrice(''); setOverrideError(null); } }}
            >
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>Override FMV Price</Dialog.Title>
                        </Dialog.Header>
                        <Dialog.Body>
                            {overrideEntry && (
                                <Box>
                                    <Flex gap={2} mb={3} align="center">
                                        <Badge colorPalette="purple">{overrideEntry.asset.symbol}</Badge>
                                        <Text fontSize="sm" color="gray.500">
                                            {overrideEntry.realized_at ? fmtDate(overrideEntry.realized_at) : ''}
                                        </Text>
                                    </Flex>
                                    {overrideEntry.proceeds_price != null && (
                                        <Text fontSize="sm" color="gray.500" mb={2}>
                                            Current FMV: <strong>{overrideEntry.proceeds_price}</strong>
                                            {overrideEntry.proceeds_price_source && ` (${overrideEntry.proceeds_price_source})`}
                                        </Text>
                                    )}
                                    <Text fontSize="sm" mb={1}>New FMV price per unit ({baseCurrency}):</Text>
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
                                        <Text fontSize="sm" color="red.500" mt={2}>{overrideError}</Text>
                                    )}
                                    <Text fontSize="xs" color="gray.400" mt={2}>
                                        This creates a manual price snapshot and triggers a full P&L recalculation.
                                    </Text>
                                </Box>
                            )}
                        </Dialog.Body>
                        <Dialog.Footer>
                            <Flex gap={2}>
                                <Button variant="outline" onClick={() => { setOverrideEntry(null); setOverridePrice(''); setOverrideError(null); }}>
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="blue"
                                    onClick={handleOverrideFmv}
                                    loading={overrideLoading}
                                    disabled={!overridePrice || overrideLoading}
                                >
                                    Save & Recalculate
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Dialog.Root>
        </SlidePanel>
    );
};
