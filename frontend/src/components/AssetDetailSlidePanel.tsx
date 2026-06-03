/**
 * AssetDetailSlidePanel — Right-side slide panel showing full asset details,
 * price getters and categories as vertical collapsible accordion sections.
 *
 * Designed to be mounted once at app root and controlled via
 * AssetDetailPanelContext.
 */

import React, { useMemo, useState } from 'react';
import { Badge, Box, Flex, Spinner, Text } from '@chakra-ui/react';
import { FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { SlidePanel } from './pnl/SlidePanel';
import { useAsset } from '../hooks/useAsset';
import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useAssetDetailPanel } from '../contexts/AssetDetailPanelContext';
import { AssetDetailsForm } from './AssetDetailsForm';
import { AssetPriceGettersEditor } from './AssetPriceGettersEditor';
import { AssetCategoriesEditor } from './AssetCategoriesEditor';
import { GapFixPanel } from './GapFixPanel';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { AssetPnLOverviewSection } from './AssetPnLOverviewSection';
import { AssetPnLAuditSection } from './AssetPnLAuditSection';
import { AssetIncomeSection } from './pnl/AssetIncomeSection';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, type TransactionFilterState } from './TransactionFilters';

/* ── Collapsible section (same pattern as TransactionSidePanel) ── */

interface SectionProps {
    title: string;
    icon?: string;
    badge?: React.ReactNode;
    children: React.ReactNode;
    defaultOpen?: boolean;
    colorScheme?: string;
}

const Section: React.FC<SectionProps> = ({
    title, icon, badge, children, defaultOpen = true, colorScheme = 'gray',
}) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    return (
        <Box mb={2}>
            <Flex
                align="center"
                gap={1}
                py={1.5}
                px={2}
                bg={`${colorScheme}.100`}
                borderRadius="sm"
                cursor="pointer"
                onClick={() => setIsOpen(o => !o)}
                _hover={{ bg: `${colorScheme}.200` }}
            >
                {isOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                <Text fontSize="11px" fontWeight="bold" color={`${colorScheme}.700`} textTransform="uppercase">
                    {icon && `${icon} `}{title}
                </Text>
                {badge}
            </Flex>
            {isOpen && (
                <Box px={1} py={1}>
                    {children}
                </Box>
            )}
        </Box>
    );
};

/**
 * Renders the slide panel reading directly from the context.
 * Mount once in App.tsx — no props needed.
 */
export const AssetDetailSlidePanel: React.FC = () => {
    const { panelState, closeAssetPanel } = useAssetDetailPanel();
    const { isOpen, assetId } = panelState;

    const { asset, isLoading, invalidate } = useAsset(assetId, isOpen);

    const titleText = asset
        ? `${asset.label ? `${asset.label} (${asset.symbol})` : asset.symbol}`
        : 'Asset Details';

    const titleIcon = asset ? (
        <Badge
            colorPalette={asset.status === 0 ? 'green' : 'gray'}
            size="sm"
            variant="subtle"
        >
            {asset.status === 0 ? 'Active' : 'Inactive'}
        </Badge>
    ) : undefined;

    return (
        <SlidePanel
            isOpen={isOpen}
            onClose={closeAssetPanel}
            title={titleText}
            titleIcon={titleIcon}
            width="1050px"
            zIndex={1500}
        >
            {isLoading && !asset && (
                <Flex justify="center" align="center" py={10}>
                    <Spinner size="lg" />
                </Flex>
            )}

            {!isLoading && !asset && assetId && (
                <Box textAlign="center" py={10}>
                    <Text color="red.500">Asset not found (ID: {assetId})</Text>
                </Box>
            )}

            {asset && (
                <Flex direction="column">
                    {/* Row 1: Details + Categories side by side */}
                    <Flex gap={2} align="flex-start">
                        <Box flex="1" minW={0}>
                            <Section title="Details" icon="📋" colorScheme="blue" defaultOpen={true}>
                                <AssetDetailsForm asset={asset} onSaved={invalidate} />
                            </Section>
                        </Box>
                        <Box flex="1" minW={0}>
                            <Section
                                title="Categories"
                                icon="🏷️"
                                colorScheme="teal"
                                defaultOpen={false}
                                badge={(asset.categories?.length ?? 0) > 0 ? (
                                    <Badge colorPalette="blue" size="xs" ml={1}>{asset.categories!.length}</Badge>
                                ) : undefined}
                            >
                                <AssetCategoriesEditor asset={asset} onSaved={invalidate} />
                            </Section>
                        </Box>
                    </Flex>

                    {/* Row 2: Price Getters + Price Chart side by side */}
                    <Flex gap={2} align="flex-start">
                        <Box flex="1" minW={0}>
                            <Section
                                title="Price Getters"
                                icon="💲"
                                colorScheme="purple"
                                defaultOpen={false}
                                badge={(asset.price_getters?.length ?? 0) > 0 ? (
                                    <Badge colorPalette="purple" size="xs" ml={1}>{asset.price_getters!.length}</Badge>
                                ) : undefined}
                            >
                                <AssetPriceGettersEditor asset={asset} onChanged={invalidate} />
                            </Section>
                        </Box>
                        <Box flex="1" minW={0}>
                            <Section
                                title="Price Chart"
                                icon="📈"
                                colorScheme="blue"
                                defaultOpen={false}
                            >
                                <PriceChartWithGaps assetId={asset.asset_id!} symbol={asset.symbol} />
                            </Section>
                        </Box>
                    </Flex>

                    <Section title="Related Transactions" icon="📝" colorScheme="cyan" defaultOpen={false}>
                        <RelatedTransactions assetId={asset.asset_id!} />
                    </Section>

                    <PnLSections assetId={asset.asset_id!} assetSymbol={asset.symbol} assetLabel={asset.label} pnlVersionId={panelState.pnlVersionId} />
                </Flex>
            )}
        </SlidePanel>
    );
};

/* ── Price chart + gap alerts (co-located for hook reuse) ── */

const PriceChartWithGaps: React.FC<{ assetId: number; symbol: string }> = ({ assetId, symbol }) => {
    const [showPriceSetter, setShowPriceSetter] = useState(false);
    return (
        <>
            <GapFixPanel assetId={assetId} symbol={symbol} onOpenPriceSetter={() => setShowPriceSetter(true)} />
            {showPriceSetter && (
                <PriceSetterDialog
                    isOpen={true}
                    onClose={() => setShowPriceSetter(false)}
                    onSave={() => setShowPriceSetter(false)}
                    assetId={assetId}
                    assetName={symbol}
                    defaultDate={new Date().toISOString()}
                />
            )}
        </>
    );
};

/* ── Related transactions (filtered by asset) ── */

const RelatedTransactions: React.FC<{ assetId: number }> = ({ assetId }) => {
    const baseFilters = useMemo<TransactionFilterState>(
        () => ({ ...defaultFilterState, relatedAssetIds: [String(assetId)] }),
        [assetId],
    );
    const [filters, setFilters] = useState<TransactionFilterState>(baseFilters);

    return (
        <TransactionsTable
            filters={filters}
            onFiltersChange={setFilters}
            resetFilters={baseFilters}
            compact
            embeddedMode
            showFilters={false}
            showBundles={false}
            hideLegend
            tableId={`asset-detail-txns-${assetId}`}
        />
    );
};

/* ── PnL sections (lazy-rendered, hidden if no PnL version exists) ── */

const PnLSections: React.FC<{ assetId: number; assetSymbol?: string; assetLabel?: string; pnlVersionId?: number | null }> = ({
    assetId, assetSymbol, assetLabel, pnlVersionId: explicitVersionId,
}) => {
    const { versionId: latestVersionId, isLoading } = useLatestPnLVersion();
    const versionId = explicitVersionId ?? latestVersionId;
    const fromPnlView = explicitVersionId != null;

    if (isLoading && !explicitVersionId) return null;
    if (!versionId) return null;

    return (
        <>
            <Section title="PnL Overview" icon="📊" colorScheme="green" defaultOpen={fromPnlView}>
                <AssetPnLOverviewSection assetId={assetId} assetSymbol={assetSymbol} versionId={versionId} />
            </Section>
            <Section title="PnL Audit" icon="🔍" colorScheme="orange" defaultOpen={fromPnlView}>
                <AssetPnLAuditSection assetId={assetId} assetSymbol={assetSymbol} assetLabel={assetLabel} versionId={versionId} />
            </Section>
            <Section title="Income" icon="💰" colorScheme="teal" defaultOpen={false}>
                <AssetIncomeSection assetId={assetId} versionId={versionId} />
            </Section>
        </>
    );
};

export default AssetDetailSlidePanel;
