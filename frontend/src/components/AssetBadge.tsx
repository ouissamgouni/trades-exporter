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
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { LuInfo } from 'react-icons/lu';
import { Tooltip } from './ui/tooltip';
import { AssetRef } from '../types';
import { AssetDetailPanelContext } from '../contexts/AssetDetailPanelContext';

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

    const fullText = `${label} (${sym})`;

    if (maxLength && fullText.length > maxLength) {
        // Truncate the label, keep the symbol visible
        const availableForLabel = maxLength - sym.length - 4; // account for " ()" and "…"
        if (availableForLabel > 3) {
            const truncatedLabel = label.slice(0, availableForLabel) + '…';
            return { display: `${truncatedLabel} (${sym})`, truncated: true, fullText };
        }
        // If there's not enough room, just show symbol
        return { display: sym, truncated: true, fullText };
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
                    <Box p={2} fontSize="xs">
                        <Text color="orange.300" fontWeight="bold" mb={1}>⚠ Unlinked Asset</Text>
                        <Flex justify="space-between" gap={4}>
                            <Text color="gray.400">Source Symbol</Text>
                            <Text color="white">{sourceSymbol}</Text>
                        </Flex>
                        <Text color="gray.400" mt={1} fontSize="2xs">
                            Click to link to an asset
                        </Text>
                    </Box>
                }
                openDelay={200}
            >
                <Badge
                    size={size}
                    colorPalette="orange"
                    variant="subtle"
                    cursor={onClick ? 'pointer' : 'default'}
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
                size={size}
                colorPalette="gray"
                variant="subtle"
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
            >
                {sourceSymbol}
            </Badge>
        );
    }

    // No asset and no source symbol
    if (!hasLinkedAsset) {
        return (
            <Text fontSize={size === 'xs' ? '9px' : size === 'sm' ? '11px' : '13px'} color="gray.400">
                {fallback}
            </Text>
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
        <Box p={2} fontSize="xs" minW="150px">
            {asset?.label && (
                <Flex justify="space-between" mb={1} gap={4}>
                    <Text color="gray.400">Name</Text>
                    <Text color="white" fontWeight="medium">{asset.label}</Text>
                </Flex>
            )}
            <Flex justify="space-between" mb={1} gap={4}>
                <Text color="gray.400">Symbol</Text>
                <Text color="white" fontFamily="mono">{asset?.symbol || '?'}</Text>
            </Flex>
            {asset?.id && (
                <Flex justify="space-between" gap={4}>
                    <Text color="gray.400">ID</Text>
                    <Text color="gray.300">#{asset.id}</Text>
                </Flex>
            )}
        </Box>
    );

    const showInfoBtn = !hideInfoIcon && openAssetPanel && asset?.id;

    return (
        <Flex
            display="inline-flex"
            align="center"
            position="relative"
            role="group"
            gap={0}
        >
            <Tooltip content={tooltipContent} openDelay={200}>
                <Badge
                    size={size}
                    colorPalette={colorPalette}
                    variant="subtle"
                    cursor={onClick ? 'pointer' : 'default'}
                    onClick={onClick}
                    title={truncated ? fullText : undefined}
                >
                    {display}
                </Badge>
            </Tooltip>
            {showInfoBtn && (
                <Tooltip content="View asset details" openDelay={100}>
                    <Box
                        as="button"
                        display="inline-flex"
                        alignItems="center"
                        justifyContent="center"
                        ml={0.5}
                        w={4}
                        h={4}
                        borderRadius="full"
                        color="gray.400"
                        opacity={0}
                        _groupHover={{ opacity: 1 }}
                        _hover={{ color: 'blue.500', bg: 'blue.50' }}
                        transition="opacity 0.15s, color 0.15s"
                        cursor="pointer"
                        flexShrink={0}
                        onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            openAssetPanel!(asset!.id!);
                        }}
                    >
                        <LuInfo size={12} />
                    </Box>
                </Tooltip>
            )}
        </Flex>
    );
};

export default AssetBadge;
