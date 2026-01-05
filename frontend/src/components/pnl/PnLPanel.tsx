/**
 * P&L Panel (Redesigned)
 * 
 * Main P&L view following design principles:
 * - Principle 1: Results first, details on demand
 * - Principle 2: Groups are primary, legs are secondary
 * - Principle 3: Everything must be traceable
 * 
 * Flow:
 * 1. User opens P&L
 * 2. Reviews global numbers (Summary Cards)
 * 3. Notices warning or surprising P&L
 * 4. Clicks asset → realized P&L row
 * 5. Opens P&L Impact Panel
 * 6. Sees: Which lots, Which fees, Why taxable
 * 7. Goes to Group or Transaction view
 * 8. Fixes data or overrides taxability
 * 9. Returns to P&L
 * 10. Recomputes → preview
 * 11. Saves new version
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Badge, Box, Button, Flex, Heading, Switch, Tabs, Text } from '@chakra-ui/react';
import { FiLayers, FiSave, FiRefreshCw, FiEyeOff, FiEye } from 'react-icons/fi';
import { useBaseCurrency } from '../BaseCurrencySelector';
import { Account, API_URL, PnLPreviewResponse, PricesResponse, PriceResponse, DimensionWithCategories } from '../../types';
import type { BalanceEntry } from '../../types';
import { toaster } from '../ui/toaster';
import { PnLVersionResponse, VersionListItem, AggregatedBalanceItem } from './types';

// P&L Components
import { CalculationContext, CalculationMode } from './CalculationContext';
import { SummaryCards, SummaryBar } from './SummaryCards';
import { AssetPnLTable } from './AssetPnLTable';
import AssetDetailView from './AssetDetailView';
import { PnLImpactPanel } from './PnLImpactPanel';
import { PnLAuditView } from './DataExplorerPanel';
import { CategoryFilterBar } from './CategoryFilterBar';
import { MarketValuePieChart } from './MarketValuePieChart';

// Types
import {
    CalculationConfig,
    CalculationStatus,
    PnLSummary,
    AssetPnLRow,
    CostLot,
    RealizedPnLRow,
    PnLImpactEvent,
    FeeEntry,
    FeeSummary,
    PnLWarningItem,
    PnLView,
    CalculationUnit,
    BundleSummary,
    TransactionSummary,
    Settlement,
    ConsumedSliceDetail,
    CostLotEventEntry,
} from './types';

export const PnLPanel: React.FC = () => {

    // Base currency from settings
    const { baseCurrency, baseCurrencyId } = useBaseCurrency();

    // Read account_ids from URL on init (for shareable links)
    const getInitialAccountIds = (): number[] => {
        const params = new URLSearchParams(window.location.search);
        const urlAccounts = params.get('accounts');
        if (urlAccounts) {
            const ids = urlAccounts.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) return ids;
        }
        return [];
    };

    // Calculation state
    const [status, setStatus] = useState<CalculationStatus>('idle');
    const [config, setConfig] = useState<CalculationConfig>({
        lot_method: 'FIFO',
        lot_mode: 'LOT_TRAVEL',
        base_currency_symbol: baseCurrency,
        base_currency_id: baseCurrencyId,
        residual_tolerance_pct: 0.05,
        allow_negative_balances: false,
        account_ids: getInitialAccountIds(),
    });
    const [isCalculating, setIsCalculating] = useState(false);
    const [isPersisting, setIsPersisting] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Version management (Option D: CQRS-Lite)
    const [currentVersionId, setCurrentVersionId] = useState<number | null>(null);
    const [currentVersionStatus, setCurrentVersionStatus] = useState<'draft' | 'committed' | null>(null);
    const [availableVersions, setAvailableVersions] = useState<VersionListItem[]>([]);
    const [isLoadingVersions, setIsLoadingVersions] = useState(false);

    // Calculation mode: 'load' existing version OR 'new' calculation
    const [calculationMode, setCalculationMode] = useState<CalculationMode>('new');

    // Update config when base currency changes
    useEffect(() => {
        setConfig(prev => ({ ...prev, base_currency_symbol: baseCurrency, base_currency_id: baseCurrencyId }));
    }, [baseCurrency, baseCurrencyId]);

    // Display filter: show/hide unsettled negative lots (e.g., base currency debt)
    const [showUnsettledNegative, setShowUnsettledNegative] = useState(false);
    const [totalUnsettledNegativeCount, setTotalUnsettledNegativeCount] = useState(0);

    // Category filter state (post-calculation display filter)
    const [selectedCategoryIds, setSelectedCategoryIds] = useState<number[]>([]);
    const [dimensions, setDimensions] = useState<DimensionWithCategories[]>([]);
    const [isLoadingCategories, setIsLoadingCategories] = useState(false);

    // Account data for filter (account_ids is in config)
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);

    // Update URL when account filter changes (for shareable links)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (config.account_ids && config.account_ids.length > 0) {
            params.set('accounts', config.account_ids.join(','));
        } else {
            params.delete('accounts');
        }
        const newUrl = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
    }, [config.account_ids]);

    // Fetch accounts on mount
    useEffect(() => {
        const fetchAccounts = async () => {
            setIsLoadingAccounts(true);
            try {
                const response = await fetch(`${API_URL}/accounts/`);
                if (response.ok) {
                    const data: Account[] = await response.json();
                    setAccounts(data);
                }
            } catch (err) {
                console.error('Failed to fetch accounts:', err);
            } finally {
                setIsLoadingAccounts(false);
            }
        };
        fetchAccounts();
    }, []);

    // Fetch categories on mount (for filter bar)
    useEffect(() => {
        const fetchCategories = async () => {
            setIsLoadingCategories(true);
            try {
                const response = await fetch(`${API_URL}/categories/by-dimension`);
                if (response.ok) {
                    const data: DimensionWithCategories[] = await response.json();
                    setDimensions(data);
                }
            } catch (err) {
                console.error('Failed to fetch categories:', err);
            } finally {
                setIsLoadingCategories(false);
            }
        };
        fetchCategories();
    }, []);

    // Read category_ids from URL on init (for shareable links)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const urlCategories = params.get('categories');
        if (urlCategories) {
            const ids = urlCategories.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
            if (ids.length > 0) setSelectedCategoryIds(ids);
        }
    }, []);

    // Update URL when category filter changes (for shareable links)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (selectedCategoryIds.length > 0) {
            params.set('categories', selectedCategoryIds.join(','));
        } else {
            params.delete('categories');
        }
        const newUrl = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
    }, [selectedCategoryIds]);

    // Result data
    const [summary, setSummary] = useState<PnLSummary | null>(null);
    const [assets, setAssets] = useState<AssetPnLRow[]>([]);

    // Category filter: filter assets client-side by selected categories
    // An asset matches if it has at least one category_id in selectedCategoryIds
    const filteredAssets = useMemo(() => {
        if (selectedCategoryIds.length === 0) return assets;
        return assets.filter(asset =>
            asset.category_ids.some(catId => selectedCategoryIds.includes(catId))
        );
    }, [assets, selectedCategoryIds]);

    // Recompute summary from filtered assets
    const filteredSummary = useMemo((): PnLSummary | null => {
        if (!summary) return null;
        if (selectedCategoryIds.length === 0) return summary;

        // Recompute totals from filtered assets
        const totalPortfolioValue = filteredAssets.reduce((sum, a) => sum + a.cost_basis, 0);
        const totalUnrealizedPnL = filteredAssets.reduce((sum, a) => sum + a.unrealized_pnl, 0);
        const totalRealizedPnL = filteredAssets.reduce((sum, a) => sum + a.realized_pnl, 0);
        const totalFees = filteredAssets.reduce((sum, a) => sum + a.total_fees, 0);
        const warningCount = filteredAssets.reduce((sum, a) => sum + a.warning_count, 0);
        const lotsCount = filteredAssets.reduce((sum, a) => sum + a.lot_count, 0);
        const realizedEventCount = filteredAssets.reduce((sum, a) => sum + a.realized_event_count, 0);

        return {
            ...summary,
            total_portfolio_value: totalPortfolioValue,
            total_unrealized_pnl: totalUnrealizedPnL,
            total_realized_pnl: totalRealizedPnL,
            total_fees: totalFees,
            warning_count: warningCount,
            lots_created_count: lotsCount,
            consumed_slices_count: realizedEventCount,
        };
    }, [summary, filteredAssets, selectedCategoryIds]);

    // Compute available category IDs (categories that have assets in current results)
    const availableCategoryIds = useMemo(() => {
        const ids = new Set<number>();
        assets.forEach(asset => {
            asset.category_ids.forEach(catId => ids.add(catId));
        });
        return ids;
    }, [assets]);

    // Handler for pie chart category click - toggles category filter
    const handlePieCategoryClick = useCallback((categoryId: number | null) => {
        if (categoryId === null) {
            // Clicking "Uncategorized" clears all filters to show uncategorized assets
            // Or we could show only uncategorized - for now, clear filter
            setSelectedCategoryIds([]);
        } else {
            // Toggle the category in selection
            setSelectedCategoryIds(prev => {
                if (prev.includes(categoryId)) {
                    // Remove if already selected
                    return prev.filter(id => id !== categoryId);
                } else {
                    // Add to selection (allows multi-select)
                    return [...prev, categoryId];
                }
            });
        }
    }, []);

    // View state
    const [currentView, setCurrentView] = useState<PnLView>('summary');
    const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
    const [selectedAsset, setSelectedAsset] = useState<AssetPnLRow | null>(null);
    const [assetLots, setAssetLots] = useState<CostLot[]>([]);
    const [assetRealizedEntries, setAssetRealizedEntries] = useState<RealizedPnLRow[]>([]);

    // Panel state
    const [showImpactPanel, setShowImpactPanel] = useState(false);
    const [impactEvent, setImpactEvent] = useState<PnLImpactEvent | null>(null);

    // Main view tab state: 'assets' or 'audit'
    const [mainTab, setMainTab] = useState<'assets' | 'audit'>('assets');

    // Audit sub-tab state: which tab to show inside P&L Audit view
    const [auditSubTab, setAuditSubTab] = useState<'units' | 'lots' | 'realized' | 'fees' | 'warnings' | 'events'>('units');

    // Fees and warnings data
    const [fees, setFees] = useState<FeeEntry[]>([]);
    const [feeSummary, setFeeSummary] = useState<FeeSummary>({
        total_fees_in_base: 0,
        fees_by_asset: {},
        fees_by_source: {},
        disposal_taxable_fee_count: 0,
    });
    const [warnings, setWarnings] = useState<PnLWarningItem[]>([]);

    // Data explorer data - all cost lots and realized P&L from calculation
    const [allCostLots, setAllCostLots] = useState<CostLot[]>([]);
    const [allConsumedSlices, setAllConsumedSlices] = useState<ConsumedSliceDetail[]>([]);
    const [allRealizedPnL, setAllRealizedPnL] = useState<RealizedPnLRow[]>([]);
    const [allSettlements, setAllSettlements] = useState<Settlement[]>([]);
    const [allLotEvents, setAllLotEvents] = useState<CostLotEventEntry[]>([]);

    // Per-tab loading states for lazy loading
    const [isLoadingUnits, setIsLoadingUnits] = useState(false);
    const [isLoadingLots, setIsLoadingLots] = useState(false);
    const [isLoadingRealized, setIsLoadingRealized] = useState(false);
    const [isLoadingFees, setIsLoadingFees] = useState(false);
    const [isLoadingWarnings, setIsLoadingWarnings] = useState(false);
    const [isLoadingEvents, setIsLoadingEvents] = useState(false);
    const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set());

    // ID arrays for tab title counts (from calculation result, before data loads)
    const [idCounts, setIdCounts] = useState<{
        unitCount: number;
        lotCount: number;
        consumedCount: number;
        realizedCount: number;
        feeCount: number;
        warningCount: number;
        settlementCount: number;
        eventCount: number;
    }>({ unitCount: 0, lotCount: 0, consumedCount: 0, realizedCount: 0, feeCount: 0, warningCount: 0, settlementCount: 0, eventCount: 0 });

    // Data explorer data
    const [calculationUnits, setCalculationUnits] = useState<CalculationUnit[]>([]);
    const [bundles, setBundles] = useState<BundleSummary[]>([]);
    const [transactions, setTransactions] = useState<TransactionSummary[]>([]);

    // --- Price Refresh State ---
    const [prices, setPrices] = useState<PriceResponse[]>([]);
    const [isRefreshingPrices, setIsRefreshingPrices] = useState(false);
    const [lastPriceRefresh, setLastPriceRefresh] = useState<Date | null>(null);
    const [isLoadingBalances, setIsLoadingBalances] = useState(false);

    // Config change handler
    const handleConfigChange = useCallback((partial: Partial<CalculationConfig>) => {
        setConfig(prev => ({ ...prev, ...partial }));
    }, []);

    // Mode change handler - switching between 'load' and 'new' modes
    const handleModeChange = useCallback((newMode: CalculationMode) => {
        setCalculationMode(newMode);
        // When switching to 'new', clear selected version
        if (newMode === 'new' && currentVersionId) {
            // Don't clear the loaded data, just switch modes
        }
    }, [currentVersionId]);

    // Load aggregated balances from dedicated endpoint (group_by_asset=true)
    // Returns balance data with realized P&L per asset
    // includeUnsettledNegative controls whether unsettled negative lots are included
    const loadBalances = useCallback(async (versionId: number, includeUnsettledNegative: boolean = false): Promise<AggregatedBalanceItem[]> => {
        setIsLoadingBalances(true);
        try {
            const params = new URLSearchParams({
                group_by_asset: 'true',
                include_unsettled_negative: includeUnsettledNegative.toString(),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`);
            if (!response.ok) {
                throw new Error('Failed to load balances');
            }
            const balances: AggregatedBalanceItem[] = await response.json();
            console.log('Loaded aggregated balances:', balances.length, 'includeUnsettledNegative:', includeUnsettledNegative);

            // Track total unsettled negative count across all assets
            const totalUnsettled = balances.reduce((sum, b) => sum + (b.unsettled_negative_count || 0), 0);
            setTotalUnsettledNegativeCount(totalUnsettled);

            return balances;
        } catch (err) {
            console.error('Failed to load balances:', err);
            toaster.error({
                title: 'Balance Load Failed',
                description: err instanceof Error ? err.message : 'Failed to load balances',
            });
            return [];
        } finally {
            setIsLoadingBalances(false);
        }
    }, []);

    // Transform aggregated balances to AssetPnLRow array
    const transformBalances = useCallback((balances: AggregatedBalanceItem[]): AssetPnLRow[] => {
        return balances.map((balance) => ({
            asset_id: balance.asset.id,
            asset_symbol: balance.asset.name,
            account_ids: balance.account_ids || [],  // All accounts holding this asset
            category_ids: balance.category_ids || [],  // All categories assigned to this asset
            quantity: balance.qty,
            market_value: 0, // Updated by prices
            cost_basis: balance.cost_basis_in_base,
            unit_cost: balance.avg_unit_cost_in_base,  // Average cost per unit from lots
            unrealized_pnl: 0, // Updated by prices
            unrealized_pnl_pct: 0, // Updated by prices
            realized_pnl: balance.realized_pnl_in_base,
            total_fees: balance.total_fees_in_base ?? 0,  // Use API-provided fee cost
            lot_count: balance.lot_count,
            realized_event_count: balance.realized_event_count,
            warning_count: balance.warning_count,
        }));
    }, []);

    // Reload balances when unsettled negative filter changes
    // Preserves price data and recalculates metrics
    useEffect(() => {
        if (currentVersionId) {
            // Re-fetch balances with new filter setting
            loadBalances(currentVersionId, showUnsettledNegative).then(balances => {
                const assetRows = transformBalances(balances);

                // Build full price map with metadata
                const fullPriceMap = new Map<number, PriceResponse>();
                for (const p of prices) {
                    if (p.asset.id !== undefined) {
                        fullPriceMap.set(p.asset.id, p);
                    }
                }

                // Apply prices to new asset rows
                const assetsWithPrices = assetRows.map(asset => {
                    const priceObj = fullPriceMap.get(asset.asset_id);
                    if (!priceObj || priceObj.price == null) {
                        return {
                            ...asset,
                            unit_value: null,
                            price_source: priceObj?.source,
                            price_fetched_at: priceObj?.fetched_at,
                            price_error: priceObj?.error,
                        };
                    }
                    const marketValue = asset.quantity * priceObj.price;
                    const unrealizedPnl = marketValue - asset.cost_basis;
                    const unrealizedPnlPct = asset.cost_basis > 0 ? unrealizedPnl / asset.cost_basis : 0;
                    return {
                        ...asset,
                        market_value: marketValue,
                        unrealized_pnl: unrealizedPnl,
                        unrealized_pnl_pct: unrealizedPnlPct,
                        unit_value: priceObj.price,
                        price_source: priceObj.source,
                        price_fetched_at: priceObj.fetched_at,
                        price_error: priceObj.error,
                    };
                });

                setAssets(assetsWithPrices);

                // Recalculate summary metrics
                const totalUnrealized = assetsWithPrices.reduce((sum, a) => sum + (a.unrealized_pnl || 0), 0);
                const totalMarketValue = assetsWithPrices.reduce((sum, a) => sum + (a.market_value || 0), 0);
                const totalCostBasis = assetsWithPrices.reduce((sum, a) => sum + a.cost_basis, 0);

                setSummary(prev => {
                    if (!prev) return prev;
                    return {
                        ...prev,
                        total_unrealized_pnl: totalUnrealized,
                        total_portfolio_value: totalMarketValue > 0 ? totalMarketValue : totalCostBasis,
                    };
                });
            });
        }
    }, [showUnsettledNegative, currentVersionId, loadBalances, transformBalances, prices]);

    // Fetch prices for all assets in balances
    const fetchPrices = useCallback(async (balances: BalanceEntry[], baseCurrency: string) => {
        if (!balances || balances.length === 0) return;
        setIsRefreshingPrices(true);
        try {
            // Extract asset IDs from AssetRef
            const assetIds = balances.map(b => b.asset.id).filter((id): id is number => id !== undefined);
            if (assetIds.length === 0) return;

            const response = await fetch(`${API_URL}/pnl/prices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_ids: assetIds, base_currency: baseCurrency }),
            });
            if (!response.ok) {
                throw new Error('Failed to fetch prices');
            }
            const data: PricesResponse = await response.json();
            setPrices(data.prices);
            setLastPriceRefresh(new Date());

            // Show warning only if some prices are missing
            const missing = data.prices.filter(p => p.price == null);
            if (missing.length > 0) {
                const found = data.prices.filter(p => p.price != null);
                const missingSymbols = missing.map(p => p.asset.name).join(', ');

                toaster.create({
                    title: `Prices: ${found.length} found, ${missing.length} missing`,
                    description: `Missing: ${missingSymbols}`,
                    type: 'warning',
                    duration: 8000,
                });
            }
        } catch (err) {
            toaster.create({
                title: 'Price Refresh Failed',
                description: 'Failed to refresh prices',
                type: 'error',
                duration: 5000,
            });
        } finally {
            setIsRefreshingPrices(false);
        }
    }, []);

    // Transform API response to our types (non-balance data only)
    // Assets are now built separately from loadBalances + transformBalances
    // Transform summary data to build summary and set assets
    // Note: Full data (units, lots, realized, warnings, settlements) are loaded on-demand via lazy loaders
    type SummaryData = {
        total_realized_pnl: number;
        total_fees_in_base?: number;
        fee_entry_count?: number;
        unit_ids?: number[];
        cost_lot_ids?: number[];
        consumed_slice_ids?: number[];
        warning_ids?: number[];
    };

    const transformResult = useCallback((result: SummaryData, assetRows: AssetPnLRow[]) => {
        // Compute portfolio value from asset rows
        const totalPortfolioValue = assetRows.reduce((sum, a) => sum + a.cost_basis, 0);
        const totalUnrealizedPnL = assetRows.reduce((sum, a) => sum + a.unrealized_pnl, 0);

        // Use server-provided fee summary (from calculation preview) for immediate display
        // Fall back to summing from assets if not available (for older API responses)
        const totalFees = result.total_fees_in_base ?? assetRows.reduce((sum, a) => sum + a.total_fees, 0);
        const feeEntryCount = result.fee_entry_count ?? 0;

        // Derive counts from ID arrays (provided by runCalculation/loadVersionById)
        const newSummary: PnLSummary = {
            total_portfolio_value: totalPortfolioValue,
            total_unrealized_pnl: totalUnrealizedPnL,
            total_realized_pnl: result.total_realized_pnl,
            total_fees: totalFees,
            fee_entry_count: feeEntryCount,
            // Counts from ID arrays - lazy loaders fetch full data on-demand
            warning_count: result.warning_ids?.length ?? 0,
            error_count: 0,  // Updated when warnings are loaded
            taxable_realized_pnl: 0,  // Updated when realized P&L is loaded
            non_taxable_realized_pnl: 0,  // Updated when realized P&L is loaded
            units_count: result.unit_ids?.length ?? 0,
            lots_created_count: result.cost_lot_ids?.length ?? 0,
            consumed_slices_count: result.consumed_slice_ids?.length ?? 0,
        };
        setSummary(newSummary);

        // Set assets from pre-built rows (built from balances endpoint)
        setAssets(assetRows);
    }, []);

    // Fetch fees from dedicated endpoint when FeesPanel is opened
    const fetchFees = useCallback(async (versionId: number) => {
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/fees`);
            if (!response.ok) {
                throw new Error('Failed to fetch fees');
            }
            const data = await response.json();

            // Map API response to FeeEntry interface
            const feeEntries: FeeEntry[] = data.fees.map((f: any) => ({
                id: String(f.id),
                date: f.date,
                asset_id: f.asset_id,
                asset_symbol: f.asset_symbol,
                fee_amount: f.fee_amount,
                fee_in_base: f.fee_in_base,
                transaction_id: f.transaction_id,
                unit_id: f.unit_id,
                source: f.source || 'unknown',
                transaction_type: f.transaction_type || 'unknown',
                cost_basis_consumed: f.cost_basis_consumed,
                realized_pnl: f.realized_pnl,
                related_asset_id: f.related_asset_id,
                related_asset_symbol: f.related_asset_symbol,
            }));

            setFees(feeEntries);
            setFeeSummary(data.summary);
        } catch (err) {
            console.error('Failed to fetch fees:', err);
            toaster.error({
                title: 'Failed to load fees',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        }
    }, []);
    // Calculate P&L using Option D workflow with lazy loading:
    // 1. POST /calculate → get version_id + summary
    // 2. Fetch only summary + balances initially
    // 3. Load other data on-demand when user navigates to views
    const runCalculation = useCallback(async () => {
        setIsCalculating(true);
        setError(null);
        setStatus('calculating');

        try {
            // Step 1: Calculate and persist as draft
            // Pass all config including account_ids filter
            const requestBody: Record<string, unknown> = {
                lot_method: config.lot_method,
                lot_mode: config.lot_mode,
                base_currency_id: config.base_currency_id,
                base_currency_symbol: config.base_currency_symbol,
                residual_tolerance_pct: config.residual_tolerance_pct,
                allow_negative_balances: config.allow_negative_balances,
            };

            // Only pass account_ids if filter is active (non-empty selection)
            if (config.account_ids && config.account_ids.length > 0) {
                requestBody.account_ids = config.account_ids;
            }

            const calcResponse = await fetch(`${API_URL}/pnl/calculate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
            });

            if (!calcResponse.ok) {
                const errorData = await calcResponse.json();
                throw new Error(errorData.detail || 'Failed to calculate P&L');
            }

            const calcResult: PnLVersionResponse = await calcResponse.json();
            const versionId = calcResult.version_id;

            console.log('P&L Calculation Result:', {
                version_id: versionId,
                status: calcResult.status,
                total_realized_pnl: calcResult.total_realized_pnl,
                unit_count: calcResult.unit_ids.length,
                lot_count: calcResult.cost_lot_ids.length,
            });

            // Store version info
            setCurrentVersionId(versionId);
            setCurrentVersionStatus(calcResult.status === 'draft' ? 'draft' : 'committed');

            // Store ID counts for tab titles (derived from ID array lengths)
            setIdCounts({
                unitCount: calcResult.unit_ids.length,
                lotCount: calcResult.cost_lot_ids.length,
                consumedCount: calcResult.consumed_slice_ids.length,
                realizedCount: calcResult.realized_pnl_ids.length,
                feeCount: calcResult.fee_entry_count ?? 0,
                warningCount: calcResult.warning_ids.length,
                settlementCount: calcResult.settlement_ids.length,
                eventCount: calcResult.cost_lot_event_ids?.length ?? 0,
            });

            // Reset loaded tabs tracker for fresh calculation
            setLoadedTabs(new Set());

            // Step 2: Load balances from dedicated endpoint (group_by_asset=true)
            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            // Build summary data for transformResult
            // Full data (lots, realized-pnl, units, settlements, warnings) loaded on-demand via lazy loaders
            const summaryData = {
                total_realized_pnl: calcResult.total_realized_pnl,
                total_fees_in_base: calcResult.total_fees_in_base ?? 0,
                fee_entry_count: calcResult.fee_entry_count ?? 0,
                unit_ids: calcResult.unit_ids,
                cost_lot_ids: calcResult.cost_lot_ids,
                consumed_slice_ids: calcResult.consumed_slice_ids,
                warning_ids: calcResult.warning_ids,
            };

            // Debug log
            console.log('Initial P&L Data Loaded:', {
                api_total_realized_pnl: summaryData.total_realized_pnl,
                asset_count: assetRows.length,
            });

            transformResult(summaryData, assetRows);
            setStatus('preview');
            setCurrentView('assets');

            // Step 3: Refresh prices for the loaded assets
            if (assetRows.length > 0) {
                const balanceEntries: BalanceEntry[] = balances.map(b => ({
                    asset: b.asset,
                    qty: b.qty,
                    cost_basis_in_base: b.cost_basis_in_base,
                    avg_unit_cost_in_base: b.avg_unit_cost_in_base,
                    lot_count: b.lot_count,
                }));
                fetchPrices(balanceEntries, config.base_currency_symbol);
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown error');
            setStatus('error');
        } finally {
            setIsCalculating(false);
        }
    }, [config, transformResult, loadBalances, transformBalances, fetchPrices]);

    // Independent loader: Load calculation units only
    const loadUnits = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('units')) {
            return; // Already loaded
        }

        setIsLoadingUnits(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/units`);
            const units = await response.json();

            // Store calculation units with complete nested data from API
            const mappedUnits = units.map((u: any, idx: number) => {
                const primaryAsset = u.outflows?.[0]?.asset || u.inflows?.[0]?.asset || { id: 0, name: '?' };
                const transactionIds = new Set<number>();
                [...(u.outflows || []), ...(u.inflows || []), ...(u.fees || [])].forEach(leg => {
                    transactionIds.add(leg.transaction_id);
                });

                return {
                    unit_id: u.unit_id ?? idx,
                    unit_label: u.unit_label || '',
                    pattern: u.pattern || 'unknown',
                    date: u.timestamp,
                    asset_id: primaryAsset.id,
                    asset_symbol: primaryAsset.name,
                    transaction_ids: Array.from(transactionIds),
                    outflow_asset_ids: u.outflows?.map((leg: any) => leg.asset.id) || [],
                    inflow_asset_ids: u.inflows?.map((leg: any) => leg.asset.id) || [],
                    fee_asset_ids: u.fees?.map((leg: any) => leg.asset.id) || [],
                    outflow_asset_symbols: u.outflows?.map((leg: any) => leg.asset.name) || [],
                    inflow_asset_symbols: u.inflows?.map((leg: any) => leg.asset.name) || [],
                    fee_asset_symbols: u.fees?.map((leg: any) => leg.asset.name) || [],
                    lots_created_uuids: u.cost_basis?.lots?.map((lot: any) => lot.cost_lot_id) || [],
                    lots_consumed_uuids: u.cost_basis?.consumed?.map((slice: any) => slice.cost_lot_id) || [],
                    consumed_slices: u.cost_basis?.consumed || [],
                    settlements: u.cost_basis?.settlements || [],
                    realized_entries: u.realized_entries || [],
                    warnings: u.warnings || [],
                    realized_pnl_in_base: u.realized_pnl_in_base || 0,
                    is_disposal_taxable: u.is_disposal_taxable || false,
                    has_fees: u.has_fees || false,
                    fee_count: u.fee_count || 0,
                    total_fees_in_base: u.total_fees_in_base || 0,
                    event_ids: u.event_ids || [],
                    member_count: (u.outflows?.length || 0) + (u.inflows?.length || 0) + (u.fees?.length || 0),
                    lots_created_count: u.cost_basis?.lots?.length || 0,
                    lots_consumed_count: u.cost_basis?.consumed?.length || 0,
                    realized_entry_count: u.realized_entries?.length || 0,
                    warning_count: u.warnings?.length || 0,
                };
            });
            setCalculationUnits(mappedUnits);
            setLoadedTabs(prev => new Set(prev).add('units'));
            console.log('Loaded units:', mappedUnits.length);
        } catch (err) {
            console.error('Failed to load units:', err);
        } finally {
            setIsLoadingUnits(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Independent loader: Load lots, consumed slices, and settlements (lots tab needs all three)
    const loadLotsData = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('lots')) {
            return; // Already loaded
        }

        setIsLoadingLots(true);
        try {
            const [lotsResponse, consumedResponse, settlementsResponse] = await Promise.all([
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/lots`),
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/consumed-slices`),
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/settlements`),
            ]);

            const [lots, consumedSlices, settlements] = await Promise.all([
                lotsResponse.json(),
                consumedResponse.json(),
                settlementsResponse.json(),
            ]);

            // Store cost lots
            const allLots: CostLot[] = lots.map((lot: any) => ({
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
            }));
            setAllCostLots(allLots);

            // Store consumed slices
            const allConsumed: ConsumedSliceDetail[] = consumedSlices.map((s: any) => ({
                cost_lot_id: s.cost_lot_id,
                asset: s.asset,
                quantity: s.quantity,
                unit_cost_in_base: s.unit_cost_in_base,
                total_cost_in_base: s.total_cost_in_base,
                acquired_at: s.acquired_at,
                holding_period_days: s.holding_period_days,
                consumed_by_transaction_id: s.consumed_by_transaction_id,
                consumed_by_unit_label: s.consumed_by_unit_label,
                consumed_at: s.consumed_at,
            }));
            setAllConsumedSlices(allConsumed);

            // Store settlements
            const mappedSettlements: Settlement[] = settlements.map((s: any) => ({
                settlement_id: s.settlement_id,
                negative_lot_id: s.negative_lot_id,
                settling_lot_id: s.settling_lot_id,
                settling_transaction_id: s.settling_transaction_id,
                qty_settled: s.qty_settled,
                cost_basis_applied: s.cost_basis_applied,
                settled_at: s.settled_at,
            }));
            setAllSettlements(mappedSettlements);

            setLoadedTabs(prev => new Set(prev).add('lots'));
            console.log('Loaded lots data:', { lots: allLots.length, consumed: allConsumed.length, settlements: mappedSettlements.length });
        } catch (err) {
            console.error('Failed to load lots data:', err);
        } finally {
            setIsLoadingLots(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Independent loader: Load realized P&L only
    const loadRealizedPnL = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('realized')) {
            return; // Already loaded
        }

        setIsLoadingRealized(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/realized-pnl`);
            const realizedPnl = await response.json();

            const allRealized: RealizedPnLRow[] = realizedPnl.map((e: any, idx: number) => ({
                id: `rpnl-${idx}`,
                asset: e.asset,
                asset_id: e.asset.id,
                asset_symbol: e.asset.name,
                realized_at: e.realized_at,
                event_type: 'disposal' as const,
                qty: e.qty,
                proceeds_in_base: e.proceeds_in_base,
                cost_basis_in_base: e.cost_basis_in_base,
                pnl_in_base: e.pnl_in_base,
                pnl_pct: e.cost_basis_in_base > 0 ? e.pnl_in_base / e.cost_basis_in_base : 0,
                disposal_taxable: e.taxable,
                holding_period_days: e.holding_period_days,
                is_long_term: (e.holding_period_days || 0) >= 365,
                transaction_id: e.transaction_id,
                consumed_lot_count: 1,
                // Proceeds tracking metadata
                proceeds_source: e.proceeds_source,
                proceeds_price: e.proceeds_price,
                proceeds_price_source: e.proceeds_price_source,
                proceeds_price_timestamp: e.proceeds_price_timestamp,
            }));
            setAllRealizedPnL(allRealized);
            setLoadedTabs(prev => new Set(prev).add('realized'));
            console.log('Loaded realized P&L:', allRealized.length);
        } catch (err) {
            console.error('Failed to load realized P&L:', err);
        } finally {
            setIsLoadingRealized(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Independent loader: Load warnings only
    const loadWarnings = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('warnings')) {
            return; // Already loaded
        }

        setIsLoadingWarnings(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/warnings`);
            const warningsData = await response.json();
            setWarnings(warningsData);
            setLoadedTabs(prev => new Set(prev).add('warnings'));
            console.log('Loaded warnings:', warningsData.length);
        } catch (err) {
            console.error('Failed to load warnings:', err);
        } finally {
            setIsLoadingWarnings(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Independent loader: Load fees only
    const loadFees = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('fees')) {
            return; // Already loaded
        }

        setIsLoadingFees(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/fees`);
            const data = await response.json();

            // Map API response to FeeEntry interface (same as fetchFees)
            const feeEntries: FeeEntry[] = (data.fees || []).map((f: any) => ({
                id: String(f.id),
                date: f.date,
                asset_id: f.asset_id,
                asset_symbol: f.asset_symbol,
                fee_amount: f.fee_amount,
                fee_in_base: f.fee_in_base,
                transaction_id: f.transaction_id,
                unit_id: f.unit_id,
                source: f.source || 'unknown',
                transaction_type: f.transaction_type || 'unknown',
                cost_basis_consumed: f.cost_basis_consumed,
                realized_pnl: f.realized_pnl,
                related_asset_id: f.related_asset_id,
                related_asset_symbol: f.related_asset_symbol,
            }));

            setFees(feeEntries);
            setLoadedTabs(prev => new Set(prev).add('fees'));
            console.log('Loaded fees:', feeEntries.length);
        } catch (err) {
            console.error('Failed to load fees:', err);
        } finally {
            setIsLoadingFees(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Independent loader: Load lot events only
    const loadLotEvents = useCallback(async () => {
        if (!currentVersionId || loadedTabs.has('events')) {
            return; // Already loaded
        }

        setIsLoadingEvents(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/lot-events`);
            const eventsData = await response.json();
            setAllLotEvents(eventsData);
            setLoadedTabs(prev => new Set(prev).add('events'));
            console.log('Loaded lot events:', eventsData.length);
        } catch (err) {
            console.error('Failed to load lot events:', err);
        } finally {
            setIsLoadingEvents(false);
        }
    }, [currentVersionId, loadedTabs]);

    // Handle audit tab changes - load data for the selected tab
    const handleAuditTabChange = useCallback((tab: string) => {
        setAuditSubTab(tab as 'units' | 'lots' | 'realized' | 'fees' | 'warnings' | 'events');

        switch (tab) {
            case 'units':
                loadUnits();
                break;
            case 'lots':
                loadLotsData();
                break;
            case 'realized':
                loadRealizedPnL();
                break;
            case 'fees':
                loadFees();
                break;
            case 'warnings':
                loadWarnings();
                break;
            case 'events':
                loadLotEvents();
                break;
        }
    }, [loadUnits, loadLotsData, loadRealizedPnL, loadFees, loadWarnings, loadLotEvents]);

    // Fetch available versions from API
    const fetchAvailableVersions = useCallback(async () => {
        setIsLoadingVersions(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions?limit=50`);
            if (!response.ok) throw new Error('Failed to fetch versions');
            const versions: VersionListItem[] = await response.json();
            setAvailableVersions(versions);
        } catch (err) {
            console.error('Failed to fetch versions:', err);
        } finally {
            setIsLoadingVersions(false);
        }
    }, []);

    // Load versions on mount
    useEffect(() => {
        fetchAvailableVersions();
    }, [fetchAvailableVersions]);

    // Load a specific version by ID - resets all state and fetches fresh data
    const loadVersionById = useCallback(async (versionId: number) => {
        setIsCalculating(true);
        setError(null);

        try {
            // Reset all state
            setLoadedTabs(new Set());
            setCalculationUnits([]);
            setAllCostLots([]);
            setAllConsumedSlices([]);
            setAllRealizedPnL([]);
            setAllSettlements([]);
            setAllLotEvents([]);
            setWarnings([]);
            setPrices([]);
            setLastPriceRefresh(null);

            // Fetch version metadata
            const versionResponse = await fetch(`${API_URL}/pnl/versions/${versionId}`);
            if (!versionResponse.ok) throw new Error('Failed to fetch version');
            const versionData: PnLVersionResponse = await versionResponse.json();

            // Store version info
            setCurrentVersionId(versionId);
            setCurrentVersionStatus(versionData.status === 'draft' ? 'draft' : 'committed');

            // Update config from version
            setConfig(prev => ({
                ...prev,
                lot_method: versionData.lot_method as any,
                lot_mode: versionData.lot_mode as any,
                base_currency_id: versionData.base_currency_id ?? prev.base_currency_id,
                base_currency_symbol: versionData.base_currency_symbol ?? prev.base_currency_symbol,
            }));

            // Store ID counts (derive from arrays or use 0 for retrieval endpoints)
            setIdCounts({
                unitCount: versionData.unit_ids?.length ?? 0,
                lotCount: versionData.cost_lot_ids?.length ?? 0,
                consumedCount: versionData.consumed_slice_ids?.length ?? 0,
                realizedCount: versionData.realized_pnl_ids?.length ?? 0,
                feeCount: versionData.fee_entry_count ?? 0,
                warningCount: versionData.warning_ids?.length ?? 0,
                settlementCount: versionData.settlement_ids?.length ?? 0,
                eventCount: versionData.cost_lot_event_ids?.length ?? 0,
            });

            // Fetch balances from dedicated endpoint (group_by_asset=true)
            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            // Build summary data for transformResult
            // Full data (lots, realized-pnl, units, settlements, warnings) loaded on-demand via lazy loaders
            const summaryData = {
                total_realized_pnl: versionData.total_realized_pnl,
                total_fees_in_base: versionData.total_fees_in_base ?? 0,
                fee_entry_count: versionData.fee_entry_count ?? 0,
                unit_ids: versionData.unit_ids ?? [],
                cost_lot_ids: versionData.cost_lot_ids ?? [],
                consumed_slice_ids: versionData.consumed_slice_ids ?? [],
                warning_ids: versionData.warning_ids ?? [],
            };

            transformResult(summaryData, assetRows);
            setStatus(versionData.status === 'committed' ? 'persisted' : 'preview');
            setCurrentView('assets');

            // Refresh prices for the loaded assets
            if (assetRows.length > 0) {
                const balanceEntries: BalanceEntry[] = balances.map(b => ({
                    asset: b.asset,
                    qty: b.qty,
                    cost_basis_in_base: b.cost_basis_in_base,
                    avg_unit_cost_in_base: b.avg_unit_cost_in_base,
                    lot_count: b.lot_count,
                }));
                fetchPrices(balanceEntries, versionData.base_currency_symbol ?? config.base_currency_symbol);
            }

            toaster.success({
                title: 'Version Loaded',
                description: `Loaded version ${versionId} (${versionData.status})`,
            });
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load version');
            toaster.error({
                title: 'Load Failed',
                description: err instanceof Error ? err.message : 'Failed to load version',
            });
        } finally {
            setIsCalculating(false);
        }
    }, [transformResult, loadBalances, transformBalances, fetchPrices, config.base_currency_symbol]);

    // Commit (save) the current draft version
    const commitVersion = useCallback(async () => {
        if (!currentVersionId) return;

        setIsPersisting(true);
        try {
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/commit`, {
                method: 'POST',
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.detail || 'Failed to save P&L');
            }

            setCurrentVersionStatus('committed');
            setStatus('persisted');
            toaster.success({
                title: 'P&L Saved',
                description: `Version ${currentVersionId} has been saved.`,
            });

            // Refresh available versions list
            fetchAvailableVersions();
        } catch (err) {
            toaster.error({
                title: 'Save Failed',
                description: err instanceof Error ? err.message : 'Unknown error',
            });
        } finally {
            setIsPersisting(false);
        }
    }, [currentVersionId, fetchAvailableVersions]);

    // Asset click handler - load lots and realized P&L if not already loaded
    const handleAssetClick = useCallback(async (assetId: number) => {
        const asset = assets.find(a => a.asset_id === assetId);
        if (!asset) return;

        setSelectedAssetId(assetId);
        setSelectedAsset(asset);

        // Ensure lots data is loaded for asset detail view
        await loadLotsData();

        // Build cost lots from loaded data (uses allCostLots state)
        const lots: CostLot[] = allCostLots
            .filter(lot => lot.asset_id === assetId)
            .map((lot) => ({
                cost_lot_id: lot.cost_lot_id,
                asset: lot.asset,
                asset_id: lot.asset_id,
                asset_symbol: lot.asset_symbol,
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
                is_zero_cost: lot.is_zero_cost,
                is_negative: lot.is_negative,
                notes: lot.notes,
            }));
        setAssetLots(lots);

        // Build realized entries from loaded data (uses allRealizedPnL state)
        const realized: RealizedPnLRow[] = allRealizedPnL
            .filter(e => e.asset_id === assetId)
            .map((e, idx) => ({
                id: `rpnl-${assetId}-${idx}`,
                asset: e.asset,
                asset_id: e.asset_id,
                asset_symbol: e.asset_symbol,
                realized_at: e.realized_at,
                event_type: 'disposal' as const,
                qty: e.qty,
                proceeds_in_base: e.proceeds_in_base,
                cost_basis_in_base: e.cost_basis_in_base,
                pnl_in_base: e.pnl_in_base,
                pnl_pct: e.cost_basis_in_base > 0 ? e.pnl_in_base / e.cost_basis_in_base : 0,
                disposal_taxable: e.disposal_taxable,
                holding_period_days: e.holding_period_days,
                is_long_term: (e.holding_period_days || 0) >= 365,
                transaction_id: e.transaction_id,
                consumed_lot_count: 1,
            }));
        setAssetRealizedEntries(realized);

        setCurrentView('asset-detail');
    }, [assets, allCostLots, allRealizedPnL, loadLotsData]);

    // Back to assets view
    const handleBackToAssets = useCallback(() => {
        setSelectedAssetId(null);
        setSelectedAsset(null);
        setCurrentView('assets');
    }, []);

    // Realized entry click handler
    const handleRealizedClick = useCallback((entryId: string) => {
        const entry = assetRealizedEntries.find(e => e.id === entryId);
        if (!entry) return;

        // Check if this entry is a fee-related entry
        // Fee entries would have event_type 'fee' and specific indicators
        const isFeeEntry = entry.event_type === 'fee';

        // Build impact event
        const event: PnLImpactEvent = {
            id: entryId,
            event_type: isFeeEntry ? 'fee' : entry.event_type,
            event_date: entry.realized_at,
            disposal_taxable: entry.disposal_taxable,
            total_pnl: entry.pnl_in_base,
            total_proceeds: entry.proceeds_in_base,
            total_cost_basis: entry.cost_basis_in_base,
            total_fees: isFeeEntry ? entry.proceeds_in_base : 0,  // Fee amount is the proceeds if it's a fee entry
            consumed_lots: [],
            transactions: [],
            unit_id: entry.unit_id,
        };
        setImpactEvent(event);
        setShowImpactPanel(true);
    }, [assetRealizedEntries]);

    // External navigation handlers (would integrate with router)
    const handleTransactionClick = useCallback((txId: number) => {
        console.log('Navigate to transaction:', txId);
        // In real app: navigate to /inbox?transaction=txId
    }, []);

    const handleUnitClick = useCallback((unitId: number) => {
        console.log('Navigate to calculation unit:', unitId);
        // In real app: navigate to /pnl/audit?unit=unitId
    }, []);

    // Version management handlers
    const handleLoadVersion = useCallback(async (versionId: number) => {
        await loadVersionById(versionId);
    }, [loadVersionById]);

    // Option D: handlePersistVersion now commits the draft version
    const handlePersistVersion = useCallback(async () => {
        // Use the new Option D commitVersion
        await commitVersion();
    }, [commitVersion]);

    const handleDeleteVersion = useCallback(async (versionId: number) => {
        setIsDeleting(true);
        try {
            // Delete version via API
            await fetch(`${API_URL}/pnl/versions/${versionId}`, {
                method: 'DELETE',
            });
            // Refresh versions list
            fetchAvailableVersions();
            if (currentVersionId === versionId) {
                setCurrentVersionId(null);
                setStatus('idle');
            }
        } finally {
            setIsDeleting(false);
        }
    }, [currentVersionId, fetchAvailableVersions]);

    // --- Manual Refresh Button ---
    const handleRefreshPrices = useCallback(() => {
        // Build balance entries from current assets
        if (assets && assets.length > 0) {
            const balanceEntries: BalanceEntry[] = assets.map(a => ({
                asset: { id: a.asset_id, name: a.asset_symbol },
                qty: a.quantity,
                cost_basis_in_base: a.cost_basis,
                avg_unit_cost_in_base: a.quantity > 0 ? a.cost_basis / a.quantity : 0,
                lot_count: a.lot_count,
            }));
            fetchPrices(balanceEntries, config.base_currency_symbol);
        }
    }, [assets, config.base_currency_symbol, fetchPrices]);

    // --- Recompute unrealized P&L using live prices ---
    useEffect(() => {
        if (!assets || !prices || prices.length === 0) return;
        const priceMap = new Map<number, PriceResponse>();
        for (const p of prices) {
            const assetId = p.asset.id;
            if (assetId !== undefined) priceMap.set(assetId, p);
        }
        setAssets(prevAssets => prevAssets.map(asset => {
            const priceObj = priceMap.get(asset.asset_id);
            if (!priceObj || priceObj.price == null) {
                return {
                    ...asset,
                    market_value: 0,
                    unrealized_pnl: 0,
                    unrealized_pnl_pct: 0,
                    unit_value: null,
                    price_source: priceObj?.source,
                    price_fetched_at: priceObj?.fetched_at,
                    price_error: priceObj?.error,
                };
            }
            const marketValue = asset.quantity * priceObj.price;
            const unrealizedPnl = marketValue - asset.cost_basis;
            const unrealizedPnlPct = asset.cost_basis > 0 ? unrealizedPnl / asset.cost_basis : 0;
            return {
                ...asset,
                market_value: marketValue,
                unrealized_pnl: unrealizedPnl,
                unrealized_pnl_pct: unrealizedPnlPct,
                unit_value: priceObj.price,
                price_source: priceObj.source,
                price_fetched_at: priceObj.fetched_at,
                price_error: priceObj.error,
            };
        }));
    }, [prices]);

    // --- Lazy load audit data when user switches to audit tab ---
    useEffect(() => {
        if (mainTab === 'audit') {
            // Load data for the current audit sub-tab
            handleAuditTabChange(auditSubTab);
        }
    }, [mainTab, auditSubTab, handleAuditTabChange]);

    // --- Recalculate summary unrealized P&L when assets change (from live prices) ---
    useEffect(() => {
        if (!assets || assets.length === 0) return;
        const totalUnrealized = assets.reduce((sum, a) => sum + (a.unrealized_pnl || 0), 0);
        const totalMarketValue = assets.reduce((sum, a) => sum + (a.market_value || 0), 0);
        setSummary(prev => {
            if (!prev) return prev;
            return {
                ...prev,
                total_unrealized_pnl: totalUnrealized,
                total_portfolio_value: totalMarketValue > 0 ? totalMarketValue : prev.total_portfolio_value,
            };
        });
    }, [assets]);

    return (
        <Box p={4}>
            <Flex justify="space-between" align="center" mb={4}>
                <Heading size="lg">📊 P&L Calculator</Heading>
            </Flex>

            {/* Calculation Context */}
            <CalculationContext
                status={status}
                config={config}
                onConfigChange={handleConfigChange}
                onCalculate={runCalculation}
                mode={calculationMode}
                onModeChange={handleModeChange}
                accounts={accounts}
                isLoadingAccounts={isLoadingAccounts}
                availableVersions={availableVersions}
                isLoadingVersions={isLoadingVersions}
                selectedVersionId={currentVersionId ?? undefined}
                onLoadVersion={handleLoadVersion}
                onPersist={handlePersistVersion}
                onDeleteVersion={handleDeleteVersion}
                isCalculating={isCalculating}
                isPersisting={isPersisting}
                isDeleting={isDeleting}
                error={error}
            />

            {/* Show content based on calculation status */}
            {status === 'idle' && (
                <Box textAlign="center" py={16} bg="gray.50" borderRadius="md">
                    <Heading size="md" color="gray.500" mb={2}>
                        No P&L Calculation Yet
                    </Heading>
                    <Box color="gray.400">
                        Configure your settings above and click "Calculate" to generate P&L report.
                    </Box>
                </Box>
            )}

            {(status === 'preview' || status === 'persisted') && summary && (
                <>
                    {/* Toolbar: Filters and Refresh Prices - above summary cards */}
                    {currentView !== 'asset-detail' && (
                        <Flex
                            align="center"
                            justify="space-between"
                            gap={3}
                            mb={4}
                            p={2}
                            bg="gray.50"
                            borderRadius="md"
                            border="1px solid"
                            borderColor="gray.200"
                        >
                            {/* Left side: Unsettled negative lots filter */}
                            <Flex align="center" gap={4}>
                                {/* Unsettled negative lots filter */}
                                {totalUnsettledNegativeCount > 0 && (
                                    <Flex align="center" gap={2}>
                                        {showUnsettledNegative ? <FiEye /> : <FiEyeOff />}
                                        <Text fontSize="sm" color="gray.600">
                                            {showUnsettledNegative
                                                ? `Showing ${totalUnsettledNegativeCount} unsettled lot${totalUnsettledNegativeCount === 1 ? '' : 's'}`
                                                : `${totalUnsettledNegativeCount} unsettled lot${totalUnsettledNegativeCount === 1 ? '' : 's'} hidden`
                                            }
                                        </Text>
                                        <Switch.Root
                                            checked={showUnsettledNegative}
                                            onCheckedChange={(e) => setShowUnsettledNegative(e.checked)}
                                            size="sm"
                                        >
                                            <Switch.HiddenInput />
                                            <Switch.Control>
                                                <Switch.Thumb />
                                            </Switch.Control>
                                            <Switch.Label ml={2} fontSize="sm">
                                                {showUnsettledNegative ? 'Hide' : 'Show'}
                                            </Switch.Label>
                                        </Switch.Root>
                                        {!showUnsettledNegative && (
                                            <Badge colorPalette="blue" size="sm">
                                                Filtered
                                            </Badge>
                                        )}
                                    </Flex>
                                )}
                            </Flex>

                            {/* Right side: Refresh Prices button */}
                            <Flex gap={2} align="center">
                                {lastPriceRefresh && (
                                    <Text fontSize="xs" color="gray.500">
                                        Prices: {lastPriceRefresh.toLocaleTimeString()}
                                    </Text>
                                )}
                                <Button
                                    onClick={handleRefreshPrices}
                                    loading={isRefreshingPrices || isLoadingBalances}
                                    colorPalette="blue"
                                    variant="outline"
                                    size="sm"
                                    disabled={!currentVersionId}
                                >
                                    <FiRefreshCw />
                                    <Text ml={2}>Refresh Prices</Text>
                                </Button>
                            </Flex>
                        </Flex>
                    )}

                    {/* Category Filter Bar (post-calculation display filter) - before summary cards */}
                    {currentView !== 'asset-detail' && dimensions.length > 0 && availableCategoryIds.size > 0 && (
                        <CategoryFilterBar
                            dimensions={dimensions}
                            selectedCategoryIds={selectedCategoryIds}
                            onSelectionChange={setSelectedCategoryIds}
                            availableCategoryIds={availableCategoryIds}
                            totalAssetCount={assets.length}
                            filteredAssetCount={filteredAssets.length}
                            isLoading={isLoadingCategories}
                        />
                    )}

                    {/* Summary Cards (always visible except in asset detail) */}
                    {currentView !== 'asset-detail' && filteredSummary && (
                        <SummaryCards
                            summary={filteredSummary}
                            baseCurrency={config.base_currency_symbol}
                            onFeesClick={() => {
                                setMainTab('audit');
                                setAuditSubTab('fees');
                            }}
                            onWarningsClick={() => {
                                setMainTab('audit');
                                setAuditSubTab('warnings');
                            }}
                        />
                    )}

                    {/* Market Value Pie Chart (after summary cards, before asset table) */}
                    {currentView !== 'asset-detail' && dimensions.length > 0 && assets.length > 0 && (
                        <MarketValuePieChart
                            assets={assets}
                            dimensions={dimensions}
                            baseCurrency={config.base_currency_symbol}
                            selectedCategoryIds={selectedCategoryIds}
                            onCategoryClick={handlePieCategoryClick}
                        />
                    )}

                    {/* Compact summary bar when in detail view */}
                    {currentView === 'asset-detail' && filteredSummary && (
                        <SummaryBar
                            summary={filteredSummary}
                            baseCurrency={config.base_currency_symbol}
                        />
                    )}

                    {/* Main content based on view */}
                    {currentView === 'assets' && (
                        <Tabs.Root value={mainTab} onValueChange={(e) => setMainTab(e.value as 'assets' | 'audit')} mb={4}>
                            <Tabs.List>
                                <Tabs.Trigger value="assets">
                                    <FiLayers style={{ marginRight: 4 }} />
                                    Asset P&L
                                </Tabs.Trigger>
                                <Tabs.Trigger value="audit">
                                    📋 P&L Audit
                                </Tabs.Trigger>
                            </Tabs.List>

                            <Tabs.Content value="assets">
                                <AssetPnLTable
                                    assets={filteredAssets}
                                    baseCurrency={config.base_currency_symbol}
                                    onAssetClick={handleAssetClick}
                                />
                            </Tabs.Content>

                            <Tabs.Content value="audit">
                                <PnLAuditView
                                    calculationUnits={calculationUnits}
                                    costLots={allCostLots}
                                    consumedSlices={allConsumedSlices}
                                    realizedPnL={allRealizedPnL}
                                    warnings={warnings}
                                    fees={fees}
                                    settlements={allSettlements}
                                    lotEvents={allLotEvents}
                                    baseCurrency={config.base_currency_symbol}
                                    versionId={currentVersionId}
                                    onTransactionClick={handleTransactionClick}
                                    onAssetClick={handleAssetClick}
                                    onUnitClick={handleUnitClick}
                                    defaultTab={auditSubTab}
                                    onTabChange={handleAuditTabChange}
                                    isLoadingUnits={isLoadingUnits}
                                    isLoadingLots={isLoadingLots}
                                    isLoadingRealized={isLoadingRealized}
                                    isLoadingFees={isLoadingFees}
                                    isLoadingWarnings={isLoadingWarnings}
                                    isLoadingEvents={isLoadingEvents}
                                    idCounts={idCounts}
                                />
                            </Tabs.Content>
                        </Tabs.Root>
                    )}

                    {currentView === 'asset-detail' && selectedAsset && currentVersionId && (
                        <AssetDetailView
                            asset={selectedAsset}
                            versionId={currentVersionId}
                            baseCurrency={config.base_currency_symbol}
                            onBack={handleBackToAssets}
                            onTransactionClick={handleTransactionClick}
                        />
                    )}
                </>
            )}

            {/* FeesPanel removed: fees now only shown in audit tab */}

            {/* WarningsPanel removed: warnings now only shown in audit tab */}

            {showImpactPanel && impactEvent && (
                <PnLImpactPanel
                    event={impactEvent}
                    baseCurrency={config.base_currency_symbol}
                    onClose={() => {
                        setShowImpactPanel(false);
                        setImpactEvent(null);
                    }}
                    onTransactionClick={handleTransactionClick}
                    onUnitClick={handleUnitClick}
                />
            )}
        </Box>
    );
};

export default PnLPanel;
