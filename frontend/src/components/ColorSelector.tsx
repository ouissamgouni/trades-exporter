import React from 'react';
import { CATEGORY_COLOR_PALETTE } from '../constants/colors';

interface ColorSelectorProps {
    value: string;
    onChange: (color: string) => void;
}

/**
 * Color selector: native color input for custom colors plus a row of
 * preset swatches from the category color palette.
 */
export const ColorSelector: React.FC<ColorSelectorProps> = ({ value, onChange }) => {
    const current = value || CATEGORY_COLOR_PALETTE[0];

    return (
        <div className="flex items-center gap-2">
            <input
                type="color"
                value={current}
                onChange={e => onChange(e.target.value)}
                className="h-8 w-8 cursor-pointer border border-slate-300 bg-white p-0.5"
            />
            <div className="flex flex-wrap items-center gap-1">
                {CATEGORY_COLOR_PALETTE.map((color) => (
                    <button
                        key={color}
                        type="button"
                        onClick={() => onChange(color)}
                        aria-label={color}
                        className={`h-5 w-5 rounded-full border ${current === color ? 'border-slate-900 ring-2 ring-offset-1 ring-slate-400' : 'border-slate-300'}`}
                        style={{ backgroundColor: color }}
                    />
                ))}
            </div>
        </div>
    );
};

export default ColorSelector;
