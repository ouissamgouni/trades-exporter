/**
 * EntityColorSettings - Configuration panel for account & connector badge colors.
 *
 * Provides a grid of accounts and connectors, each with a clickable color
 * swatch that cycles through the available hex color palette.
 * Overrides are persisted in localStorage via useEntityColors.
 *
 * Can be embedded in any settings drawer, modal, or panel.
 */

import React from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { Account } from '../types';
import { useEntityColors, ENTITY_COLOR_PALETTE, hexToRgba } from '../hooks/useEntityColors';
import { Tooltip } from './ui/tooltip';
import { Badge, Button } from './ui/primitives';

interface EntityColorSettingsProps {
    /** Available accounts to configure */
    accounts: Account[];
    /** Known connector names to configure */
    connectorNames: string[];
}

/** Small clickable circle showing a hex color */
const ColorSwatch: React.FC<{
    color: string;
    active?: boolean;
    onClick: () => void;
    size?: number;
}> = ({ color, active, onClick, size = 16 }) => (
    <button
        type="button"
        className="shrink-0 cursor-pointer rounded-full border-2 transition-transform hover:scale-125"
        style={{
            width: size,
            height: size,
            backgroundColor: color,
            borderColor: active ? 'white' : 'transparent',
            outline: active ? `2px solid ${color}` : 'none',
        }}
        onClick={onClick}
        title={color}
    />
);

export const EntityColorSettings: React.FC<EntityColorSettingsProps> = ({
    accounts,
    connectorNames,
}) => {
    const {
        getAccountColor,
        getConnectorColor,
        setAccountColor,
        setConnectorColor,
        resetAccountColor,
        resetConnectorColor,
        resetAllColors,
    } = useEntityColors();

    return (
        <div>
            {/* Header */}
            <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-bold text-slate-700">Badge Colors</span>
                <Tooltip content="Reset all colors to auto-assigned defaults">
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={resetAllColors}
                        className="text-[9px]"
                    >
                        <FiRefreshCw size={10} />
                        Reset All
                    </Button>
                </Tooltip>
            </div>

            {/* Accounts */}
            {accounts.length > 0 && (
                <div className="mb-4">
                    <span className="mb-2 block text-xs font-bold uppercase text-slate-500">
                        Accounts
                    </span>
                    <div className="flex flex-col gap-1.5">
                        {accounts.map(account => {
                            const currentColor = getAccountColor(account.id, account.name, account.color);
                            return (
                                <div key={account.id} className="flex items-center gap-2 py-0.5">
                                    <Badge
                                        className="min-w-[80px] text-[9px]"
                                        style={{ backgroundColor: hexToRgba(currentColor, 0.18), color: currentColor }}
                                    >
                                        {account.name.length > 16 ? account.name.slice(0, 16) + '…' : account.name}
                                    </Badge>
                                    <div className="flex flex-wrap items-center gap-0.5">
                                        {ENTITY_COLOR_PALETTE.map(hex => (
                                            <ColorSwatch
                                                key={hex}
                                                color={hex}
                                                active={currentColor.toLowerCase() === hex.toLowerCase()}
                                                onClick={() => setAccountColor(account.id, hex)}
                                                size={14}
                                            />
                                        ))}
                                    </div>
                                    <Tooltip content="Reset to auto">
                                        <button
                                            type="button"
                                            className="ml-1 cursor-pointer text-[8px] text-slate-400 hover:text-slate-600"
                                            onClick={() => resetAccountColor(account.id)}
                                        >
                                            ✕
                                        </button>
                                    </Tooltip>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Connectors */}
            {connectorNames.length > 0 && (
                <div>
                    <span className="mb-2 block text-xs font-bold uppercase text-slate-500">
                        Connectors
                    </span>
                    <div className="flex flex-col gap-1.5">
                        {connectorNames.map(name => {
                            const currentColor = getConnectorColor(name);
                            return (
                                <div key={name} className="flex items-center gap-2 py-0.5">
                                    <Badge
                                        className="min-w-[80px] text-[9px]"
                                        style={{ backgroundColor: hexToRgba(currentColor, 0.18), color: currentColor }}
                                    >
                                        {name.length > 16 ? name.slice(0, 16) + '…' : name}
                                    </Badge>
                                    <div className="flex flex-wrap items-center gap-0.5">
                                        {ENTITY_COLOR_PALETTE.map(hex => (
                                            <ColorSwatch
                                                key={hex}
                                                color={hex}
                                                active={currentColor.toLowerCase() === hex.toLowerCase()}
                                                onClick={() => setConnectorColor(name, hex)}
                                                size={14}
                                            />
                                        ))}
                                    </div>
                                    <Tooltip content="Reset to auto">
                                        <button
                                            type="button"
                                            className="ml-1 cursor-pointer text-[8px] text-slate-400 hover:text-slate-600"
                                            onClick={() => resetConnectorColor(name)}
                                        >
                                            ✕
                                        </button>
                                    </Tooltip>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default EntityColorSettings;
