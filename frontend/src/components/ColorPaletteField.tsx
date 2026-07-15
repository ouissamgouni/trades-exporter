/**
 * ColorPaletteField – Color picker with palette swatches for forms.
 *
 * Combines Chakra UI's full ColorPicker (area, hue slider, hex input, eyedropper)
 * with preset swatches from the entity palette.
 * Used in AccountFormDialog and ConnectorFormDialog.
 */

import React from 'react';
import { ENTITY_COLOR_PALETTE, DEFAULT_ENTITY_COLOR } from '../hooks/useEntityColors';

interface ColorPaletteFieldProps {
    value?: string | null;
    onChange: (color: string | null) => void;
    label?: string;
    /** Colors already in use – the picker will visually dim them */
    usedColors?: string[];
}

export const ColorPaletteField: React.FC<ColorPaletteFieldProps> = ({
    value,
    onChange,
    label = 'Color',
    usedColors = [],
}) => {
    const usedSet = new Set(usedColors.map(c => c?.toLowerCase()));
    const currentColor = value || DEFAULT_ENTITY_COLOR;

    return (
        <div>
            <span className="mb-1.5 block font-medium">{label}</span>
            <div className="flex items-center gap-2">
                <input
                    type="color"
                    value={currentColor}
                    onChange={e => onChange(e.target.value)}
                    className="h-8 w-8 cursor-pointer border border-slate-300 bg-white p-0.5"
                />
                <div className="flex flex-wrap items-center gap-1">
                    {ENTITY_COLOR_PALETTE.map(hex => {
                        const isUsed = usedSet.has(hex.toLowerCase());
                        return (
                            <button
                                key={hex}
                                type="button"
                                onClick={() => onChange(hex)}
                                title={isUsed ? `${hex} (in use)` : hex}
                                style={{ backgroundColor: hex, opacity: isUsed ? 0.35 : 1 }}
                                className={`h-5 w-5 rounded-full border ${currentColor.toLowerCase() === hex.toLowerCase() ? 'border-slate-900 ring-2 ring-offset-1 ring-slate-400' : 'border-slate-300'}`}
                            />
                        );
                    })}
                </div>
            </div>
        </div>
    );
};

export default ColorPaletteField;
