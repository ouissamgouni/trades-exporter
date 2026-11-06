import React, { useState } from 'react';
import { LuX } from 'react-icons/lu';
import { cn } from '../../../lib/cn';
import { FACET_LABEL, facetDimensions, hasFacetSelection } from './groupUtils';
import type { FacetKey, GroupFacetSelection, TransactionGroup } from './types';

const MAX_CHIPS = 8;

interface GroupFacetBarProps {
    group: TransactionGroup;
    scopeLabel: string;
    selection: GroupFacetSelection;
    onChange: (selection: GroupFacetSelection) => void;
    onApplyToAll: (selection: GroupFacetSelection) => void;
}

/** Group-local quick filters: recap dimensions with 2+ values become toggleable chips. */
export const GroupFacetBar: React.FC<GroupFacetBarProps> = ({ group, scopeLabel, selection, onChange, onApplyToAll }) => {
    const [expandedDims, setExpandedDims] = useState<Set<FacetKey>>(new Set());
    const dims = facetDimensions(group);
    const active = hasFacetSelection(selection);
    if (dims.length === 0) return null;

    const toggle = (dim: FacetKey, value: string) => {
        const current = selection[dim] ?? [];
        const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
        onChange({ ...selection, [dim]: next });
    };

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-slate-100 py-1 text-[10px]" onClick={e => e.stopPropagation()}>
            <span className="text-slate-500">Filter this {scopeLabel}:</span>
            {dims.map(dim => {
                const values = group.facets[dim];
                const showAll = expandedDims.has(dim);
                const visible = showAll ? values : values.slice(0, MAX_CHIPS);
                return (
                    <span key={dim} className="inline-flex flex-wrap items-center gap-1">
                        <span className="text-slate-400">{FACET_LABEL[dim]}</span>
                        {visible.map(v => {
                            const isOn = (selection[dim] ?? []).includes(v.value);
                            return (
                                <button
                                    key={v.value}
                                    type="button"
                                    aria-pressed={isOn}
                                    onClick={() => toggle(dim, v.value)}
                                    className={cn(
                                        'border px-1 tabular-nums',
                                        isOn
                                            ? 'border-blue-500 bg-blue-500 text-white'
                                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                                    )}
                                >
                                    {v.label} <span className={isOn ? 'text-blue-100' : 'text-slate-400'}>{v.count}</span>
                                </button>
                            );
                        })}
                        {values.length > MAX_CHIPS && !showAll && (
                            <button
                                type="button"
                                className="text-slate-500 hover:text-blue-600"
                                onClick={() => setExpandedDims(prev => new Set(prev).add(dim))}
                            >
                                +{values.length - MAX_CHIPS}
                            </button>
                        )}
                    </span>
                );
            })}
            {active && (
                <span className="inline-flex items-center gap-2">
                    <button
                        type="button"
                        className="inline-flex items-center gap-0.5 text-slate-500 hover:text-slate-800"
                        onClick={() => onChange({})}
                    >
                        <LuX size={10} /> Clear
                    </button>
                    <button
                        type="button"
                        className="font-medium text-blue-600 hover:underline"
                        title="Move these filters to the main filter bar"
                        onClick={() => onApplyToAll(selection)}
                    >
                        Apply to all ↗
                    </button>
                </span>
            )}
        </div>
    );
};
