/**
 * SourceInfoCell - Compact display of transaction source information
 * 
 * Shows: Account (with badge or warning) + Source + Source Type + Source Symbol + Connector info
 * Used in transaction tables and data health check panels.
 */

import React from 'react';
import { Badge, Box, Flex, HStack, Text } from '@chakra-ui/react';
import { Tooltip } from '@chakra-ui/react/tooltip';
import { FiAlertTriangle, FiPlusCircle } from 'react-icons/fi';
import { Account } from '../types';
import { AccountBadge } from './AccountBadge';
import { getConfidenceColor, formatConfidence } from '../utils/similarity';
import { useAccountSuggestions, AccountSuggestion } from '../hooks/useAccountSuggestions';
import { useEntityColors, hexToRgba } from '../hooks/useEntityColors';

export interface SourceInfoCellProps {
    sourceAccount?: string;      // Raw source_account field
    accountId?: number | null;   // Resolved account_id (to show warning if missing)
    resolvedAccount?: Account;   // Full resolved account object
    resolvedAccountName?: string; // Resolved account name for display
    source: string;
    sourceType?: string;
    sourceSymbol?: string;
    onClick?: () => void;
    /** 
     * Account suggestions for quick linking.
     * If not provided, the component self-fetches from the backend using
     * source, sourceAccount, and network for network-aware disambiguation.
     */
    accountSuggestions?: AccountSuggestion[];
    /** Callback to accept a suggested account */
    onAcceptSuggestion?: (accountId: number) => void;
    /** Callback to quick-create a new account (opens AccountFormDialog) */
    onCreateAccount?: () => void;
    /** Connector metadata */
    connectorName?: string | null;
    runDatetime?: string | null;
    syncConnectorRunId?: number | null;
    onConnectorRunClick?: (runId: number) => void;
    network?: string | null;
}

export const SourceInfoCell: React.FC<SourceInfoCellProps> = ({
    sourceAccount,
    accountId,
    resolvedAccount,
    resolvedAccountName,
    source,
    sourceType,
    sourceSymbol,
    onClick,
    accountSuggestions: externalSuggestions,
    onAcceptSuggestion,
    onCreateAccount,
    connectorName,
    runDatetime,
    syncConnectorRunId,
    onConnectorRunClick,
    network,
}) => {
    // Determine if account is linked (resolved)
    const isAccountLinked = accountId != null;
    const needsSuggestions = !isAccountLinked && !!sourceAccount && !externalSuggestions;

    // Self-fetch suggestions when none provided externally (network-aware)
    const { suggestions: fetchedSuggestions } = useAccountSuggestions({
        label: sourceAccount,
        source,
        network,
        maxResults: 2,
        enabled: needsSuggestions,
    });

    const { getConnectorColor } = useEntityColors();
    const sourceColor = getConnectorColor(connectorName || source);

    const accountSuggestions = externalSuggestions ?? (needsSuggestions ? fetchedSuggestions : []);

    return (
        <Flex
            direction="column"
            gap={1}
            minW="100px"
            maxW="200px"
        >
            {/* First row: Account badge + Source badge */}
            <HStack gap={1} flexWrap="wrap" align="center">
                {/* Account badge */}
                {isAccountLinked ? (
                    <Box display="inline-block" maxW="fit-content">
                        <AccountBadge
                            account={resolvedAccount}
                            accountId={accountId}
                            accountName={resolvedAccountName}
                            size="xs"
                            maxLength={14}
                            onClick={onClick}
                        />
                    </Box>
                ) : sourceAccount ? (
                    <Flex direction="column" gap={1} minW={0}>
                        <Flex align="center" gap={1} minW={0}>
                            <FiAlertTriangle size={10} color="var(--chakra-colors-orange-500)" style={{ flexShrink: 0 }} />
                            <Text
                                fontSize="2xs"
                                color="orange.600"
                                fontWeight="medium"
                                overflow="hidden"
                                textOverflow="ellipsis"
                                whiteSpace="nowrap"
                                flex={1}
                                minW={0}
                                cursor="pointer"
                                onClick={onClick}
                                title={sourceAccount ? `Unlinked: ${sourceAccount}` : 'No account linked'}
                            >
                                {sourceAccount.length > 12 ? sourceAccount.slice(0, 12) + '...' : sourceAccount}
                            </Text>
                            {onCreateAccount && (
                                <Tooltip.Root>
                                    <Tooltip.Trigger asChild>
                                        <Box
                                            as="button"
                                            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onCreateAccount(); }}
                                            color="green.500"
                                            cursor="pointer"
                                            flexShrink={0}
                                            _hover={{ color: 'green.700' }}
                                            aria-label="Create new account"
                                        >
                                            <FiPlusCircle size={10} />
                                        </Box>
                                    </Tooltip.Trigger>
                                    <Tooltip.Positioner>
                                        <Tooltip.Content>Create new account</Tooltip.Content>
                                    </Tooltip.Positioner>
                                </Tooltip.Root>
                            )}
                        </Flex>
                        {/* Show compact suggestion chips for unlinked accounts */}
                        {accountSuggestions.length > 0 && (
                            <HStack gap={1} flexWrap="wrap">
                                {accountSuggestions.slice(0, 2).map((s, idx) => (
                                    <Tooltip.Root key={idx}>
                                        <Tooltip.Trigger asChild>
                                            <Badge
                                                size="xs"
                                                colorPalette={getConfidenceColor(s.confidence)}
                                                variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                                                cursor="pointer"
                                                style={{ fontSize: '7px' }}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onAcceptSuggestion?.(s.id);
                                                }}
                                            >
                                                {s.name.slice(0, 10)}{s.name.length > 10 ? '…' : ''}
                                                {s.confidence >= 0.9 && ' ✓'}
                                            </Badge>
                                        </Tooltip.Trigger>
                                        <Tooltip.Positioner>
                                            <Tooltip.Content>
                                                {formatConfidence(s.confidence)} match - Click to link
                                            </Tooltip.Content>
                                        </Tooltip.Positioner>
                                    </Tooltip.Root>
                                ))}
                            </HStack>
                        )}
                    </Flex>
                ) : null}

                {/* Source badge */}
                <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                        <Badge
                            size="xs"
                            bg={hexToRgba(sourceColor, 0.18)}
                            color={sourceColor}
                            variant="subtle"
                            style={{
                                fontSize: '9px',
                                padding: '1px 4px',
                                cursor: 'default',
                                maxWidth: '120px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                display: 'inline-block',
                            }}
                        >
                            {source}
                        </Badge>
                    </Tooltip.Trigger>
                    <Tooltip.Positioner>
                        <Tooltip.Content>
                            Source: {source}
                        </Tooltip.Content>
                    </Tooltip.Positioner>
                </Tooltip.Root>
            </HStack>

            {/* Second row: Connector run and other optional badges */}
            <HStack gap={1} flexWrap="wrap" align="center">
                {/* Clickable connector run badge (run ID + date) */}
                {syncConnectorRunId && runDatetime && (
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <Badge
                                size="xs"
                                colorPalette="grey"
                                variant="subtle"
                                cursor={onConnectorRunClick ? 'pointer' : 'default'}
                                onClick={(e) => {
                                    if (onConnectorRunClick) {
                                        e.stopPropagation();
                                        onConnectorRunClick(syncConnectorRunId);
                                    }
                                }}
                                _hover={onConnectorRunClick ? { bg: 'purple.100' } : undefined}
                                style={{
                                    fontSize: '9px',
                                    padding: '1px 4px',
                                    display: 'inline-block',
                                }}
                            >
                                #{syncConnectorRunId} • {new Date(runDatetime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                            </Badge>
                        </Tooltip.Trigger>
                        <Tooltip.Positioner>
                            <Tooltip.Content>
                                Click to view connector run details
                            </Tooltip.Content>
                        </Tooltip.Positioner>
                    </Tooltip.Root>
                )}

                {/* Source type badge (if different from source) */}
                {sourceType && sourceType !== source && (
                    <Badge
                        size="xs"
                        colorPalette="green"
                        variant="subtle"
                        title={`Type: ${sourceType}`}
                        style={{
                            fontSize: '9px',
                            padding: '1px 4px',
                            cursor: 'default',
                        }}
                    >
                        {sourceType}
                    </Badge>
                )}

                {/* Source symbol badge (if provided) */}
                {sourceSymbol && (
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <Badge
                                size="xs"
                                colorPalette="purple"
                                variant="outline"
                                style={{
                                    fontSize: '9px',
                                    padding: '1px 4px',
                                    cursor: 'default',
                                    maxWidth: '100px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    display: 'inline-block',
                                }}
                            >
                                {sourceSymbol}
                            </Badge>
                        </Tooltip.Trigger>
                        <Tooltip.Positioner>
                            <Tooltip.Content>
                                Symbol: {sourceSymbol}
                            </Tooltip.Content>
                        </Tooltip.Positioner>
                    </Tooltip.Root>
                )}

                {/* Network badge (if provided) */}
                {network && (
                    <Tooltip.Root>
                        <Tooltip.Trigger asChild>
                            <Badge
                                size="xs"
                                colorPalette="pink"
                                variant="subtle"
                                style={{
                                    fontSize: '8px',
                                    padding: '1px 4px',
                                    cursor: 'default',
                                    maxWidth: '100px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    display: 'inline-block',
                                }}
                            >
                                {network}
                            </Badge>
                        </Tooltip.Trigger>
                        <Tooltip.Positioner>
                            <Tooltip.Content>
                                Network: {network}
                            </Tooltip.Content>
                        </Tooltip.Positioner>
                    </Tooltip.Root>
                )}
            </HStack>
        </Flex>
    );
};
