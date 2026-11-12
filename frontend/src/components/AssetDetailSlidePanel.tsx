/**
 * AssetDetailSlidePanel — Right-side slide panel for one asset: sticky summary header
 * (identity, price, position, contracts) + tabs (Overview / P&L / Transactions / Prices / Settings).
 *
 * Designed to be mounted once at app root and controlled via
 * AssetDetailPanelContext.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { FiMaximize2, FiMinimize2 } from 'react-icons/fi';
import { SlidePanel } from './pnl/SlidePanel';
import { useAsset } from '../hooks/useAsset';
import { useLatestPnLVersion } from '../hooks/useLatestPnLVersion';
import { useAssetDetailPanel } from '../contexts/AssetDetailPanelContext';
import { AssetDetailsForm } from './AssetDetailsForm';
import { AssetPriceGettersEditor } from './AssetPriceGettersEditor';
import { AssetCategoriesEditor } from './AssetCategoriesEditor';
import { GapFixPanel } from './GapFixPanel';
import { PriceSetterDialog } from './pnl/PriceSetterDialog';
import { useAccountBalances } from './AssetPnLOverviewSection';
import { ScopedPnLOverview } from './pnl/ScopedPnLOverview';
import { AccountBadge } from './AccountBadge';
import { fmtCurrency } from './pnl/TotalReturnScorecard';
import { formatQuantity } from '../utils/numberUtils';
import { AssetPnLAuditSection } from './AssetPnLAuditSection';
import { AssetIncomeSection } from './pnl/AssetIncomeSection';
import { AssetSummaryHeader } from './AssetSummaryHeader';
import { TransactionsTable } from './TransactionsTable';
import { defaultFilterState, type TransactionFilterState } from './TransactionFilters';
import { Badge, Spinner } from './ui/primitives';

type AssetTab = 'overview' | 'pnl' | 'transactions' | 'prices' | 'settings';

const TABS: { id: AssetTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'pnl', label: 'P&L' },
    { id: 'transactions', label: 'Transactions' },
    { id: 'prices', label: 'Prices' },
    { id: 'settings', label: 'Settings' },
];

/** Legacy initialTab values from callers of openAssetPanel */
const TAB_ALIASES: Record<string, AssetTab> = {
    details: 'overview',
    'price-getters': 'prices',
    categories: 'settings',
};

const toTab = (t: string | undefined): AssetTab =>
    TAB_ALIASES[t ?? ''] ?? (TABS.some(x => x.id === t) ? (t as AssetTab) : 'overview');

const SubHeading: React.FC<{ children: React.ReactNode; badge?: React.ReactNode }> = ({ children, badge }) => (
    <div className="mb-1.5 mt-3 flex items-center gap-1.5 border-b border-slate-100 pb-1 first:mt-0">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}</span>
        {badge}
    </div>
);

/**
 * Renders the slide panel reading directly from the context.
 * Mount once in App.tsx — no props needed.
 */
export const AssetDetailSlidePanel: React.FC = () => {
    const { panelState, closeAssetPanel } = useAssetDetailPanel();
    const { isOpen, assetId } = panelState;

    const { asset, isLoading, invalidate } = useAsset(assetId, isOpen);
    const { versionId: latestVersionId, baseCurrency } = useLatestPnLVersion(isOpen);
    const versionId = panelState.pnlVersionId ?? latestVersionId ?? null;

    const [tab, setTab] = useState<AssetTab>('overview');
    const [wide, setWide] = useState(false);
    useEffect(() => {
        if (isOpen) setTab(toTab(panelState.initialTab));
    }, [isOpen, assetId, panelState.initialTab]);

    const expandToggle = (
        <button
            type="button"
            onClick={() => setWide(w => !w)}
            aria-label={wide ? 'Narrow panel' : 'Widen panel'}
            title={wide ? 'Narrow panel' : 'Widen panel'}
            className="hidden p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 sm:inline-flex"
        >
            {wide ? <FiMinimize2 size={15} /> : <FiMaximize2 size={15} />}
        </button>
    );

    return (
        <SlidePanel
            isOpen={isOpen}
            onClose={closeAssetPanel}
            title="Asset"
            headerActions={expandToggle}
            width={wide || tab === 'transactions' || tab === 'overview' ? '1100px' : '720px'}
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
                    <div className="sticky -top-4 z-[2] -mx-4 -mt-4 bg-white">
                        <AssetSummaryHeader asset={asset} versionId={versionId} baseCurrency={baseCurrency} />
                        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50 px-2">
                            {TABS.map(({ id, label }) => (
                                <button
                                    key={id}
                                    type="button"
                                    role="tab"
                                    aria-selected={tab === id}
                                    onClick={() => setTab(id)}
                                    className={tab === id
                                        ? '-mb-px shrink-0 border-b-2 border-blue-600 px-3 py-2 text-sm font-semibold text-blue-700'
                                        : '-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-slate-600 hover:text-slate-900'}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="pt-3">
                        {tab === 'overview' && (
                            versionId ? (
                                <>
                                    <ScopedPnLOverview versionId={versionId} baseCurrency={baseCurrency} assetIds={[asset.asset_id!]} contextLabel={asset.symbol} defaultGroupBy="account" />
                                    <SubHeading>Holdings by account</SubHeading>
                                    <AssetHoldingsByAccount assetId={asset.asset_id!} versionId={versionId} baseCurrency={baseCurrency} />
                                </>
                            ) : <p className="py-6 text-center text-xs text-slate-400">No P&L calculation yet — run one to see position and performance.</p>
                        )}

                        {tab === 'pnl' && (
                            versionId ? (
                                <>
                                    <SubHeading>Audit</SubHeading>
                                    <AssetPnLAuditSection assetId={asset.asset_id!} assetSymbol={asset.symbol} assetLabel={asset.label} versionId={versionId} />
                                    <SubHeading>Income</SubHeading>
                                    <AssetIncomeSection assetId={asset.asset_id!} versionId={versionId} />
                                </>
                            ) : (
                                <p className="py-6 text-center text-xs text-slate-400">No P&L calculation yet.</p>
                            )
                        )}

                        {tab === 'transactions' && <RelatedTransactions assetId={asset.asset_id!} />}

                        {tab === 'prices' && (
                            <>
                                <SubHeading>History & gaps</SubHeading>
                                <PriceChartWithGaps assetId={asset.asset_id!} symbol={asset.symbol} />
                                <SubHeading badge={(asset.price_getters?.length ?? 0) > 0 ? <Badge colorScheme="purple">{asset.price_getters!.length}</Badge> : undefined}>
                                    Price getters
                                </SubHeading>
                                <AssetPriceGettersEditor asset={asset} onChanged={invalidate} />
                            </>
                        )}

                        {tab === 'settings' && (
                            <>
                                <SubHeading>Details</SubHeading>
                                <AssetDetailsForm asset={asset} onSaved={invalidate} />
                                <SubHeading badge={(asset.categories?.length ?? 0) > 0 ? <Badge colorScheme="blue">{asset.categories!.length}</Badge> : undefined}>
                                    Categories
                                </SubHeading>
                                <AssetCategoriesEditor asset={asset} onSaved={invalidate} />
                            </>
                        )}
                    </div>
                </div>
            )}
        </SlidePanel>
    );
};

/* ── Per-account position of this asset ── */

const AssetHoldingsByAccount: React.FC<{ assetId: number; versionId: number; baseCurrency: string }> = ({ assetId, versionId, baseCurrency }) => {
    const { breakdowns, isLoading } = useAccountBalances(versionId, assetId);
    if (isLoading) return <div className="flex justify-center py-3"><Spinner size="sm" /></div>;
    if (!breakdowns.length) return <p className="py-3 text-center text-xs text-slate-400">Not held in any account.</p>;
    const totalQty = breakdowns.reduce((s, b) => s + Math.max(b.qty, 0), 0);
    return (
        <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase text-slate-500">
                <tr><th className="py-1">Account</th><th className="text-right">Qty</th><th className="text-right">Share</th><th className="text-right">Cost</th><th className="text-right">Avg cost</th><th className="text-right">Lots</th></tr>
            </thead>
            <tbody>
                {[...breakdowns].sort((a, b) => b.qty - a.qty).map(b => (
                    <tr key={b.account_id} className="border-t border-slate-100">
                        <td className="py-1"><AccountBadge accountId={b.account_id} accountName={b.account_name} size="xs" /></td>
                        <td className={`text-right tabular-nums ${b.qty < 0 ? 'text-red-700' : ''}`}>{formatQuantity(b.qty)}</td>
                        <td className="text-right tabular-nums">{totalQty > 0 && b.qty > 0 ? `${((b.qty / totalQty) * 100).toFixed(1)}%` : '—'}</td>
                        <td className="text-right tabular-nums">{fmtCurrency(b.cost_basis_in_base, baseCurrency)}</td>
                        <td className="text-right tabular-nums">{b.avg_unit_cost_in_base ? fmtCurrency(b.avg_unit_cost_in_base, baseCurrency) : '—'}</td>
                        <td className="text-right tabular-nums">{b.lot_count}</td>
                    </tr>
                ))}
            </tbody>
        </table>
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
            title=""
            subtitle=""
            compact
            showSuggestions
            pinDateColumn
            tableId={`asset-detail-txns-${assetId}`}
        />
    );
};

export default AssetDetailSlidePanel;
