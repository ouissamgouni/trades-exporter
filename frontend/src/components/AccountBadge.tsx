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
import { Tooltip } from './ui/tooltip';
import { Account } from '../types';

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
    /** Color palette for the badge */
    colorPalette?: string;
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
    colorPalette = 'purple',
    maxLength = 20,
    onClick,
    showWarning = true,
    fallback = '-',
}) => {
    // Determine what to display
    const resolvedId = account?.id ?? accountId;
    const resolvedName = account?.name ?? accountName;
    const hasLinkedAccount = resolvedId != null && resolvedName;
    const hasSourceAccount = !!sourceAccount;

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
                colorPalette={colorPalette}
                variant="subtle"
                cursor={onClick ? 'pointer' : 'default'}
                onClick={onClick}
                title={resolvedName.length > maxLength ? resolvedName : undefined}
            >
                {displayName}
            </Badge>
        </Tooltip>
    );
};

export default AccountBadge;
