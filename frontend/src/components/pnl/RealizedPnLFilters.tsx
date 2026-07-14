/**
 * Shared filter components for Realized P&L views.
 *
 * Extracted from RealizedPnLSlidePanel for reuse across
 * Realized P&L and French Tax disposal tables.
 */

import React, { useEffect, useRef, useState } from 'react';
import { LuCheck, LuChevronDown, LuSearch, LuX } from 'react-icons/lu';
import { LuArrowDown, LuArrowUp, LuArrowUpDown } from 'react-icons/lu';
import { Button } from '../ui/primitives';

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

/* ─── Dynamic color support ───
 * `color` is a free-form string prop passed by callers (still-Chakra files
 * like FrenchTaxPanel.tsx included). Tailwind's JIT scanner cannot resolve
 * `bg-${color}-100`-style interpolation, so every shade actually used across
 * this file is pre-declared here as a literal class string and looked up at
 * render time — never synthesized via string concatenation. */
type FilterColorName = 'red' | 'blue' | 'green' | 'gray' | 'purple' | 'teal';

interface FilterColorClasses {
    border200: string;
    bg100: string;
    text700: string;
    border300: string;
    hoverBg200: string;
    hoverBorder400: string;
    text500: string;
    bg50: string;
    hoverBorder300: string;
    hoverBg100: string;
    border500: string;
    bg500: string;
}

const FILTER_COLORS: Record<FilterColorName, FilterColorClasses> = {
    red: {
        border200: 'border-red-200', bg100: 'bg-red-100', text700: 'text-red-700', border300: 'border-red-300',
        hoverBg200: 'hover:bg-red-200', hoverBorder400: 'hover:border-red-400', text500: 'text-red-500',
        bg50: 'bg-red-50', hoverBorder300: 'hover:border-red-300', hoverBg100: 'hover:bg-red-100',
        border500: 'border-red-500', bg500: 'bg-red-500',
    },
    blue: {
        border200: 'border-blue-200', bg100: 'bg-blue-100', text700: 'text-blue-700', border300: 'border-blue-300',
        hoverBg200: 'hover:bg-blue-200', hoverBorder400: 'hover:border-blue-400', text500: 'text-blue-500',
        bg50: 'bg-blue-50', hoverBorder300: 'hover:border-blue-300', hoverBg100: 'hover:bg-blue-100',
        border500: 'border-blue-500', bg500: 'bg-blue-500',
    },
    green: {
        border200: 'border-green-200', bg100: 'bg-green-100', text700: 'text-green-700', border300: 'border-green-300',
        hoverBg200: 'hover:bg-green-200', hoverBorder400: 'hover:border-green-400', text500: 'text-green-500',
        bg50: 'bg-green-50', hoverBorder300: 'hover:border-green-300', hoverBg100: 'hover:bg-green-100',
        border500: 'border-green-500', bg500: 'bg-green-500',
    },
    gray: {
        border200: 'border-slate-200', bg100: 'bg-slate-100', text700: 'text-slate-700', border300: 'border-slate-300',
        hoverBg200: 'hover:bg-slate-200', hoverBorder400: 'hover:border-slate-400', text500: 'text-slate-500',
        bg50: 'bg-slate-50', hoverBorder300: 'hover:border-slate-300', hoverBg100: 'hover:bg-slate-100',
        border500: 'border-slate-500', bg500: 'bg-slate-500',
    },
    purple: {
        border200: 'border-purple-200', bg100: 'bg-purple-100', text700: 'text-purple-700', border300: 'border-purple-300',
        hoverBg200: 'hover:bg-purple-200', hoverBorder400: 'hover:border-purple-400', text500: 'text-purple-500',
        bg50: 'bg-purple-50', hoverBorder300: 'hover:border-purple-300', hoverBg100: 'hover:bg-purple-100',
        border500: 'border-purple-500', bg500: 'bg-purple-500',
    },
    teal: {
        border200: 'border-teal-200', bg100: 'bg-teal-100', text700: 'text-teal-700', border300: 'border-teal-300',
        hoverBg200: 'hover:bg-teal-200', hoverBorder400: 'hover:border-teal-400', text500: 'text-teal-500',
        bg50: 'bg-teal-50', hoverBorder300: 'hover:border-teal-300', hoverBg100: 'hover:bg-teal-100',
        border500: 'border-teal-500', bg500: 'bg-teal-500',
    },
};

const getFilterColor = (color: string): FilterColorClasses =>
    FILTER_COLORS[color as FilterColorName] ?? FILTER_COLORS.gray;

/* ─── SortHeader ─── */

export const SortHeader: React.FC<{
    label: string; field: string; current: string | null; order: string; align?: string;
    onSort: (f: string) => void;
}> = ({ label, field, current, order, align = 'left', onSort }) => (
    <th style={{ ...TH, textAlign: align as any, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => onSort(field)}>
        <div className={`flex items-center gap-0.5 ${align === 'right' ? 'justify-end' : 'justify-start'}`}>
            {label}
            {current === field
                ? (order === 'desc' ? <LuArrowDown size={10} /> : <LuArrowUp size={10} />)
                : <span className="text-slate-400"><LuArrowUpDown size={9} /></span>}
        </div>
    </th>
);

/* ─── RFilterCard (toggleable chips) ─── */

export const RFilterCard: React.FC<{
    label: string; icon: string; options: FilterOption[];
    selected: string[]; onChange: (s: string[]) => void; color: string;
    searchable?: boolean;
}> = ({ label, icon, options, selected, onChange, color, searchable }) => {
    const [search, setSearch] = useState('');
    const c = getFilterColor(color);
    const handleToggle = (value: string) => {
        onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
    };
    const displayOptions = searchable && search
        ? options.filter(o => (o.label || o.value).toLowerCase().includes(search.toLowerCase()))
        : options;
    const needsScroll = displayOptions.length > 6;

    return (
        <div className={`min-h-[70px] border bg-white p-2 ${selected.length > 0 ? c.border200 : 'border-slate-200'}`}>
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">{icon}</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">{label}</span>
                </div>
                {selected.length > 0 && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.bg100} ${c.text700}`}>
                        {selected.length}
                    </span>
                )}
            </div>
            {searchable && (
                <div className="mb-1.5 flex items-center gap-1 bg-slate-50 px-1 py-1">
                    <LuSearch size={10} color="#A0AEC0" />
                    <input type="text" placeholder="Search..." value={search}
                        onChange={e => setSearch(e.target.value)}
                        style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: '10px', width: '100%', color: '#4A5568' }} />
                </div>
            )}
            <div className={needsScroll ? 'thin-scrollbar max-h-[110px] overflow-y-auto' : ''}>
                <div className="flex flex-wrap gap-1">
                    {displayOptions.map(option => {
                        const isSelected = selected.includes(option.value);
                        return (
                            <button key={option.value} type="button"
                                className={`inline-flex items-center gap-0.5 border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${isSelected
                                    ? `${c.bg100} ${c.text700} ${c.border300} ${c.hoverBg200} ${c.hoverBorder400}`
                                    : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                                    }`}
                                onClick={() => handleToggle(option.value)}>
                                {isSelected && <LuCheck size={8} />}
                                {option.label || option.value}
                                {option.count !== undefined && (
                                    <span className={isSelected ? c.text500 : 'text-slate-400'}>({option.count})</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

/* ─── RDropdownCard (searchable popover) ─── */

export const RDropdownCard: React.FC<{
    label: string; icon: string; options: FilterOption[];
    selected: string[]; onChange: (s: string[]) => void; color: string;
    isOpen: boolean; onToggle: () => void; onClose: () => void;
}> = ({ label, icon, options, selected, onChange, color, isOpen, onToggle, onClose }) => {
    const [search, setSearch] = useState('');
    const c = getFilterColor(color);
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
        <div ref={cardRef} className={`relative min-h-[70px] border bg-white p-2 ${selected.length > 0 ? c.border200 : 'border-slate-200'}`}>
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">{icon}</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">{label}</span>
                </div>
                {selected.length > 0 && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.bg100} ${c.text700}`}>
                        {selected.length}
                    </span>
                )}
            </div>
            <button type="button"
                className={`flex w-full items-center justify-between border px-1.5 py-1 transition-colors ${isOpen ? c.border300 : 'border-slate-200'} ${selected.length > 0 ? c.bg50 : 'bg-white'} ${c.hoverBorder300}`}
                onClick={onToggle}>
                <span className={`truncate text-[10px] ${selected.length > 0 ? c.text700 : 'text-slate-600'}`}>
                    {getSelectedDisplay()}
                </span>
                <LuChevronDown size={10} style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }} />
            </button>
            {isOpen && (
                <div ref={popoverRef} className="absolute inset-x-0 top-full z-[1000] mt-1 overflow-hidden border border-slate-200 bg-white shadow-lg">
                    <div className="border-b border-slate-100 p-1.5">
                        <div className="flex items-center gap-1 bg-slate-50 px-1.5">
                            <LuSearch size={10} color="#A0AEC0" />
                            <input type="text" placeholder="Search..." value={search}
                                onChange={e => setSearch(e.target.value)}
                                style={{ flex: 1, border: 'none', background: 'transparent', padding: '6px 0', fontSize: '10px', outline: 'none' }} />
                        </div>
                    </div>
                    <div className="flex gap-1 border-b border-slate-100 p-1.5">
                        <Button size="sm" variant="ghost" className="text-[10px]" onClick={() => onChange(filteredOptions.map(o => o.value))}>
                            All
                        </Button>
                        <Button size="sm" variant="ghost" className="text-[10px]" onClick={() => onChange([])}>
                            None
                        </Button>
                    </div>
                    <div className="max-h-[160px] overflow-y-auto p-1">
                        {filteredOptions.map(option => {
                            const isSelected = selected.includes(option.value);
                            return (
                                <div key={option.value}
                                    className={`flex cursor-pointer items-center gap-1.5 px-1.5 py-1 ${isSelected ? `${c.bg50} ${c.hoverBg100}` : 'hover:bg-slate-50'}`}
                                    onClick={() => handleToggle(option.value)}>
                                    <div className={`flex h-3 w-3 shrink-0 items-center justify-center border ${isSelected ? `${c.border500} ${c.bg500}` : 'border-slate-300 bg-white'}`}>
                                        {isSelected && <LuCheck size={8} color="white" />}
                                    </div>
                                    <span className="flex-1 text-[10px]">{option.label || option.value}</span>
                                    {option.count !== undefined && <span className="text-[10px] text-slate-400">({option.count})</span>}
                                </div>
                            );
                        })}
                        {filteredOptions.length === 0 && (
                            <span className="block p-1.5 text-center text-[10px] text-slate-400">No results</span>
                        )}
                    </div>
                </div>
            )}
        </div>
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
        <div className={`min-h-[70px] overflow-hidden border bg-white p-2 ${hasValue ? 'border-purple-200' : 'border-slate-200'}`}>
            <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                    <span className="text-xs">📅</span>
                    <span className="text-[10px] font-semibold uppercase text-slate-600">Date Range</span>
                </div>
                {hasValue && (
                    <button type="button" onClick={onClear} className="cursor-pointer p-0.5 text-slate-400 hover:text-slate-600">
                        <LuX size={10} />
                    </button>
                )}
            </div>
            <div className="mb-1.5 flex flex-wrap gap-1">
                {DATE_PRESETS.map(preset => {
                    const isActive = activePreset === preset.label;
                    return (
                        <button key={preset.label} type="button"
                            className={`border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${isActive
                                ? 'border-purple-300 bg-purple-100 text-purple-700 hover:bg-purple-200 hover:border-purple-400'
                                : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:border-slate-300'
                                }`}
                            onClick={() => applyPreset(preset.months)}>
                            {preset.label}
                        </button>
                    );
                })}
            </div>
            <div className="flex flex-col gap-1">
                <div>
                    <span className="mb-0.5 block text-[10px] text-slate-500">From</span>
                    <input type="date" value={dateFrom ? dateFrom.split('T')[0] : ''}
                        onChange={e => onChangeFrom(e.target.value ? `${e.target.value}T00:00` : '')}
                        style={{ width: '100%', height: '22px', padding: '0 4px', fontSize: '10px', border: '1px solid #E2E8F0', borderRadius: '4px', backgroundColor: 'white' }} />
                </div>
                <div>
                    <span className="mb-0.5 block text-[10px] text-slate-500">To</span>
                    <input type="date" value={dateTo ? dateTo.split('T')[0] : ''}
                        onChange={e => onChangeTo(e.target.value ? `${e.target.value}T23:59` : '')}
                        style={{ width: '100%', height: '22px', padding: '0 4px', fontSize: '10px', border: '1px solid #E2E8F0', borderRadius: '4px', backgroundColor: 'white' }} />
                </div>
            </div>
        </div>
    );
};

/* ─── FilterChip (removable badge) ─── */

export const FilterChip: React.FC<{ chip: FilterChipData }> = ({ chip }) => {
    const c = getFilterColor(chip.color);
    return (
        <span
            className={`inline-flex cursor-pointer items-center gap-1 px-2 py-0.5 text-xs font-medium transition-transform hover:scale-95 hover:opacity-80 ${c.bg100} ${c.text700}`}
            onClick={e => { e.stopPropagation(); chip.onClear(); }}>
            <span className="text-xs">{chip.label}</span>
            <LuX size={12} />
        </span>
    );
};
