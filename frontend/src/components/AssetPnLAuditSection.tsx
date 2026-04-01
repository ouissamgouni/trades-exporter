/**
 * AssetPnLAuditSection — Standalone PnL audit for a single asset.
 *
 * Wraps InvestigationView with pre-applied asset filter.
 * Fetches the latest PnL version independently (no PnL context needed).
 */
import React from 'react';
import { Badge, Flex, Spinner, Text } from '@chakra-ui/react';
import { FiClock } from 'react-icons/fi';

import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { InvestigationView } from './pnl/InvestigationView';

interface AssetPnLAuditSectionProps {
    assetId: number;
    assetSymbol?: string;
    assetLabel?: string;
    /** Explicit PnL version ID (skips latest-version fetch when provided) */
    versionId?: number;
}

export const AssetPnLAuditSection: React.FC<AssetPnLAuditSectionProps> = ({
    assetId,
    assetSymbol,
    assetLabel,
    versionId: explicitVersionId,
}) => {
    const { version, versionId: latestVersionId, baseCurrency, isLoading: versionLoading } = useLatestPnLVersion();
    const versionId = explicitVersionId ?? latestVersionId;

    if (versionLoading) {
        return (
            <Flex justify="center" py={6}>
                <Spinner size="sm" />
                <Text ml={2} fontSize="xs" color="gray.500">Loading PnL data…</Text>
            </Flex>
        );
    }

    if (!versionId) {
        return (
            <Text fontSize="xs" color="gray.400" py={3} textAlign="center">
                No PnL calculation available.
            </Text>
        );
    }

    const createdAt = version?.created_at
        ? new Date(version.created_at).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        })
        : 'Unknown';

    return (
        <>
            {/* Version info banner */}
            <Flex
                align="center"
                gap={1.5}
                px={2}
                py={1}
                mb={2}
                bg="gray.50"
                borderRadius="sm"
                fontSize="2xs"
                color="gray.500"
            >
                <FiClock size={10} />
                <Text>
                    Version #{version?.version_id} · {createdAt}
                </Text>
                <Badge size="xs" variant="subtle" colorPalette="gray" ml={1}>
                    {version?.lot_method}
                </Badge>
            </Flex>

            <InvestigationView
                versionId={versionId}
                baseCurrency={baseCurrency}
                initialFilters={{ relatedAssetIds: [String(assetId)] }}
                assets={assetSymbol ? [{ id: assetId, symbol: assetSymbol, label: assetLabel }] : undefined}
            />
        </>
    );
};
