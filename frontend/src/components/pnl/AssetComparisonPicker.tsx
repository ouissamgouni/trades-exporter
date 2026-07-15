/**
 * AssetComparisonPicker — multi-select asset chip bar.
 *
 * Renders selected assets as colored Tag chips with remove button,
 * plus an "+ Add" button that opens a search popover.
 * Each chip's color dot matches its line in the comparison chart.
 */
import React, { useMemo, useState, useRef } from 'react';
import { FiX, FiPlus } from 'react-icons/fi';
import { CATEGORY_COLOR_PALETTE } from '../../constants/colors';
import type { AssetPnLRow } from './types';
import { Badge, Input } from '../ui/primitives';

interface AssetComparisonPickerProps {
    /** All available assets for selection */
    assets: AssetPnLRow[];
    /** Currently selected asset IDs (order determines color assignment) */
    selectedIds: number[];
    /** Called when selection changes */
    onChange: (ids: number[]) => void;
    /** Max number of assets that can be selected (default 10) */
    maxSelections?: number;
}

export const AssetComparisonPicker: React.FC<AssetComparisonPickerProps> = ({
    assets,
    selectedIds,
    onChange,
    maxSelections = 10,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [search, setSearch] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Map asset id → asset for quick lookup
    const assetMap = useMemo(() => {
        const m = new Map<number, AssetPnLRow>();
        for (const a of assets) {
            if (a.asset.id != null) m.set(a.asset.id, a);
        }
        return m;
    }, [assets]);

    // Filtered options for dropdown (not already selected, matching search)
    const filteredOptions = useMemo(() => {
        const selectedSet = new Set(selectedIds);
        const q = search.toLowerCase().trim();
        return assets.filter(a => {
            if (a.asset.id == null) return false;
            if (selectedSet.has(a.asset.id)) return false;
            if (!q) return true;
            const sym = (a.asset.symbol || '').toLowerCase();
            const label = (a.asset.label || '').toLowerCase();
            return sym.includes(q) || label.includes(q);
        }).slice(0, 20); // Cap for performance
    }, [assets, selectedIds, search]);

    const handleRemove = (id: number) => {
        onChange(selectedIds.filter(x => x !== id));
    };

    const handleAdd = (id: number) => {
        if (selectedIds.length >= maxSelections) return;
        onChange([...selectedIds, id]);
        setSearch('');
        setIsOpen(false);
    };

    const atMax = selectedIds.length >= maxSelections;

    return (
        <div className="relative flex flex-wrap items-center gap-2">
            {/* Add button + popover */}
            <div className="relative">
                <Badge
                    className={`border border-slate-300 bg-white px-2 py-1 text-slate-700 ${atMax ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                    onClick={() => {
                        if (!atMax) {
                            setIsOpen(prev => !prev);
                            setTimeout(() => inputRef.current?.focus(), 50);
                        }
                    }}
                >
                    <FiPlus size={10} />
                    <span className="text-xs">{atMax ? `Max ${maxSelections}` : 'Add'}</span>
                </Badge>

                {isOpen && !atMax && (
                    <div className="absolute left-0 top-full z-20 mt-1 w-60 max-h-[260px] overflow-hidden border border-slate-200 bg-white shadow-lg">
                        <div className="border-b border-slate-100 p-2">
                            <Input
                                ref={inputRef}
                                placeholder="Search assets..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Escape') {
                                        setIsOpen(false);
                                        setSearch('');
                                    }
                                }}
                            />
                        </div>
                        <div className="max-h-[200px] overflow-y-auto">
                            {filteredOptions.length === 0 ? (
                                <span className="block p-3 text-center text-xs text-slate-400">
                                    No assets found
                                </span>
                            ) : (
                                filteredOptions.map(a => (
                                    <div
                                        key={a.asset.id}
                                        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-blue-50"
                                        onClick={() => handleAdd(a.asset.id!)}
                                    >
                                        <span className="flex-1 text-xs font-medium">
                                            {a.asset.symbol}
                                        </span>
                                        {a.asset.label && a.asset.label !== a.asset.symbol && (
                                            <span className="max-w-[100px] truncate text-xs text-slate-400">
                                                {a.asset.label}
                                            </span>
                                        )}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Click-away layer */}
            {isOpen && (
                <div
                    className="fixed inset-0 z-[19]"
                    onClick={() => { setIsOpen(false); setSearch(''); }}
                />
            )}
        </div>
    );
};
