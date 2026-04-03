/**
 * Shared filter components for Realized P&L views.
 *
 * Extracted from RealizedPnLSlidePanel for reuse across
 * Realized P&L and French Tax disposal tables.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Badge, Box, Button, Flex, Text } from '@chakra-ui/react';
import { LuCheck, LuChevronDown, LuSearch, LuX } from 'react-icons/lu';
import { LuArrowDown, LuArrowUp, LuArrowUpDown } from 'react-icons/lu';

/* ─── Types ─── */

export interface FilterOption { value: string; label?: string; count: number }

export interface RealizedFilterOptions {
    assets: FilterOption[];
    taxable_options: FilterOption[];
    pnl_sign_options: FilterOption[];
    holding_period_options: FilterOption[];
    origin_type_options: FilterOption[];
    accounts: FilterOption[];
    date_range?: { min: string; max: string } | null;
}

export interface FilterChipData { id: string; label: string; color: string; onClear: () => void }

/* ─── Constants ─── */

export const DATE_PRESETS = [
    { label: '1M', months: 1 },
    { label: '3M', months: 3 },
    { label: '6M', months: 6 },
    { label: '1Y', months: 12 },
];

export const TH: React.CSSProperties = { padding: '4px 6px', fontSize: 10, whiteSpace: 'nowrap', fontWeight: 600 };
export const TD: React.CSSProperties = { padding: '3px 6px', fontSize: 11 };

/* ─── SortHeader ─── */

export const SortHeader: React.FC<{
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

/* ─── RFilterCard (toggleable chips) ─── */

export const RFilterCard: React.FC<{
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

/* ─── RDropdownCard (searchable popover) ─── */

export const RDropdownCard: React.FC<{
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

/* ─── RDateCard ─── */

export const RDateCard: React.FC<{
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

export const FilterChip: React.FC<{ chip: FilterChipData }> = ({ chip }) => (
    <Badge size="sm" colorPalette={chip.color} display="inline-flex" alignItems="center" gap={1}
        px={2} py={0.5} borderRadius="md" cursor="pointer" transition="all 0.15s"
        _hover={{ transform: 'scale(0.95)', opacity: 0.8 }} onClick={e => { e.stopPropagation(); chip.onClear(); }}>
        <Text fontSize="xs">{chip.label}</Text>
        <LuX size={12} />
    </Badge>
);
