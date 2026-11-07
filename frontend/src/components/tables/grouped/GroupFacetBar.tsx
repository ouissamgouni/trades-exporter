import React from 'react';
import { LuFilter, LuX } from 'react-icons/lu';
import type { FacetKey, GroupFacetSelection, TransactionGroup } from './types';

const FACET_SINGULAR: Record<FacetKey, string> = {
    accounts: 'Account',
    assets: 'Asset',
    networks: 'Network',
    sources: 'Connector',
};

interface AppliedFacetsBarProps {
    group: TransactionGroup;
    selection: GroupFacetSelection;
    onChange: (selection: GroupFacetSelection) => void;
    onApplyToAll: (selection: GroupFacetSelection) => void;
}

/** Group-local filters picked from the recap chips, shown at the bottom of the sticky group header. */
export const AppliedFacetsBar: React.FC<AppliedFacetsBarProps> = ({ group, selection, onChange, onApplyToAll }) => {
    const chips = (Object.keys(selection) as FacetKey[]).flatMap(dim =>
        (selection[dim] ?? []).map(value => ({
            dim,
            value,
            label: group.facets[dim].find(v => v.value === value)?.label ?? value,
        })),
    );

    const remove = (dim: FacetKey, value: string) =>
        onChange({ ...selection, [dim]: (selection[dim] ?? []).filter(v => v !== value) });

    return (
        <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-xs" onClick={e => e.stopPropagation()}>
            <span className="inline-flex shrink-0 items-center gap-1 text-slate-500">
                <LuFilter size={11} className="text-blue-600" /> Filtered:
            </span>
            {chips.map(c => (
                <button
                    key={`${c.dim}:${c.value}`}
                    type="button"
                    aria-label={`Remove ${FACET_SINGULAR[c.dim]} filter ${c.label}`}
                    className="inline-flex shrink-0 items-center gap-1 border border-blue-500 bg-blue-500 px-1.5 text-white hover:bg-blue-600"
                    onClick={() => remove(c.dim, c.value)}
                >
                    <span className="text-blue-100">{FACET_SINGULAR[c.dim]}:</span> {c.label} <LuX size={10} />
                </button>
            ))}
            <button
                type="button"
                className="inline-flex shrink-0 items-center gap-0.5 text-slate-500 hover:text-slate-800"
                onClick={() => onChange({})}
            >
                <LuX size={10} /> Clear
            </button>
            <button
                type="button"
                className="shrink-0 font-medium text-blue-600 hover:underline"
                title="Move these filters to the main filter bar"
                onClick={() => onApplyToAll(selection)}
            >
                Apply to all ↗
            </button>
        </div>
    );
};
