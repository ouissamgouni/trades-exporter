/**
 * AccountBadge - Reusable component for displaying account information
 * 
 * Features:
 * - Displays resolved account name when linked
 * - Shows warning state for unlinked accounts (sourceAccount fallback)
 * - Supports onClick for inline editing scenarios
 * - Shows full details on hover via Tooltip
 */

import React from 'react';
import { Badge, Box, Flex, Text } from '@chakra-ui/react';
import { FiHome, FiGlobe } from 'react-icons/fi';
import { Tooltip } from './ui/tooltip';
import { Account } from '../types';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';

export interface AccountBadgeProps {
    /** Linked account object */
    account?: Account | null;
    /** Account ID if no full account object provided */
    accountId?: number | null;
    /** Resolved account name (if account object not provided) */
    accountName?: string | null;
    /** Fallback source account label when not linked (shows warning state) */
    sourceAccount?: string | null;
    /** Original source label to display on hover when account is linked */
    sourceLabel?: string | null;
    /** Badge size */
    size?: 'xs' | 'sm' | 'md';
    /** Color palette for the badge (overrides entity color if provided) */
    colorPalette?: string;
    /** Use auto-assigned entity color instead of static colorPalette (default: true) */
    useEntityColor?: boolean;
    /** Maximum characters before truncating */
    maxLength?: number;
    /** Click handler for inline editing */
    onClick?: (e: React.MouseEvent) => void;
    /** Show warning icon/style for unlinked state */
    showWarning?: boolean;
    /** Custom fallback text when no account and no sourceAccount */
    fallback?: string;
}

/**
 * AccountBadge component for consistent account display across the app
 */
export const AccountBadge: React.FC<AccountBadgeProps> = ({
    account,
    accountId,
    accountName,
    sourceAccount,
    sourceLabel,
    size = 'xs',
    colorPalette: colorPaletteProp,
    useEntityColor = true,
    maxLength = 20,
    onClick,
    showWarning = true,
    fallback = '-',
}) => {
    const { getAccountColor } = useEntityColors();

    // Determine what to display
    const resolvedId = account?.id ?? accountId;
    const resolvedName = account?.name ?? accountName;
    const hasLinkedAccount = resolvedId != null && resolvedName;
    const hasSourceAccount = !!sourceAccount;

    // Resolve color: prefer DB-stored color, then entity color hook, then prop fallback
    const entityColor = (() => {
        // useEntityColors already handles priority: dbColor > localStorage > hash
        if (useEntityColor && hasLinkedAccount) return getAccountColor(resolvedId, resolvedName, account?.color);
        // Explicit prop or default
        return colorPaletteProp ?? '#9467BD';
    })();

    // Unlinked state: no account but has source account label
    if (!hasLinkedAccount && hasSourceAccount && showWarning) {
        return (
            <Tooltip
                content={
                    <Box p={2} fontSize="xs">
                        <Text color="orange.300" fontWeight="bold" mb={1}>⚠ Unlinked Account</Text>
                        <Flex justify="space-between" gap={4}>
                            <Text color="gray.400">Source Label</Text>
                            <Text color="white">{sourceAccount}</Text>
                        </Flex>
                        <Text color="gray.400" mt={1} fontSize="2xs">
                            Click to link to an account
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
                    ⚠ {sourceAccount.length > maxLength ? sourceAccount.slice(0, maxLength) + '…' : sourceAccount}
                </Badge>
            </Tooltip>
        );
    }

    // No account and no source account
    if (!hasLinkedAccount) {
        return (
            <Text
                fontSize={size === 'xs' ? '9px' : size === 'sm' ? '11px' : '13px'}
                color="gray.400"
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
            >
                {fallback}
            </Text>
        );
    }

    // Determine ownership state
    const isOwned = account?.owned;
    const ownershipKnown = account != null && typeof account.owned === 'boolean';
    const OwnershipIcon = isOwned ? FiHome : FiGlobe;
    const ownershipLabel = isOwned ? 'Owned' : 'External';

    // Format display string with truncation
    const displayName = resolvedName.length > maxLength
        ? resolvedName.slice(0, maxLength) + '…'
        : resolvedName;

    // Build tooltip content
    const tooltipContent = (
        <Box p={2} fontSize="xs" minW="150px">
            <Flex justify="space-between" mb={1} gap={4}>
                <Text color="gray.400">Name</Text>
                <Text color="white" fontWeight="medium">{resolvedName}</Text>
            </Flex>
            {ownershipKnown && (
                <Flex justify="space-between" mb={1} gap={4} align="center">
                    <Text color="gray.400">Ownership</Text>
                    <Flex align="center" gap={1}>
                        <OwnershipIcon size={10} />
                        <Text color={isOwned ? 'green.300' : 'orange.300'}>{ownershipLabel}</Text>
                    </Flex>
                </Flex>
            )}
            {sourceLabel && sourceLabel !== resolvedName && (
                <Flex justify="space-between" mb={1} gap={4}>
                    <Text color="gray.400">Source</Text>
                    <Text color="gray.300" fontFamily="mono" fontSize="2xs" maxW="180px" truncate>
                        {sourceLabel}
                    </Text>
                </Flex>
            )}
            {account?.account_type && (
                <Flex justify="space-between" mb={1} gap={4}>
                    <Text color="gray.400">Type</Text>
                    <Text color="white">{account.account_type}</Text>
                </Flex>
            )}
            {account?.address_or_identifier && (
                <Flex justify="space-between" mb={1} gap={4}>
                    <Text color="gray.400">Address</Text>
                    <Text color="gray.300" fontFamily="mono" fontSize="2xs">
                        {account.address_or_identifier.slice(0, 16)}...
                    </Text>
                </Flex>
            )}
            {resolvedId && (
                <Flex justify="space-between" gap={4}>
                    <Text color="gray.400">ID</Text>
                    <Text color="gray.300">#{resolvedId}</Text>
                </Flex>
            )}
        </Box>
    );

    return (
        <Tooltip content={tooltipContent} openDelay={200}>
            <Badge
                size={size}
                bg={hexToRgba(entityColor, 0.18)}
                color={entityColor}
                variant="subtle"
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
                title={resolvedName.length > maxLength ? resolvedName : undefined}
                display="inline-flex"
                alignItems="center"
                gap={0.5}
            >
                {ownershipKnown && <OwnershipIcon size={size === 'xs' ? 9 : size === 'sm' ? 11 : 13} />}
                {displayName}
            </Badge>
        </Tooltip>
    );
};

export default AccountBadge;
