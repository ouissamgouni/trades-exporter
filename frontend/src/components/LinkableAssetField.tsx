/**
 * LinkableAssetField - Reusable component for asset source↔linked-id display & editing.
 *
 * Encapsulates the repetitive pattern of:
 *   - Linked state: AssetBadge (shows source on hover), click to edit
 *   - Unlinked state: editable source text (orange ⚠) + client-side asset suggestions + AssetSelector
 *   - When source value is edited → clear linked ID + show new suggestions
 *   - When a suggestion is accepted → link the asset
 *
 * Used for: asset_id, price_quote_asset_id, fee_quote_asset_id fields.
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { FiEdit2, FiCopy, FiPlusCircle } from 'react-icons/fi';
import { LuLoader } from 'react-icons/lu';
import { Asset, AssetRef } from '../types';
import { AssetBadge } from './AssetBadge';
import { AssetSelector } from './AssetSelector';
import { getAssetSuggestions, getConfidenceColor, formatConfidence } from '../utils/similarity';
import { Tooltip } from './ui/tooltip';
import { Badge, type BadgeColorScheme } from './ui/primitives';

const SCHEMES = ['gray', 'blue', 'green', 'red', 'yellow', 'purple', 'orange'];
const toScheme = (c: string): BadgeColorScheme => (SCHEMES.includes(c) ? c : 'gray') as BadgeColorScheme;

export interface LinkableAssetFieldProps {
    /** Label shown on the left */
    label: string;
    /** Raw source symbol */
    sourceValue?: string | null;
    /** Linked asset ID */
    linkedId?: number | null;
    /** Linked asset reference (for display) */
    linkedAsset?: AssetRef | null;
    /** All assets for selector + suggestions */
    assets: Asset[];
    /** Called when user edits the source text. Should clear linkedId upstream. */
    onSourceChange?: (newSource: string) => Promise<void>;
    /** Called when user links to an asset (via selector or suggestion) */
    onLink: (assetId: number | null) => Promise<void>;
    /** Font size */
    fontSize?: string;
    /** Badge color palette */
    colorPalette?: string;
    /** Badge max length */
    maxLength?: number;
    /** Callback to quick-create a new asset (opens AssetFormDialog) */
    onCreateNew?: () => void;
    /** Connector source for raw asset linking */
    source?: string | null;
}

export const LinkableAssetField: React.FC<LinkableAssetFieldProps> = ({
    label,
    sourceValue,
    linkedId,
    linkedAsset,
    assets,
    onSourceChange,
    onLink,
    fontSize = '10px',
    colorPalette = 'purple',
    maxLength = 18,
    onCreateNew,
    source,
}) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editingSource, setEditingSource] = useState(false);
    const [localSource, setLocalSource] = useState(sourceValue || '');
    const [isSaving, setIsSaving] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Sync local source when prop changes
    useEffect(() => {
        if (!editingSource) setLocalSource(sourceValue || '');
    }, [sourceValue, editingSource]);

    // Click-outside to close edit mode
    useEffect(() => {
        if (!isEditing) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsEditing(false);
                setEditingSource(false);
            }
        };
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 100);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isEditing]);

    // Global Escape to close
    useEffect(() => {
        if (!isEditing) return;
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsEditing(false);
                setEditingSource(false);
                setLocalSource(sourceValue || '');
            }
        };
        document.addEventListener('keydown', handleEscape, true);
        return () => document.removeEventListener('keydown', handleEscape, true);
    }, [isEditing, sourceValue]);

    const isLinked = linkedId != null && linkedAsset != null;

    // Client-side asset suggestions
    const suggestions = useMemo(() => {
        if (!sourceValue || isLinked) return [];
        return getAssetSuggestions(sourceValue, assets, 0.4, 3);
    }, [sourceValue, assets, isLinked]);

    const handleAcceptSuggestion = async (assetId: number) => {
        setIsSaving(true);
        try {
            await onLink(assetId);
            setIsEditing(false);
        } catch { /* ignore */ }
        finally { setIsSaving(false); }
    };

    const handleSelectAsset = async (id: number | null) => {
        setIsSaving(true);
        try {
            await onLink(id);
            setIsEditing(false);
        } catch { /* ignore */ }
        finally { setIsSaving(false); }
    };

    const handleSourceSave = async () => {
        if (localSource === (sourceValue || '')) {
            setEditingSource(false);
            return;
        }
        if (!onSourceChange) return;
        setIsSaving(true);
        try {
            await onSourceChange(localSource);
            setEditingSource(false);
        } catch {
            setLocalSource(sourceValue || '');
        } finally {
            setIsSaving(false);
        }
    };

    // ---- Edit mode: show selector + suggestions ----
    if (isEditing) {
        return (
            <div ref={containerRef} className="py-0.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="shrink-0 font-medium text-blue-600" style={{ fontSize }}>{label}</span>
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                </div>

                {/* Editable source text */}
                {onSourceChange && (
                    <div className="mb-1 flex items-center gap-1">
                        <span className="shrink-0 text-[12px] text-slate-500">Source:</span>
                        {editingSource ? (
                            <input
                                value={localSource}
                                onChange={(e) => setLocalSource(e.target.value)}
                                onBlur={handleSourceSave}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleSourceSave(); }
                                }}
                                autoFocus
                                className="flex-1 border border-slate-300 bg-white px-1 py-0.5 font-mono text-[12px] outline-none focus:border-blue-500"
                            />
                        ) : (
                            <span
                                className={`flex-1 cursor-pointer font-mono text-[12px] hover:text-blue-500 ${sourceValue ? 'text-slate-600' : 'text-slate-400'}`}
                                onClick={() => setEditingSource(true)}
                            >
                                {sourceValue || '(empty)'}
                            </span>
                        )}
                    </div>
                )}

                {/* Asset selector */}
                <AssetSelector
                    value={linkedId ?? null}
                    onChange={handleSelectAsset}
                    assets={assets}
                    size="xs"
                    defaultSymbol={sourceValue || ''}
                    rawAssetSource={undefined}
                    rawAssetSymbol={sourceValue || undefined}
                />

                {/* Suggestions */}
                {sourceValue && !isLinked && suggestions.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                        {suggestions.map((s, idx) => (
                            <Tooltip
                                key={idx}
                                content={`${s.item.symbol}${s.item.label ? ` (${s.item.label})` : ''} - ${formatConfidence(s.confidence)} match`}
                                openDelay={100}
                            >
                                <Badge
                                    colorScheme={toScheme(getConfidenceColor(s.confidence))}
                                    className={`cursor-pointer ${s.confidence >= 0.9 ? 'font-semibold' : ''}`}
                                    style={{ fontSize: '8px' }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleAcceptSuggestion(s.item.asset_id!);
                                    }}
                                >
                                    {s.item.symbol.slice(0, 8)}{s.item.symbol.length > 8 ? '…' : ''}
                                    {s.confidence >= 0.9 && ' ✓'}
                                </Badge>
                            </Tooltip>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // ---- View mode ----
    return (
        <div
            className="group -mx-1 flex cursor-pointer items-center justify-between gap-2 border border-transparent px-1 py-0.5 transition-all hover:border-blue-200 hover:bg-blue-50"
            onClick={() => setIsEditing(true)}
        >
            <span className="shrink-0 text-slate-500" style={{ fontSize }}>{label}</span>
            <div className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-blue-400 opacity-0 transition-opacity group-hover:opacity-50">
                    <FiEdit2 size={9} />
                </span>

                {isLinked ? (
                    <AssetBadge
                        asset={linkedAsset}
                        sourceSymbol={sourceValue}
                        size="xs"
                        colorPalette={colorPalette}
                        maxLength={maxLength}
                    />
                ) : sourceValue ? (
                    <div className="flex items-center gap-1">
                        <AssetBadge
                            sourceSymbol={sourceValue}
                            size="xs"
                            colorPalette="orange"
                            maxLength={maxLength}
                        />
                        {onCreateNew && (
                            <Tooltip content="Create new asset" openDelay={100}>
                                <button
                                    type="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        onCreateNew();
                                    }}
                                    className="shrink-0 cursor-pointer text-green-500 hover:text-green-700"
                                >
                                    <FiPlusCircle size={9} />
                                </button>
                            </Tooltip>
                        )}
                        {suggestions.length > 0 && suggestions.map((s, idx) => (
                            <Tooltip
                                key={idx}
                                content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`}
                                openDelay={100}
                            >
                                <Badge
                                    colorScheme={toScheme(getConfidenceColor(s.confidence))}
                                    className={`cursor-pointer ${s.confidence >= 0.9 ? 'font-semibold' : ''}`}
                                    style={{ fontSize: '7px' }}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleAcceptSuggestion(s.item.asset_id!);
                                    }}
                                >
                                    {s.item.symbol.slice(0, 6)}{s.item.symbol.length > 6 ? '…' : ''}
                                    {s.confidence >= 0.9 && ' ✓'}
                                </Badge>
                            </Tooltip>
                        ))}
                    </div>
                ) : (
                    <span className="text-slate-400" style={{ fontSize }}>-</span>
                )}
            </div>
        </div>
    );
};

export default LinkableAssetField;
