/**
 * Asset Detail View - Split-View Analytics Layout with Lazy-Loaded Tabs
 * 
 * Design: Option C - Split-View Analytics with Tabs
 * - Left sidebar (30%): Asset summary with all key metrics stacked vertically
 * - Right main area (70%): Tabs for "Calculation Units" and "Cost Lot Events"
 * 
 * Principle 1: Results first, details on demand
 * Principle 3: Everything must be traceable
 * 
 * Tabs are lazy-loaded: Content is only fetched when user clicks "Load" button.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Badge, Button, Spinner, Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/primitives';
import { FiArrowLeft, FiTrendingUp, FiTrendingDown } from 'react-icons/fi';
import { AssetPnLRow, CostLot, CalculationUnit, CostLotEventEntry, AccountBalanceBreakdown, mapProcessedUnitToCalculationUnit } from './types';
import { UnitsTab, CostLotEventsTab } from './DataExplorerPanel';
import { BalanceTimelineChart } from './BalanceTimelineChart';
import { TransactionsTable } from '../TransactionsTable';
import { defaultFilterState, TransactionFilterState } from '../TransactionFilters';
import { API_URL } from '../../types';
import { formatQuantity, formatQuantityWithCurrency } from '../../utils/numberUtils';
import { ValueDisplay } from '../ValueDisplay';
import { Tooltip } from '../ui/tooltip';
import { getAccountColor } from '../../utils/accountColors';
import { DeltaBar } from './DeltaBar';
import { computeDelta } from './deltaUtils';

interface AssetDetailViewProps {
    asset: AssetPnLRow;
    versionId: number;
    baseCurrency: string;
    onBack: () => void;
    onTransactionClick?: (txId: number) => void;
    /** Per-account P&L balance breakdown for this asset */
    accountBreakdown?: AccountBalanceBreakdown[];
    /** Aggregated live qty for this asset's symbol */
    liveBalance?: number;
    /** Per-account live qty: accountId → qty */
    liveAccountBalances?: Map<number, number>;
    /** True while live balances are being fetched */
    liveBalanceLoading?: boolean;
    /** Account IDs whose live-balance fetch completed */
    liveFetchedAccountIds?: Set<number>;
    /** Account IDs that had connector-level errors: accountId → error messages */
    liveAccountErrors?: Map<number, string[]>;
    /** Initial account ID to filter transactions by (from clicking account in expanded PnL row) */
    initialAccountFilter?: number;
}

/** Metric Card for sidebar */
type MetricColor = 'blue' | 'green' | 'red' | 'orange' | 'gray';

const METRIC_TEXT: Record<MetricColor, string> = {
    blue: 'text-blue-600',
    green: 'text-green-600',
    red: 'text-red-600',
    orange: 'text-orange-600',
    gray: 'text-gray-900',
};
const METRIC_BORDER: Record<MetricColor, string> = {
    blue: 'border-blue-600',
    green: 'border-green-600',
    red: 'border-red-600',
    orange: 'border-orange-600',
    gray: 'border-gray-300',
};

const MetricCard: React.FC<{
    label: string;
    value: string;
    subValue?: string;
    color?: MetricColor;
    icon?: React.ReactNode;
}> = ({ label, value, subValue, color = 'gray', icon }) => (
    <div className={`border-l-[3px] bg-gray-50 p-3 ${METRIC_BORDER[color]}`}>
        <div className="text-xs uppercase tracking-wide text-gray-500">
            {label}
        </div>
        <div className="flex items-center gap-2">
            {icon}
            <span className={`font-mono text-lg font-bold ${METRIC_TEXT[color]}`}>
                {value}
            </span>
        </div>
        {subValue && (
            <div className="text-xs text-gray-500">{subValue}</div>
        )}
    </div>
);

/** Loading placeholder when data is being fetched */
const LoadingPlaceholder: React.FC<{ label: string }> = ({ label }) => (
    <div className="flex min-h-[200px] flex-col items-center justify-center bg-gray-50 px-4 py-12">
        <Spinner size="lg" className="mb-4 text-blue-500" />
        <div className="text-lg font-medium text-gray-600">
            Loading {label}...
        </div>
    </div>
);

/** Embedded transactions table filtered to a specific asset (any role: base, price quote, fee quote) */
const AssetTransactionsTab: React.FC<{
    versionId: number;
    assetId: number;
    accountId?: number;
    onTransactionClick?: (txId: number) => void;
}> = ({ versionId, assetId, accountId, onTransactionClick }) => {
    const [filters, setFilters] = React.useState<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: [],
        taxability: [],
        relatedAssetIds: [String(assetId)],
        versionId: String(versionId),
        inclusionStatus: 'included',
        relatedAccountIds: accountId ? [String(accountId)] : [],
    }));

    const resetFilters = React.useMemo<TransactionFilterState>(() => ({
        ...defaultFilterState,
        reviewStatus: [],
        taxability: [],
        relatedAssetIds: [String(assetId)],
        versionId: String(versionId),
        inclusionStatus: 'included',
    }), [versionId, assetId]);

    // Update account filter when accountId prop changes
    React.useEffect(() => {
        setFilters(prev => ({
            ...prev,
            relatedAccountIds: accountId ? [String(accountId)] : [],
        }));
    }, [accountId]);

    return (
        <TransactionsTable
            tableId={`asset-detail-txs-${assetId}`}
            title=""
            subtitle=""
            filters={filters}
            onFiltersChange={setFilters}
            resetFilters={resetFilters}
            showFilters={true}
            showBundles={false}
            showSuggestions={false}
            compact={true}
            defaultFiltersCollapsed={true}
        />
    );
};

function AssetDetailView({
    asset: assetPnlRow,
    versionId,
    baseCurrency,
    onBack,
    onTransactionClick,
    accountBreakdown,
    liveBalance,
    liveAccountBalances,
    liveBalanceLoading = false,
    liveFetchedAccountIds,
    liveAccountErrors,
    initialAccountFilter,
}: AssetDetailViewProps) {
    // Tab state - if initialAccountFilter is set, start on transactions tab
    const [activeTab, setActiveTab] = useState<'units' | 'events' | 'timeline' | 'transactions'>(
        initialAccountFilter ? 'transactions' : 'units'
    );
    const [timelineViewMode, setTimelineViewMode] = useState<'total' | 'by-account'>('total');
    // Account filter for transactions tab
    const [txAccountFilter, setTxAccountFilter] = useState<number | undefined>(initialAccountFilter);

    // Units data state
    const [calculationUnits, setCalculationUnits] = useState<CalculationUnit[]>([]);
    const [costLots, setCostLots] = useState<CostLot[]>([]);
    const [unitsLoading, setUnitsLoading] = useState(true);

    // Events data state  
    const [lotEvents, setLotEvents] = useState<CostLotEventEntry[]>([]);
    const [eventsLoading, setEventsLoading] = useState(false);
    const [eventsLoaded, setEventsLoaded] = useState(false);

    // Track current fetch to handle race conditions
    const fetchIdRef = useRef(0);

    // Load units on mount
    useEffect(() => {
        const currentFetchId = ++fetchIdRef.current;
        console.log(`[AssetDetailView] Fetch ${currentFetchId}: Starting units fetch for asset:`, assetPnlRow.asset.id);

        setUnitsLoading(true);
        setCalculationUnits([]);
        setCostLots([]);
        setEventsLoaded(false);
        setLotEvents([]);

        fetch(`${API_URL}/pnl/versions/${versionId}/units?related_asset_id=${assetPnlRow.asset.id}&limit=1000`)
            .then(response => {
                if (fetchIdRef.current !== currentFetchId) {
                    console.log(`[AssetDetailView] Fetch ${currentFetchId}: Stale response, ignoring`);
                    return null;
                }
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Response status:`, response.status);
                if (!response.ok) throw new Error('Failed to load units');
                return response.json();
            })
            .then(data => {
                if (!data || fetchIdRef.current !== currentFetchId) return;

                // API returns paginated response: { items, total, page, limit }
                const units = data.items || [];
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Units received:`, units.length);

                // Build cost lots array from raw units' nested data first (before mapping)
                const allLots: CostLot[] = [];
                for (const u of units) {
                    if (u.cost_basis?.lots) {
                        for (const lot of u.cost_basis.lots) {
                            allLots.push({
                                cost_lot_id: lot.cost_lot_id,
                                asset: lot.asset,
                                asset_id: lot.asset.id,
                                asset_symbol: lot.asset.name,
                                account_id: lot.account_id,
                                account_name: lot.account_name,
                                qty_original: lot.qty_original,
                                qty_remaining: lot.qty_remaining,
                                qty_consumed: lot.qty_consumed,
                                unit_cost_in_base: lot.unit_cost_in_base,
                                total_cost_in_base: lot.total_cost_in_base,
                                remaining_cost_in_base: lot.remaining_cost_in_base,
                                acquired_at: lot.acquired_at,
                                origin_transaction_id: lot.origin_transaction_id,
                                origin_unit_id: lot.origin_unit_id,
                                origin_unit_label: lot.origin_unit_label,
                                is_zero_cost: lot.is_zero_cost,
                                is_negative: lot.is_negative,
                                notes: lot.notes,
                            });
                        }
                    }
                }

                // Map to CalculationUnit type
                const mappedUnits: CalculationUnit[] = units.map(mapProcessedUnitToCalculationUnit);

                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Setting state - units:`, mappedUnits.length, 'lots:', allLots.length);
                setCalculationUnits(mappedUnits);
                setCostLots(allLots);
                setUnitsLoading(false);
                console.log(`[AssetDetailView] Fetch ${currentFetchId}: Done, unitsLoading=false`);
            })
            .catch(err => {
                if (fetchIdRef.current !== currentFetchId) return;
                console.error(`[AssetDetailView] Fetch ${currentFetchId}: Failed to load units:`, err);
                setUnitsLoading(false);
            });
    }, [versionId, assetPnlRow.asset.id]);

    // Load events when events or timeline tab is selected
    useEffect(() => {
        if ((activeTab !== 'events' && activeTab !== 'timeline') || eventsLoaded || eventsLoading) return;

        console.log('[AssetDetailView] Starting events fetch');
        setEventsLoading(true);

        fetch(`${API_URL}/pnl/versions/${versionId}/lot-events?related_asset_id=${assetPnlRow.asset.id}&limit=1000`)
            .then(response => {
                if (!response.ok) throw new Error('Failed to load lot events');
                return response.json();
            })
            .then(data => {
                // API returns paginated response: { items, total, page, limit }
                const events = data.items || [];
                console.log('[AssetDetailView] Events received:', events.length);
                setLotEvents(events);
                setEventsLoaded(true);
                setEventsLoading(false);
            })
            .catch(err => {
                console.error('[AssetDetailView] Failed to load events:', err);
                setEventsLoading(false);
            });
    }, [activeTab, eventsLoaded, eventsLoading, versionId, assetPnlRow.asset.id]);

    const unrealizedColor: MetricColor = assetPnlRow.unrealized_pnl >= 0 ? 'green' : 'red';
    const realizedColor: MetricColor = assetPnlRow.realized_pnl >= 0 ? 'green' : 'red';
    const unrealizedPct = `${assetPnlRow.unrealized_pnl_pct >= 0 ? '+' : ''}${(assetPnlRow.unrealized_pnl_pct * 100).toFixed(2)}%`;

    // Debug logging for render
    console.log('[AssetDetailView] Rendering - unitsLoading:', unitsLoading, 'units:', calculationUnits.length, 'activeTab:', activeTab);

    return (
        <div>
            {/* Header with back button */}
            <div className="mb-4 flex items-center gap-3">
                <Button variant="ghost" size="sm" onClick={onBack}>
                    <FiArrowLeft />
                </Button>
                <h2 className="flex items-center text-lg font-semibold">
                    <Badge colorScheme="blue" className="mr-2 text-xl">
                        {assetPnlRow.asset.symbol}
                    </Badge>
                    <span className="text-base font-normal text-gray-500">
                        {assetPnlRow.asset.label}
                    </span>
                </h2>
            </div>

            {/* Split-View Layout */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_1fr]">
                {/* Left Sidebar - Asset Summary */}
                <div>
                    <div className="sticky top-20 border border-gray-200 bg-white">
                        <div className="p-3">
                            {/* ── Balances ── */}
                            <div className="mb-3 flex items-center gap-2">
                                <span className="text-sm font-bold text-gray-600">
                                    Balances
                                </span>
                                {liveBalanceLoading && <Spinner size="xs" className="text-gray-400" />}
                            </div>

                            {/* Total row: P&L qty vs Live qty + delta */}
                            {(() => {
                                // Resolve effective live balance: explicit value, confirmed 0 (fetched but no entries), or undefined
                                const fetchDone = !liveBalanceLoading && liveFetchedAccountIds && liveFetchedAccountIds.size > 0;
                                const effectiveLive = liveBalance ?? (fetchDone ? 0 : undefined);

                                if (effectiveLive != null) {
                                    const deltaInfo = computeDelta(assetPnlRow.quantity, effectiveLive);

                                    // Check if any account had errors (partial data)
                                    const hasErrors = liveAccountErrors && liveAccountErrors.size > 0;
                                    return (
                                        <div className="mb-2 bg-blue-50 p-2">
                                            <div className="mb-1 flex items-center justify-between">
                                                <div className="flex items-center gap-1">
                                                    <span className="text-xs font-medium text-gray-500">Total</span>
                                                    {hasErrors && (
                                                        <Tooltip content={`${liveAccountErrors!.size} account(s) had fetch errors — live total may be incomplete`} openDelay={200}>
                                                            <span className="cursor-help text-xs text-orange-500">⚠</span>
                                                        </Tooltip>
                                                    )}
                                                </div>
                                                <DeltaBar delta={deltaInfo} liveQty={effectiveLive} pnlQty={assetPnlRow.quantity} size="sm" />
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="font-mono text-sm font-bold">
                                                    <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                                                </span>
                                            </div>
                                        </div>
                                    );
                                }

                                // Fallback: still loading or no live data infrastructure
                                return (
                                    <div className="mb-2 bg-gray-50 p-3">
                                        <div className="mb-1 text-xs text-gray-500">Quantity</div>
                                        <span className="font-mono text-sm font-bold text-blue-600">
                                            <ValueDisplay value={assetPnlRow.quantity} options={{ maxDecimals: 4 }} />
                                        </span>
                                    </div>
                                );
                            })()}

                            {/* Per-account rows */}
                            {accountBreakdown && accountBreakdown.length > 0 ? (
                                <div className="mb-2 flex flex-col gap-1">
                                    {[...accountBreakdown]
                                        .sort((a, b) => Math.abs(b.qty) - Math.abs(a.qty))
                                        .map((acct) => {
                                            const acctLiveQtyRaw = liveAccountBalances?.get(acct.account_id);
                                            const acctFetched = liveFetchedAccountIds?.has(acct.account_id) ?? false;
                                            const acctErrors = liveAccountErrors?.get(acct.account_id);
                                            // If account was fetched but has no entry for this symbol → confirmed 0
                                            const acctLiveQty = acctLiveQtyRaw ?? (acctFetched ? 0 : undefined);
                                            const acctColor = getAccountColor(acct.account_id);
                                            const acctDelta = computeDelta(acct.qty, acctLiveQty);
                                            let deltaNode: React.ReactNode = <DeltaBar delta={null} size="xs" />;

                                            if (acctErrors && acctErrors.length > 0 && acctLiveQtyRaw == null) {
                                                // Connector error — no live data for this account
                                                deltaNode = (
                                                    <Tooltip
                                                        content={
                                                            <div className="text-xs">
                                                                <div className="mb-1 font-medium">Fetch error:</div>
                                                                {acctErrors.map((err, i) => <div key={i}>{err}</div>)}
                                                            </div>
                                                        }
                                                        openDelay={200}
                                                    >
                                                        <span className="cursor-help text-xs text-red-500">⚠ err</span>
                                                    </Tooltip>
                                                );
                                            } else if (acctLiveQty != null) {
                                                deltaNode = (
                                                    <DeltaBar delta={acctDelta} liveQty={acctLiveQty} pnlQty={acct.qty} size="xs" />
                                                );
                                            }

                                            return (
                                                <div key={acct.account_id} className="bg-gray-50 px-1.5 py-1">
                                                    <div className="mb-0.5 flex items-center gap-1">
                                                        <span
                                                            className="h-1.5 w-1.5 shrink-0 rounded-full"
                                                            style={{ backgroundColor: acctColor }}
                                                        />
                                                        <span
                                                            className="max-w-[120px] cursor-pointer truncate text-[10px] font-medium hover:text-blue-600 hover:underline"
                                                            title={acct.account_name}
                                                            onClick={() => {
                                                                setTxAccountFilter(acct.account_id);
                                                                setActiveTab('transactions');
                                                            }}
                                                        >
                                                            {acct.account_name}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-mono text-xs"><ValueDisplay value={acct.qty} options={{ maxDecimals: 4 }} /></span>
                                                        {deltaNode}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                </div>
                            ) : (
                                <div className="py-2 text-center text-xs text-gray-400">
                                    {liveBalanceLoading ? 'Loading...' : 'No account breakdown available'}
                                </div>
                            )}

                            {/* Divider between balance rows and monetary metrics */}
                            <div className="my-2 border-t border-gray-200" />

                            <div className="flex flex-col gap-2">
                                <MetricCard
                                    label="Market Value"
                                    value={formatQuantityWithCurrency(assetPnlRow.market_value, baseCurrency)}
                                    subValue={assetPnlRow.unit_value != null ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_value, baseCurrency)}/unit` : undefined}
                                    color="blue"
                                />
                                <MetricCard
                                    label="Cost Basis"
                                    value={formatQuantityWithCurrency(assetPnlRow.cost_basis, baseCurrency)}
                                    subValue={assetPnlRow.unit_cost != null && assetPnlRow.unit_cost > 0 ? `@ ${formatQuantityWithCurrency(assetPnlRow.unit_cost, baseCurrency)}/unit` : undefined}
                                />
                            </div>

                            <div className="mb-3 mt-4 text-sm font-bold text-gray-600">
                                P&L Summary
                            </div>
                            <div className="flex flex-col gap-2">
                                <MetricCard
                                    label="Unrealized P&L"
                                    value={formatQuantityWithCurrency(assetPnlRow.unrealized_pnl, baseCurrency)}
                                    subValue={unrealizedPct}
                                    color={unrealizedColor}
                                    icon={assetPnlRow.unrealized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Realized P&L"
                                    value={formatQuantityWithCurrency(assetPnlRow.realized_pnl, baseCurrency)}
                                    subValue={assetPnlRow.taxable_realized_pnl ? `Taxable: ${formatQuantityWithCurrency(assetPnlRow.taxable_realized_pnl, baseCurrency)}` : undefined}
                                    color={realizedColor}
                                    icon={assetPnlRow.realized_pnl >= 0 ?
                                        <FiTrendingUp color="green" size={14} /> :
                                        <FiTrendingDown color="red" size={14} />
                                    }
                                />
                                <MetricCard
                                    label="Total Fees"
                                    value={formatQuantityWithCurrency(assetPnlRow.total_fees, baseCurrency)}
                                    color="orange"
                                />
                            </div>

                            <div className="mb-3 mt-4 text-sm font-bold text-gray-600">
                                Activity
                            </div>
                            <div className="flex flex-col gap-2">
                                <div className="bg-gray-50 p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-gray-500">Cost Lots</span>
                                        <Badge colorScheme="blue">{assetPnlRow.lot_count}</Badge>
                                    </div>
                                </div>
                                <div className="bg-gray-50 p-3">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-gray-500">Realized Events</span>
                                        <Badge colorScheme="green">{assetPnlRow.realized_event_count}</Badge>
                                    </div>
                                </div>
                                {assetPnlRow.warning_count > 0 && (
                                    <div className="bg-orange-50 p-3">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-orange-600">Warnings</span>
                                            <Badge colorScheme="orange">{assetPnlRow.warning_count}</Badge>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Main Area - Tabs */}
                <div className="min-w-0 overflow-hidden">
                    <div className="border border-gray-200 bg-white">
                        <Tabs
                            value={activeTab}
                            onValueChange={(v) => setActiveTab(v as 'units' | 'events' | 'timeline' | 'transactions')}
                        >
                            <TabsList className="px-4 pt-2">
                                <TabsTrigger value="units">
                                    Calculation Units
                                    {!unitsLoading && (
                                        <Badge colorScheme="purple" className="ml-2">
                                            {calculationUnits.length}
                                        </Badge>
                                    )}
                                </TabsTrigger>
                                <TabsTrigger value="events">
                                    Cost Lot Events
                                    {eventsLoaded && (
                                        <Badge colorScheme="blue" className="ml-2">
                                            {lotEvents.length}
                                        </Badge>
                                    )}
                                </TabsTrigger>
                                <TabsTrigger value="timeline">
                                    Balance Timeline
                                </TabsTrigger>
                                <TabsTrigger value="transactions">
                                    Transactions
                                </TabsTrigger>
                            </TabsList>

                            <TabsContent value="units">
                                {unitsLoading ? (
                                    <LoadingPlaceholder label="Calculation Units" />
                                ) : (
                                    <UnitsTab
                                        units={calculationUnits}
                                        baseCurrency={baseCurrency}
                                        costLots={costLots}
                                        versionId={versionId}
                                        onTransactionClick={onTransactionClick}
                                    />
                                )}
                            </TabsContent>

                            <TabsContent value="events">
                                <CostLotEventsTab
                                    versionId={versionId}
                                    baseCurrency={baseCurrency}
                                    onTransactionClick={onTransactionClick}
                                    assetId={assetPnlRow.asset.id ?? undefined}
                                />
                            </TabsContent>

                            <TabsContent value="timeline" className="p-4">
                                {!eventsLoaded ? (
                                    <LoadingPlaceholder label="Balance Timeline" />
                                ) : (
                                    <div>
                                        <div className="mb-4 flex justify-end">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setTimelineViewMode(timelineViewMode === 'by-account' ? 'total' : 'by-account')}
                                            >
                                                View: {timelineViewMode === 'by-account' ? 'By Account' : 'Total'}
                                            </Button>
                                        </div>
                                        <BalanceTimelineChart
                                            events={lotEvents}
                                            baseCurrency={baseCurrency}
                                            viewMode={timelineViewMode}
                                            assetSymbol={assetPnlRow.asset.symbol || 'Unknown'}
                                        />
                                    </div>
                                )}
                            </TabsContent>

                            <TabsContent value="transactions">
                                <AssetTransactionsTab
                                    versionId={versionId}
                                    assetId={assetPnlRow.asset.id!}
                                    accountId={txAccountFilter}
                                    onTransactionClick={onTransactionClick}
                                />
                            </TabsContent>
                        </Tabs>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AssetDetailView;
