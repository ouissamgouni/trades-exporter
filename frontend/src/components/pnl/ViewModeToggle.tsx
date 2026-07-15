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
        <div className="flex items-center gap-0.5 border border-slate-200 bg-white p-0.5">
            {MODES.map(({ key, label, icon }) => (
                <button
                    key={key}
                    type="button"
                    onClick={() => onChange(key)}
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 ${value === key ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'}`}
                >
                    {icon}
                    {label}
                </button>
            ))}
        </div>
    </div>
);
