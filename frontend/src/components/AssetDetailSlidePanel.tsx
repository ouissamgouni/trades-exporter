/**
 * AssetDetailSlidePanel — Right-side slide panel showing full asset details,
 * price getters and categories as vertical collapsible accordion sections.
 *
 * Designed to be mounted once at app root and controlled via
 * AssetDetailPanelContext.
 */

import React, { useMemo, useState } from 'react';
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
import { Badge, Spinner } from './ui/primitives';

/* ── Collapsible section (same pattern as TransactionSidePanel) ── */

interface SectionProps {
    title: string;
    icon?: string;
    badge?: React.ReactNode;
    children: React.ReactNode;
    defaultOpen?: boolean;
    colorScheme?: string;
}

/** Literal Tailwind classes per color — Tailwind's JIT scanner requires full class
 * strings in source, so dynamic `bg-${colorScheme}-100` interpolation is unsafe. */
const SECTION_COLORS: Record<string, { bg: string; hoverBg: string; text: string }> = {
    gray: { bg: 'bg-gray-100', hoverBg: 'hover:bg-gray-200', text: 'text-gray-700' },
    blue: { bg: 'bg-blue-100', hoverBg: 'hover:bg-blue-200', text: 'text-blue-700' },
    teal: { bg: 'bg-teal-100', hoverBg: 'hover:bg-teal-200', text: 'text-teal-700' },
    purple: { bg: 'bg-purple-100', hoverBg: 'hover:bg-purple-200', text: 'text-purple-700' },
    cyan: { bg: 'bg-cyan-100', hoverBg: 'hover:bg-cyan-200', text: 'text-cyan-700' },
    green: { bg: 'bg-green-100', hoverBg: 'hover:bg-green-200', text: 'text-green-700' },
    orange: { bg: 'bg-orange-100', hoverBg: 'hover:bg-orange-200', text: 'text-orange-700' },
};

const Section: React.FC<SectionProps> = ({
    title, icon, badge, children, defaultOpen = true, colorScheme = 'gray',
}) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const colors = SECTION_COLORS[colorScheme] ?? SECTION_COLORS.gray;
    return (
        <div className="mb-2">
            <div
                className={`flex cursor-pointer items-center gap-1 px-2 py-1.5 ${colors.bg} ${colors.hoverBg}`}
                onClick={() => setIsOpen(o => !o)}
            >
                {isOpen ? <FiChevronDown size={14} /> : <FiChevronRight size={14} />}
                <span className={`text-[11px] font-bold uppercase ${colors.text}`}>
                    {icon && `${icon} `}{title}
                </span>
                {badge}
            </div>
            {isOpen && (
                <div className="px-1 py-1">
                    {children}
                </div>
            )}
        </div>
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
        <Badge colorScheme={asset.status === 0 ? 'green' : 'gray'}>
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
                <div className="flex items-center justify-center py-10">
                    <Spinner size="lg" />
                </div>
            )}

            {!isLoading && !asset && assetId && (
                <div className="py-10 text-center">
                    <span className="text-red-500">Asset not found (ID: {assetId})</span>
                </div>
            )}

            {asset && (
                <div className="flex flex-col">
                    {/* Row 1: Details + Categories side by side */}
                    <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                            <Section title="Details" icon="📋" colorScheme="blue" defaultOpen={true}>
                                <AssetDetailsForm asset={asset} onSaved={invalidate} />
                            </Section>
                        </div>
                        <div className="min-w-0 flex-1">
                            <Section
                                title="Categories"
                                icon="🏷️"
                                colorScheme="teal"
                                defaultOpen={false}
                                badge={(asset.categories?.length ?? 0) > 0 ? (
                                    <Badge colorScheme="blue" className="ml-1">{asset.categories!.length}</Badge>
                                ) : undefined}
                            >
                                <AssetCategoriesEditor asset={asset} onSaved={invalidate} />
                            </Section>
                        </div>
                    </div>

                    {/* Row 2: Price Getters + Price Chart side by side */}
                    <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                            <Section
                                title="Price Getters"
                                icon="💲"
                                colorScheme="purple"
                                defaultOpen={false}
                                badge={(asset.price_getters?.length ?? 0) > 0 ? (
                                    <Badge colorScheme="purple" className="ml-1">{asset.price_getters!.length}</Badge>
                                ) : undefined}
                            >
                                <AssetPriceGettersEditor asset={asset} onChanged={invalidate} />
                            </Section>
                        </div>
                        <div className="min-w-0 flex-1">
                            <Section
                                title="Price Chart"
                                icon="📈"
                                colorScheme="blue"
                                defaultOpen={false}
                            >
                                <PriceChartWithGaps assetId={asset.asset_id!} symbol={asset.symbol} />
                            </Section>
                        </div>
                    </div>

                    <Section title="Related Transactions" icon="📝" colorScheme="cyan" defaultOpen={false}>
                        <RelatedTransactions assetId={asset.asset_id!} />
                    </Section>

                    <PnLSections assetId={asset.asset_id!} assetSymbol={asset.symbol} assetLabel={asset.label} pnlVersionId={panelState.pnlVersionId} />
                </div>
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
