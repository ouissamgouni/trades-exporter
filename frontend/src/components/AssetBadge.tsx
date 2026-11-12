/**
 * AssetBadge - Reusable component for displaying asset information
 * 
 * Features:
 * - Displays "Label (SYMBOL)" format when label exists, else just "SYMBOL"
 * - Truncates long labels with ellipsis
 * - Shows full details on hover via Chakra Tooltip
 * - Supports warning state for unlinked assets (sourceSymbol fallback)
 * - Supports onClick for inline editing scenarios
 */

import React, { useContext } from 'react';
import { Badge, type BadgeColorScheme } from './ui/primitives';
import { Tooltip } from './ui/tooltip';
import { AssetRef } from '../types';
import { AssetDetailPanelContext } from '../contexts/AssetDetailPanelContext';
import { EntityInfoButton } from './EntityInfoButton';

const BADGE_SCHEMES = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toScheme = (c?: string, fallback: BadgeColorScheme = 'gray'): BadgeColorScheme =>
    (c && BADGE_SCHEMES.includes(c) ? c : fallback) as BadgeColorScheme;

export interface AssetBadgeProps {
    /** Nested asset reference with id, symbol, and label */
    asset?: AssetRef | null;
    /** Fallback source symbol when asset is not linked (shows warning state) */
    sourceSymbol?: string | null;
    /** Badge size */
    size?: 'xs' | 'sm' | 'md';
    /** Color palette for the badge */
    colorPalette?: string;
    /** Maximum characters for label before truncating */
    maxLength?: number;
    /** Click handler for inline editing */
    onClick?: (e: React.MouseEvent) => void;
    /** Show warning icon/style for unlinked state */
    showWarning?: boolean;
    /** Custom fallback text when no asset and no sourceSymbol */
    fallback?: string;
    /** Hide the info icon that opens the asset detail panel */
    hideInfoIcon?: boolean;
}

/**
 * Formats asset display string: "Label (SYMBOL)" or just "SYMBOL"
 */
export const formatAssetDisplay = (
    symbol?: string | null,
    label?: string | null,
    maxLength?: number
): { display: string; truncated: boolean; fullText: string } => {
    if (!symbol && !label) {
        return { display: '-', truncated: false, fullText: '-' };
    }

    const sym = symbol || '?';

    if (!label) {
        return { display: sym, truncated: false, fullText: sym };
    }

    const fullText = label;

    if (maxLength && label.length > maxLength) {
        const truncatedLabel = label.slice(0, maxLength - 1) + '…';
        return { display: truncatedLabel, truncated: true, fullText };
    }

    return { display: fullText, truncated: false, fullText };
};

/**
 * AssetBadge component for consistent asset display across the app
 */
export const AssetBadge: React.FC<AssetBadgeProps> = ({
    asset,
    sourceSymbol,
    size = 'xs',
    colorPalette = 'purple',
    maxLength = 20,
    onClick,
    showWarning = true,
    hideInfoIcon = false,
    fallback = '-',
}) => {
    // Use context directly (before early returns — rules of hooks)
    const panelCtx = useContext(AssetDetailPanelContext);
    const openAssetPanel = panelCtx?.openAssetPanel ?? null;

    // Determine what to display
    const hasLinkedAsset = asset && (asset.symbol || asset.label);
    const hasSourceSymbol = !!sourceSymbol;

    // Unlinked state: no asset but has source symbol
    if (!hasLinkedAsset && hasSourceSymbol && showWarning) {
        return (
            <Tooltip
                content={
                    <div className="p-2 text-xs">
                        <div className="mb-1 font-bold text-orange-300">⚠ Unlinked Asset</div>
                        <div className="flex justify-between gap-4">
                            <span className="text-slate-400">Source Symbol</span>
                            <span className="text-white">{sourceSymbol}</span>
                        </div>
                        <div className="mt-1 text-[10px] text-slate-400">
                            Click to link to an asset
                        </div>
                    </div>
                }
                openDelay={200}
            >
                <Badge
                    colorScheme="orange"
                    className={onClick ? 'cursor-pointer' : 'cursor-default'}
                    onClick={onClick}
                >
                    ⚠ {sourceSymbol}
                </Badge>
            </Tooltip>
        );
    }

    // Unlinked state without warning: show raw source symbol in gray badge
    if (!hasLinkedAsset && hasSourceSymbol && !showWarning) {
        return (
            <Badge
                colorScheme="gray"
                className={onClick ? 'cursor-pointer' : 'cursor-default'}
                onClick={onClick}
            >
                {sourceSymbol}
            </Badge>
        );
    }

    // No asset and no source symbol
    if (!hasLinkedAsset) {
        return (
            <span className="text-slate-400" style={{ fontSize: size === 'xs' ? '9px' : size === 'sm' ? '11px' : '13px' }}>
                {fallback}
            </span>
        );
    }

    // Format the display string
    const { display, truncated, fullText } = formatAssetDisplay(
        asset?.symbol,
        asset?.label,
        maxLength
    );

    // Build tooltip content
    const tooltipContent = (
        <div className="min-w-[150px] p-2 text-xs">
            {asset?.label && (
                <div className="mb-1 flex justify-between gap-4">
                    <span className="text-slate-400">Name</span>
                    <span className="font-medium text-white">{asset.label}</span>
                </div>
            )}
            <div className="mb-1 flex justify-between gap-4">
                <span className="text-slate-400">Symbol</span>
                <span className="font-mono text-white">{asset?.symbol || '?'}</span>
            </div>
            {asset?.id && (
                <div className="flex justify-between gap-4">
                    <span className="text-slate-400">ID</span>
                    <span className="text-slate-300">#{asset.id}</span>
                </div>
            )}
        </div>
    );

    const showInfoBtn = !hideInfoIcon && openAssetPanel && asset?.id;

    return (
        <span className="group relative inline-flex items-center">
            <Tooltip content={tooltipContent} openDelay={200}>
                <Badge
                    colorScheme={toScheme(colorPalette, 'purple')}
                    className={onClick ? 'cursor-pointer' : 'cursor-default'}
                    onClick={onClick}
                    title={truncated ? fullText : undefined}
                >
                    {display}
                </Badge>
            </Tooltip>
            {showInfoBtn && (
                <EntityInfoButton kind="asset" id={asset!.id} label={asset!.label || asset!.symbol} className="ml-0.5" />
            )}
        </span>
    );
};

export default AssetBadge;
