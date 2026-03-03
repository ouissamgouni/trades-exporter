/**
 * AccountSuggestionBadges
 *
 * Renders inline suggestion badges for account linking, powered by the
 * backend GET /accounts/suggest endpoint (network-aware).
 *
 * Used in TransactionsTable cells for account_id, from_account_id, and
 * to_account_id fields to replace the old client-side getAccountSuggestions().
 */

import React from 'react';
import { Badge, HStack, Text } from '@chakra-ui/react';
import { useAccountSuggestions, AccountSuggestion } from '../hooks/useAccountSuggestions';
import { getConfidenceColor, formatConfidence } from '../utils/similarity';
import { Tooltip } from './ui/tooltip';

export interface AccountSuggestionBadgesProps {
    /** Raw account label to match */
    label: string | undefined | null;
    /** Source connector type */
    source?: string | null;
    /** Network/chain for disambiguation */
    network?: string | null;
    /** Callback when a suggestion badge is clicked */
    onAccept: (suggestion: AccountSuggestion) => void;
    /** Whether to show "Suggestions:" label */
    showLabel?: boolean;
    /** Max suggestions to show */
    maxResults?: number;
    /** Min confidence threshold */
    minConfidence?: number;
    /** Font size for badge text */
    fontSize?: string;
    /** Whether to enable the query */
    enabled?: boolean;
    /** Pre-fetched suggestions — when provided, skips internal useAccountSuggestions hook */
    suggestions?: AccountSuggestion[];
}

export const AccountSuggestionBadges: React.FC<AccountSuggestionBadgesProps> = ({
    label,
    source,
    network,
    onAccept,
    showLabel = false,
    maxResults = 3,
    minConfidence = 0.5,
    fontSize = '7px',
    enabled = true,
    suggestions: externalSuggestions,
}) => {
    // When pre-fetched suggestions are provided, skip the internal hook
    const { suggestions: hookSuggestions } = useAccountSuggestions({
        label,
        source,
        network,
        minConfidence,
        maxResults,
        enabled: enabled && !!label && externalSuggestions === undefined,
    });

    const suggestions = externalSuggestions ?? hookSuggestions;

    if (suggestions.length === 0) return null;

    return (
        <HStack gap={1} flexWrap="wrap">
            {showLabel && (
                <Text fontSize={fontSize} color="gray.500">Suggestions:</Text>
            )}
            {suggestions.map((s, idx) => (
                <Tooltip
                    key={idx}
                    content={`${s.name} (${formatConfidence(s.confidence)} match) - Click to link`}
                    openDelay={100}
                >
                    <Badge
                        size="xs"
                        colorPalette={getConfidenceColor(s.confidence)}
                        variant={s.confidence >= 0.9 ? 'solid' : 'outline'}
                        cursor="pointer"
                        fontSize={fontSize}
                        onClick={(e) => {
                            e.stopPropagation();
                            onAccept(s);
                        }}
                    >
                        {s.name.slice(0, 10)}{s.name.length > 10 ? '…' : ''}
                        {s.confidence >= 0.9 && ' ✓'}
                    </Badge>
                </Tooltip>
            ))}
        </HStack>
    );
};
