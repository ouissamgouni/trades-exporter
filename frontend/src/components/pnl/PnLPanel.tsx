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
import { Account, API_URL, PriceResponse, DimensionWithCategories } from '../../types';
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
import { PerformanceBarChart } from './PerformanceBarChart';
import { PriceStatusList } from './PriceStatusList';
import { SlidePanel } from './SlidePanel';
import { TransactionDetailDrawer } from '../TransactionDetailDrawer';
import { getPersistedPageSize } from '../../hooks/usePagination';

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
    mapProcessedUnitToCalculationUnit,
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
        allow_negative_balances: true,
        account_ids: getInitialAccountIds(),
        // Advanced settings
        compute_residuals: false,
        crypto_swap_taxable_by_default: false,
        fee_taxable_by_default: false,
        // Price fallback settings
        use_price_fallback: true,
        price_staleness_window_days: 7,
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

    // Transaction detail drawer state
    const [selectedTransactionId, setSelectedTransactionId] = useState<number | null>(null);
    const [isTransactionDrawerOpen, setIsTransactionDrawerOpen] = useState(false);

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

    // Track previous audit state to detect actual tab changes vs callback recreations
    const prevAuditStateRef = React.useRef<{ mainTab: string; auditSubTab: string; versionId: number | null }>({
        mainTab: 'assets',
        auditSubTab: 'units',
        versionId: null,
    });

    // Per-tab pagination state for P&L Audit view
    // Each tab maintains its own page/pageSize/totalCount
    // Initialize pageSize from localStorage for persistence
    const [unitsPagination, setUnitsPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('units'), total: 0 }));
    const [lotsPagination, setLotsPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('lots'), total: 0 }));
    const [realizedPagination, setRealizedPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('realized'), total: 0 }));
    const [feesPagination, setFeesPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('fees'), total: 0 }));
    const [warningsPagination, setWarningsPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('warnings'), total: 0 }));
    const [eventsPagination, setEventsPagination] = useState(() => ({ page: 1, pageSize: getPersistedPageSize('events'), total: 0 }));

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
    const [loadingPriceAssetIds, setLoadingPriceAssetIds] = useState<Set<number>>(new Set());
    const [showPriceDrawer, setShowPriceDrawer] = useState(false);
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
            asset: balance.asset,
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
                    const assetId = p.asset.id;
                    if (assetId != null) fullPriceMap.set(assetId, p);
                }

                // Apply prices to new asset rows
                const assetsWithPrices = assetRows.map(assetpnlrow => {
                    const assetId = assetpnlrow.asset.id;
                    const priceObj = assetId != null ? fullPriceMap.get(assetId) : undefined;
                    const isPriceLoading = assetId != null && loadingPriceAssetIds.has(assetId);

                    if (!priceObj || priceObj.price == null) {
                        return {
                            ...assetpnlrow,
                            unit_value: null,
                            price_source: priceObj?.source,
                            price_fetched_at: priceObj?.fetched_at,
                            price_error: priceObj?.error,
                            price_loading: isPriceLoading,
                        };
                    }
                    const marketValue = assetpnlrow.quantity * priceObj.price;
                    const unrealizedPnl = marketValue - assetpnlrow.cost_basis;
                    const unrealizedPnlPct = assetpnlrow.cost_basis > 0 ? unrealizedPnl / assetpnlrow.cost_basis : 0;
                    return {
                        ...assetpnlrow,
                        market_value: marketValue,
                        unrealized_pnl: unrealizedPnl,
                        unrealized_pnl_pct: unrealizedPnlPct,
                        unit_value: priceObj.price,
                        price_source: priceObj.source,
                        price_fetched_at: priceObj.fetched_at,
                        price_error: priceObj.error,
                        price_loading: isPriceLoading,
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
    }, [showUnsettledNegative, currentVersionId, loadBalances, transformBalances, prices, loadingPriceAssetIds]);

    // Fetch prices for all assets in balances (Individually with concurrency control)
    const fetchPrices = useCallback(async (balances: BalanceEntry[], baseCurrency: string) => {
        if (!balances || balances.length === 0) return;

        // Extract asset IDs from AssetRef
        const assetIds = balances.map(b => b.asset.id).filter((id): id is number => id !== undefined);
        if (assetIds.length === 0) return;

        setIsRefreshingPrices(true);
        setLoadingPriceAssetIds(new Set(assetIds));
        setLastPriceRefresh(new Date());

        // Helper to fetch single price
        const fetchSinglePrice = async (assetId: number) => {
            try {
                // Include fallback params from config
                const response = await fetch(
                    `${API_URL}/pnl/prices/${assetId}?base_currency=${baseCurrency}&use_fallback=${config.use_price_fallback}&staleness_window_days=${config.price_staleness_window_days}`
                );

                if (!response.ok) {
                    throw new Error(`Failed to fetch price`);
                }

                const data: PriceResponse = await response.json();

                // Update specific price in state
                setPrices(prev => {
                    const idx = prev.findIndex(p => p.asset.id === assetId);
                    if (idx >= 0) {
                        const next = [...prev];
                        next[idx] = data;
                        return next;
                    }
                    return [...prev, data];
                });
            } catch (err) {
                console.error(`Fetch failed for asset ${assetId}`, err);

                // Create error entry
                const errorItem: PriceResponse = {
                    asset: { id: assetId, symbol: 'Unknown' },
                    price: null,
                    price_quote: baseCurrency,
                    error: err instanceof Error ? err.message : 'Unknown error',
                    fetched_at: new Date().toISOString()
                };

                // Try to find name from balances
                const balance = balances.find(b => b.asset.id === assetId);
                if (balance) {
                    errorItem.asset.symbol = balance.asset.symbol;
                }

                setPrices(prev => {
                    const idx = prev.findIndex(p => p.asset.id === assetId);
                    if (idx >= 0) {
                        const next = [...prev];
                        next[idx] = errorItem;
                        return next;
                    }
                    return [...prev, errorItem];
                });
            } finally {
                setLoadingPriceAssetIds(prev => {
                    const next = new Set(prev);
                    next.delete(assetId);
                    return next;
                });
            }
        };

        // Concurrency control (5 parallel requests)
        const CONCURRENCY = 5;
        const queue = [...assetIds];
        const active: Promise<void>[] = [];

        try {
            while (queue.length > 0 || active.length > 0) {
                while (queue.length > 0 && active.length < CONCURRENCY) {
                    const id = queue.shift();
                    if (id !== undefined) {
                        const promise = fetchSinglePrice(id).then(() => {
                            active.splice(active.indexOf(promise), 1);
                        });
                        active.push(promise);
                    }
                }
                if (active.length > 0) {
                    await Promise.race(active);
                }
            }
        } finally {
            setIsRefreshingPrices(false);
        }
    }, [config.use_price_fallback, config.price_staleness_window_days]);

    // Refresh a single asset price (used after manual price entry)
    const refreshSinglePrice = useCallback(async (assetId: number) => {
        try {
            setLoadingPriceAssetIds(prev => new Set(prev).add(assetId));

            const response = await fetch(
                `${API_URL}/pnl/prices/${assetId}?base_currency=${config.base_currency_symbol}&use_fallback=${config.use_price_fallback}&staleness_window_days=${config.price_staleness_window_days}`
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch price`);
            }

            const data: PriceResponse = await response.json();

            // Update specific price in state
            setPrices(prev => {
                const idx = prev.findIndex(p => p.asset.id === assetId);
                if (idx >= 0) {
                    const next = [...prev];
                    next[idx] = data;
                    return next;
                }
                return [...prev, data];
            });
        } catch (err) {
            console.error(`Refresh failed for asset ${assetId}`, err);
        } finally {
            setLoadingPriceAssetIds(prev => {
                const next = new Set(prev);
                next.delete(assetId);
                return next;
            });
        }
    }, [config.base_currency_symbol, config.use_price_fallback, config.price_staleness_window_days]);

    // Remove a warning by ID (used after manual price fixes the issue)
    const removeWarning = useCallback((warningId: string) => {
        setWarnings(prev => prev.filter(w => w.id !== warningId));
        // Also update summary warning count
        setSummary(prev => prev ? {
            ...prev,
            warning_count: Math.max(0, (prev.warning_count ?? 0) - 1),
        } : prev);
    }, []);

    // Callback for manual price added from PriceStatusList or WarningsPanel
    const handlePriceAdded = useCallback((assetId: number, warningId?: string) => {
        // Refresh the single price to show updated status
        refreshSinglePrice(assetId);
        // Remove the warning if provided
        if (warningId) {
            removeWarning(warningId);
        }
    }, [refreshSinglePrice, removeWarning]);

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
            // Note: Only send base_currency_symbol (not ID) to avoid stale ID issues after DB reset
            const requestBody: Record<string, unknown> = {
                lot_method: config.lot_method,
                lot_mode: config.lot_mode,
                base_currency_symbol: config.base_currency_symbol,
                residual_tolerance_pct: config.residual_tolerance_pct,
                allow_negative_balances: config.allow_negative_balances,
                // Advanced settings
                compute_residuals: config.compute_residuals,
                crypto_swap_taxable_by_default: config.crypto_swap_taxable_by_default,
                fee_taxable_by_default: config.fee_taxable_by_default,
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
            });

            // Store version info
            setCurrentVersionId(versionId);
            setCurrentVersionStatus(calcResult.status === 'draft' ? 'draft' : 'committed');

            // Initialize ID counts (will be populated from paginated endpoint totals)
            setIdCounts({
                unitCount: 0,  // Will be set from units pagination
                lotCount: 0,  // Will be set from lots pagination
                consumedCount: 0,  // Will be set from consumed slices pagination
                realizedCount: 0,  // Will be set from realized pagination
                feeCount: calcResult.fee_entry_count ?? 0,
                warningCount: 0,  // Will be set from warnings pagination
                settlementCount: 0,  // Will be set from settlements pagination
                eventCount: 0,  // Will be set from events pagination
            });

            // Reset loaded tabs tracker for fresh calculation
            setLoadedTabs(new Set());
            // Reset audit state ref to force reload on next audit tab view
            prevAuditStateRef.current = { mainTab: 'assets', auditSubTab: 'units', versionId: null };

            // Reset pagination to page 1 (totals will be set when tabs load)
            setUnitsPagination(prev => ({ ...prev, page: 1, total: 0 }));
            setLotsPagination(prev => ({ ...prev, page: 1, total: 0 }));
            setRealizedPagination(prev => ({ ...prev, page: 1, total: 0 }));
            setFeesPagination(prev => ({ ...prev, page: 1, total: calcResult.fee_entry_count ?? 0 }));
            setWarningsPagination(prev => ({ ...prev, page: 1, total: 0 }));
            setEventsPagination(prev => ({ ...prev, page: 1, total: 0 }));

            // Step 2: Load balances from dedicated endpoint (group_by_asset=true)
            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            // Build summary data for transformResult
            // Full data (lots, realized-pnl, units, settlements, warnings) loaded on-demand via lazy loaders
            const summaryData = {
                total_realized_pnl: calcResult.total_realized_pnl,
                total_fees_in_base: calcResult.total_fees_in_base ?? 0,
                fee_entry_count: calcResult.fee_entry_count ?? 0,
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

    // Independent loader: Load calculation units with pagination
    const loadUnits = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingUnits(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/units?${params}`);
            const data = await response.json();

            // Check if response is paginated (has items + total) or legacy array
            const units = Array.isArray(data) ? data : data.items || [];
            const total = data.total ?? units.length;

            // Store calculation units with complete nested data from API
            const mappedUnits = units.map(mapProcessedUnitToCalculationUnit);
            setCalculationUnits(mappedUnits);
            setUnitsPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('units'));
            console.log('Loaded units:', mappedUnits.length, 'of', total);
        } catch (err) {
            console.error('Failed to load units:', err);
        } finally {
            setIsLoadingUnits(false);
        }
    }, [currentVersionId]);

    // Independent loader: Load lots with pagination (consumed slices and settlements still loaded fully for cross-referencing)
    const loadLotsData = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingLots(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const [lotsResponse, consumedResponse, settlementsResponse] = await Promise.all([
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/lots?${params}`),
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/consumed-slices`),
                fetch(`${API_URL}/pnl/versions/${currentVersionId}/settlements`),
            ]);

            const [lotsData, consumedSlices, settlements] = await Promise.all([
                lotsResponse.json(),
                consumedResponse.json(),
                settlementsResponse.json(),
            ]);

            // Check if response is paginated (has items + total) or legacy array
            const lots = Array.isArray(lotsData) ? lotsData : lotsData.items || [];
            const total = lotsData.total ?? lots.length;

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

            // Store consumed slices (full list for cross-referencing)
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

            // Store settlements (full list for cross-referencing)
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

            setLotsPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('lots'));
            console.log('Loaded lots data:', { lots: allLots.length, total, consumed: allConsumed.length, settlements: mappedSettlements.length });
        } catch (err) {
            console.error('Failed to load lots data:', err);
        } finally {
            setIsLoadingLots(false);
        }
    }, [currentVersionId]);

    // Independent loader: Load realized P&L with pagination
    const loadRealizedPnL = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingRealized(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/realized-pnl?${params}`);
            const data = await response.json();

            // Check if response is paginated (has items + total) or legacy array
            const realizedPnl = Array.isArray(data) ? data : data.items || [];
            const total = data.total ?? realizedPnl.length;

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
            setRealizedPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('realized'));
            console.log('Loaded realized P&L:', allRealized.length, 'of', total);
        } catch (err) {
            console.error('Failed to load realized P&L:', err);
        } finally {
            setIsLoadingRealized(false);
        }
    }, [currentVersionId]);

    // Independent loader: Load warnings with pagination
    const loadWarnings = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingWarnings(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/warnings?${params}`);
            const data = await response.json();

            // Check if response is paginated (has items + total) or legacy array
            const warningsData = Array.isArray(data) ? data : data.items || [];
            const total = data.total ?? warningsData.length;

            setWarnings(warningsData);
            setWarningsPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('warnings'));
            console.log('Loaded warnings:', warningsData.length, 'of', total);
        } catch (err) {
            console.error('Failed to load warnings:', err);
        } finally {
            setIsLoadingWarnings(false);
        }
    }, [currentVersionId]);

    // Independent loader: Load fees with pagination
    const loadFees = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingFees(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/fees?${params}`);
            const data = await response.json();

            // Check if response is paginated (has fees + total) or legacy structure
            const feesData = data.fees || [];
            const total = data.total ?? feesData.length;

            // Map API response to FeeEntry interface
            const feeEntries: FeeEntry[] = feesData.map((f: any) => ({
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
            setFeesPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('fees'));
            console.log('Loaded fees:', feeEntries.length, 'of', total);
        } catch (err) {
            console.error('Failed to load fees:', err);
        } finally {
            setIsLoadingFees(false);
        }
    }, [currentVersionId]);

    // Independent loader: Load lot events with pagination
    const loadLotEvents = useCallback(async (page: number = 1, limit: number = 50) => {
        if (!currentVersionId) return;

        setIsLoadingEvents(true);
        try {
            const params = new URLSearchParams({
                page: String(page),
                limit: String(limit),
            });
            const response = await fetch(`${API_URL}/pnl/versions/${currentVersionId}/lot-events?${params}`);
            const data = await response.json();

            // Check if response is paginated (has items + total) or legacy array
            const eventsData = Array.isArray(data) ? data : data.items || [];
            const total = data.total ?? eventsData.length;

            setAllLotEvents(eventsData);
            setEventsPagination(prev => ({ ...prev, page, pageSize: limit, total }));
            setLoadedTabs(prev => new Set(prev).add('events'));
            console.log('Loaded lot events:', eventsData.length, 'of', total);
        } catch (err) {
            console.error('Failed to load lot events:', err);
        } finally {
            setIsLoadingEvents(false);
        }
    }, [currentVersionId]);

    // Handle audit tab changes - just update state, the useEffect will handle loading
    const handleAuditTabChange = useCallback((tab: string) => {
        setAuditSubTab(tab as 'units' | 'lots' | 'realized' | 'fees' | 'warnings' | 'events');
        // Note: Data loading is handled by the useEffect that watches mainTab/auditSubTab changes
    }, []);

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
            // Reset audit state ref to force reload on next audit tab view
            prevAuditStateRef.current = { mainTab: 'assets', auditSubTab: 'units', versionId: null };
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

            // Store ID counts (will be populated from paginated endpoint totals when tabs load)
            setIdCounts({
                unitCount: 0,
                lotCount: 0,
                consumedCount: 0,
                realizedCount: 0,
                feeCount: versionData.fee_entry_count ?? 0,
                warningCount: 0,
                settlementCount: 0,
                eventCount: 0,
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
    const handleAssetClick = useCallback(async (assetId: number | null | undefined) => {
        const asset = assets.find(apnl => apnl.asset.id === assetId);
        if (!asset) return;

        setSelectedAssetId(assetId ?? null);
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
            .filter(e => e.asset.id === assetId)
            .map((e, idx) => ({
                id: `rpnl-${assetId}-${idx}`,
                asset: e.asset,
                asset_id: e.asset.id,
                asset_symbol: e.asset.symbol,
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

    // External navigation handlers
    const handleTransactionClick = useCallback((txId: number) => {
        setSelectedTransactionId(txId);
        setIsTransactionDrawerOpen(true);
    }, []);

    const handleCloseTransactionDrawer = useCallback(() => {
        setIsTransactionDrawerOpen(false);
        setSelectedTransactionId(null);
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
                asset: a.asset,
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
            if (assetId != null) priceMap.set(assetId, p);
        }
        setAssets(prevAssets => prevAssets.map(assetpnlrow => {
            const assetId = assetpnlrow.asset.id;
            const priceObj = assetId != null ? priceMap.get(assetId) : undefined;
            if (!priceObj || priceObj.price == null) {
                return {
                    ...assetpnlrow,
                    market_value: 0,
                    unrealized_pnl: 0,
                    unrealized_pnl_pct: 0,
                    unit_value: null,
                    price_source: priceObj?.source,
                    price_fetched_at: priceObj?.fetched_at,
                    price_error: priceObj?.error,
                };
            }
            const marketValue = assetpnlrow.quantity * priceObj.price;
            const unrealizedPnl = marketValue - assetpnlrow.cost_basis;
            const unrealizedPnlPct = assetpnlrow.cost_basis > 0 ? unrealizedPnl / assetpnlrow.cost_basis : 0;
            return {
                ...assetpnlrow,
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
    // Uses ref to track actual state changes vs callback recreations to prevent infinite loops
    useEffect(() => {
        const prev = prevAuditStateRef.current;
        const shouldLoad = mainTab === 'audit' && currentVersionId && (
            prev.mainTab !== mainTab ||
            prev.auditSubTab !== auditSubTab ||
            prev.versionId !== currentVersionId
        );

        // Update ref with current state
        prevAuditStateRef.current = { mainTab, auditSubTab, versionId: currentVersionId };

        if (shouldLoad) {
            // Load data for the current audit sub-tab
            const pageSize = getPersistedPageSize(auditSubTab);
            switch (auditSubTab) {
                case 'units':
                    loadUnits(1, pageSize);
                    break;
                case 'lots':
                    loadLotsData(1, pageSize);
                    break;
                case 'realized':
                    loadRealizedPnL(1, pageSize);
                    break;
                case 'fees':
                    loadFees(1, pageSize);
                    break;
                case 'warnings':
                    loadWarnings(1, pageSize);
                    break;
                case 'events':
                    loadLotEvents(1, pageSize);
                    break;
            }
        }
    }, [mainTab, auditSubTab, currentVersionId, loadUnits, loadLotsData, loadRealizedPnL, loadFees, loadWarnings, loadLotEvents]);

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
                                {/* Price Status Badges */}
                                {prices.length > 0 && (
                                    <Flex gap={2} align="center">
                                        <Badge
                                            colorPalette="green"
                                            variant="solid"
                                            cursor="pointer"
                                            onClick={() => setShowPriceDrawer(true)}
                                            _hover={{ opacity: 0.8 }}
                                        >
                                            <Flex align="center" gap={1}>
                                                <Box as="span">✅</Box>
                                                <Text>{prices.filter(p => !p.error && p.price != null).length}</Text>
                                            </Flex>
                                        </Badge>

                                        {prices.some(p => !!p.error || p.price == null) && (
                                            <Badge
                                                colorPalette="red"
                                                variant="solid"
                                                cursor="pointer"
                                                onClick={() => setShowPriceDrawer(true)}
                                                _hover={{ opacity: 0.8 }}
                                            >
                                                <Flex align="center" gap={1}>
                                                    <Box as="span">⚠️</Box>
                                                    <Text>{prices.filter(p => !!p.error || p.price == null).length}</Text>
                                                </Flex>
                                            </Badge>
                                        )}
                                    </Flex>
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

                    {/* Charts Section: Pie Chart + Performance Bar Chart side by side */}
                    {currentView !== 'asset-detail' && dimensions.length > 0 && assets.length > 0 && (
                        <Box
                            display="grid"
                            gridTemplateColumns={{ base: '1fr', lg: '6fr 3fr' }}
                            gap={4}
                            mb={4}
                        >
                            <MarketValuePieChart
                                assets={assets}
                                dimensions={dimensions}
                                baseCurrency={config.base_currency_symbol}
                                selectedCategoryIds={selectedCategoryIds}
                                onCategoryClick={handlePieCategoryClick}
                            />
                            <PerformanceBarChart
                                assets={assets}
                                dimensions={dimensions}
                                baseCurrency={config.base_currency_symbol}
                                onItemClick={(itemId: number, type: 'asset' | 'category') => {
                                    if (type === 'asset') {
                                        handleAssetClick(itemId);
                                    } else {
                                        handlePieCategoryClick(itemId);
                                    }
                                }}
                            />
                        </Box>
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
                                    quoteAssetId={config.base_currency_id ?? undefined}
                                    onPriceAdded={(assetId, warningId) => handlePriceAdded(assetId, warningId)}
                                    assets={assets.map(a => a.asset)}
                                    // Pagination props
                                    unitsPagination={unitsPagination}
                                    lotsPagination={lotsPagination}
                                    realizedPagination={realizedPagination}
                                    feesPagination={feesPagination}
                                    warningsPagination={warningsPagination}
                                    eventsPagination={eventsPagination}
                                    onUnitsPageChange={(page, pageSize) => {
                                        setUnitsPagination(prev => ({ ...prev, page, pageSize }));
                                        loadUnits(page, pageSize);
                                    }}
                                    onLotsPageChange={(page, pageSize) => {
                                        setLotsPagination(prev => ({ ...prev, page, pageSize }));
                                        loadLotsData(page, pageSize);
                                    }}
                                    onRealizedPageChange={(page, pageSize) => {
                                        setRealizedPagination(prev => ({ ...prev, page, pageSize }));
                                        loadRealizedPnL(page, pageSize);
                                    }}
                                    onFeesPageChange={(page, pageSize) => {
                                        setFeesPagination(prev => ({ ...prev, page, pageSize }));
                                        loadFees(page, pageSize);
                                    }}
                                    onWarningsPageChange={(page, pageSize) => {
                                        setWarningsPagination(prev => ({ ...prev, page, pageSize }));
                                        loadWarnings(page, pageSize);
                                    }}
                                    onEventsPageChange={(page, pageSize) => {
                                        setEventsPagination(prev => ({ ...prev, page, pageSize }));
                                        loadLotEvents(page, pageSize);
                                    }}
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

            <SlidePanel
                isOpen={showPriceDrawer}
                onClose={() => setShowPriceDrawer(false)}
                title="Price Fetch Results"
                width="600px"
            >
                <PriceStatusList
                    prices={prices}
                    baseCurrency={config.base_currency_symbol}
                    quoteAssetId={config.base_currency_id ?? undefined}
                    onPriceAdded={(assetId) => handlePriceAdded(assetId)}
                />
            </SlidePanel>

            {/* Transaction Detail Drawer - opens when clicking any transaction badge */}
            <TransactionDetailDrawer
                transactionId={selectedTransactionId}
                isOpen={isTransactionDrawerOpen}
                onClose={handleCloseTransactionDrawer}
                accounts={accounts}
            />
        </Box>
    );
};

export default PnLPanel;
