import React from 'react';
import { FiList } from 'react-icons/fi';
import { LuLayoutGrid, LuChartPie } from 'react-icons/lu';

export type AssetsViewMode = 'list' | 'treemap' | 'pie';

interface ViewModeToggleProps {
    value: AssetsViewMode;
    onChange: (mode: AssetsViewMode) => void;
}

const MODES: { key: AssetsViewMode; label: string; icon: React.ReactNode }[] = [
    { key: 'list', label: 'List', icon: <FiList size={14} /> },
    { key: 'treemap', label: 'Treemap', icon: <LuLayoutGrid size={14} /> },
    { key: 'pie', label: 'Pie', icon: <LuChartPie size={14} /> },
];

export const ViewModeToggle: React.FC<ViewModeToggleProps> = ({ value, onChange }) => (
    <div className="flex items-center gap-1">
        <div className="flex overflow-hidden border border-slate-200">
            {MODES.map(({ key, label, icon }) => (
                <button
                    key={key}
                    type="button"
                    onClick={() => onChange(key)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium ${value === key ? 'bg-slate-700 text-white' : 'bg-transparent text-slate-700 hover:bg-slate-100'}`}
                >
                    {icon}
                    {label}
                </button>
            ))}
        </div>
    </div>
);
