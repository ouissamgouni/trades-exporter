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

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Badge, Box, Button, Dialog, Flex, Heading, Switch, Text } from '@chakra-ui/react';
import { FiRefreshCw } from 'react-icons/fi';
import { useBaseCurrency } from '../BaseCurrencySelector';
import { Account, API_URL, PriceResponse, DimensionWithCategories } from '../../types';
import type { BalanceEntry } from '../../types';
import { toaster } from '../ui/toaster';
import { useDataHealth } from '../../contexts/DataHealthContext';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { PnLVersionResponse, VersionListItem, AggregatedBalanceItem } from './types';

// P&L Components
import { CalculationContext, CalculationMode } from './CalculationContext';
import { SummaryCards, SummaryBar } from './SummaryCards';
import { AssetPnLTable } from './AssetPnLTable';
import AssetDetailView from './AssetDetailView';
import { PnLImpactPanel } from './PnLImpactPanel';
import { PnLAuditView } from './DataExplorerPanel';
import { PnLFilterBar } from './PnLFilterBar';
import { MarketValuePieChart } from './MarketValuePieChart';
import { PerformanceBarChart } from './PerformanceBarChart';
import { PriceStatusList } from './PriceStatusList';
import { SlidePanel } from './SlidePanel';
import { TransactionDetailDrawer } from '../TransactionDetailDrawer';

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
    PnLWarningItem,
    PnLView,
    CalculationUnit,
    PnLFilterState,
    PerAccountBalanceItem,
    AccountBalanceBreakdown,
} from './types';

interface PnLPanelProps {
    onOpenHealthCheck?: () => void;
}

export const PnLPanel: React.FC<PnLPanelProps> = ({ onOpenHealthCheck }) => {

    // Base currency from settings
    const { baseCurrency, baseCurrencyId } = useBaseCurrency();

    // Data health context for UI display only (not used for calculation gating)
    // Calculation flow uses direct API calls to avoid race conditions with polling
    const { refreshHealthData } = useDataHealth();

    // Confirmation dialog state for data health issues
    const [showHealthConfirm, setShowHealthConfirm] = useState(false);
    const [healthCheckIssueCount, setHealthCheckIssueCount] = useState(0);
    
    // Refs to track state without causing closure issues
    const isCalculatingRef = useRef(false);
    const skipHealthCheckRef = useRef(false);  // Flag to skip health check after user confirms

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

    // Unified filter state for Portfolio View (accounts + categories + options)
    const [filterState, setFilterState] = useState<PnLFilterState>({
        selectedAccountIds: [],
        selectedCategoryIds: [],
        includeUnsettledNegative: false,
    });

    // Category dimensions for filter
    const [dimensions, setDimensions] = useState<DimensionWithCategories[]>([]);
    const [isLoadingCategories, setIsLoadingCategories] = useState(false);

    // Account data for filter
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);

    // Per-account balances for expandable rows (prefetched)
    const [accountBalances, setAccountBalances] = useState<Map<number, AccountBalanceBreakdown[]>>(new Map());
    const [isLoadingAccountBalances, setIsLoadingAccountBalances] = useState(false);

    // Main view mode: 'portfolio' (filtered view) or 'audit' (full unfiltered audit)
    const [viewMode, setViewMode] = useState<'portfolio' | 'audit'>('portfolio');

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
        const urlFilterAccounts = params.get('filter_accounts');
        if (urlCategories || urlFilterAccounts) {
            const categoryIds = urlCategories
                ? urlCategories.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
                : [];
            const accountIds = urlFilterAccounts
                ? urlFilterAccounts.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
                : [];
            setFilterState(prev => ({
                ...prev,
                selectedCategoryIds: categoryIds,
                selectedAccountIds: accountIds,
            }));
        }
    }, []);

    // Update URL when filter state changes (for shareable links)
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (filterState.selectedCategoryIds.length > 0) {
            params.set('categories', filterState.selectedCategoryIds.join(','));
        } else {
            params.delete('categories');
        }
        if (filterState.selectedAccountIds.length > 0) {
            params.set('filter_accounts', filterState.selectedAccountIds.join(','));
        } else {
            params.delete('filter_accounts');
        }
        const newUrl = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        window.history.replaceState({}, '', newUrl);
    }, [filterState.selectedCategoryIds, filterState.selectedAccountIds]);

    // Result data
    const [summary, setSummary] = useState<PnLSummary | null>(null);
    const [assets, setAssets] = useState<AssetPnLRow[]>([]);

    // Filter assets client-side by selected accounts and categories
    // An asset matches if:
    // - No account filter OR asset has at least one account_id in selectedAccountIds
    // - No category filter OR asset has at least one category_id in selectedCategoryIds
    const filteredAssets = useMemo(() => {
        let result = assets;

        // Filter by accounts
        if (filterState.selectedAccountIds.length > 0) {
            result = result.filter(asset =>
                asset.account_ids.some(accId => filterState.selectedAccountIds.includes(accId))
            );
        }

        // Filter by categories
        if (filterState.selectedCategoryIds.length > 0) {
            result = result.filter(asset =>
                asset.category_ids.some(catId => filterState.selectedCategoryIds.includes(catId))
            );
        }

        return result;
    }, [assets, filterState.selectedAccountIds, filterState.selectedCategoryIds]);

    // Check if any filters are active
    const hasActiveFilters = filterState.selectedAccountIds.length > 0 || filterState.selectedCategoryIds.length > 0;

    // Recompute summary from filtered assets
    const filteredSummary = useMemo((): PnLSummary | null => {
        if (!summary) return null;
        if (!hasActiveFilters) return summary;

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
    }, [summary, filteredAssets, hasActiveFilters]);

    // Compute available account IDs (accounts that have assets in current results)
    const availableAccountIds = useMemo(() => {
        const ids = new Set<number>();
        assets.forEach(asset => {
            asset.account_ids.forEach(accId => ids.add(accId));
        });
        return ids;
    }, [assets]);

    // Compute available category IDs (categories that have assets in current results)
    const availableCategoryIds = useMemo(() => {
        const ids = new Set<number>();
        assets.forEach(asset => {
            console.log(`Asset ${asset.asset.symbol}: category_ids =`, asset.category_ids);
            asset.category_ids.forEach(catId => ids.add(catId));
        });
        console.log('availableCategoryIds:', [...ids]);
        return ids;
    }, [assets]);

    // Handler for pie chart category click - toggles category filter
    const handlePieCategoryClick = useCallback((categoryId: number | null) => {
        if (categoryId === null) {
            // Clicking "Uncategorized" clears category filter
            setFilterState(prev => ({ ...prev, selectedCategoryIds: [] }));
        } else {
            // Toggle the category in selection
            setFilterState(prev => {
                const currentIds = prev.selectedCategoryIds;
                if (currentIds.includes(categoryId)) {
                    return { ...prev, selectedCategoryIds: currentIds.filter(id => id !== categoryId) };
                } else {
                    return { ...prev, selectedCategoryIds: [...currentIds, categoryId] };
                }
            });
        }
    }, []);

    // View state
    const [currentView, setCurrentView] = useState<PnLView>('summary');
    const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
    const [selectedAsset, setSelectedAsset] = useState<AssetPnLRow | null>(null);
    const [assetRealizedEntries, setAssetRealizedEntries] = useState<RealizedPnLRow[]>([]);

    // Panel state
    const [showImpactPanel, setShowImpactPanel] = useState(false);
    const [impactEvent, setImpactEvent] = useState<PnLImpactEvent | null>(null);

    // Transaction detail drawer state
    const [selectedTransactionId, setSelectedTransactionId] = useState<number | null>(null);
    const [isTransactionDrawerOpen, setIsTransactionDrawerOpen] = useState(false);

    // Audit sub-tab state: which tab to show inside P&L Audit view
    const [auditSubTab, setAuditSubTab] = useState<'units' | 'lots' | 'realized' | 'fees' | 'warnings' | 'events'>('units');

    // Fees and warnings data
    const [fees, setFees] = useState<FeeEntry[]>([]);
    const [warnings, setWarnings] = useState<PnLWarningItem[]>([]);
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

    // Load per-account balances for expandable rows (group_by_asset=false)
    // Prefetches all account breakdowns and organizes by asset ID
    const loadAccountBalances = useCallback(async (versionId: number): Promise<Map<number, AccountBalanceBreakdown[]>> => {
        setIsLoadingAccountBalances(true);
        try {
            const params = new URLSearchParams({
                group_by_asset: 'false',
                include_unsettled_negative: 'true',
            });
            const response = await fetch(`${API_URL}/pnl/versions/${versionId}/balances?${params}`);
            if (!response.ok) {
                throw new Error('Failed to load account balances');
            }
            const balances: PerAccountBalanceItem[] = await response.json();
            console.log('Loaded per-account balances:', balances.length);

            // Group by asset ID
            const balanceMap = new Map<number, AccountBalanceBreakdown[]>();
            for (const balance of balances) {
                const assetId = balance.asset.id;
                if (assetId == null) continue;

                const breakdown: AccountBalanceBreakdown = {
                    account_id: balance.account_id,
                    account_name: balance.account_name,
                    qty: balance.qty,
                    cost_basis_in_base: balance.cost_basis_in_base,
                    avg_unit_cost_in_base: balance.avg_unit_cost_in_base,
                    lot_count: balance.lot_count,
                };

                if (!balanceMap.has(assetId)) {
                    balanceMap.set(assetId, []);
                }
                balanceMap.get(assetId)!.push(breakdown);
            }

            setAccountBalances(balanceMap);
            return balanceMap;
        } catch (err) {
            console.error('Failed to load account balances:', err);
            return new Map();
        } finally {
            setIsLoadingAccountBalances(false);
        }
    }, []);

    // Reload balances when unsettled negative filter changes
    // Preserves price data and recalculates metrics
    useEffect(() => {
        // Skip if calculation is in progress to prevent duplicate API calls
        if (isCalculatingRef.current) return;
        
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showUnsettledNegative, currentVersionId]);

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
        warning_ids?: number[];
        realized_pnl_ids?: number[];
        fee_ids?: number[];
        cost_lot_event_ids?: number[];
    };

    // Helper function to map PnLVersionResponse to SummaryData
    const mapToSummaryData = useCallback((calcResult: PnLVersionResponse): SummaryData => {
        return {
            total_realized_pnl: calcResult.total_realized_pnl,
            total_fees_in_base: calcResult.total_fees_in_base ?? 0,
            fee_entry_count: calcResult.fee_entry_count ?? 0,
            unit_ids: calcResult.calculation_unit_ids,
            cost_lot_ids: calcResult.cost_lot_ids,
            warning_ids: calcResult.warning_ids,
            realized_pnl_ids: calcResult.realized_pnl_ids,
            fee_ids: calcResult.fee_ids,
            cost_lot_event_ids: calcResult.cost_lot_event_ids,
        };
    }, []);

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
            consumed_slices_count: 0,  // Computed later from asset-level data
        };
        setSummary(newSummary);

        // Set assets from pre-built rows (built from balances endpoint)
        setAssets(assetRows);
    }, []);

    // Calculate P&L using Option D workflow with lazy loading:
    // 1. POST /calculate → get version_id + summary
    // 2. Fetch only summary + balances initially
    // 3. Load other data on-demand when user navigates to views
    const runCalculation = useCallback(async () => {
        // Pre-calculation health check (direct API call to avoid race conditions with context polling)
        // Skip if user already confirmed to continue despite issues
        if (!skipHealthCheckRef.current) {
            try {
                // Direct health check API call (not using context state)
                let healthUrl = `${API_URL}/transactions/data-health-check/status`;
                if (config.account_ids && config.account_ids.length > 0) {
                    healthUrl += `?account_ids=${config.account_ids.join(',')}`;
                }
                const healthResponse = await fetch(healthUrl);
                
                if (!healthResponse.ok) {
                    // Health check API failed - show modal to let user decide
                    toaster.create({
                        title: 'Health Check Failed',
                        description: 'Unable to verify data health. You can try calculating anyway.',
                        type: 'warning',
                        duration: 5000,
                    });
                    setHealthCheckIssueCount(0); // Unknown
                    setShowHealthConfirm(true);
                    return;
                }
                
                const healthData = await healthResponse.json();
                
                // Check if there are data health issues
                if (healthData && healthData.has_issues) {
                    const issueCount = healthData.total_issues;
                    
                    // Store issue count for dialog display
                    setHealthCheckIssueCount(issueCount);

                    // Show warning toast
                    toaster.create({
                        title: 'Data Health Issues Detected',
                        description: `Found ${issueCount} data issue${issueCount !== 1 ? 's' : ''}. P&L calculation may be incomplete or inaccurate.`,
                        type: 'warning',
                        duration: 5000,
                    });

                    // Show confirmation dialog
                    setShowHealthConfirm(true);
                    return; // Don't proceed yet
                }
            } catch (err) {
                console.error('Health check failed:', err);
                // Show modal to let user decide
                toaster.create({
                    title: 'Health Check Error',
                    description: 'Error checking data health. You can try calculating anyway.',
                    type: 'warning',
                    duration: 5000,
                });
                setHealthCheckIssueCount(0); // Unknown
                setShowHealthConfirm(true);
                return;
            }
        }

        // Reset skip flag for next calculation
        skipHealthCheckRef.current = false;
        
        // Mark calculation as in progress
        isCalculatingRef.current = true;

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

            // Initialize ID counts from calculation response ID lists
            setIdCounts({
                unitCount: calcResult.calculation_unit_ids?.length ?? 0,
                lotCount: calcResult.cost_lot_ids?.length ?? 0,
                consumedCount: 0,  // Will be set from consumed slices pagination
                realizedCount: calcResult.realized_pnl_ids?.length ?? 0,
                feeCount: calcResult.fee_ids?.length ?? 0,
                warningCount: calcResult.warning_ids?.length ?? 0,
                settlementCount: 0,  // Will be set from settlements pagination
                eventCount: calcResult.cost_lot_event_ids?.length ?? 0,
            });

            // Step 2: Load balances from dedicated endpoint (group_by_asset=true)
            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            // Note: Per-account balances are loaded on-demand when user expands asset rows

            // Map response to summary data for transformResult
            const summaryData = mapToSummaryData(calcResult);

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
            // Mark calculation as complete
            isCalculatingRef.current = false;
        }
    }, [config, transformResult, loadBalances, transformBalances, fetchPrices, mapToSummaryData, showUnsettledNegative]);

    // Independent loader: Load calculation units with pagination
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

    // Handle continuing calculation despite health issues
    const handleContinueAnyway = useCallback(() => {
        skipHealthCheckRef.current = true;  // Skip health check on next call
        setShowHealthConfirm(false);
        // Call runCalculation directly (no setTimeout needed)
        runCalculation();
    }, [runCalculation]);

    // Handle opening health check drawer to fix issues
    const handleFixIssues = useCallback(() => {
        setShowHealthConfirm(false);
        onOpenHealthCheck?.();
    }, [onOpenHealthCheck]);

    // Load a specific version by ID - resets all state and fetches fresh data
    const loadVersionById = useCallback(async (versionId: number) => {
        setIsCalculating(true);
        setError(null);

        try {
            // Reset relevant state for version reload
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

            // Store ID counts from version response ID lists
            setIdCounts({
                unitCount: versionData.calculation_unit_ids?.length ?? 0,
                lotCount: versionData.cost_lot_ids?.length ?? 0,
                consumedCount: 0,  // Will be set from consumed slices pagination
                realizedCount: versionData.realized_pnl_ids?.length ?? 0,
                feeCount: versionData.fee_ids?.length ?? 0,
                warningCount: versionData.warning_ids?.length ?? 0,
                settlementCount: 0,  // Will be set from settlements pagination
                eventCount: versionData.cost_lot_event_ids?.length ?? 0,
            });

            // Fetch balances from dedicated endpoint (group_by_asset=true)
            const balances = await loadBalances(versionId, showUnsettledNegative);
            const assetRows = transformBalances(balances);

            // Prefetch per-account balances for expandable rows
            loadAccountBalances(versionId);

            // Map response to summary data for transformResult
            const summaryData = mapToSummaryData(versionData);

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
    }, [transformResult, loadBalances, transformBalances, fetchPrices, config.base_currency_symbol, mapToSummaryData, loadAccountBalances, showUnsettledNegative]);

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

    // Asset click handler - TEMPORARILY DISABLED during refactoring
    const handleAssetClick = useCallback(async (assetId: number | null | undefined) => {
        const asset = assets.find(apnl => apnl.asset.id === assetId);
        if (!asset) return;
        setSelectedAssetId(assetId ?? null);
        setSelectedAsset(asset);
        setCurrentView('asset-detail');
    }, [assets]);

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

    // --- Lazy load audit data removed - tabs now fetch their own data when opened ---

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
                    {/* Toolbar: View toggle, Price Status and Refresh - above summary cards */}
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
                            {/* Left side: View toggle */}
                            <Flex gap={2} align="center">
                                <Button
                                    size="sm"
                                    variant={viewMode === 'portfolio' ? 'solid' : 'outline'}
                                    colorPalette={viewMode === 'portfolio' ? 'blue' : 'gray'}
                                    onClick={() => setViewMode('portfolio')}
                                >
                                    📊 Portfolio
                                    {hasActiveFilters && viewMode === 'portfolio' && (
                                        <Badge ml={2} colorPalette="blue" size="xs" variant="subtle">filtered</Badge>
                                    )}
                                </Button>
                                <Button
                                    size="sm"
                                    variant={viewMode === 'audit' ? 'solid' : 'outline'}
                                    colorPalette={viewMode === 'audit' ? 'blue' : 'gray'}
                                    onClick={() => setViewMode('audit')}
                                >
                                    📋 Full Audit
                                </Button>
                            </Flex>

                            {/* Right side: Price Status and Refresh button */}
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
                    {currentView !== 'asset-detail' && viewMode === 'portfolio' && (
                        <PnLFilterBar
                            allAccounts={accounts}
                            dimensions={dimensions}
                            availableAccountIds={availableAccountIds}
                            availableCategoryIds={availableCategoryIds}
                            filterState={filterState}
                            onFilterChange={(newState) => {
                                setFilterState(newState);
                                // Sync includeUnsettledNegative with the existing showUnsettledNegative state
                                if (newState.includeUnsettledNegative !== showUnsettledNegative) {
                                    setShowUnsettledNegative(newState.includeUnsettledNegative);
                                }
                            }}
                            totalAssetCount={assets.length}
                            filteredAssetCount={filteredAssets.length}
                            isLoading={isLoadingCategories || isLoadingAccounts}
                            unsettledNegativeCount={totalUnsettledNegativeCount}
                        />
                    )}

                    {/* Filter active indicator banner */}
                    {currentView !== 'asset-detail' && viewMode === 'portfolio' && hasActiveFilters && (
                        <Box
                            bg="blue.50"
                            border="1px solid"
                            borderColor="blue.200"
                            borderRadius="md"
                            px={3}
                            py={2}
                            mb={4}
                        >
                            <Flex align="center" gap={2}>
                                <Text fontSize="sm" color="blue.700">
                                    ⚠️ Showing {filteredAssets.length} of {assets.length} assets (filters applied)
                                </Text>
                            </Flex>
                        </Box>
                    )}

                    {/* Summary Cards (only in Portfolio view, not in asset detail or audit) */}
                    {currentView !== 'asset-detail' && viewMode === 'portfolio' && filteredSummary && (
                        <SummaryCards
                            summary={filteredSummary}
                            baseCurrency={config.base_currency_symbol}
                            onFeesClick={() => {
                                setViewMode('audit');
                                setAuditSubTab('fees');
                            }}
                            onWarningsClick={() => {
                                setViewMode('audit');
                                setAuditSubTab('warnings');
                            }}
                        />
                    )}

                    {/* Charts Section: Pie Chart + Performance Bar Chart side by side */}
                    {currentView !== 'asset-detail' && viewMode === 'portfolio' && dimensions.length > 0 && filteredAssets.length > 0 && (
                        <Box
                            display="grid"
                            gridTemplateColumns={{ base: '1fr', lg: '6fr 3fr' }}
                            gap={4}
                            mb={4}
                        >
                            <MarketValuePieChart
                                assets={filteredAssets}
                                dimensions={dimensions}
                                baseCurrency={config.base_currency_symbol}
                                selectedCategoryIds={filterState.selectedCategoryIds}
                                onCategoryClick={handlePieCategoryClick}
                            />
                            <PerformanceBarChart
                                assets={filteredAssets}
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

                    {/* Main content based on view - Portfolio View (assets table) */}
                    {currentView === 'assets' && viewMode === 'portfolio' && (
                        <AssetPnLTable
                            assets={filteredAssets}
                            baseCurrency={config.base_currency_symbol}
                            onAssetClick={handleAssetClick}
                            accountBalances={accountBalances}
                            accounts={accounts}
                            onLoadAccountBalances={() => currentVersionId && loadAccountBalances(currentVersionId)}
                        />
                    )}

                    {/* Full Audit View - only shown when viewMode is 'audit' */}
                    {currentView === 'assets' && viewMode === 'audit' && currentVersionId && (
                        <>
                            {/* Info banner for audit view */}
                            <Box
                                bg="gray.50"
                                border="1px solid"
                                borderColor="gray.200"
                                borderRadius="md"
                                px={3}
                                py={2}
                                mb={4}
                            >
                                <Text fontSize="sm" color="gray.600">
                                    📋 Complete P&L calculation audit — no filters applied
                                </Text>
                            </Box>
                            <PnLAuditView
                                versionId={currentVersionId}
                                baseCurrency={config.base_currency_symbol}
                                onTransactionClick={handleTransactionClick}
                                onAssetClick={handleAssetClick}
                                onUnitClick={handleUnitClick}
                                defaultTab={auditSubTab}
                                onTabChange={handleAuditTabChange}
                                idCounts={idCounts}
                                quoteAssetId={config.base_currency_id ?? undefined}
                                onPriceAdded={(assetId, warningId) => handlePriceAdded(assetId, warningId)}
                                assets={assets.map(a => a.asset)}
                            />
                        </>
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

            {/* Data Health Confirmation Dialog */}
            <Dialog.Root
                open={showHealthConfirm}
                onOpenChange={(e) => { if (!e.open) setShowHealthConfirm(false); }}
            >
                <Dialog.Backdrop />
                <Dialog.Positioner>
                    <Dialog.Content>
                        <Dialog.Header>
                            <Dialog.Title>Data Health Issues Detected</Dialog.Title>
                        </Dialog.Header>
                        <Dialog.Body>
                            <Text>
                                Found <strong>{healthCheckIssueCount}</strong> data issue
                                {healthCheckIssueCount !== 1 ? 's' : ''}
                                (linkage, transfers, etc.). P&L calculation may be incomplete or inaccurate.
                            </Text>
                            <Text mt={3} fontSize="sm" color="gray.600">
                                What would you like to do?
                            </Text>
                        </Dialog.Body>
                        <Dialog.Footer>
                            <Flex gap={2} width="100%">
                                <Button
                                    variant="outline"
                                    onClick={() => setShowHealthConfirm(false)}
                                    flex={1}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    colorPalette="orange"
                                    variant="outline"
                                    onClick={handleContinueAnyway}
                                    flex={1}
                                >
                                    Continue Anyway
                                </Button>
                                <Button
                                    colorPalette="blue"
                                    onClick={handleFixIssues}
                                    flex={1}
                                >
                                    Fix Issues
                                </Button>
                            </Flex>
                        </Dialog.Footer>
                    </Dialog.Content>
                </Dialog.Positioner>
            </Dialog.Root>
        </Box>
    );
};

export default PnLPanel;
