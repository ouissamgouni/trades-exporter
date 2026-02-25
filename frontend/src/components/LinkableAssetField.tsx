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
import { Badge, Box, Flex, Input, Text } from '@chakra-ui/react';
import { FiEdit2, FiCopy, FiPlusCircle } from 'react-icons/fi';
import { LuLoader } from 'react-icons/lu';
import { Asset, AssetRef } from '../types';
import { AssetBadge } from './AssetBadge';
import { AssetSelector } from './AssetSelector';
import { getAssetSuggestions, getConfidenceColor, formatConfidence } from '../utils/similarity';
import { Tooltip } from './ui/tooltip';

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
            <Box ref={containerRef} py={0.5}>
                <Flex justify="space-between" gap={2} align="center" mb={1}>
                    <Text fontSize={fontSize} color="blue.600" fontWeight="medium" flexShrink={0}>{label}</Text>
                    {isSaving && <LuLoader size={10} className="animate-spin" />}
                </Flex>

                {/* Editable source text */}
                {onSourceChange && (
                    <Flex align="center" gap={1} mb={1}>
                        <Text fontSize="9px" color="gray.500" flexShrink={0}>Source:</Text>
                        {editingSource ? (
                            <Input
                                size="xs"
                                fontSize="9px"
                                fontFamily="mono"
                                value={localSource}
                                onChange={(e) => setLocalSource(e.target.value)}
                                onBlur={handleSourceSave}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleSourceSave(); }
                                }}
                                autoFocus
                                flex={1}
                            />
                        ) : (
                            <Text
                                fontSize="9px"
                                fontFamily="mono"
                                color={sourceValue ? 'gray.600' : 'gray.400'}
                                cursor="pointer"
                                _hover={{ color: 'blue.500' }}
                                onClick={() => setEditingSource(true)}
                                flex={1}
                            >
                                {sourceValue || '(empty)'}
                            </Text>
                        )}
                    </Flex>
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
                    <Flex gap={1} wrap="wrap" mt={1}>
                        {suggestions.map((s, idx) => (
                            <Tooltip
                                key={idx}
                                content={`${s.item.symbol}${s.item.label ? ` (${s.item.label})` : ''} - ${formatConfidence(s.confidence)} match`}
                                openDelay={100}
                            >
                                <Badge
                                    size="xs"
                                    colorPalette={getConfidenceColor(s.confidence)}
                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                    cursor="pointer"
                                    fontSize="8px"
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
                    </Flex>
                )}
            </Box>
        );
    }

    // ---- View mode ----
    return (
        <Flex
            justify="space-between"
            py={0.5}
            gap={2}
            align="center"
            cursor="pointer"
            onClick={() => setIsEditing(true)}
            px={1}
            mx={-1}
            borderWidth="1px"
            borderColor="transparent"
            borderRadius="sm"
            transition="all 0.1s"
            _hover={{ borderColor: 'blue.200', bg: 'blue.50' }}
            css={{ '&:hover .ef-pencil': { opacity: 0.5 } }}
        >
            <Text fontSize={fontSize} color="gray.500" flexShrink={0}>{label}</Text>
            <Flex
                align="center"
                gap={1}
                minW={0}
            >
                <Box
                    className="ef-pencil"
                    opacity={0}
                    transition="opacity 0.15s"
                    flexShrink={0}
                    color="blue.400"
                >
                    <FiEdit2 size={9} />
                </Box>

                {isLinked ? (
                    <AssetBadge
                        asset={linkedAsset}
                        sourceSymbol={sourceValue}
                        size="xs"
                        colorPalette={colorPalette}
                        maxLength={maxLength}
                    />
                ) : sourceValue ? (
                    <Flex align="center" gap={1}>
                        <AssetBadge
                            sourceSymbol={sourceValue}
                            size="xs"
                            colorPalette="orange"
                            maxLength={maxLength}
                        />
                        {onCreateNew && (
                            <Tooltip content="Create new asset" openDelay={100}>
                                <Box
                                    as="button"
                                    onClick={(e: React.MouseEvent) => {
                                        e.stopPropagation();
                                        onCreateNew();
                                    }}
                                    color="green.500"
                                    cursor="pointer"
                                    flexShrink={0}
                                    _hover={{ color: 'green.700' }}
                                >
                                    <FiPlusCircle size={9} />
                                </Box>
                            </Tooltip>
                        )}
                        {suggestions.length > 0 && suggestions.map((s, idx) => (
                            <Tooltip
                                key={idx}
                                content={`${s.item.symbol} - ${formatConfidence(s.confidence)} match`}
                                openDelay={100}
                            >
                                <Badge
                                    size="xs"
                                    colorPalette={getConfidenceColor(s.confidence)}
                                    variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                    cursor="pointer"
                                    fontSize="7px"
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
                    </Flex>
                ) : (
                    <Text fontSize={fontSize} color="gray.400">-</Text>
                )}
            </Flex>
        </Flex>
    );
};

export default LinkableAssetField;
